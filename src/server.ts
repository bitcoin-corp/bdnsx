// Plain node:http server. Run: pnpm build && node dist/server.js
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';
import { PrivateKey } from '@bsv/sdk';
import { LeaseError, LeaseService, normalizeName, type LeaseDeps } from './lease.js';
import { resolveName } from './resolve.js';
import { MemoryStore } from './store.js';
import { loadPricing } from './pricing.js';
import { wocFetchTx, wocRate, type FetchLike } from './payment.js';
import { dryRunBroadcaster, wocBroadcaster } from './broadcast.js';

const MAX_BODY = 16 * 1024;

export interface App { svc: LeaseService; deps: LeaseDeps; vaultPubKey: string }

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new LeaseError('bad_request', 'content-type must be application/json', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new LeaseError('too_large', 'body too large', 413);
    chunks.push(c as Buffer);
  }
  let v: unknown;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LeaseError('bad_json', 'invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LeaseError('bad_json', 'body must be a JSON object');
  return v as Record<string, unknown>;
}

const publicLease = (r: Awaited<ReturnType<LeaseService['createLease']>>) => ({
  name: r.lease.name, renter: r.lease.renter, from: r.lease.from, until: r.lease.until,
  txid: r.txid, dryRun: r.dryRun, record: r.record, quote: r.quote,
});

export function handler(app: App) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const m = req.method ?? 'GET';
      if (m === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
        return void res.end();
      }
      let match: RegExpMatchArray | null;
      if (m === 'GET' && path === '/health') return send(res, 200, { ok: true, broadcast: !app.deps.broadcaster || app.deps.broadcaster === dryRunBroadcaster ? 'dry-run' : 'live' });
      if (m === 'GET' && (match = path.match(/^\/api\/resolve\/([^/]+)$/))) {
        const r = await resolveName(decodeURIComponent(match[1]), { store: app.deps.store, vaultHolds: app.deps.vaultHolds, vaultPubKey: app.vaultPubKey, now: app.deps.now });
        return r ? send(res, 200, r) : send(res, 404, { error: 'not_found' });
      }
      if (m === 'GET' && (match = path.match(/^\/api\/leases\/([^/]+)$/))) {
        const name = normalizeName(decodeURIComponent(match[1]));
        const { lease, status } = await app.svc.status(name);
        if (!lease) return send(res, 404, { name, status });
        return send(res, 200, { name, status, renter: lease.renter, from: lease.from, until: lease.until, annualUsd: lease.annualUsd, revoked: lease.revoked ?? null, records: lease.records.map((x) => ({ txid: x.txid, dryRun: x.dryRun, type: x.record.type, record: x.record })) });
      }
      if (m === 'POST' && path === '/api/lease/quote') {
        const b = await readJson(req);
        const name = normalizeName(b.name);
        if (!(await app.deps.vaultHolds(name))) throw new LeaseError('not_held', 'name is not held by the vault', 404);
        const { lease, status } = await app.svc.status(name);
        const live = lease && (status === 'active' || status === 'grace');
        const forRenewal = live && typeof b.renterKey === 'string' && b.renterKey.toLowerCase() === lease.renter ? lease : undefined;
        if (live && !forRenewal) return send(res, 409, { error: 'already_leased', until: lease.until });
        return send(res, 200, { ...(await app.svc.quote(name, b.years, forRenewal)), payTo: app.deps.payTo, renewal: !!forRenewal });
      }
      if (m === 'POST' && path === '/api/lease') return send(res, 201, publicLease(await app.svc.createLease(await readJson(req) as never)));
      if (m === 'POST' && path === '/api/lease/renew') return send(res, 200, publicLease(await app.svc.renew(await readJson(req) as never)));
      if (m === 'POST' && path === '/api/lease/transfer') return send(res, 200, publicLease(await app.svc.transfer(await readJson(req) as never)));
      if (m === 'POST' && path === '/api/admin/revoke') return send(res, 200, publicLease(await app.svc.revoke(await readJson(req) as never)));
      if (m === 'POST' && path === '/api/link') {
        const r = await app.svc.link(await readJson(req) as never);
        return send(res, 201, { ...r.link, txid: r.txid, dryRun: r.dryRun, record: r.record });
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof LeaseError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[bdnsx]', (e as Error).message);
      return send(res, 502, { error: 'upstream', message: 'upstream or internal error' });
    }
  };
}

function lines(file: string | undefined): Set<string> {
  if (!file) return new Set();
  return new Set(readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('#')));
}

/** Build the app from environment variables. The vault WIF is read only when a record is signed. */
export function appFromEnv(env = process.env, fetchImpl: FetchLike = fetch as unknown as FetchLike): App {
  const required = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is required`); return v; };
  const vaultPubKey = required('BDNSX_VAULT_PUBKEY').toLowerCase();
  const vaultKey = () => {
    const wif = env.BDNSX_VAULT_WIF;
    if (!wif) throw new LeaseError('no_vault_key', 'BDNSX_VAULT_WIF is not set', 503);
    const k = PrivateKey.fromWif(wif);
    if (k.toPublicKey().toString() !== vaultPubKey) throw new LeaseError('vault_key_mismatch', 'BDNSX_VAULT_WIF does not match BDNSX_VAULT_PUBKEY', 503);
    return k;
  };
  const network = env.BDNSX_NETWORK === 'test' ? 'test' : 'main';
  const live = env.BDNSX_BROADCAST === '1';
  const held = lines(env.BDNSX_VAULT_NAMES_FILE);
  const deps: LeaseDeps = {
    store: new MemoryStore(env.BDNSX_CACHE_FILE || undefined),
    pricing: loadPricing(env.BDNSX_PRICING_FILE ? new URL(`file://${env.BDNSX_PRICING_FILE}`) : undefined),
    fetchTx: wocFetchTx(fetchImpl, network),
    bsvUsd: wocRate(fetchImpl),
    vaultHolds: async (n) => held.has(n),
    vaultKey,
    payTo: required('BDNSX_PAY_TO'),
    ownerPubKey: env.BDNSX_OWNER_PUBKEY?.toLowerCase() || undefined,
    broadcaster: live
      ? wocBroadcaster({ fetch: fetchImpl, network, fundingKey: () => (env.BDNSX_FUNDING_WIF ? PrivateKey.fromWif(env.BDNSX_FUNDING_WIF) : vaultKey()) })
      : dryRunBroadcaster,
    ownedNamesCount: async () => Number(env.BDNSX_OWNED_NAMES_COUNT ?? 0) || 0,
    minConfirmations: Number(env.BDNSX_MIN_CONFIRMATIONS ?? 0) || 0,
    notForLease: lines(env.BDNSX_NOT_FOR_LEASE_FILE),
    resolveTxt,
  };
  return { svc: new LeaseService(deps), deps, vaultPubKey };
}

export function start(app: App, port: number): Server {
  const server = createServer(handler(app));
  server.listen(port, () => console.log(`[bdnsx] listening on :${port} (${app.deps.broadcaster === dryRunBroadcaster ? 'dry-run' : 'LIVE broadcast'})`));
  return server;
}

if (process.argv[1]?.endsWith('server.js')) {
  start(appFromEnv(), Number(process.env.PORT ?? 8787));
}

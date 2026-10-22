// Lease lifecycle: create, renew (with grace), lapse, transfer (two-party), revoke (owner only), link.
import { PrivateKey, PublicKey } from '@bsv/sdk';
import { messages, signRecord, verifyMessage, type BdnsxRecord, type SignedRecord } from './record.js';
import { checkPayment, TXID_RE, type FetchTx } from './payment.js';
import { quote, usdToSats, type PricingConfig, type Quote } from './pricing.js';
import { dryRunBroadcaster, type Broadcaster } from './broadcast.js';
import type { Lease, Link, Store } from './store.js';

export const GRACE_DAYS = 30;
const DAY = 86_400_000;
const YEAR = 365.25 * DAY;

export class LeaseError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export type LeaseStatus = 'active' | 'grace' | 'lapsed' | 'revoked';

export interface LeaseDeps {
  store: Store;
  pricing: PricingConfig;
  fetchTx: FetchTx;
  bsvUsd: () => Promise<number>;
  /** True when the vault ordinals address holds this OpNS name. */
  vaultHolds: (name: string) => Promise<boolean>;
  /** Vault signing key, loaded lazily (env BDNSX_VAULT_WIF). Never stored. */
  vaultKey: () => PrivateKey;
  /** Store payment address the rent must be paid to. */
  payTo: string;
  /** Owner key allowed to revoke (compressed pubkey hex). */
  ownerPubKey?: string;
  broadcaster?: Broadcaster;
  now?: () => Date;
  /** Owned (sold) names counted toward adoption, in addition to active leases. */
  ownedNamesCount?: () => Promise<number>;
  minConfirmations?: number;
  /** Names never leased (brands, KEEP list). */
  notForLease?: Set<string>;
  /** DNS TXT lookup for link verification. */
  resolveTxt?: (host: string) => Promise<string[][]>;
}

export const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function addYears(isoDate: string, years: number): string {
  const d = new Date(isoDate);
  const out = new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  return iso(out);
}

export function leaseStatus(lease: Lease, now: Date): LeaseStatus {
  if (lease.revoked) return 'revoked';
  const until = Date.parse(lease.until);
  if (now.getTime() < until) return 'active';
  if (now.getTime() < until + GRACE_DAYS * DAY) return 'grace';
  return 'lapsed';
}

/** OpNS names: lowercase, no whitespace, no dots/pipes/colons, 1-64 code points. */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new LeaseError('bad_name', 'name required');
  const n = raw.trim().normalize('NFC').toLowerCase();
  const len = [...n].length;
  if (len < 1 || len > 64 || /[\s.|:/\\@]/u.test(n) || /\p{C}/u.test(n)) throw new LeaseError('bad_name', 'invalid name');
  return n;
}

export function normalizeKey(raw: unknown): string {
  if (typeof raw !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(raw)) throw new LeaseError('bad_key', 'renterKey must be a compressed public key (hex)');
  try { PublicKey.fromString(raw); } catch { throw new LeaseError('bad_key', 'renterKey is not on the curve'); }
  return raw.toLowerCase();
}

function normalizeTxid(raw: unknown): string {
  if (typeof raw !== 'string' || !TXID_RE.test(raw.toLowerCase())) throw new LeaseError('bad_txid', 'paymentTxid must be 64 hex chars');
  return raw.toLowerCase();
}

export interface LeaseResult { lease: Lease; record: SignedRecord; txid: string; dryRun: boolean; quote?: Quote }

export class LeaseService {
  private queue: Promise<unknown> = Promise.resolve();
  private broadcaster: Broadcaster;
  private now: () => Date;

  constructor(private deps: LeaseDeps) {
    this.broadcaster = deps.broadcaster ?? dryRunBroadcaster;
    this.now = deps.now ?? (() => new Date());
  }

  /** Serialize all mutations so two requests can't lease the same name or reuse a payment. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async adoption(): Promise<number> {
    const now = this.now();
    const leases = await this.deps.store.allLeases();
    const active = leases.filter((l) => ['active', 'grace'].includes(leaseStatus(l, now))).length;
    return active + ((await this.deps.ownedNamesCount?.()) ?? 0);
  }

  async quote(rawName: unknown, years: unknown, renewal?: Lease): Promise<Quote & { sats: number; bsvUsd: number }> {
    const name = normalizeName(rawName);
    if (typeof years !== 'number') throw new LeaseError('bad_years', 'years must be a number');
    const highWater = await this.deps.store.getHighWater();
    let q: Quote;
    try {
      q = quote({
        name, years, adoption: await this.adoption(), highWater,
        renewal: renewal ? { lastAnnualUsd: renewal.annualUsd, yearsSinceLastPrice: (this.now().getTime() - Date.parse(renewal.priceSetAt)) / YEAR } : undefined,
      }, this.deps.pricing);
    } catch (e) {
      throw new LeaseError('bad_years', (e as Error).message);
    }
    const bsvUsd = await this.deps.bsvUsd();
    return { ...q, sats: usdToSats(q.totalUsd, bsvUsd), bsvUsd };
  }

  private async verifyPaid(paymentTxid: string, totalUsd: number): Promise<void> {
    if (await this.deps.store.isPaymentUsed(paymentTxid)) throw new LeaseError('payment_used', 'payment already used', 409);
    const rate = await this.deps.bsvUsd();
    const min = Math.floor(usdToSats(totalUsd, rate) * (1 - this.deps.pricing.paymentTolerancePct / 100));
    const check = checkPayment(await this.deps.fetchTx(paymentTxid), this.deps.payTo, min, this.deps.minConfirmations ?? 0);
    if (!check.ok) throw new LeaseError('payment_invalid', check.reason ?? 'payment invalid', 402);
  }

  private async publish(rec: BdnsxRecord): Promise<{ record: SignedRecord; txid: string; dryRun: boolean }> {
    const record = signRecord(rec, this.deps.vaultKey());
    const { txid, dryRun } = await this.broadcaster(record);
    return { record, txid, dryRun };
  }

  private async liveLease(name: string): Promise<Lease | null> {
    const l = await this.deps.store.getLease(name);
    if (!l) return null;
    const s = leaseStatus(l, this.now());
    return s === 'active' || s === 'grace' ? l : null;
  }

  async status(rawName: unknown): Promise<{ lease: Lease | null; status: LeaseStatus | 'none' }> {
    const name = normalizeName(rawName);
    const lease = await this.deps.store.getLease(name);
    return { lease, status: lease ? leaseStatus(lease, this.now()) : 'none' };
  }

  createLease(input: { name: unknown; years: unknown; paymentTxid: unknown; renterKey: unknown; signature: unknown }): Promise<LeaseResult> {
    return this.exclusive(async () => {
      const name = normalizeName(input.name);
      const renter = normalizeKey(input.renterKey);
      const paymentTxid = normalizeTxid(input.paymentTxid);
      const years = input.years;
      if (typeof years !== 'number') throw new LeaseError('bad_years', 'years must be a number');
      if (typeof input.signature !== 'string' || !verifyMessage(messages.lease(name, years, paymentTxid), input.signature, renter)) {
        throw new LeaseError('bad_signature', 'signature does not prove renterKey', 401);
      }
      if (this.deps.notForLease?.has(name)) throw new LeaseError('not_for_lease', 'this name is not offered for lease', 403);
      if (await this.liveLease(name)) throw new LeaseError('already_leased', 'name is already leased', 409);
      if (!(await this.deps.vaultHolds(name))) throw new LeaseError('not_held', 'name is not held by the vault', 404);
      const q = await this.quote(name, years);
      await this.verifyPaid(paymentTxid, q.totalUsd);

      const now = iso(this.now());
      const until = addYears(now, years);
      const pub = await this.publish({ type: 'lease', fields: { name, renter, from: now, until, paid: paymentTxid, usd: q.totalUsd.toFixed(2) } });
      const lease: Lease = {
        name, renter, from: now, until, annualUsd: q.annualUsd, priceSetAt: now, paidTxids: [paymentTxid],
        recordTxid: pub.txid, records: [{ txid: pub.txid, record: pub.record, dryRun: pub.dryRun }],
      };
      await this.deps.store.markPaymentUsed(paymentTxid);
      await this.deps.store.putLease(lease);
      await this.deps.store.setHighWater(q.multiplier);
      return { lease, ...pub, quote: q };
    });
  }

  renew(input: { name: unknown; years: unknown; paymentTxid: unknown; renterKey: unknown; signature: unknown }): Promise<LeaseResult> {
    return this.exclusive(async () => {
      const name = normalizeName(input.name);
      const renter = normalizeKey(input.renterKey);
      const paymentTxid = normalizeTxid(input.paymentTxid);
      const years = input.years;
      if (typeof years !== 'number') throw new LeaseError('bad_years', 'years must be a number');
      const lease = await this.liveLease(name);
      if (!lease) throw new LeaseError('no_lease', 'no active lease (lapsed leases cannot be renewed; lease again)', 404);
      if (lease.renter !== renter) throw new LeaseError('not_renter', 'only the current renter can renew', 403);
      if (typeof input.signature !== 'string' || !verifyMessage(messages.renew(name, years, paymentTxid), input.signature, renter)) {
        throw new LeaseError('bad_signature', 'signature does not prove renterKey', 401);
      }
      const q = await this.quote(name, years, lease);
      await this.verifyPaid(paymentTxid, q.totalUsd);
      const until = addYears(lease.until, years); // extends from current expiry, also during grace
      const pub = await this.publish({ type: 'renew', fields: { name, renter, until, paid: paymentTxid, usd: q.totalUsd.toFixed(2), prev: lease.recordTxid } });
      const now = iso(this.now());
      const next: Lease = {
        ...lease, until, annualUsd: q.annualUsd, priceSetAt: now, paidTxids: [...lease.paidTxids, paymentTxid],
        recordTxid: pub.txid, records: [...lease.records, { txid: pub.txid, record: pub.record, dryRun: pub.dryRun }],
      };
      await this.deps.store.markPaymentUsed(paymentTxid);
      await this.deps.store.putLease(next);
      await this.deps.store.setHighWater(q.multiplier);
      return { lease: next, ...pub, quote: q };
    });
  }

  /** Two-party handover: current renter signs transferOut, new renter signs transferAccept. */
  transfer(input: { name: unknown; toKey: unknown; fromSig: unknown; toSig: unknown }): Promise<LeaseResult> {
    return this.exclusive(async () => {
      const name = normalizeName(input.name);
      const to = normalizeKey(input.toKey);
      const lease = await this.deps.store.getLease(name);
      if (!lease || leaseStatus(lease, this.now()) !== 'active') throw new LeaseError('no_lease', 'only an active lease (not in grace) can be transferred', 404);
      if (to === lease.renter) throw new LeaseError('same_renter', 'new renter is the current renter');
      const outMsg = messages.transferOut(name, lease.renter, to, lease.until);
      const accMsg = messages.transferAccept(name, lease.renter, to, lease.until);
      if (typeof input.fromSig !== 'string' || !verifyMessage(outMsg, input.fromSig, lease.renter)) throw new LeaseError('bad_signature', 'current renter signature invalid', 401);
      if (typeof input.toSig !== 'string' || !verifyMessage(accMsg, input.toSig, to)) throw new LeaseError('bad_signature', 'new renter signature invalid', 401);
      const pub = await this.publish({ type: 'transfer', fields: { name, renter: lease.renter, to, until: lease.until, prev: lease.recordTxid, fromsig: input.fromSig, tosig: input.toSig } });
      const next: Lease = { ...lease, renter: to, recordTxid: pub.txid, records: [...lease.records, { txid: pub.txid, record: pub.record, dryRun: pub.dryRun }] };
      await this.deps.store.putLease(next);
      return { lease: next, ...pub };
    });
  }

  /** Owner-only early end. The owner signs `bdnsx:revoke:<name>:<renter>:<reason>` with BDNSX_OWNER_PUBKEY's key. */
  revoke(input: { name: unknown; reason: unknown; ownerSig: unknown }): Promise<LeaseResult> {
    return this.exclusive(async () => {
      const name = normalizeName(input.name);
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 200 || input.reason.includes('|')) {
        throw new LeaseError('bad_reason', 'reason required (max 200 chars, no |)');
      }
      const reason = input.reason.trim();
      const lease = await this.liveLease(name);
      if (!lease) throw new LeaseError('no_lease', 'no live lease to revoke', 404);
      const owner = this.deps.ownerPubKey;
      if (!owner || typeof input.ownerSig !== 'string' || !verifyMessage(revokeMessage(name, lease.renter, reason), input.ownerSig, owner)) {
        throw new LeaseError('not_owner', 'revocation must be signed by the owner key', 403);
      }
      const pub = await this.publish({ type: 'revoke', fields: { name, renter: lease.renter, prev: lease.recordTxid, reason } });
      const next: Lease = { ...lease, revoked: { at: iso(this.now()), reason }, recordTxid: pub.txid, records: [...lease.records, { txid: pub.txid, record: pub.record, dryRun: pub.dryRun }] };
      await this.deps.store.putLease(next);
      return { lease: next, ...pub };
    });
  }

  /** Names whose lease has lapsed (past grace) and that can go back to stock. */
  async lapsed(): Promise<string[]> {
    const now = this.now();
    return (await this.deps.store.allLeases()).filter((l) => leaseStatus(l, now) === 'lapsed').map((l) => l.name);
  }

  /** Link a domain to a key after checking TXT `_bdnsx.<domain>` holds the key's signature. */
  link(input: { domain: unknown; key: unknown; name?: unknown; site?: unknown }): Promise<{ link: Link; record: SignedRecord; txid: string; dryRun: boolean }> {
    return this.exclusive(async () => {
      if (typeof input.domain !== 'string' || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.domain.toLowerCase())) {
        throw new LeaseError('bad_domain', 'invalid domain');
      }
      const domain = input.domain.toLowerCase();
      const key = normalizeKey(input.key);
      const name = input.name === undefined ? undefined : normalizeName(input.name);
      const site = typeof input.site === 'string' && /^https:\/\/\S{1,300}$/.test(input.site) ? input.site : undefined;
      if (!this.deps.resolveTxt) throw new LeaseError('link_disabled', 'DNS lookup not configured', 503);
      let txt: string[][];
      try { txt = await this.deps.resolveTxt(`_bdnsx.${domain}`); } catch { txt = []; }
      const msg = messages.link(domain, key);
      if (!txt.map((parts) => parts.join('')).some((sig) => verifyMessage(msg, sig.trim(), key))) {
        throw new LeaseError('txt_missing', `TXT _bdnsx.${domain} must contain a signature of "${msg}"`, 422);
      }
      const pub = await this.publish({ type: 'link', fields: name ? { domain, key, name } : { domain, key } });
      const link: Link = { domain, key, name, site, recordTxid: pub.txid, verifiedAt: iso(this.now()) };
      await this.deps.store.putLink(link);
      return { link, ...pub };
    });
  }
}

export const revokeMessage = (name: string, renter: string, reason: string) => `bdnsx:revoke:${name}:${renter}:${reason}`;

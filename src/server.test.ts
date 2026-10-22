import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { messages, signMessage, verifyRecord } from './record.js';
import { handler } from './server.js';
import { alice, bob, fixture, pub, vault } from './testHelpers.js';

const f = fixture();
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer(handler({ svc: f.svc, deps: f.deps, vaultPubKey: pub(vault) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (p: string, body: unknown, ct = 'application/json') => fetch(base + p, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('http api', () => {
  it('resolve before lease returns owner; unknown is 404', async () => {
    const r = await fetch(`${base}/api/resolve/abc`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ holder: 'owner', key: pub(vault) });
    expect((await fetch(`${base}/api/resolve/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/resolve/a%7Cb`)).status).toBe(400);
  });
  it('quote -> lease -> resolve -> leases', async () => {
    const q = await (await post('/api/lease/quote', { name: 'abc', years: 1 })).json();
    expect(q).toMatchObject({ name: 'abc', annualUsd: 15, totalUsd: 15, sats: 30_000_000, renewal: false });
    const id = f.pay(10, 15);
    const r = await post('/api/lease', { name: 'abc', years: 1, paymentTxid: id, renterKey: pub(alice), signature: signMessage(messages.lease('abc', 1, id), alice) });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.dryRun).toBe(true);
    expect(verifyRecord(body.record)).toBe(true);
    expect(await (await fetch(`${base}/api/resolve/abc`)).json()).toMatchObject({ holder: 'renter', key: pub(alice), until: body.until });
    const l = await (await fetch(`${base}/api/leases/abc`)).json();
    expect(l.status).toBe('active');
    expect(l.records).toHaveLength(1);
    expect((await post('/api/lease/quote', { name: 'abc', years: 1 })).status).toBe(409);
    expect((await post('/api/lease/quote', { name: 'abc', years: 1, renterKey: pub(alice) })).status).toBe(200);
  });
  it('validates input', async () => {
    expect((await post('/api/lease', 'not json')).status).toBe(400);
    expect((await post('/api/lease', { name: 'xyz' }, 'text/plain')).status).toBe(415);
    expect((await post('/api/lease', [1])).status).toBe(400);
    expect((await post('/api/lease', { name: 'xyz', years: 1, paymentTxid: 'x', renterKey: pub(bob), signature: 's' })).status).toBe(400);
    expect((await post('/api/lease', { name: 'x'.repeat(20000) })).status).toBe(413);
    expect((await post('/api/lease/quote', { name: 'xyz', years: 99 })).status).toBe(400);
    const id = f.pay(11, 15);
    expect((await post('/api/lease', { name: 'xyz', years: 1, paymentTxid: id, renterKey: pub(bob), signature: signMessage('wrong', bob) })).status).toBe(401);
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
  });
});

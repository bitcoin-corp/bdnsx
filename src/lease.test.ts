import { describe, expect, it } from 'vitest';
import { messages, signMessage, verifyRecord } from './record.js';
import { addYears, leaseStatus, revokeMessage, LeaseError } from './lease.js';
import { alice, bob, fixture, owner, pub, txid } from './testHelpers.js';

const leaseReq = (name: string, years: number, paymentTxid: string, k = alice) => ({
  name, years, paymentTxid, renterKey: pub(k), signature: signMessage(messages.lease(name, years, paymentTxid), k),
});
const renewReq = (name: string, years: number, paymentTxid: string, k = alice) => ({
  name, years, paymentTxid, renterKey: pub(k), signature: signMessage(messages.renew(name, years, paymentTxid), k),
});
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as LeaseError).code; } };

describe('create lease', () => {
  it('creates a signed lease record (dry-run)', async () => {
    const f = fixture();
    const r = await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    expect(r.dryRun).toBe(true);
    expect(r.lease.until).toBe('2027-11-01T00:00:00Z');
    expect(r.record.type).toBe('lease');
    expect(r.record.fields.usd).toBe('15.00');
    expect(verifyRecord(r.record)).toBe(true);
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
  });
  it('normalizes the name', async () => {
    const f = fixture();
    const id = f.pay(1, 15);
    const req = { ...leaseReq('abc', 1, id), name: ' ABC ' };
    expect((await f.svc.createLease(req)).lease.name).toBe('abc');
  });
  it('rejects bad input, bad signatures, unheld or already leased names', async () => {
    const f = fixture();
    expect(await code(f.svc.createLease({ ...leaseReq('abc', 1, f.pay(1, 15)), renterKey: 'zz' }))).toBe('bad_key');
    expect(await code(f.svc.createLease({ ...leaseReq('abc', 1, f.pay(1, 15)), signature: signMessage('x', alice) }))).toBe('bad_signature');
    expect(await code(f.svc.createLease(leaseReq('nothere', 1, f.pay(2, 15))))).toBe('not_held');
    expect(await code(f.svc.createLease(leaseReq('a.b', 1, f.pay(2, 15))))).toBe('bad_name');
    expect(await code(f.svc.createLease(leaseReq('abc', 0, f.pay(2, 15))))).toBe('bad_years');
    await f.svc.createLease(leaseReq('abc', 1, f.pay(3, 15)));
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(4, 15), bob)))).toBe('already_leased');
  });
  it('rejects underpayment, wrong address, unknown tx and payment reuse', async () => {
    const f = fixture();
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(1, 10))))).toBe('payment_invalid');
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(2, 15, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'))))).toBe('payment_invalid');
    expect(await code(f.svc.createLease(leaseReq('abc', 1, txid(999))))).toBe('payment_invalid');
    const id = f.pay(3, 30);
    await f.svc.createLease(leaseReq('abc', 1, id));
    expect(await code(f.svc.createLease(leaseReq('xyz', 1, id)))).toBe('payment_used');
  });
  it('accepts payment within tolerance', async () => {
    const f = fixture();
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(1, 14.7))))).toBe('ok');
  });
  it('refuses names on the not-for-lease list', async () => {
    const f = fixture({ notForLease: new Set(['abc']) });
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15))))).toBe('not_for_lease');
  });
  it('serializes concurrent requests for the same name', async () => {
    const f = fixture();
    const results = await Promise.all([
      code(f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)))),
      code(f.svc.createLease(leaseReq('abc', 1, f.pay(2, 15), bob))),
    ]);
    expect(results.sort()).toEqual(['already_leased', 'ok']);
  });
});

describe('renew, grace, lapse', () => {
  it('extends from current expiry, not from today', async () => {
    const f = fixture();
    await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    f.advanceDays(100);
    const r = await f.svc.renew(renewReq('abc', 2, f.pay(2, 30)));
    expect(r.lease.until).toBe('2029-11-01T00:00:00Z');
    expect(r.record.type).toBe('renew');
    expect(r.record.fields.prev).toBe(r.lease.records[0].txid);
  });
  it('only the renter can renew; renter can renew in grace', async () => {
    const f = fixture();
    await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    f.advanceDays(366 + 10); // in grace
    expect((await f.svc.status('abc')).status).toBe('grace');
    expect(await code(f.svc.renew(renewReq('abc', 1, f.pay(2, 15), bob)))).toBe('not_renter');
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(3, 15), bob)))).toBe('already_leased');
    const r = await f.svc.renew(renewReq('abc', 1, f.pay(4, 15)));
    expect(r.lease.until).toBe('2028-11-01T00:00:00Z');
    expect(leaseStatus(r.lease, f.clock.t)).toBe('active');
  });
  it('lapses after grace; then anyone can lease and renewal is refused', async () => {
    const f = fixture();
    await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    f.advanceDays(365 + 31);
    expect((await f.svc.status('abc')).status).toBe('lapsed');
    expect(await f.svc.lapsed()).toEqual(['abc']);
    expect(await code(f.svc.renew(renewReq('abc', 1, f.pay(2, 15))))).toBe('no_lease');
    const r = await f.svc.createLease(leaseReq('abc', 1, f.pay(3, 15), bob));
    expect(r.lease.renter).toBe(pub(bob));
  });
  it('caps renewal price rises for existing renters', async () => {
    const f = fixture();
    await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    f.deps.ownedNamesCount = async () => 20_000; // adoption jumps -> x3 list price
    const q = await f.svc.quote('abc', 1);
    expect(q.annualUsd).toBe(45);
    f.advanceDays(300);
    const r = await f.svc.renew(renewReq('abc', 1, f.pay(2, 18.75)));
    expect(r.quote?.annualUsd).toBe(18.75);
    expect(r.quote?.capped).toBe(true);
    expect(r.lease.annualUsd).toBe(18.75);
  });
  it('multiplier never drops after adoption falls', async () => {
    const f = fixture();
    f.deps.ownedNamesCount = async () => 5000;
    await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 30)));
    f.deps.ownedNamesCount = async () => 0;
    expect((await f.svc.quote('xyz', 1)).multiplier).toBe(2);
  });
});

describe('transfer', () => {
  it('needs both signatures and keeps the expiry', async () => {
    const f = fixture();
    const { lease } = await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    const out = signMessage(messages.transferOut('abc', pub(alice), pub(bob), lease.until), alice);
    const acc = signMessage(messages.transferAccept('abc', pub(alice), pub(bob), lease.until), bob);
    expect(await code(f.svc.transfer({ name: 'abc', toKey: pub(bob), fromSig: out, toSig: out }))).toBe('bad_signature');
    expect(await code(f.svc.transfer({ name: 'abc', toKey: pub(bob), fromSig: acc, toSig: acc }))).toBe('bad_signature');
    const r = await f.svc.transfer({ name: 'abc', toKey: pub(bob), fromSig: out, toSig: acc });
    expect(r.lease.renter).toBe(pub(bob));
    expect(r.lease.until).toBe(lease.until);
    expect(r.record.fields.to).toBe(pub(bob));
    expect(verifyRecord(r.record)).toBe(true);
    // old renter can no longer renew
    expect(await code(f.svc.renew(renewReq('abc', 1, f.pay(2, 15))))).toBe('not_renter');
  });
  it('refuses transfer during grace', async () => {
    const f = fixture();
    const { lease } = await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    f.advanceDays(370);
    const out = signMessage(messages.transferOut('abc', pub(alice), pub(bob), lease.until), alice);
    const acc = signMessage(messages.transferAccept('abc', pub(alice), pub(bob), lease.until), bob);
    expect(await code(f.svc.transfer({ name: 'abc', toKey: pub(bob), fromSig: out, toSig: acc }))).toBe('no_lease');
  });
});

describe('revoke', () => {
  it('owner only, published, frees the name', async () => {
    const f = fixture();
    const { lease } = await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    const reason = 'brand claim upheld';
    expect(await code(f.svc.revoke({ name: 'abc', reason, ownerSig: signMessage(revokeMessage('abc', lease.renter, reason), alice) }))).toBe('not_owner');
    const r = await f.svc.revoke({ name: 'abc', reason, ownerSig: signMessage(revokeMessage('abc', lease.renter, reason), owner) });
    expect(r.record.type).toBe('revoke');
    expect(r.lease.revoked?.reason).toBe(reason);
    expect((await f.svc.status('abc')).status).toBe('revoked');
    expect(await code(f.svc.createLease(leaseReq('abc', 1, f.pay(2, 15), bob)))).toBe('ok');
  });
  it('is disabled without an owner key', async () => {
    const f = fixture({ ownerPubKey: undefined });
    const { lease } = await f.svc.createLease(leaseReq('abc', 1, f.pay(1, 15)));
    expect(await code(f.svc.revoke({ name: 'abc', reason: 'x', ownerSig: signMessage(revokeMessage('abc', lease.renter, 'x'), owner) }))).toBe('not_owner');
  });
});

describe('link', () => {
  it('verifies the TXT signature', async () => {
    const sig = signMessage(messages.link('example.com', pub(bob)), bob);
    const f = fixture({ resolveTxt: async (h) => (h === '_bdnsx.example.com' ? [[sig.slice(0, 40), sig.slice(40)]] : []) });
    const r = await f.svc.link({ domain: 'Example.com', key: pub(bob), name: 'example', site: 'https://example.com' });
    expect(r.record.type).toBe('link');
    expect(r.link.domain).toBe('example.com');
    expect(await code(f.svc.link({ domain: 'example.com', key: pub(alice) }))).toBe('txt_missing');
    expect(await code(f.svc.link({ domain: 'not a domain', key: pub(bob) }))).toBe('bad_domain');
  });
});

describe('dates', () => {
  it('adds calendar years in UTC', () => {
    expect(addYears('2026-11-01T00:00:00Z', 1)).toBe('2027-11-01T00:00:00Z');
    expect(addYears('2028-02-29T12:00:00Z', 1)).toBe('2029-03-01T12:00:00Z');
  });
});

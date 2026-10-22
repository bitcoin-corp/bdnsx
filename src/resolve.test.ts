import { describe, expect, it } from 'vitest';
import { messages, signMessage } from './record.js';
import { resolveName } from './resolve.js';
import { alice, bob, fixture, pub, vault } from './testHelpers.js';

describe('resolver', () => {
  it('owner -> renter -> grace -> owner again after lapse', async () => {
    const f = fixture({ resolveTxt: async () => [[signMessage(messages.link('alice.com', pub(alice)), alice)]] });
    const deps = { store: f.store, vaultHolds: f.deps.vaultHolds, vaultPubKey: pub(vault), now: () => f.clock.t };
    expect(await resolveName('abc', deps)).toEqual({ name: 'abc', holder: 'owner', key: pub(vault), until: null, status: 'owned' });
    expect(await resolveName('unknown', deps)).toBeNull();

    const id = f.pay(1, 15);
    await f.svc.createLease({ name: 'abc', years: 1, paymentTxid: id, renterKey: pub(alice), signature: signMessage(messages.lease('abc', 1, id), alice) });
    await f.svc.link({ domain: 'alice.com', key: pub(alice), site: 'https://alice.com' });
    expect(await resolveName('ABC', deps)).toEqual({ name: 'abc', holder: 'renter', key: pub(alice), until: '2027-11-01T00:00:00Z', status: 'active', site: 'https://alice.com' });

    f.advanceDays(370);
    expect((await resolveName('abc', deps))?.status).toBe('grace');
    f.advanceDays(30);
    expect((await resolveName('abc', deps))?.holder).toBe('owner');
  });
  it('rejects invalid names', async () => {
    const f = fixture();
    await expect(resolveName('a|b', { store: f.store, vaultHolds: f.deps.vaultHolds, vaultPubKey: pub(bob) })).rejects.toThrow();
  });
});

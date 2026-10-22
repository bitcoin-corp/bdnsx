// Test fixtures (TEST-ONLY keys).
import type { PrivateKey } from '@bsv/sdk';
import { LeaseService, type LeaseDeps } from './lease.js';
import { loadPricing } from './pricing.js';
import { MemoryStore } from './store.js';
import type { TxInfo } from './payment.js';
import { testKey } from './testKeys.js';

export const PAY_TO = testKey('store-pay').toAddress();
export const vault = testKey('vault');
export const owner = testKey('owner');
export const alice = testKey('alice');
export const bob = testKey('bob');
export const pub = (k: PrivateKey) => k.toPublicKey().toString();
export const txid = (n: number) => n.toString(16).padStart(64, '0');

export function fixture(over: Partial<LeaseDeps> = {}) {
  const clock = { t: new Date('2026-11-01T00:00:00Z') };
  const txs = new Map<string, TxInfo>();
  const held = new Set(['abc', 'xyz', 'ab', 'abcd', 'example']);
  const store = new MemoryStore();
  const deps: LeaseDeps = {
    store,
    pricing: loadPricing(),
    fetchTx: async (id) => txs.get(id) ?? null,
    bsvUsd: async () => 50,
    vaultHolds: async (n) => held.has(n),
    vaultKey: () => vault,
    payTo: PAY_TO,
    ownerPubKey: pub(owner),
    now: () => clock.t,
    ...over,
  };
  const svc = new LeaseService(deps);
  /** Register a payment tx paying `usd` at the $50 rate. */
  const pay = (n: number, usd: number, to = PAY_TO) => {
    txs.set(txid(n), { txid: txid(n), confirmations: 1, outputs: [{ address: to, sats: Math.ceil((usd / 50) * 1e8) }] });
    return txid(n);
  };
  const advanceDays = (d: number) => { clock.t = new Date(clock.t.getTime() + d * 86_400_000); };
  return { svc, deps, store, clock, txs, held, pay, advanceDays };
}

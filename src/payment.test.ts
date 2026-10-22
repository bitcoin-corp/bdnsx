import { describe, expect, it, vi } from 'vitest';
import { checkPayment, wocFetchTx, wocRate, type FetchLike } from './payment.js';

const id = 'ab'.repeat(32);
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('WhatsOnChain fetch (mocked)', () => {
  it('parses outputs into sats and addresses', async () => {
    const fetch = vi.fn<FetchLike>(async () => res(200, {
      txid: id, confirmations: 2,
      vout: [
        { n: 0, value: 0.3, scriptPubKey: { addresses: ['1Pay'] } },
        { n: 1, value: 0.00000001, scriptPubKey: { addresses: ['1Other'] } },
        { n: 2, value: 0, scriptPubKey: {} },
      ],
    }));
    const tx = await wocFetchTx(fetch)(id);
    expect(fetch).toHaveBeenCalledWith(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${id}`);
    expect(tx).toEqual({ txid: id, confirmations: 2, outputs: [{ address: '1Pay', sats: 30_000_000 }, { address: '1Other', sats: 1 }, { address: null, sats: 0 }] });
  });
  it('returns null on 404, throws on other errors and on mismatched txid', async () => {
    expect(await wocFetchTx(async () => res(404, {}))(id)).toBeNull();
    await expect(wocFetchTx(async () => res(500, {}))(id)).rejects.toThrow();
    await expect(wocFetchTx(async () => res(200, { txid: 'cd'.repeat(32), vout: [] }))(id)).rejects.toThrow();
    await expect(wocFetchTx(async () => res(200, {}))('nothex')).rejects.toThrow('bad txid');
  });
  it('reads the BSV/USD rate', async () => {
    expect(await wocRate(async () => res(200, { rate: 42.5 }))()).toBe(42.5);
    await expect(wocRate(async () => res(200, { rate: 'x' }))()).rejects.toThrow();
  });
});

describe('checkPayment', () => {
  const tx = { txid: id, confirmations: 0, outputs: [{ address: '1Pay', sats: 600 }, { address: '1Pay', sats: 400 }, { address: '1X', sats: 5000 }] };
  it('sums outputs to the pay address', () => {
    expect(checkPayment(tx, '1Pay', 1000)).toEqual({ ok: true, paidSats: 1000 });
    expect(checkPayment(tx, '1Pay', 1001).ok).toBe(false);
    expect(checkPayment(tx, '1Nope', 1).reason).toMatch(/does not pay/);
    expect(checkPayment(null, '1Pay', 1).reason).toMatch(/not found/);
    expect(checkPayment(tx, '1Pay', 1000, 1).reason).toMatch(/not confirmed/);
  });
});

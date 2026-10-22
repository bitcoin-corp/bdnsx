// Payment verification. Network access is injected (fetch) so tests run offline.

export interface TxOutput { address: string | null; sats: number }
export interface TxInfo { txid: string; outputs: TxOutput[]; confirmations: number }

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type FetchTx = (txid: string) => Promise<TxInfo | null>;

export const TXID_RE = /^[0-9a-f]{64}$/;

interface WocVout { value: number; n: number; scriptPubKey?: { addresses?: string[] } }
interface WocTx { txid: string; vout: WocVout[]; confirmations?: number }

/** WhatsOnChain transaction lookup. Returns null when the tx is unknown (404). */
export function wocFetchTx(fetchImpl: FetchLike, network: 'main' | 'test' = 'main', base = 'https://api.whatsonchain.com/v1/bsv'): FetchTx {
  return async (txid) => {
    if (!TXID_RE.test(txid)) throw new Error('bad txid');
    const res = await fetchImpl(`${base}/${network}/tx/hash/${txid}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WhatsOnChain ${res.status}`);
    const tx = (await res.json()) as WocTx;
    if (tx.txid !== txid || !Array.isArray(tx.vout)) throw new Error('unexpected WhatsOnChain response');
    return {
      txid,
      confirmations: tx.confirmations ?? 0,
      outputs: tx.vout.map((o) => ({
        address: o.scriptPubKey?.addresses?.length === 1 ? o.scriptPubKey.addresses[0] : null,
        // WoC reports BSV as a float; round to sats.
        sats: Math.round(o.value * 1e8),
      })),
    };
  };
}

export interface PaymentCheck { ok: boolean; paidSats: number; reason?: string }

export function checkPayment(tx: TxInfo | null, payTo: string, minSats: number, minConfirmations = 0): PaymentCheck {
  if (!tx) return { ok: false, paidSats: 0, reason: 'payment tx not found' };
  const paidSats = tx.outputs.filter((o) => o.address === payTo).reduce((a, o) => a + o.sats, 0);
  if (paidSats === 0) return { ok: false, paidSats, reason: 'payment tx does not pay the store address' };
  if (paidSats < minSats) return { ok: false, paidSats, reason: `underpaid: ${paidSats} < ${minSats} sats` };
  if (tx.confirmations < minConfirmations) return { ok: false, paidSats, reason: 'payment not confirmed yet' };
  return { ok: true, paidSats };
}

/** WhatsOnChain BSV/USD rate. */
export function wocRate(fetchImpl: FetchLike, base = 'https://api.whatsonchain.com/v1/bsv/main'): () => Promise<number> {
  return async () => {
    const res = await fetchImpl(`${base}/exchangerate`);
    if (!res.ok) throw new Error(`rate ${res.status}`);
    const j = (await res.json()) as { rate?: number };
    if (!(typeof j.rate === 'number' && j.rate > 0)) throw new Error('bad rate response');
    return j.rate;
  };
}

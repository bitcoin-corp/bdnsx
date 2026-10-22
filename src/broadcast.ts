// Turning a signed record into a transaction. Default is dry-run: nothing is funded, signed or sent.
import { Hash, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { toScript, type SignedRecord } from './record.js';
import type { FetchLike } from './payment.js';

export interface BroadcastResult { txid: string; dryRun: boolean; rawTx?: string }
export type Broadcaster = (record: SignedRecord) => Promise<BroadcastResult>;

/** Dry-run id: sha256 of the record script, so `prev` links are stable before anything is on chain. */
export function dryRunId(record: SignedRecord): string {
  return Utils.toHex(Hash.sha256(toScript(record).toBinary()));
}

export const dryRunBroadcaster: Broadcaster = async (record) => ({ txid: dryRunId(record), dryRun: true });

/** Builds the record tx with a single 0-sat OP_RETURN output and no inputs (for inspection / tests). */
export function unfundedRecordTx(record: SignedRecord): Transaction {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: toScript(record), satoshis: 0 });
  return tx;
}

/**
 * LIVE broadcaster (only when BDNSX_BROADCAST=1). Funds the record tx from the funding key's
 * P2PKH UTXOs via WhatsOnChain and broadcasts through WhatsOnChain.
 * Skips any UTXO under `minUtxoSats` so 1-sat ordinals (the names themselves) are never spent.
 * Not exercised against mainnet in v1; see README "open decisions" on using a dedicated funding key.
 */
export function wocBroadcaster(opts: { fetch: FetchLike; fundingKey: () => PrivateKey; network?: 'main' | 'test'; minUtxoSats?: number }): Broadcaster {
  const base = `https://api.whatsonchain.com/v1/bsv/${opts.network ?? 'main'}`;
  const minUtxo = opts.minUtxoSats ?? 1000;
  return async (record) => {
    const key = opts.fundingKey();
    const address = key.toAddress();
    const res = await opts.fetch(`${base}/address/${address}/unspent`);
    if (!res.ok) throw new Error(`utxo lookup ${res.status}`);
    const utxos = ((await res.json()) as { tx_hash: string; tx_pos: number; value: number }[])
      .filter((u) => u.value >= minUtxo)
      .sort((a, b) => b.value - a.value);
    if (!utxos.length) throw new Error('no funding UTXO');
    const u = utxos[0];
    const hexRes = await opts.fetch(`${base}/tx/${u.tx_hash}/hex`);
    if (!hexRes.ok) throw new Error(`source tx ${hexRes.status}`);
    const tx = unfundedRecordTx(record);
    tx.addInput({ sourceTransaction: Transaction.fromHex(await hexRes.text()), sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(key) });
    tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
    await tx.fee();
    await tx.sign();
    const rawTx = tx.toHex();
    const b = await opts.fetch(`${base}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: rawTx }) });
    if (!b.ok) throw new Error(`broadcast failed ${b.status}: ${await b.text()}`);
    return { txid: tx.id('hex'), dryRun: false, rawTx };
  };
}

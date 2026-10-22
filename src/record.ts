// bDNSX on-chain record format (spec/RECORDS.md).
// OP_FALSE OP_RETURN | B "" text/plain utf-8 | MAP SET app bdnsx type <t> ...fields | AIP BITCOIN_ECDSA <address> <sig>
import { BSM, BigNumber, OP, PrivateKey, PublicKey, Script, Signature, Utils } from '@bsv/sdk';

export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
export const APP = 'bdnsx';
export const VERSION = '1';

export type RecordType = 'lease' | 'renew' | 'transfer' | 'link' | 'revoke';

/** Field order per type. Order matters: it fixes the signed bytes. */
export const FIELD_ORDER: Record<RecordType, readonly string[]> = {
  lease: ['name', 'renter', 'from', 'until', 'paid', 'usd'],
  renew: ['name', 'renter', 'until', 'paid', 'usd', 'prev'],
  transfer: ['name', 'renter', 'to', 'until', 'prev', 'fromsig', 'tosig'],
  link: ['domain', 'key', 'name'],
  revoke: ['name', 'renter', 'prev', 'reason'],
};

export interface BdnsxRecord {
  type: RecordType;
  fields: Record<string, string>;
}

export interface SignedRecord extends BdnsxRecord {
  address: string;
  signature: string; // base64 compact BSM signature
}

const utf8 = (s: string): number[] => Utils.toArray(s, 'utf8');
const str = (b: number[]): string => Utils.toUTF8(b);

/** The data pushes before the AIP section, in order. */
export function dataPushes(rec: BdnsxRecord): string[] {
  const order = FIELD_ORDER[rec.type];
  if (!order) throw new Error(`unknown record type: ${String(rec.type)}`);
  const extra = Object.keys(rec.fields).filter((k) => !order.includes(k));
  if (extra.length) throw new Error(`unknown field(s) for ${rec.type}: ${extra.join(',')}`);
  const pushes = [B_PREFIX, '', 'text/plain', 'utf-8', '|', MAP_PREFIX, 'SET', 'app', APP, 'type', rec.type];
  for (const k of order) {
    const v = rec.fields[k];
    if (v === undefined || v === '') continue; // optional fields are omitted
    if (v === '|') throw new Error(`field ${k} may not be a bare pipe`);
    pushes.push(k, v);
  }
  pushes.push('v', VERSION);
  return pushes;
}

/** AIP message: 0x6a (OP_RETURN) followed by every data push before the AIP pipe, concatenated. */
export function signingMessage(rec: BdnsxRecord): number[] {
  const out: number[] = [OP.OP_RETURN];
  for (const p of dataPushes(rec)) out.push(...utf8(p));
  return out;
}

export function signRecord(rec: BdnsxRecord, key: PrivateKey): SignedRecord {
  const signature = BSM.sign(signingMessage(rec), key, 'base64') as string;
  return { ...rec, fields: { ...rec.fields }, address: key.toAddress(), signature };
}

/** Recover the signer public key from a base64 compact BSM signature over msg. */
export function recoverSigner(msg: number[], sigB64: string): PublicKey {
  const raw = Utils.toArray(sigB64, 'base64');
  if (raw.length !== 65) throw new Error('bad compact signature length');
  const recovery = (raw[0] - 27) & 3;
  const sig = Signature.fromCompact(raw);
  return sig.RecoverPublicKey(recovery, new BigNumber(BSM.magicHash(msg)));
}

export function verifyRecord(rec: SignedRecord): boolean {
  try {
    const pub = recoverSigner(signingMessage(rec), rec.signature);
    if (pub.toAddress() !== rec.address) return false;
    return BSM.verify(signingMessage(rec), Signature.fromCompact(Utils.toArray(rec.signature, 'base64')), pub);
  } catch {
    return false;
  }
}

export function toScript(rec: SignedRecord): Script {
  const s = new Script();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const p of [...dataPushes(rec), '|', AIP_PREFIX, 'BITCOIN_ECDSA', rec.address, rec.signature]) {
    const b = utf8(p);
    if (b.length === 0) s.writeOpCode(OP.OP_0);
    else s.writeBin(b);
  }
  return s;
}

export function encodeHex(rec: SignedRecord): string {
  return toScript(rec).toHex();
}

/** Parse a locking script hex back into a signed record. Throws on malformed input. */
export function decodeHex(hex: string): SignedRecord {
  const bytes = Utils.toArray(hex, 'hex');
  let i = 0;
  if (bytes[i] === OP.OP_FALSE) i++;
  if (bytes[i] !== OP.OP_RETURN) throw new Error('not an OP_RETURN script');
  i++;
  // The SDK folds everything after OP_RETURN into one chunk, so parse the pushes by hand.
  const pushes: string[] = [];
  while (i < bytes.length) {
    const op = bytes[i++];
    let len: number;
    if (op === OP.OP_0) len = 0;
    else if (op < OP.OP_PUSHDATA1) len = op;
    else if (op === OP.OP_PUSHDATA1) len = bytes[i++];
    else if (op === OP.OP_PUSHDATA2) { len = bytes[i] | (bytes[i + 1] << 8); i += 2; }
    else if (op === OP.OP_PUSHDATA4) { len = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) + bytes[i + 3] * 0x1000000; i += 4; }
    else throw new Error(`unexpected opcode ${op} in data`);
    if (len === undefined || i + len > bytes.length) throw new Error('truncated push');
    pushes.push(str(bytes.slice(i, i + len)));
    i += len;
  }
  const aipAt = pushes.lastIndexOf(AIP_PREFIX);
  if (aipAt < 1 || pushes[aipAt - 1] !== '|') throw new Error('missing AIP section');
  const [, alg, address, signature] = pushes.slice(aipAt);
  if (alg !== 'BITCOIN_ECDSA' || !address || !signature) throw new Error('bad AIP section');
  const data = pushes.slice(0, aipAt - 1);
  if (data[0] !== B_PREFIX || data[4] !== '|' || data[5] !== MAP_PREFIX || data[6] !== 'SET') {
    throw new Error('not a B|MAP record');
  }
  const kv = data.slice(7);
  if (kv.length % 2) throw new Error('odd MAP key/value count');
  const map: Record<string, string> = {};
  for (let k = 0; k < kv.length; k += 2) map[kv[k]] = kv[k + 1];
  if (map.app !== APP) throw new Error('not a bdnsx record');
  if (map.v !== VERSION) throw new Error(`unsupported version ${map.v}`);
  const type = map.type as RecordType;
  if (!FIELD_ORDER[type]) throw new Error(`unknown type ${map.type}`);
  const fields: Record<string, string> = {};
  for (const k of FIELD_ORDER[type]) if (map[k] !== undefined) fields[k] = map[k];
  const rec: SignedRecord = { type, fields, address, signature };
  // Re-encode must round-trip exactly, otherwise fields were reordered or unknown keys added.
  if (dataPushes(rec).join('\u0000') !== data.join('\u0000')) throw new Error('non-canonical record');
  return rec;
}

// ---- Party signatures (renter proofs, transfer handover) ----

export function signMessage(message: string, key: PrivateKey): string {
  return BSM.sign(utf8(message), key, 'base64') as string;
}

/** True when sigB64 is a valid BSM signature over message by the given compressed pubkey hex. */
export function verifyMessage(message: string, sigB64: string, pubKeyHex: string): boolean {
  try {
    const pub = recoverSigner(utf8(message), sigB64);
    return pub.toString() === pubKeyHex.toLowerCase();
  } catch {
    return false;
  }
}

export const messages = {
  lease: (name: string, years: number, paymentTxid: string) => `bdnsx:lease:${name}:${years}:${paymentTxid}`,
  renew: (name: string, years: number, paymentTxid: string) => `bdnsx:renew:${name}:${years}:${paymentTxid}`,
  transferOut: (name: string, from: string, to: string, until: string) =>
    `bdnsx:transfer:${name}:${from}:${to}:${until}`,
  transferAccept: (name: string, from: string, to: string, until: string) =>
    `bdnsx:accept:${name}:${from}:${to}:${until}`,
  link: (domain: string, key: string) => `bdnsx:link:${domain}:${key}`,
};

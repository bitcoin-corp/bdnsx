import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeHex, encodeHex, messages, signMessage, signRecord, verifyMessage, verifyRecord, type BdnsxRecord } from './record.js';
import { testKey } from './testKeys.js';
import { buildVectors } from './genVectors.js';

const vault = testKey('vault');
const lease: BdnsxRecord = {
  type: 'lease',
  fields: { name: 'abc', renter: testKey('alice').toPublicKey().toString(), from: '2026-11-01T00:00:00Z', until: '2027-11-01T00:00:00Z', paid: 'a'.repeat(64), usd: '15.00' },
};

describe('record encode/decode', () => {
  it('round-trips and verifies', () => {
    const s = signRecord(lease, vault);
    const back = decodeHex(encodeHex(s));
    expect(back).toEqual(s);
    expect(verifyRecord(back)).toBe(true);
    expect(back.address).toBe(vault.toAddress());
  });
  it('detects tampering', () => {
    const s = signRecord(lease, vault);
    expect(verifyRecord({ ...s, fields: { ...s.fields, until: '2099-01-01T00:00:00Z' } })).toBe(false);
    expect(verifyRecord({ ...s, address: testKey('mallory').toAddress() })).toBe(false);
  });
  it('rejects unknown fields and non-bdnsx scripts', () => {
    expect(() => signRecord({ type: 'lease', fields: { evil: 'x' } }, vault)).toThrow(/unknown field/);
    expect(() => decodeHex('006a0568656c6c6f')).toThrow();
  });
  it('matches the committed spec vectors', () => {
    const committed = JSON.parse(readFileSync(new URL('../spec/vectors.json', import.meta.url), 'utf8'));
    expect(buildVectors()).toEqual(committed);
    for (const v of committed.vectors) {
      const d = decodeHex(v.scriptHex);
      expect(d).toEqual(v.record);
      expect(verifyRecord(d)).toBe(true);
    }
  });
});

describe('party messages', () => {
  it('verifies a renter signature by pubkey', () => {
    const alice = testKey('alice');
    const m = messages.lease('abc', 1, 'f'.repeat(64));
    const sig = signMessage(m, alice);
    expect(verifyMessage(m, sig, alice.toPublicKey().toString())).toBe(true);
    expect(verifyMessage(m, sig, testKey('bob').toPublicKey().toString())).toBe(false);
    expect(verifyMessage(m + 'x', sig, alice.toPublicKey().toString())).toBe(false);
    expect(verifyMessage(m, 'garbage', alice.toPublicKey().toString())).toBe(false);
  });
});

// Generates spec/vectors.json from TEST-ONLY keys. Run: pnpm vectors
import { writeFileSync } from 'node:fs';
import { encodeHex, signRecord, type BdnsxRecord } from './record.js';
import { testKey } from './testKeys.js';

export function buildVectors() {
  const vault = testKey('vault');
  const alice = testKey('alice').toPublicKey().toString();
  const bob = testKey('bob').toPublicKey().toString();
  const t1 = 'a'.repeat(64);
  const t2 = 'b'.repeat(64);
  const recs: BdnsxRecord[] = [
    { type: 'lease', fields: { name: 'abc', renter: alice, from: '2026-11-01T00:00:00Z', until: '2027-11-01T00:00:00Z', paid: t1, usd: '15.00' } },
    { type: 'renew', fields: { name: 'abc', renter: alice, until: '2028-11-01T00:00:00Z', paid: t2, usd: '15.00', prev: 'c'.repeat(64) } },
    { type: 'transfer', fields: { name: 'abc', renter: alice, to: bob, until: '2028-11-01T00:00:00Z', prev: 'd'.repeat(64), fromsig: 'SIG_A', tosig: 'SIG_B' } },
    { type: 'link', fields: { domain: 'example.com', key: bob, name: 'example' } },
    { type: 'revoke', fields: { name: 'abc', renter: bob, prev: 'e'.repeat(64), reason: 'brand claim upheld' } },
  ];
  return {
    note: 'TEST-ONLY vault key = sha256("bdnsx-test-only:vault"). Never fund it.',
    vaultAddress: vault.toAddress(),
    vectors: recs.map((r) => {
      const signed = signRecord(r, vault);
      return { record: signed, scriptHex: encodeHex(signed) };
    }),
  };
}

if (process.argv[1]?.endsWith('genVectors.js')) {
  writeFileSync(new URL('../spec/vectors.json', import.meta.url), JSON.stringify(buildVectors(), null, 2) + '\n');
  console.log('wrote spec/vectors.json');
}

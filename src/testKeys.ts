// TEST-ONLY keys derived from public strings. Never fund these. Used for spec vectors and tests.
import { Hash, PrivateKey, Utils } from '@bsv/sdk';

export function testKey(label: string): PrivateKey {
  return new PrivateKey(Utils.toHex(Hash.sha256(Utils.toArray(`bdnsx-test-only:${label}`, 'utf8'))), 'hex');
}

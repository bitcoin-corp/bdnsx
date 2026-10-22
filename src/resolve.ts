// name -> who answers for it right now (renter while a lease is live, else the owner/vault).
import { leaseStatus, normalizeName, type LeaseStatus } from './lease.js';
import type { Store } from './store.js';

export interface Resolution {
  name: string;
  holder: 'owner' | 'renter';
  key: string;
  until: string | null;
  status: LeaseStatus | 'owned';
  site?: string;
}

export interface ResolveDeps {
  store: Store;
  vaultHolds: (name: string) => Promise<boolean>;
  /** Vault identity public key (hex). Public; no secret needed to resolve. */
  vaultPubKey: string;
  now?: () => Date;
}

/** Returns null when bDNSX knows nothing about the name (not held by the vault, no lease). */
export async function resolveName(rawName: unknown, deps: ResolveDeps): Promise<Resolution | null> {
  const name = normalizeName(rawName);
  const now = (deps.now ?? (() => new Date()))();
  const lease = await deps.store.getLease(name);
  if (lease) {
    const status = leaseStatus(lease, now);
    // Grace: the renter keeps the name working for 30 days so a late renewal doesn't break their site.
    if (status === 'active' || status === 'grace') {
      const link = await deps.store.getLinkByKey(lease.renter);
      return { name, holder: 'renter', key: lease.renter, until: lease.until, status, ...(link?.site ? { site: link.site } : {}) };
    }
  }
  if (await deps.vaultHolds(name)) return { name, holder: 'owner', key: deps.vaultPubKey, until: null, status: 'owned' };
  return null;
}

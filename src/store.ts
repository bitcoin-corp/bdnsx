// Index cache. The chain is the source of truth; this is for speed.
// MemoryStore optionally persists to a JSON file. A Postgres store would implement the same interface
// against migrations/001_bdnsx_leases.sql.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SignedRecord } from './record.js';

export interface Lease {
  name: string;
  renter: string;
  from: string;
  until: string;
  annualUsd: number;
  priceSetAt: string;
  paidTxids: string[];
  recordTxid: string;
  records: { txid: string; record: SignedRecord; dryRun: boolean }[];
  revoked?: { at: string; reason: string };
}

export interface Link { domain: string; key: string; name?: string; site?: string; recordTxid: string; verifiedAt: string }

export interface Store {
  getLease(name: string): Promise<Lease | null>;
  putLease(lease: Lease): Promise<void>;
  allLeases(): Promise<Lease[]>;
  isPaymentUsed(txid: string): Promise<boolean>;
  markPaymentUsed(txid: string): Promise<void>;
  getLinkByKey(key: string): Promise<Link | null>;
  getLinkByDomain(domain: string): Promise<Link | null>;
  putLink(link: Link): Promise<void>;
  getHighWater(): Promise<number>;
  setHighWater(m: number): Promise<void>;
}

interface Snapshot { leases: Lease[]; links: Link[]; usedPayments: string[]; highWater: number }

export class MemoryStore implements Store {
  private leases = new Map<string, Lease>();
  private links = new Map<string, Link>();
  private used = new Set<string>();
  private highWater = 1;

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
      for (const l of s.leases) this.leases.set(l.name, l);
      for (const l of s.links) this.links.set(l.domain, l);
      for (const t of s.usedPayments) this.used.add(t);
      this.highWater = s.highWater ?? 1;
    }
  }

  private flush(): void {
    if (!this.file) return;
    const s: Snapshot = { leases: [...this.leases.values()], links: [...this.links.values()], usedPayments: [...this.used], highWater: this.highWater };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }

  async getLease(name: string) { return structuredClone(this.leases.get(name) ?? null); }
  async putLease(lease: Lease) { this.leases.set(lease.name, structuredClone(lease)); this.flush(); }
  async allLeases() { return structuredClone([...this.leases.values()]); }
  async isPaymentUsed(txid: string) { return this.used.has(txid); }
  async markPaymentUsed(txid: string) { this.used.add(txid); this.flush(); }
  async getLinkByKey(key: string) { return structuredClone([...this.links.values()].find((l) => l.key === key) ?? null); }
  async getLinkByDomain(domain: string) { return structuredClone(this.links.get(domain) ?? null); }
  async putLink(link: Link) { this.links.set(link.domain, structuredClone(link)); this.flush(); }
  async getHighWater() { return this.highWater; }
  async setHighWater(m: number) { this.highWater = Math.max(this.highWater, m); this.flush(); }
}

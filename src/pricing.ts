// Pure pricing functions. No I/O except loadPricing().
import { readFileSync } from 'node:fs';

export type Tier = '1-2' | '3' | '4' | '5+';

export interface AdoptionStep { min: number; multiplier: number }

export interface PricingConfig {
  version: number;
  currency: 'USD';
  buyUsd: Record<Tier, number>;
  leaseRatePerYear: number;
  adoption: { metric: string; steps: AdoptionStep[] };
  renewalCapPctPerYear: number;
  minYears: number;
  maxYears: number;
  /** e.g. {"3": 1} = pay 3 years, 1 is free. Empty = no prepay discount. */
  prepayFreeYears: Record<string, number>;
  paymentTolerancePct: number;
}

export function loadPricing(path = new URL('../config/pricing.json', import.meta.url)): PricingConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as PricingConfig;
  validatePricing(cfg);
  return cfg;
}

export function validatePricing(cfg: PricingConfig): void {
  const steps = cfg.adoption?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('adoption.steps required');
  if (steps[0].min !== 0) throw new Error('first adoption step must start at 0');
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].min <= steps[i - 1].min) throw new Error('adoption step mins must increase');
    if (steps[i].multiplier < steps[i - 1].multiplier) throw new Error('adoption multipliers must never decrease');
  }
  if (steps[0].multiplier < 1) throw new Error('multiplier below 1');
  for (const t of ['1-2', '3', '4', '5+'] as Tier[]) {
    if (!(cfg.buyUsd[t] > 0)) throw new Error(`buyUsd.${t} must be > 0`);
  }
  if (!(cfg.leaseRatePerYear > 0 && cfg.leaseRatePerYear <= 1)) throw new Error('leaseRatePerYear out of range');
  if (!(cfg.renewalCapPctPerYear >= 0)) throw new Error('renewalCapPctPerYear must be >= 0');
}

/** Length in Unicode code points (OpNS names may contain non-ASCII). */
export function nameLength(name: string): number {
  return [...name].length;
}

export function tierOf(name: string): Tier {
  const n = nameLength(name);
  if (n <= 0) throw new Error('empty name');
  if (n <= 2) return '1-2';
  if (n === 3) return '3';
  if (n === 4) return '4';
  return '5+';
}

/** Step multiplier for an adoption count. */
export function scheduleMultiplier(adoption: number, steps: AdoptionStep[]): number {
  if (!Number.isFinite(adoption) || adoption < 0) throw new Error('adoption must be a non-negative number');
  let m = steps[0].multiplier;
  for (const s of steps) if (adoption >= s.min) m = s.multiplier;
  return m;
}

/**
 * Effective multiplier: never decreases automatically. `highWater` is the highest multiplier
 * ever applied (persisted by the service); if adoption falls back, prices stay where they were.
 */
export function adoptionMultiplier(adoption: number, steps: AdoptionStep[], highWater = 1): number {
  return Math.max(scheduleMultiplier(adoption, steps), highWater);
}

export const cents = (usd: number): number => Math.round(usd * 100);
export const usd = (c: number): number => c / 100;

export function buyPriceUsd(name: string, cfg: PricingConfig, multiplier: number): number {
  return usd(cents(cfg.buyUsd[tierOf(name)] * multiplier));
}

/** Annual list price for a new lease (before any renewal cap). */
export function leaseAnnualUsd(name: string, cfg: PricingConfig, multiplier: number): number {
  return usd(cents(cfg.buyUsd[tierOf(name)] * cfg.leaseRatePerYear * multiplier));
}

export function checkYears(years: number, cfg: PricingConfig): void {
  if (!Number.isInteger(years) || years < cfg.minYears || years > cfg.maxYears) {
    throw new Error(`years must be an integer from ${cfg.minYears} to ${cfg.maxYears}`);
  }
}

export function paidYears(years: number, cfg: PricingConfig): number {
  const free = cfg.prepayFreeYears[String(years)] ?? 0;
  return Math.max(1, years - free);
}

/**
 * Annual price for a renewal: the current list price, but never more than
 * lastAnnual * (1 + cap)^(whole years since that price was set, at least 1).
 */
export function renewalAnnualUsd(listAnnual: number, lastAnnual: number, yearsSinceLastPrice: number, capPct: number): number {
  const y = Math.max(1, Math.floor(yearsSinceLastPrice));
  const capped = lastAnnual * Math.pow(1 + capPct / 100, y);
  return usd(Math.min(cents(listAnnual), cents(capped)));
}

export interface Quote {
  name: string;
  tier: Tier;
  years: number;
  paidYears: number;
  multiplier: number;
  buyUsd: number;
  listAnnualUsd: number;
  annualUsd: number;
  totalUsd: number;
  capped: boolean;
}

export interface QuoteInput {
  name: string;
  years: number;
  adoption: number;
  highWater?: number;
  /** For renewals: the renter's last annual price and how long ago it was set. */
  renewal?: { lastAnnualUsd: number; yearsSinceLastPrice: number };
}

export function quote(input: QuoteInput, cfg: PricingConfig): Quote {
  checkYears(input.years, cfg);
  const multiplier = adoptionMultiplier(input.adoption, cfg.adoption.steps, input.highWater ?? 1);
  const listAnnual = leaseAnnualUsd(input.name, cfg, multiplier);
  const annual = input.renewal
    ? renewalAnnualUsd(listAnnual, input.renewal.lastAnnualUsd, input.renewal.yearsSinceLastPrice, cfg.renewalCapPctPerYear)
    : listAnnual;
  const py = paidYears(input.years, cfg);
  return {
    name: input.name,
    tier: tierOf(input.name),
    years: input.years,
    paidYears: py,
    multiplier,
    buyUsd: buyPriceUsd(input.name, cfg, multiplier),
    listAnnualUsd: listAnnual,
    annualUsd: annual,
    totalUsd: usd(cents(annual) * py),
    capped: annual < listAnnual,
  };
}

/** USD → sats at a given BSV/USD rate, rounded up so the house never undercharges. */
export function usdToSats(amountUsd: number, bsvUsd: number): number {
  if (!(bsvUsd > 0)) throw new Error('bad BSV/USD rate');
  return Math.ceil((amountUsd / bsvUsd) * 1e8);
}

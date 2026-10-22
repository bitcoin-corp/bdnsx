import { describe, expect, it } from 'vitest';
import { adoptionMultiplier, buyPriceUsd, loadPricing, quote, renewalAnnualUsd, scheduleMultiplier, tierOf, usdToSats, validatePricing, type PricingConfig } from './pricing.js';

const cfg = loadPricing();

describe('tiers and base prices', () => {
  it('maps lengths to tiers', () => {
    expect(tierOf('a')).toBe('1-2');
    expect(tierOf('ab')).toBe('1-2');
    expect(tierOf('abc')).toBe('3');
    expect(tierOf('abcd')).toBe('4');
    expect(tierOf('abcde')).toBe('5+');
    expect(tierOf('日本')).toBe('1-2');
  });
  it('base buy prices', () => {
    expect(buyPriceUsd('ab', cfg, 1)).toBe(500);
    expect(buyPriceUsd('abc', cfg, 1)).toBe(100);
    expect(buyPriceUsd('abcd', cfg, 1)).toBe(50);
    expect(buyPriceUsd('abcdefg', cfg, 1)).toBe(10);
  });
  it('lease is 15% of buy per year', () => {
    expect(quote({ name: 'abc', years: 1, adoption: 0 }, cfg).annualUsd).toBe(15);
    expect(quote({ name: 'ab', years: 2, adoption: 0 }, cfg).totalUsd).toBe(150);
    expect(quote({ name: 'abcd', years: 1, adoption: 0 }, cfg).annualUsd).toBe(7.5);
    expect(quote({ name: 'abcde', years: 1, adoption: 0 }, cfg).annualUsd).toBe(1.5);
  });
  it('validates years', () => {
    expect(() => quote({ name: 'abc', years: 0, adoption: 0 }, cfg)).toThrow();
    expect(() => quote({ name: 'abc', years: 1.5, adoption: 0 }, cfg)).toThrow();
    expect(() => quote({ name: 'abc', years: 11, adoption: 0 }, cfg)).toThrow();
  });
});

describe('adoption multiplier', () => {
  const steps = cfg.adoption.steps;
  it('steps at thresholds', () => {
    expect(scheduleMultiplier(0, steps)).toBe(1);
    expect(scheduleMultiplier(249, steps)).toBe(1);
    expect(scheduleMultiplier(250, steps)).toBe(1.1);
    expect(scheduleMultiplier(1000, steps)).toBe(1.25);
    expect(scheduleMultiplier(9999, steps)).toBe(2);
    expect(scheduleMultiplier(1e6, steps)).toBe(3);
  });
  it('never decreases automatically (high-water mark)', () => {
    expect(adoptionMultiplier(10, steps, 1.5)).toBe(1.5);
    expect(adoptionMultiplier(5000, steps, 1.5)).toBe(2);
  });
  it('applies to quotes', () => {
    expect(quote({ name: 'abc', years: 1, adoption: 1000 }, cfg).annualUsd).toBe(18.75);
    expect(quote({ name: 'abc', years: 1, adoption: 0, highWater: 2 }, cfg).buyUsd).toBe(200);
  });
  it('rejects schedules that could decrease', () => {
    const bad: PricingConfig = { ...cfg, adoption: { metric: 'x', steps: [{ min: 0, multiplier: 1 }, { min: 10, multiplier: 0.9 }] } };
    expect(() => validatePricing(bad)).toThrow(/never decrease/);
    const unordered: PricingConfig = { ...cfg, adoption: { metric: 'x', steps: [{ min: 0, multiplier: 1 }, { min: 0, multiplier: 2 }] } };
    expect(() => validatePricing(unordered)).toThrow();
  });
});

describe('renewal cap', () => {
  it('caps at +25% per year over the last price', () => {
    expect(renewalAnnualUsd(45, 15, 1, 25)).toBe(18.75);
    expect(renewalAnnualUsd(45, 15, 2, 25)).toBe(23.44);
    expect(renewalAnnualUsd(16, 15, 1, 25)).toBe(16);
  });
  it('quote marks capped renewals', () => {
    const q = quote({ name: 'abc', years: 1, adoption: 10000, renewal: { lastAnnualUsd: 15, yearsSinceLastPrice: 1 } }, cfg);
    expect(q.listAnnualUsd).toBe(45);
    expect(q.annualUsd).toBe(18.75);
    expect(q.capped).toBe(true);
  });
  it('renewal never above list even if last price was higher', () => {
    expect(renewalAnnualUsd(15, 30, 1, 25)).toBe(15);
  });
});

describe('prepay and sats', () => {
  it('free years when configured', () => {
    const c = { ...cfg, prepayFreeYears: { '3': 1 } };
    expect(quote({ name: 'abc', years: 3, adoption: 0 }, c).totalUsd).toBe(30);
  });
  it('converts USD to sats rounding up', () => {
    expect(usdToSats(15, 50)).toBe(30_000_000);
    expect(usdToSats(1, 3)).toBe(33_333_334);
  });
});

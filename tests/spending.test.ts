import { describe, expect, it } from 'vitest';
import { accountValue, convert, defaultCurrency, FALLBACK_FX, mergePurchases, parseDate, parseMoney, parseNumber, parsePurchases, parseVp, summarize, VP_PRICE } from '../shared/spending';

describe('spending', () => {
  it('reads numbers in both separator styles', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('1,000')).toBe(1000);
    expect(parseNumber('9,99')).toBe(9.99);
  });

  it('reads VP, money and dates', () => {
    expect(parseVp('Purchased 5,350 VALORANT Points')).toBe(5350);
    expect(parseVp('VP 1000')).toBe(1000);
    expect(parseMoney('$9.99')).toEqual({ amount: 9.99, currency: 'USD' });
    expect(parseMoney('₹ 3,999.00')).toEqual({ amount: 3999, currency: 'INR' });
    expect(parseMoney('9,99 €')).toEqual({ amount: 9.99, currency: 'EUR' });
    expect(parseMoney('INR 799')).toEqual({ amount: 799, currency: 'INR' });
    expect(new Date(parseDate('Nov 14, 2026')!).getMonth()).toBe(10);
    expect(new Date(parseDate('03/04/2025')!).getMonth()).toBe(2);
    expect(new Date(parseDate('03/04/2025', true)!).getMonth()).toBe(3);
  });

  it('parses a table and a card layout, skips Radianite-only rows, flags refunds', () => {
    const table = ['Date\tItem\tAmount', 'Nov 14, 2026\t1,000 VP\t$9.99', '2026-10-02\t5,350 VP\t₹3,999', 'Sep 1, 2026\t1,000 Radianite Points\t$9.99', 'Aug 3, 2026\t475 VP\t$4.99\tRefunded'].join('\n');
    const t = parsePurchases(table, 'paste');
    expect(t.map((p) => p.vp)).toEqual([1000, 5350, 475]);
    expect(t[1]).toMatchObject({ amount: 3999, currency: 'INR' });
    expect(t[2].refunded).toBe(true);
    const cards = ['Purchase', 'November 14, 2026', '2,050 VALORANT Points', 'Paid $19.99', 'Purchase', 'October 1, 2026', '1,000 VALORANT Points', 'Paid $9.99'].join('\n');
    const c = parsePurchases(cards, 'riot');
    expect(c.map((p) => [p.vp, p.amount])).toEqual([[2050, 19.99], [1000, 9.99]]);
  });

  it('merging skips what is already there but keeps real same-day duplicates', () => {
    const a = parsePurchases('Nov 14, 2026 1,000 VP $9.99', 'paste');
    const twice = parsePurchases('Nov 14, 2026 1,000 VP $9.99\nNov 14, 2026 1,000 VP $9.99', 'paste');
    const first = mergePurchases([], a);
    expect(first.added).toBe(1);
    expect(mergePurchases(first.list, a).added).toBe(0);
    expect(mergePurchases(first.list, twice).added).toBe(1);
  });

  it('converts US cards on an Indian account and prices rows without an amount from VP', () => {
    const list = [
      { id: '1', at: Date.parse('2026-01-02'), vp: 1000, amount: 10, currency: 'USD', source: 'manual' as const },
      { id: '2', at: Date.parse('2026-01-03'), vp: 1000, amount: 799, currency: 'INR', source: 'manual' as const },
      { id: '3', at: Date.parse('2025-01-03'), vp: 1000, source: 'manual' as const },
      { id: '4', at: Date.parse('2025-01-04'), vp: 1000, amount: 5, currency: 'USD', source: 'manual' as const, refunded: true },
    ];
    const s = summarize(list, 'INR', FALLBACK_FX);
    expect(s.count).toBe(3);
    expect(s.converted).toBe(1);
    expect(s.pricedFromVp).toBe(1);
    expect(s.spent).toBeCloseTo(10 * FALLBACK_FX.rates.INR + 799 + 799);
    expect(convert(94.25, 'INR', 'USD', FALLBACK_FX)).toBeCloseTo(1);
  });

  it('account value takes Battle Passes out and divides by three; currency follows the region', () => {
    const v = accountValue(300, 2, 'USD', 'purchases');
    expect(v.battlePassSpend).toBeCloseTo(2 * 1000 * VP_PRICE.USD.perVp);
    expect(v.value).toBeCloseTo((300 - v.battlePassSpend) / 3);
    expect(defaultCurrency('ap')).toBe('INR');
    expect(defaultCurrency('kr')).toBe('INR');
    expect(defaultCurrency('na')).toBe('USD');
    expect(defaultCurrency(undefined)).toBe('USD');
  });
});

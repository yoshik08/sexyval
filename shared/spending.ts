// VP purchase history, spend estimates and an account value. Riot has no API for VP purchases: they live on
// Riot's support site ("Purchase history"), so purchases come from that page (scanned or pasted) or are added
// by hand. The estimate from your collection needs nothing. Pure: no I/O, no clocks.

export type Currency = 'USD' | 'INR';
export const DISPLAY_CURRENCIES: Currency[] = ['USD', 'INR'];

export interface VpPurchase {
  id: string;
  /** ms epoch (midnight local when the source had no time). */
  at: number;
  vp: number;
  /** What was paid, in `currency` (ISO 4217). */
  amount?: number;
  currency?: string;
  note?: string;
  source: 'manual' | 'riot' | 'paste';
  /** Refunded purchases stay listed and leave every total. */
  refunded?: boolean;
}

/** USD -> X rates (ECB via Frankfurter), with the date they're from. */
export interface FxRates {
  date: string;
  /** 1 USD = rates[X] X. USD itself is 1. */
  rates: Record<string, number>;
  fallback?: boolean;
}

/** Used until live rates load (Nov 2026 levels); flagged in the UI. */
export const FALLBACK_FX: FxRates = {
  date: '2026-11-13',
  rates: { USD: 1, INR: 94.25, EUR: 0.905, GBP: 0.756, CAD: 1.426, AUD: 1.474, SGD: 1.288, PHP: 63.8, IDR: 18245, JPY: 160, KRW: 1337, BRL: 5.66, TRY: 50.4, MYR: 4.09, THB: 33.9, HKD: 7.85, MXN: 18.6, NZD: 1.81, PLN: 3.99, SEK: 10.05, NOK: 9.56, DKK: 6.76, CHF: 0.838, ZAR: 16.96, CNY: 6.67 },
  fallback: true,
};

export function convert(amount: number, from: string, to: string, fx: FxRates): number | undefined {
  const a = from === 'USD' ? 1 : fx.rates[from];
  const b = to === 'USD' ? 1 : fx.rates[to];
  if (!a || !b) return undefined;
  return (amount / a) * b;
}

/**
 * What one VP costs on the 1,000 VP pack (bonus VP left out), per display currency: US store for USD, India
 * store for INR. Used only for the collection-based estimate, which has no real prices to go on.
 */
export const VP_PRICE: Record<Currency, { perVp: number; pack: string }> = {
  USD: { perVp: 9.99 / 1000, pack: '1,000 VP = $9.99 (US store)' },
  INR: { perVp: 799 / 1000, pack: '1,000 VP = ₹799 (India store)' },
};

/** A premium Battle Pass costs 1,000 VP. */
export const BATTLE_PASS_VP = 1000;
/** Rule of thumb for what an account sells for: a third of what went into it. */
export const ACCOUNT_VALUE_DIVISOR = 3;

/** Asia-Pacific and Korea shards default to rupees, everywhere else to dollars. */
export function defaultCurrency(region?: string | null): Currency {
  return region === 'ap' || region === 'kr' ? 'INR' : 'USD';
}

export function fmtMoney(v: number, c: string): string {
  try {
    return new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: c, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${c} ${v.toFixed(2)}`;
  }
}

// ---------------- parsing Riot's purchase history (scanned page text or a paste) ----------------

const SYMBOLS: [RegExp, string][] = [
  [/R\$/, 'BRL'],
  [/A\$|AU\$/, 'AUD'],
  [/C\$|CA\$/, 'CAD'],
  [/S\$|SG\$/, 'SGD'],
  [/HK\$/, 'HKD'],
  [/NZ\$/, 'NZD'],
  [/MX\$/, 'MXN'],
  [/US\$|\$/, 'USD'],
  [/₹|Rs\.?(?=\s?\d)/, 'INR'],
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/₱/, 'PHP'],
  [/₩/, 'KRW'],
  [/¥|円/, 'JPY'],
  [/₺/, 'TRY'],
  [/Rp(?=\s?\d)/, 'IDR'],
  [/RM(?=\s?\d)/, 'MYR'],
  [/฿/, 'THB'],
  [/zł/, 'PLN'],
];
const CODES = 'USD|INR|EUR|GBP|CAD|AUD|SGD|PHP|IDR|JPY|KRW|BRL|TRY|MYR|THB|HKD|MXN|NZD|PLN|SEK|NOK|DKK|CHF|ZAR|CNY';
// Grouped thousands ("1,000", "1 000") or plain digits; never starts or stops inside a longer number.
const NUM = String.raw`(?<!\d)(?:\d{1,3}(?:[,\s.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\d)`;

/** "1,234.56" / "1.234,56" / "1 234" -> number. */
export function parseNumber(s: string): number {
  const t = s.replace(/\s/g, '');
  const lastSep = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
  // A separator followed by exactly 1-2 digits at the end is the decimal point.
  if (lastSep >= 0 && t.length - lastSep - 1 <= 2) {
    return Number(t.slice(0, lastSep).replace(/[.,]/g, '') + '.' + t.slice(lastSep + 1));
  }
  return Number(t.replace(/[.,]/g, ''));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** First date in a line: 2026-11-14, 11/14/2026, 14.11.2026, Nov 14, 2026, 14 Nov 2026. Local midnight. */
export function parseDate(line: string, dayFirst = false): number | undefined {
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(line);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(line);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return new Date(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]).getTime();
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/i.exec(line);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return new Date(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]).getTime();
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(line);
  if (m) {
    let [d, mo] = dayFirst ? [+m[1], +m[2]] : [+m[2], +m[1]];
    if (mo > 12) [d, mo] = [mo, d];
    return new Date(+m[3], mo - 1, d).getTime();
  }
  return undefined;
}

/** VP in a line: "1,000 VP", "1000 VALORANT Points", "VP 1,000". */
export function parseVp(line: string): number | undefined {
  const m = new RegExp(String.raw`(${NUM})\s*(?:VP\b|VALORANT\s*Points|Valorant\s*Points)`, 'i').exec(line) ?? new RegExp(String.raw`\bVP\s*(${NUM})`, 'i').exec(line);
  if (!m) return undefined;
  const v = Math.round(parseNumber(m[1]));
  return v > 0 && v < 1_000_000 ? v : undefined;
}

/** Money in a line: "$9.99", "₹ 799", "INR 799.00", "9,99 €", "USD 19.99". */
export function parseMoney(line: string): { amount: number; currency: string } | undefined {
  const code = new RegExp(String.raw`\b(${CODES})\s*(${NUM})|(${NUM})\s*(${CODES})\b`).exec(line);
  if (code) {
    const amount = parseNumber(code[2] ?? code[3]);
    if (amount > 0) return { amount, currency: code[1] ?? code[4] };
  }
  for (const [re, cur] of SYMBOLS) {
    const before = new RegExp(String.raw`(?:${re.source})\s?(${NUM})`).exec(line);
    const after = new RegExp(String.raw`(${NUM})\s?(?:${re.source})`).exec(line);
    const hit = before ?? after;
    if (hit) {
      const amount = parseNumber(hit[1]);
      if (amount > 0) return { amount, currency: cur };
    }
  }
  return undefined;
}

/**
 * Purchase rows from page text. A table comes through as one row per line; card layouts split a purchase
 * over several lines, so a row with a date and VP also takes the money from the next couple of lines.
 * Lines that mention Radianite or Kingdom Credits only aren't VP purchases.
 */
export function parsePurchases(text: string, source: VpPurchase['source'], dayFirst = false): VpPurchase[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t+/g, '  ').trim())
    .filter(Boolean);
  const out: VpPurchase[] = [];
  const used = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    // A window of up to 4 lines starting here, used only as far as it needs to be.
    let joined = lines[i];
    let end = i;
    let vp = parseVp(joined);
    let at = parseDate(joined, dayFirst);
    let money = parseMoney(joined.replace(/(\d)\s*(?:VP\b|VALORANT\s*Points)/gi, '$1 '));
    while ((!vp || !at || !money) && end < i + 3 && end + 1 < lines.length) {
      const next = lines[end + 1];
      // The next purchase's date starts a new row.
      if (at && parseDate(next, dayFirst) && vp) break;
      end++;
      joined += '  ' + next;
      vp ??= parseVp(next);
      at ??= parseDate(next, dayFirst);
      money ??= parseMoney(next.replace(/(\d)\s*(?:VP\b|VALORANT\s*Points)/gi, '$1 '));
    }
    if (!vp || !at) continue;
    if (/radianite|kingdom credit/i.test(joined) && !/VP\b|VALORANT\s*Points/i.test(joined)) continue;
    for (let k = i; k <= end; k++) used.add(k);
    out.push({
      id: `${source}-${at}-${vp}-${money ? `${money.amount}${money.currency}` : 'x'}-${out.length}`,
      at,
      vp,
      amount: money?.amount,
      currency: money?.currency,
      source,
      refunded: /refund|chargeback|reversed/i.test(joined) || undefined,
    });
  }
  return out;
}

/** Same day, VP and amount = the same purchase (a re-scan or a second paste). */
export function mergePurchases(existing: VpPurchase[], incoming: VpPurchase[]): { list: VpPurchase[]; added: number } {
  const key = (p: VpPurchase) => `${new Date(p.at).toDateString()}|${p.vp}|${p.amount ?? ''}|${p.currency ?? ''}`;
  const counts = new Map<string, number>();
  for (const p of existing) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  const seenIncoming = new Map<string, number>();
  const list = [...existing];
  let added = 0;
  for (const p of incoming) {
    const k = key(p);
    const n = (seenIncoming.get(k) ?? 0) + 1;
    seenIncoming.set(k, n);
    // Two identical purchases on one day are both kept, as long as there are that many in the new data.
    if (n <= (counts.get(k) ?? 0)) continue;
    list.push({ ...p, id: `${p.id}-${Date.now().toString(36)}${added}` });
    added++;
  }
  list.sort((a, b) => b.at - a.at);
  return { list, added };
}

// ---------------- totals ----------------

export interface SpendSummary {
  currency: Currency;
  /** Purchases counted (not refunded). */
  count: number;
  vp: number;
  /** Paid, converted to `currency`. Purchases without an amount are priced from their VP. */
  spent: number;
  /** Purchases whose amount came from VP_PRICE (no amount recorded). */
  pricedFromVp: number;
  /** Converted from another currency (e.g. a US VP card on an Indian account). */
  converted: number;
  byYear: { year: number; spent: number; vp: number }[];
}

export function summarize(list: VpPurchase[], currency: Currency, fx: FxRates): SpendSummary {
  const live = list.filter((p) => !p.refunded);
  let spent = 0;
  let pricedFromVp = 0;
  let converted = 0;
  const years = new Map<number, { spent: number; vp: number }>();
  for (const p of live) {
    let v: number | undefined;
    if (p.amount != null && p.currency) {
      v = p.currency === currency ? p.amount : convert(p.amount, p.currency, currency, fx);
      if (v != null && p.currency !== currency) converted++;
    }
    if (v == null) {
      v = p.vp * VP_PRICE[currency].perVp;
      pricedFromVp++;
    }
    spent += v;
    const y = new Date(p.at).getFullYear();
    const e = years.get(y) ?? { spent: 0, vp: 0 };
    e.spent += v;
    e.vp += p.vp;
    years.set(y, e);
  }
  return {
    currency,
    count: live.length,
    vp: live.reduce((s, p) => s + p.vp, 0),
    spent,
    pricedFromVp,
    converted,
    byYear: [...years.entries()].sort((a, b) => b[0] - a[0]).map(([year, e]) => ({ year, ...e })),
  };
}

export interface AccountValue {
  /** Money behind the account, Battle Passes taken out. */
  base: number;
  battlePassSpend: number;
  value: number;
  /** Where `base` came from. */
  basis: 'purchases' | 'collection';
}

/** Account value = (spent − Battle Pass spend) / 3. Battle Passes are bought with VP, so they come out of the VP spend. */
export function accountValue(spent: number, battlePasses: number, currency: Currency, basis: AccountValue['basis']): AccountValue {
  const battlePassSpend = battlePasses * BATTLE_PASS_VP * VP_PRICE[currency].perVp;
  const base = Math.max(0, spent - battlePassSpend);
  return { base, battlePassSpend, value: base / ACCOUNT_VALUE_DIVISOR, basis };
}

/** Collection estimate: VP of every owned skin with a known or approximate price (contract rewards and free skins left out). */
export function collectionVp(owned: { id: string; vp?: number; reward: boolean }[]): { vp: number; priced: number; unpriced: number } {
  let vp = 0;
  let priced = 0;
  let unpriced = 0;
  for (const s of owned) {
    if (s.reward) continue;
    if (s.vp && s.vp > 0) {
      vp += s.vp;
      priced++;
    } else unpriced++;
  }
  return { vp, priced, unpriced };
}

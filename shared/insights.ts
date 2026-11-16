// Performance Intelligence: evidence-backed statements from your own stored matches (shared/warehouse.ts).
// Deterministic and pure. Every insight carries its sample size, the numbers compared and the method, and
// is only produced when the test below says the difference is unlikely to be noise. Nothing here models
// Riot's hidden MMR; RR figures are Riot's own competitive updates.
import type { WRow } from './warehouse';

export interface Insight {
  id: string;
  kind: 'strength' | 'weakness' | 'trend-up' | 'trend-down' | 'info';
  title: string;
  detail: string;
  /** Matches (or rounds / duels) behind it. */
  n: number;
  unit: 'matches' | 'rounds' | 'duels' | 'sessions';
  confidence: 'medium' | 'high';
  method: string;
}

export interface InsightReport {
  eligible: number;
  insights: Insight[];
  /** Why there isn't more (not enough data for a category). */
  notes: string[];
}

const Z95 = 1.96;

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

/** Two-proportion z statistic (pooled). */
export function twoProp(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (k1 / n1 - k2 / n2) / se : 0;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a: number[]) => {
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};

/** Two-sided 95% critical t for Welch df (table, conservative between rows). */
export function tCrit(df: number): number {
  const t: [number, number][] = [[5, 2.571], [10, 2.228], [15, 2.131], [20, 2.086], [30, 2.042], [60, 2.0], [120, 1.98]];
  for (const [d, v] of t) if (df <= d) return v;
  return Z95;
}

/** Welch t-test; returns t and whether |t| beats the 95% critical value. */
export function welch(a: number[], b: number[]): { t: number; significant: boolean } {
  if (a.length < 2 || b.length < 2) return { t: 0, significant: false };
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return { t: 0, significant: false };
  const t = (mean(a) - mean(b)) / se;
  const df = (va + vb) ** 2 / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  return { t, significant: Math.abs(t) > tCrit(df) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const conf = (n: number, big: number): Insight['confidence'] => (n >= big ? 'high' : 'medium');

export interface InsightOptions {
  mapName?: (id?: string) => string | undefined;
  agentName?: (id?: string) => string | undefined;
  /** Minimum matches for a map/agent verdict. */
  minGroup?: number;
}

export const MIN_ELIGIBLE = 10;
const SESSION_GAP_MS = 2 * 3_600_000;

/** rows: one account, any order; only decided round-based matches count. */
export function computeInsights(all: WRow[], o: InsightOptions = {}): InsightReport {
  const rows = all.filter((r) => (r.result === 'W' || r.result === 'L') && r.rounds > 0).sort((a, b) => b.t - a.t);
  const notes: string[] = [];
  const out: Insight[] = [];
  const mapName = (id?: string) => o.mapName?.(id) ?? 'this map';
  const agentName = (id?: string) => o.agentName?.(id) ?? 'this agent';
  const minGroup = o.minGroup ?? 8;
  if (rows.length < MIN_ELIGIBLE) {
    return { eligible: rows.length, insights: [], notes: [`Insights need at least ${MIN_ELIGIBLE} finished matches; ${rows.length} stored so far.`] };
  }
  const wins = rows.filter((r) => r.result === 'W').length;
  const base = wins / rows.length;

  // Map and agent win rate: the Wilson interval must exclude your overall win rate.
  const groups = (key: (r: WRow) => string | undefined, label: (id?: string) => string, what: 'map' | 'agent') => {
    const m = new Map<string, WRow[]>();
    for (const r of rows) {
      const k = key(r);
      if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    let thin = 0;
    for (const [k, rs] of m) {
      if (rs.length < minGroup) {
        thin++;
        continue;
      }
      const w = rs.filter((r) => r.result === 'W').length;
      const [lo, hi] = wilson(w, rs.length);
      const name = label(k);
      if (lo > base)
        out.push({ id: `${what}-strong-${k}`, kind: 'strength', title: `${name} is a strength`, detail: `You win ${pct(w / rs.length)} on ${name} (${w}–${rs.length - w}) vs ${pct(base)} overall. 95% range ${pct(lo)}–${pct(hi)}.`, n: rs.length, unit: 'matches', confidence: conf(rs.length, 20), method: 'Wilson 95% interval on match win rate; shown only when the whole interval is above your overall win rate.' });
      else if (hi < base)
        out.push({ id: `${what}-weak-${k}`, kind: 'weakness', title: `${name} is costing you games`, detail: `You win ${pct(w / rs.length)} on ${name} (${w}–${rs.length - w}) vs ${pct(base)} overall. 95% range ${pct(lo)}–${pct(hi)}.`, n: rs.length, unit: 'matches', confidence: conf(rs.length, 20), method: 'Wilson 95% interval on match win rate; shown only when the whole interval is below your overall win rate.' });
    }
    if (thin) notes.push(`${thin} ${what}${thin === 1 ? '' : 's'} with fewer than ${minGroup} matches: not enough to judge.`);
  };
  groups((r) => r.map, mapName, 'map');
  groups((r) => r.agent, agentName, 'agent');

  // Attack vs defense round win rate.
  const sided = rows.filter((r) => r.atk && r.def);
  const atk = sided.reduce((s, r) => [s[0] + r.atk![0], s[1] + r.atk![1]], [0, 0]);
  const def = sided.reduce((s, r) => [s[0] + r.def![0], s[1] + r.def![1]], [0, 0]);
  if (atk[1] >= 100 && def[1] >= 100) {
    const z = twoProp(atk[0], atk[1], def[0], def[1]);
    if (Math.abs(z) >= Z95) {
      const better = z > 0 ? 'attack' : 'defense';
      out.push({ id: 'side', kind: 'info', title: `You're stronger on ${better}`, detail: `Round win rate: attack ${pct(atk[0] / atk[1])} (${atk[1]} rounds), defense ${pct(def[0] / def[1])} (${def[1]} rounds).`, n: atk[1] + def[1], unit: 'rounds', confidence: conf(atk[1] + def[1], 600), method: 'Two-proportion z-test on rounds won per side (|z| ≥ 1.96). Sides from the round number: Red attacks rounds 1–12.' });
    }
  } else notes.push('Attack/defense needs 100+ rounds on each side in competitive, unrated or premier.');

  // Map × side trend: your last 15 matches on a map vs the ones before (the spec's example).
  const byMap = new Map<string, WRow[]>();
  for (const r of sided) if (r.map) (byMap.get(r.map) ?? byMap.set(r.map, []).get(r.map)!).push(r);
  for (const [map, rs] of byMap) {
    if (rs.length < 30) continue;
    const recent = rs.slice(0, 15);
    const before = rs.slice(15);
    for (const side of ['def', 'atk'] as const) {
      const a = recent.reduce((s, r) => [s[0] + r[side]![0], s[1] + r[side]![1]], [0, 0]);
      const b = before.reduce((s, r) => [s[0] + r[side]![0], s[1] + r[side]![1]], [0, 0]);
      const z = twoProp(a[0], a[1], b[0], b[1]);
      if (Math.abs(z) < Z95) continue;
      const sideName = side === 'def' ? 'defense' : 'attack';
      out.push({ id: `trend-${map}-${side}`, kind: z < 0 ? 'trend-down' : 'trend-up', title: `Your ${sideName} on ${mapName(map)} has ${z < 0 ? 'declined' : 'improved'}`, detail: `Over your last 15 eligible matches on ${mapName(map)} you won ${pct(a[0] / a[1])} of ${sideName} rounds (${a[1]}), vs ${pct(b[0] / b[1])} in the ${before.length} before (${b[1]}).`, n: a[1] + b[1], unit: 'rounds', confidence: conf(before.length, 30), method: 'Two-proportion z-test, last 15 matches on the map vs all earlier ones (|z| ≥ 1.96).' });
    }
  }

  // Opening duels (first kill vs first death), matches stored by 1.7+ only.
  const duelRows = rows.filter((r) => r.fk != null && r.fd != null);
  const fk = duelRows.reduce((s, r) => s + (r.fk ?? 0), 0);
  const fd = duelRows.reduce((s, r) => s + (r.fd ?? 0), 0);
  if (fk + fd >= 30) {
    const [lo, hi] = wilson(fk, fk + fd);
    if (lo > 0.5 || hi < 0.5)
      out.push({ id: 'duels', kind: lo > 0.5 ? 'strength' : 'weakness', title: lo > 0.5 ? 'You win your opening duels' : 'You lose more opening duels than you win', detail: `First kills ${fk}, first deaths ${fd}: ${pct(fk / (fk + fd))} of the opening duels you took part in. 95% range ${pct(lo)}–${pct(hi)}.`, n: fk + fd, unit: 'duels', confidence: conf(fk + fd, 100), method: 'Wilson 95% interval on first kills ÷ (first kills + first deaths); shown when it excludes 50%.' });
  } else notes.push(`Opening duels need 30+ recorded (${fk + fd} so far; first deaths are stored for matches saved by SexyVal 1.7 or later).`);

  // Form: ACS of the last 15 vs the 30 before.
  if (rows.length >= 45) {
    const a = rows.slice(0, 15).map((r) => r.acs);
    const b = rows.slice(15, 45).map((r) => r.acs);
    const w = welch(a, b);
    if (w.significant)
      out.push({ id: 'form', kind: w.t > 0 ? 'trend-up' : 'trend-down', title: w.t > 0 ? 'Your recent form is up' : 'Your recent form is down', detail: `Average ACS ${Math.round(mean(a))} over your last 15 matches vs ${Math.round(mean(b))} over the 30 before.`, n: 45, unit: 'matches', confidence: 'medium', method: 'Welch t-test on ACS, last 15 vs previous 30 matches (95%).' });
  } else notes.push('Form trend needs 45 matches.');

  // Session consistency: first two games of a session vs game 4 onwards.
  const sessions: WRow[][] = [];
  for (const r of [...rows].reverse()) {
    const cur = sessions[sessions.length - 1];
    if (cur && r.t - cur[cur.length - 1].t < SESSION_GAP_MS) cur.push(r);
    else sessions.push([r]);
  }
  const long = sessions.filter((s) => s.length >= 4);
  if (long.length >= 5) {
    const early = long.flatMap((s) => s.slice(0, 2).map((r) => r.acs));
    const late = long.flatMap((s) => s.slice(3).map((r) => r.acs));
    const w = welch(late, early);
    if (w.significant)
      out.push({ id: 'session', kind: w.t < 0 ? 'weakness' : 'strength', title: w.t < 0 ? 'You fade in long sessions' : 'You warm up in long sessions', detail: `Average ACS ${Math.round(mean(early))} in the first two games of a session vs ${Math.round(mean(late))} from game 4 on (${long.length} sessions of 4+ games).`, n: long.length, unit: 'sessions', confidence: conf(long.length, 15), method: 'Sessions split at 2 h breaks; Welch t-test on ACS, games 1–2 vs 4+ (95%).' });
  } else notes.push('Session consistency needs 5 sessions of 4+ games.');

  // RR: Riot's own numbers, last 20 ranked matches with an update.
  const ranked = rows.filter((r) => r.rr != null).slice(0, 20);
  if (ranked.length >= 10) {
    const gains = ranked.filter((r) => r.result === 'W').map((r) => r.rr!);
    const losses = ranked.filter((r) => r.result === 'L').map((r) => r.rr!);
    if (gains.length >= 3 && losses.length >= 3) {
      const g = mean(gains);
      const l = mean(losses);
      out.push({ id: 'rr', kind: 'info', title: g + l >= 0 ? 'Your wins are worth more RR than your losses cost' : 'Your losses cost more RR than your wins give', detail: `Last ${ranked.length} ranked: +${Math.round(g)} RR per win, ${Math.round(l)} RR per loss, ${ranked.reduce((s, r) => s + r.rr!, 0) >= 0 ? '+' : ''}${ranked.reduce((s, r) => s + r.rr!, 0)} RR in total.`, n: ranked.length, unit: 'matches', confidence: 'high', method: 'Averages of Riot’s competitive updates (RR earned) for the matches stored here. Exact figures, not an estimate.' });
    }
  }

  const order: Record<Insight['kind'], number> = { 'trend-down': 0, weakness: 1, 'trend-up': 2, strength: 3, info: 4 };
  out.sort((a, b) => order[a.kind] - order[b.kind] || b.n - a.n);
  return { eligible: rows.length, insights: out, notes };
}

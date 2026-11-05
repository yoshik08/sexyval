import type { MatchRow } from './features';

export interface GroupStat {
  key: string;
  name: string;
  icon?: string;
  games: number;
  wins: number;
  winRate: number;
  kd: number;
  acs: number;
}

function group(rows: MatchRow[], keyOf: (r: MatchRow) => string | undefined, nameOf: (r: MatchRow) => string, iconOf?: (r: MatchRow) => string | undefined): GroupStat[] {
  const m = new Map<string, { name: string; icon?: string; games: number; wins: number; decided: number; k: number; d: number; acs: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const g = m.get(key) ?? { name: nameOf(r), icon: iconOf?.(r), games: 0, wins: 0, decided: 0, k: 0, d: 0, acs: 0 };
    g.games++;
    if (r.result === 'W' || r.result === 'L') g.decided++;
    if (r.result === 'W') g.wins++;
    g.k += r.kills;
    g.d += r.deaths;
    g.acs += r.acs;
    m.set(key, g);
  }
  return [...m.entries()]
    .map(([key, g]) => ({
      key,
      name: g.name,
      icon: g.icon,
      games: g.games,
      wins: g.wins,
      winRate: g.decided ? Math.round((g.wins / g.decided) * 100) : 0,
      kd: g.d ? Math.round((g.k / g.d) * 100) / 100 : g.k,
      acs: Math.round(g.acs / g.games),
    }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
}

/** Per-agent / per-map win rate and chronological K/D + ACS trend. */
export function analyzeMatches(rows: MatchRow[]) {
  const chrono = [...rows].sort((a, b) => a.startTime - b.startTime);
  return {
    byAgent: group(rows, (r) => r.agentId, (r) => r.agentName ?? 'Unknown', (r) => r.agentIcon),
    byMap: group(rows, (r) => r.mapId, (r) => r.mapName ?? 'Unknown'),
    trend: chrono.map((r) => ({ t: r.startTime, kd: r.deaths ? Math.round((r.kills / r.deaths) * 100) / 100 : r.kills, acs: r.acs, result: r.result })),
  };
}

/** Highest competitive tier seen across all seasons in an MMR response. */
export function peakTier(mmr: any): number {
  let peak = 0;
  const queues = mmr?.QueueSkills ?? {};
  for (const q of Object.values<any>(queues)) {
    for (const s of Object.values<any>(q?.SeasonalInfoBySeasonID ?? {})) {
      peak = Math.max(peak, Number(s?.CompetitiveTier) || 0);
      for (const t of Object.keys(s?.WinsByTier ?? {})) peak = Math.max(peak, Number(t) || 0);
    }
  }
  return peak;
}

/** Current rank/RR for a season, falling back to LatestCompetitiveUpdate. */
export function seasonRank(mmr: any, seasonId?: string): { tier: number; rr: number; leaderboardRank: number } {
  const comp = mmr?.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
  const s = seasonId ? comp[seasonId] : undefined;
  if (s) return { tier: Number(s.CompetitiveTier) || 0, rr: Number(s.RankedRating) || 0, leaderboardRank: Number(s.LeaderboardRank) || 0 };
  const l = mmr?.LatestCompetitiveUpdate;
  return { tier: Number(l?.TierAfterUpdate) || 0, rr: Number(l?.RankedRatingAfterUpdate) || 0, leaderboardRank: 0 };
}

export interface HistoryFilter {
  queue?: string;
  agentId?: string;
  mapId?: string;
  result?: 'W' | 'L' | 'D';
  from?: number;
  to?: number;
}

export function filterMatches(rows: MatchRow[], f: HistoryFilter): MatchRow[] {
  return rows.filter(
    (r) =>
      (!f.queue || r.queueId === f.queue) &&
      (!f.agentId || r.agentId === f.agentId) &&
      (!f.mapId || r.mapId === f.mapId) &&
      (!f.result || r.result === f.result) &&
      (!f.from || r.startTime >= f.from) &&
      (!f.to || r.startTime <= f.to),
  );
}

/**
 * Current competitive rank for an act, and the peak across every act with the act it was reached in.
 * Peak per act = the higher of its final CompetitiveTier and any tier it won games at (WinsByTier).
 * `currentTier` 0 means no rank this act (Unrated). Only the competitive queue counts.
 */
export function currentAndPeak(mmr: any, actId?: string): { currentTier: number; rr: number; peakTier: number; peakSeasonId?: string } {
  const seasons: Record<string, any> = mmr?.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
  let peakTier = 0;
  let peakSeasonId: string | undefined;
  for (const [id, s] of Object.entries(seasons)) {
    let t = Number(s?.CompetitiveTier) || 0;
    for (const k of Object.keys(s?.WinsByTier ?? {})) if ((Number(s.WinsByTier[k]) || 0) > 0) t = Math.max(t, Number(k) || 0);
    if (t > peakTier) {
      peakTier = t;
      peakSeasonId = String(s?.SeasonID ?? id).toLowerCase();
    }
  }
  let currentTier = 0;
  let rr = 0;
  const latest = mmr?.LatestCompetitiveUpdate;
  const cur = actId ? Object.entries(seasons).find(([id, s]) => String(s?.SeasonID ?? id).toLowerCase() === actId.toLowerCase())?.[1] : undefined;
  if (cur) {
    currentTier = Number(cur.CompetitiveTier) || 0;
    rr = Number(cur.RankedRating) || 0;
  } else if (latest && (!actId || String(latest.SeasonID ?? '').toLowerCase() === actId.toLowerCase())) {
    currentTier = Number(latest.TierAfterUpdate) || 0;
    rr = Number(latest.RankedRatingAfterUpdate) || 0;
  }
  if (currentTier <= 2) {
    currentTier = 0;
    rr = 0;
  }
  if (peakTier <= 2) {
    peakTier = 0;
    peakSeasonId = undefined;
  }
  return { currentTier, rr, peakTier, peakSeasonId };
}

/** Act id -> "Episode 9 Act III" / "Season 2025 Act I" using valorant-api seasons (act + its parent). */
export function actLabel(seasons: { id: string; name?: string; parentId?: string }[], actId?: string): string | undefined {
  if (!actId) return undefined;
  const act = seasons.find((s) => s.id === actId.toLowerCase());
  if (!act?.name) return undefined;
  const parent = act.parentId ? seasons.find((s) => s.id === act.parentId) : undefined;
  const raw = `${parent?.name ? `${parent.name} ` : ''}${act.name}`;
  return raw
    .replace(/\s*(?::|\/\/)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((w, i, all) => (all[i - 1] === 'act' && /^(?:i{1,3}|iv|vi{0,3}|ix|x{1,3})$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

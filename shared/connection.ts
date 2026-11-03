// Pure logic for picking token source, region/shard and client version from
// several fallbacks. Kept side-effect free so the chains are unit-testable.

export type TokenSource = 'riot-client' | 'signin' | 'none';

export interface RegionCandidate {
  source: 'valorant-session' | 'region-locale' | 'riot-geo' | 'disk-cache' | 'shooter-log' | 'shard-probe';
  region?: string | null;
  shard?: string | null;
}

export interface VersionCandidate {
  source: 'valorant-session' | 'disk-cache' | 'shooter-log' | 'valorant-api';
  version?: string | null;
}

/** region -> shard. latam/br live on na. Returns null for unknown regions. */
export function shardFor(region: string | null | undefined): string | null {
  const r = String(region ?? '').toLowerCase();
  if (r === 'na' || r === 'latam' || r === 'br') return 'na';
  if (r === 'eu' || r === 'ap' || r === 'kr' || r === 'pbe') return r;
  return null;
}

/**
 * Normalises Riot Client region strings (region-locale "region"/"webRegion", geo affinities)
 * to a Valorant deployment region. Returns null when unknown so the next fallback is used.
 */
export function normalizeRegion(raw: string | null | undefined): string | null {
  const r = String(raw ?? '').trim().toLowerCase();
  if (!r) return null;
  if (['na', 'eu', 'ap', 'kr', 'latam', 'br', 'pbe'].includes(r)) return r;
  if (r.startsWith('na')) return 'na';
  if (r.startsWith('eu') || r === 'tr' || r === 'ru' || r === 'me') return 'eu';
  if (r.startsWith('la')) return 'latam';
  if (r.startsWith('br')) return 'br';
  if (r.startsWith('kr')) return 'kr';
  if (['ap', 'oc', 'oc1', 'jp', 'jp1', 'sg', 'sg2', 'tw', 'tw2', 'ph', 'ph2', 'th', 'th2', 'vn', 'vn2', 'id'].includes(r)) return 'ap';
  return null;
}

export interface ResolvedRegion {
  region: string;
  shard: string;
  source: RegionCandidate['source'];
}

/** First candidate (in the given order) with a valid region wins. */
export function resolveRegion(candidates: RegionCandidate[]): ResolvedRegion | null {
  for (const c of candidates) {
    const region = normalizeRegion(c.region);
    if (!region) continue;
    const shard = region === 'latam' || region === 'br' ? 'na' : (c.shard ? String(c.shard).toLowerCase() : null) ?? shardFor(region);
    if (!shard) continue;
    return { region, shard, source: c.source };
  }
  return null;
}

/** Sources that come from the game itself and need no verification. */
const AUTHORITATIVE = new Set<RegionCandidate['source']>(['valorant-session', 'riot-geo']);
export const PROBE_SHARDS = ['na', 'eu', 'ap', 'kr'];

/**
 * Picks a region, verifying non-authoritative candidates against the shard
 * (verify = "does this account have data there?"). The Riot Client's region-locale
 * is the client UI region and can differ from the Valorant shard (seen: NA for an AP account).
 * If nothing verifies, probes every shard; if still nothing, falls back to the first candidate.
 */
export async function chooseRegion(candidates: RegionCandidate[], verify: (shard: string) => Promise<boolean>): Promise<(ResolvedRegion & { verified: boolean }) | null> {
  const tried = new Set<string>();
  for (const c of candidates) {
    const r = resolveRegion([c]);
    if (!r) continue;
    if (AUTHORITATIVE.has(r.source)) return { ...r, verified: true };
    if (tried.has(r.shard)) continue;
    tried.add(r.shard);
    if (await verify(r.shard)) return { ...r, verified: true };
  }
  for (const shard of PROBE_SHARDS) {
    if (tried.has(shard)) continue;
    if (await verify(shard)) return { region: shard, shard, source: 'shard-probe', verified: true };
  }
  const first = resolveRegion(candidates);
  return first ? { ...first, verified: false } : null;
}

export function isValidVersion(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^release-\d+\.\d+/.test(v);
}

/** First candidate with a release-* version wins. */
export function resolveVersion(candidates: VersionCandidate[]): { version: string; source: VersionCandidate['source'] } | null {
  for (const c of candidates) if (isValidVersion(c.version)) return { version: c.version, source: c.source };
  return null;
}

/** Riot Client first (when it's running and gave tokens), else a signed-in session. */
export function pickTokenSource(s: { riotClientTokens: boolean; signedInTokens: boolean }): TokenSource {
  if (s.riotClientTokens) return 'riot-client';
  if (s.signedInTokens) return 'signin';
  return 'none';
}

export interface AuthRedirect {
  accessToken: string;
  idToken: string;
  expiresIn: number;
}

/** Parses https://playvalorant.com/opt_in#access_token=...&id_token=...&expires_in=3600 */
export function parseAuthRedirect(url: string): AuthRedirect | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'playvalorant.com' || !u.pathname.startsWith('/opt_in')) return null;
  const params = new URLSearchParams(u.hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');
  if (!accessToken || !idToken) return null;
  const expiresIn = Number(params.get('expires_in')) || 3600;
  return { accessToken, idToken, expiresIn };
}

export const AUTHORIZE_URL =
  'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid';

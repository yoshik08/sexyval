export interface RegionInfo {
  region: string;
  shard: string;
  version?: string;
}

/** latam and br live on the na shard. */
export function normalizeShard(region: string, shard?: string | null): string {
  const r = region.toLowerCase();
  if (r === 'latam' || r === 'br') return 'na';
  if (shard) return shard.toLowerCase();
  if (r === 'na' || r === 'pbe') return r === 'pbe' ? 'pbe' : 'na';
  return r; // eu, ap, kr map to themselves
}

export function glzUrl(region: string, shard: string): string {
  return `https://glz-${region}-1.${shard}.a.pvp.net`;
}

export function pdUrl(shard: string): string {
  return `https://pd.${shard}.a.pvp.net`;
}

function argList(session: any): string[] {
  const args = session?.launchConfiguration?.arguments;
  if (Array.isArray(args)) return args.filter((a: unknown) => typeof a === 'string');
  if (typeof args === 'string') return args.split(/\s+/);
  return [];
}

/** Reads region/shard/version from /product-session/v1/external-sessions. */
export function parseExternalSessions(json: unknown): RegionInfo | null {
  if (!json || typeof json !== 'object') return null;
  const sessions = Object.values(json as Record<string, any>);
  const val = sessions.find((s) => s && typeof s === 'object' && String(s.productId).toLowerCase() === 'valorant');
  if (!val) return null;
  let region: string | undefined;
  let shard: string | undefined;
  for (const arg of argList(val)) {
    const r = /^-ares-deployment=([a-z0-9]+)/i.exec(arg);
    if (r) region = r[1].toLowerCase();
    const s = /^-config-endpoint=https?:\/\/shared\.([a-z0-9]+)\.a\.pvp\.net/i.exec(arg);
    if (s) shard = s[1].toLowerCase();
  }
  if (!region) return null;
  const version = typeof val.version === 'string' && val.version ? val.version : undefined;
  return { region, shard: normalizeShard(region, shard), version };
}

/** True when the Valorant product session exists at all (game running). */
export function hasValorantSession(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  return Object.values(json as Record<string, any>).some((s) => String(s?.productId).toLowerCase() === 'valorant');
}

/** Fallback: ShooterGame.log. Uses the last occurrence of each marker. */
export function parseShooterLog(text: string): Partial<RegionInfo> {
  const out: Partial<RegionInfo> = {};
  const verRe = /CI server version:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = verRe.exec(text))) out.version = m[1];
  const glzRe = /https:\/\/glz-([a-z0-9]+)-1\.([a-z0-9]+)\.a\.pvp\.net/gi;
  while ((m = glzRe.exec(text))) {
    out.region = m[1].toLowerCase();
    out.shard = normalizeShard(out.region, m[2]);
  }
  return out;
}

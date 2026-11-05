/**
 * tracker.gg profile link for a Riot ID. SexyVal only opens this page in the browser; it never
 * fetches anything from tracker.gg. Null for anything that isn't a plausible Riot ID.
 */
export function trackerUrl(name: string | undefined, tag: string | undefined): string | null {
  const n = (name ?? '').trim();
  const t = (tag ?? '').trim();
  if (!n || !t || n.length > 32 || t.length > 16 || n.includes('#') || t.includes('#')) return null;
  return `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(`${n}#${t}`)}/overview`;
}

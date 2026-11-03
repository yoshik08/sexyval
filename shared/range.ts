/** "bytes=a-b" | "bytes=a-" | "bytes=-n" against a known size. null = no range or not satisfiable. */
export function parseRange(range: string | null, size: number): { start: number; end: number } | null {
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  if (start >= size) return null;
  start = Math.max(0, start);
  end = Math.max(start, Math.min(end, size - 1));
  return { start, end };
}

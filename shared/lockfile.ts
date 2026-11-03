export interface Lockfile {
  name: string;
  pid: number;
  port: number;
  password: string;
  protocol: 'http' | 'https';
}

/**
 * Parses "name:pid:port:password:protocol". Parsed from the right so a name
 * containing ':' still works. Returns null on anything malformed.
 */
export function parseLockfile(raw: string | null | undefined): Lockfile | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length < 5) return null;
  const protocol = parts[parts.length - 1].trim().toLowerCase();
  const password = parts[parts.length - 2];
  const port = Number(parts[parts.length - 3]);
  const pid = Number(parts[parts.length - 4]);
  const name = parts.slice(0, parts.length - 4).join(':');
  if (protocol !== 'http' && protocol !== 'https') return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isInteger(pid) || pid < 0) return null;
  if (!password) return null;
  return { name, pid, port, password, protocol };
}

// SexyVal Vault: the format and the rules, without I/O (main/services/vault.ts does the files).
//
// A .sxyval file is "SXYVAL1\n" followed by gzip(JSON envelope). The envelope carries the payload as a JSON
// string plus its SHA-256, so a damaged or edited file is detected before anything is restored. No Riot
// passwords, tokens or cookies are ever in it: restoring on another PC brings data back, not a login.

export const VAULT_MAGIC = 'sexyval-vault';
export const VAULT_HEADER = 'SXYVAL1\n';
/** Payload schema. Bump with a migration in MIGRATIONS. */
export const VAULT_SCHEMA = 1;
/** Imports are refused above this size once decompressed. */
export const MAX_PAYLOAD_BYTES = 300 * 1024 * 1024;

/** User-owned JSON files in the data folder that the vault carries (caches and secrets are not here). */
export const VAULT_FILES = [
  'accounts.json',
  'settings.json',
  'wishlist.json',
  'lineups.json',
  'spending.json',
  'friend-watch.json',
  'loadout-presets.json',
  'shop-history.json',
  'bundles.json',
  'prices.json',
  'boost-journal.json',
] as const;
export type VaultFile = (typeof VAULT_FILES)[number];
/** Never carried in settings: secrets and machine-specific values. */
export const SKIP_SETTINGS = ['henrikKey', 'window', 'stretchDevice', 'overlayDisplay'] as const;

export const ID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
export const MATCH_FILE = /^[0-9a-zA-Z-]{20,64}\.v2\.json$/;

export interface VaultPayload {
  /** Keyed by VAULT_FILES name; value is the parsed JSON. */
  files: Partial<Record<VaultFile, unknown>>;
  /** Per-player competitive updates (MMR history): mmr-updates/<puuid>.json. */
  mmrUpdates: Record<string, unknown>;
  /** Full exports only: cached match details (matches/<id>.v2.json). Snapshots keep matches beside the file. */
  matches?: Record<string, unknown>;
  /** How many cached matches existed when this was taken (snapshots: they live in the vault's match mirror). */
  matchCount: number;
}

export interface VaultEnvelope {
  magic: typeof VAULT_MAGIC;
  schema: number;
  createdAt: number;
  appVersion: string;
  reason: 'auto' | 'quit' | 'startup' | 'before-restore' | 'export';
  sha256: string;
  payloadText: string;
}

export type VaultCheck = { ok: true; envelope: VaultEnvelope; payload: VaultPayload } | { ok: false; error: string };

/** Older payload shapes → the current one. Key = the schema being migrated FROM. */
export const MIGRATIONS: Record<number, (p: any) => any> = {
  // 0: the 1.6 "Backup" JSON ({ app: 'SexyVal', settings, files }) imported through the vault path.
  0: (p) => ({
    files: { ...(p.files ?? {}), ...(p.settings ? { 'settings.json': p.settings } : {}) },
    mmrUpdates: {},
    matchCount: 0,
  }),
};

export function migrate(schema: number, payload: any): any {
  let s = schema;
  let p = payload;
  while (s < VAULT_SCHEMA) {
    const m = MIGRATIONS[s];
    if (!m) throw new Error(`No migration from vault schema ${s}`);
    p = m(p);
    s++;
  }
  return p;
}

/** Strips anything the vault must not carry or restore (unknown files, bad names, secrets). */
export function sanitizePayload(p: any): VaultPayload {
  const out: VaultPayload = { files: {}, mmrUpdates: {}, matchCount: 0 };
  if (!p || typeof p !== 'object') throw new Error('Empty vault payload');
  for (const f of VAULT_FILES) if (p.files && Object.prototype.hasOwnProperty.call(p.files, f) && p.files[f] !== undefined) out.files[f] = p.files[f];
  const s = out.files['settings.json'];
  if (s && typeof s === 'object') {
    const clean = { ...(s as Record<string, unknown>) };
    for (const k of SKIP_SETTINGS) delete clean[k];
    out.files['settings.json'] = clean;
  }
  for (const [k, v] of Object.entries(p.mmrUpdates ?? {})) if (ID_FILE.test(k)) out.mmrUpdates[k] = v;
  if (p.matches && typeof p.matches === 'object') {
    out.matches = {};
    for (const [k, v] of Object.entries(p.matches)) if (MATCH_FILE.test(k)) out.matches[k] = v;
  }
  out.matchCount = Number.isFinite(p.matchCount) ? Number(p.matchCount) : Object.keys(out.matches ?? {}).length;
  return out;
}

/**
 * Validates a decoded envelope (checksum supplied by the caller, which owns crypto) and returns the
 * migrated, sanitized payload. Untrusted input: every field is checked.
 */
export function checkEnvelope(env: any, sha256: (text: string) => string): VaultCheck {
  if (!env || typeof env !== 'object' || env.magic !== VAULT_MAGIC) return { ok: false, error: 'Not a SexyVal vault file' };
  if (typeof env.payloadText !== 'string' || typeof env.sha256 !== 'string') return { ok: false, error: 'Vault file is incomplete' };
  if (env.payloadText.length > MAX_PAYLOAD_BYTES) return { ok: false, error: 'Vault file is too large' };
  if (!Number.isInteger(env.schema) || env.schema < 0) return { ok: false, error: 'Unknown vault version' };
  if (env.schema > VAULT_SCHEMA) return { ok: false, error: `Made by a newer SexyVal (vault v${env.schema}); update SexyVal to read it` };
  if (sha256(env.payloadText) !== env.sha256) return { ok: false, error: 'Checksum mismatch: the file is damaged' };
  try {
    const payload = sanitizePayload(migrate(env.schema, JSON.parse(env.payloadText)));
    return { ok: true, envelope: env as VaultEnvelope, payload };
  } catch (e) {
    return { ok: false, error: `Unreadable vault payload: ${(e as Error).message}` };
  }
}

/**
 * Which history snapshots to keep: the newest `recent`, plus the newest one of each of the last `days`
 * calendar days. Everything else may be deleted. Input: snapshot times; output: the times to keep.
 */
export function keepSnapshots(times: number[], recent = 6, days = 14): Set<number> {
  const sorted = [...times].sort((a, b) => b - a);
  const keep = new Set(sorted.slice(0, recent));
  const seenDays = new Set<string>();
  for (const t of sorted) {
    const d = new Date(t).toDateString();
    if (seenDays.has(d)) continue;
    if (seenDays.size >= days) break;
    seenDays.add(d);
    keep.add(t);
  }
  return keep;
}

/** Restoring into an existing install: only files that are missing are written (newer data always wins). */
export function missingOnly<T extends string>(available: T[], existing: Set<string>): T[] {
  return available.filter((f) => !existing.has(f));
}

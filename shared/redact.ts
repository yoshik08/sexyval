const SECRET_KEY = /(token|authorization|password|passwd|secret|jwt|cookie|entitlement|credential|key$)/i;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER = /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const ARG_SECRET = /(-[a-z-]*(?:token|auth|password)[a-z-]*=)[^\s"]+/gi;

export function redactString(s: string): string {
  return s.replace(JWT, '[REDACTED_JWT]').replace(BEARER, '$1 [REDACTED]').replace(ARG_SECRET, '$1[REDACTED]');
}

/** Deep copy with secret-looking keys and token-like strings removed. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 40) return '[depth]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

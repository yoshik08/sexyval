import { redactString } from '../shared/redact';

const MAX = 400;
const lines: string[] = [];

function fmt(level: string, parts: unknown[]): string {
  const msg = parts
    .map((p) => {
      if (p instanceof Error) return `${p.name}: ${p.message}`;
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
  const t = new Date().toISOString().slice(11, 23);
  return redactString(`${t} ${level} ${msg}`);
}

function push(level: string, parts: unknown[]): void {
  const line = fmt(level, parts);
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  if (process.env.SEXYVAL_QUIET !== '1') console.log(line);
}

export const log = {
  info: (...p: unknown[]) => push('INFO', p),
  warn: (...p: unknown[]) => push('WARN', p),
  error: (...p: unknown[]) => push('ERR ', p),
  debug: (...p: unknown[]) => push('DBG ', p),
  tail: (n = 200) => lines.slice(-n),
};

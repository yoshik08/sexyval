import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { WarningCircle } from '../lib/icons';
import { Segmented } from './ui';

export function Btn({
  children,
  onClick,
  disabled,
  tone = 'default',
  title,
  className,
  type = 'button',
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger' | 'ghost';
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'h-8 px-3.5 text-sm' : 'h-9 px-4 text-sm',
        tone === 'primary' && 'bg-white text-black hover:bg-white/90',
        tone === 'danger' && 'bg-loss/[0.14] text-loss hover:bg-loss/[0.22]',
        tone === 'default' && 'bg-white/[0.1] text-ink hover:bg-white/[0.16]',
        tone === 'ghost' && 'text-muted hover:bg-white/[0.06] hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabBar<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return <Segmented value={value} options={tabs} onChange={onChange} />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-loss/[0.1] px-4 py-3 text-sm text-ink/90">
      <WarningCircle size={18} weight="fill" className="mt-px shrink-0 text-loss" />
      <div>{children}</div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl bg-white/[0.05] px-4 py-3 text-sm text-muted">{children}</div>;
}

export function Untested({ what }: { what?: string }) {
  return (
    <span className="rounded-full bg-warn/[0.12] px-2.5 py-1 text-2xs font-semibold text-warn" title={what ?? 'Built from the unofficial docs; not verified against the live game'}>
      Unverified
    </span>
  );
}

/** Page title. `label` is accepted for older call sites but intentionally not rendered: the heading carries itself. */
export function PageHeader({ title, right }: { label?: string; title: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6">
      <h1 className="t-title text-page text-ink">{title}</h1>
      {right}
    </div>
  );
}

export function Bar({ value, max, tone = 'bg-white' }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.1]">
      <div className={cx('h-full rounded-full transition-[width] duration-[420ms] ease-out', tone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** rpc call with loading/error state; `reload` re-runs it. */
export function useRpc<T>(method: string, args: unknown[] = [], enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(args);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.rpc<T>(method, ...JSON.parse(key)));
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': (Error: )?/, ''));
    } finally {
      setLoading(false);
    }
  }, [method, key]);
  useEffect(() => {
    if (enabled) void reload();
  }, [reload, enabled]);
  return { data, setData, error, loading, reload };
}

/** Runs an rpc action, surfacing errors to the caller. */
export async function act<T>(method: string, ...args: unknown[]): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await api.rpc<T>(method, ...args) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': (Error: )?/, '') };
  }
}

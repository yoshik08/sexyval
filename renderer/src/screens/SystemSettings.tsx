import { useEffect, useState } from 'react';
import type { BoostStatus, StretchStatus } from '../../../shared/types';
import { PRESETS, resLabel } from '../../../shared/stretch';
import { api } from '../lib/api';
import { cx } from '../lib/format';
import { saveSettings, useSettings } from '../lib/store';
import { Panel, Select, Toggle } from '../components/ui';
import { act, Btn, ErrorNote } from '../components/kit';

function useLive<T>(rpc: string, event: string): [T | null, (v: T) => void] {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    void api.rpc<T>(rpc).then(setV);
    return api.on<T>(event, setV);
  }, [rpc, event]);
  return [v, setV];
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={cx('press h-9 rounded-full px-4 text-sm font-medium', on ? 'bg-white text-black' : 'bg-white/[0.08] text-ink hover:bg-white/[0.14]')}>
      {children}
    </button>
  );
}

export function StretchTab() {
  const s = useSettings();
  const [st] = useLive<StretchStatus>('stretch:status', 'stretch');
  const [custom, setCustom] = useState(false);
  const [cw, setCw] = useState('');
  const [ch, setCh] = useState('');
  if (!s) return null;
  const isPreset = PRESETS.some((p) => p.w === s.stretchRes.w && p.h === s.stretchRes.h);
  const showCustom = custom || !isPreset;
  const monitors = st?.monitors ?? [];
  const device = s.stretchDevice ?? monitors.find((m) => m.primary)?.device ?? '';
  const mon = monitors.find((m) => m.device === device);
  const available = (w: number, h: number) => !mon || mon.modes.some((m) => m.w === w && m.h === h);
  return (
    <div data-stretch className="flex flex-col gap-6">
      <Panel className="divide-y divide-white/[0.06] px-6">
        <Toggle checked={s.stretchEnabled} onChange={(v) => void saveSettings({ stretchEnabled: v })} label="Stretched resolution" />
        <div className="flex flex-wrap items-center gap-2 py-4">
          {PRESETS.map((p) => (
            <Chip key={resLabel(p)} on={!showCustom && s.stretchRes.w === p.w && s.stretchRes.h === p.h} onClick={() => (setCustom(false), void saveSettings({ stretchRes: p }))}>
              <span className={cx(!available(p.w, p.h) && 'opacity-50')}>{resLabel(p)}</span>
            </Chip>
          ))}
          <Chip on={showCustom} onClick={() => (setCustom(true), setCw(String(s.stretchRes.w)), setCh(String(s.stretchRes.h)))}>
            Custom
          </Chip>
          {showCustom && (
            <form
              className="ml-2 flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const w = Number(cw);
                const h = Number(ch);
                if (Number.isInteger(w) && Number.isInteger(h)) void saveSettings({ stretchRes: { w, h } });
              }}
            >
              <input value={cw} onChange={(e) => setCw(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Width" className="field w-20 text-center" />
              <span className="text-faint">×</span>
              <input value={ch} onChange={(e) => setCh(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Height" className="field w-20 text-center" />
              <Btn size="sm" type="submit">
                Set
              </Btn>
            </form>
          )}
        </div>
        {monitors.length > 1 && (
          <div className="flex items-center justify-between py-3.5">
            <span className="text-base text-ink">Monitor</span>
            <Select value={device} onChange={(v) => void saveSettings({ stretchDevice: v })} options={monitors.map((m) => ({ value: m.device, label: `${m.name}${m.primary ? ' (main)' : ''}`, hint: `${m.current.w}×${m.current.h}` }))} align="right" />
          </div>
        )}
        <Toggle checked={s.stretchNativeOnAltTab} onChange={(v) => void saveSettings({ stretchNativeOnAltTab: v })} label="Native while alt-tabbed" />
      </Panel>
      <div className="flex items-center gap-2.5 px-1 text-sm">
        <span className={cx('h-2 w-2 rounded-full', st?.error ? 'bg-loss' : st?.phase === 'stretched' ? 'bg-win' : 'bg-faint')} />
        <span data-stretch-status className="text-ink">
          {st?.line ?? 'Native'}
        </span>
        {st?.dryRun && <span className="text-xs text-faint">(mock: dry run)</span>}
      </div>
      {st?.error && <ErrorNote>{st.error}</ErrorNote>}
    </div>
  );
}

export function BoostTab() {
  const s = useSettings();
  const [st, setSt] = useLive<BoostStatus>('boost:status', 'boost');
  const [err, setErr] = useState<string | null>(null);
  if (!s || !st) return null;
  const preset = async (rpc: string) => {
    setErr(null);
    const r = await act<BoostStatus>(rpc);
    if (r.ok) setSt(r.data);
    else setErr(r.error);
  };
  return (
    <div data-boost className="flex flex-col gap-6">
      <Panel className="px-6">
        <Toggle checked={s.boostEnabled} onChange={(v) => void saveSettings({ boostEnabled: v })} label="Game boost" />
      </Panel>
      <Panel className={cx('divide-y divide-white/[0.06] px-6 transition-opacity duration-180', !s.boostEnabled && 'opacity-50')}>
        {st.tweaks.map((t) => {
          const dot = t.error ? 'bg-loss' : t.applied ? 'bg-win' : s.boostEnabled && t.on && t.scope === 'session' ? 'bg-warn' : 'bg-white/20';
          const title = t.error ?? (t.applied ? 'Active' : s.boostEnabled && t.on && t.scope === 'session' ? 'Waiting for Valorant' : 'Off');
          return (
            <div key={t.id} className="flex items-center gap-3">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', dot)} title={title} aria-label={title} />
              <div className="min-w-0 flex-1">
                <Toggle
                  checked={t.on}
                  onChange={(v) => void saveSettings({ boostTweaks: { ...s.boostTweaks, [t.id]: v } })}
                  label={t.label}
                  hint={t.id === 'hags' ? `${st.hags === 'on' ? 'On' : st.hags === 'off' ? 'Off' : 'Unknown'} · ${t.note}` : t.error}
                />
              </div>
            </div>
          );
        })}
      </Panel>
      <Panel className="flex items-center justify-between gap-4 px-6 py-4">
        <span className="text-base text-ink">Competitive FPS preset</span>
        <div className="flex gap-2">
          <Btn size="sm" disabled={!st.preset.canApply} onClick={() => void preset('boost:preset')}>
            Apply
          </Btn>
          <Btn size="sm" tone="ghost" disabled={!st.preset.hasBackup || st.gameRunning} onClick={() => void preset('boost:restorePreset')}>
            Restore my settings
          </Btn>
        </div>
      </Panel>
      {err && <ErrorNote>{err}</ErrorNote>}
      {st.dryRun && <p className="px-1 text-xs text-faint">Mock: changes go to a pretend Windows.</p>}
    </div>
  );
}

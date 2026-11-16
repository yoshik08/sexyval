import { useEffect, useState } from 'react';
import type { VaultStatus } from '../../../shared/features';
import { ago, cx, fmtBytes } from '../lib/format';
import { FolderOpen } from '../lib/icons';
import { Panel, Skeleton, showToast, Toggle } from '../components/ui';
import { act, Btn, ErrorNote, Note } from '../components/kit';

const HEALTH: Record<VaultStatus['health'], { label: string; dot: string; text: string }> = {
  ok: { label: 'Healthy', dot: 'bg-win', text: 'Your latest snapshot is valid.' },
  none: { label: 'No snapshot yet', dot: 'bg-faint', text: 'The first snapshot is taken shortly after SexyVal starts.' },
  recovered: { label: 'Recovered', dot: 'bg-warn', text: 'The newest snapshot was missing or damaged; an older valid one is in use.' },
  corrupt: { label: 'Damaged', dot: 'bg-loss', text: 'No valid snapshot was found. Your live data is untouched; a new snapshot will be taken.' },
};
const REASON: Record<string, string> = { auto: 'Automatic', quit: 'On exit', startup: 'On start', 'before-restore': 'Before a restore', export: 'Export' };
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function DataRecoveryTab() {
  const [s, setS] = useState<VaultStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withMatches, setWithMatches] = useState(false);
  const load = () => void act<VaultStatus>('vault:status').then((r) => (r.ok && r.data ? setS(r.data) : setErr(r.ok ? 'Vault unavailable' : r.error)));
  useEffect(load, []);
  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!s) return <Skeleton className="h-72" />;
  const h = HEALTH[s.health];
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <Panel className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className={cx('h-2.5 w-2.5 rounded-full', h.dot)} />
              <span className="t-head text-lg text-ink">Vault · {h.label}</span>
            </div>
            <p className="mt-1 text-sm text-muted">{h.text}</p>
            {s.error && <p className="mt-1 text-xs text-warn">{s.error}</p>}
          </div>
          <div className="flex gap-2">
            <Btn size="sm" disabled={busy} onClick={() => run(async () => { const r = await act<VaultStatus>('vault:snapshot'); if (r.ok && r.data) { setS(r.data); showToast('Snapshot saved'); } })}>
              Snapshot now
            </Btn>
            <Btn size="sm" tone="ghost" onClick={() => void act('vault:openFolder')}>
              <FolderOpen size={14} /> Open folder
            </Btn>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-6 text-sm">
          {[
            ['Last snapshot', s.lastSnapshotAt ? `${ago(s.lastSnapshotAt)}` : '—'],
            ['Size', s.size ? fmtBytes(s.size) : '—'],
            ['Versions kept', String(s.versions.filter((v) => v.ok).length)],
            ['Matches kept', `${s.matchesMirrored.toLocaleString()}`],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-2xs text-faint">{k}</div>
              <div className="t-num text-lg text-ink">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 truncate rounded-xl bg-white/[0.04] px-3 py-2 font-mono text-xs text-muted" title={s.location}>
          {s.location}
        </div>
        {s.recoveredAt && Date.now() - s.recoveredAt < 7 * 24 * 3_600_000 && (
          <p className="mt-3 text-xs text-win">Restored {s.recoveredFiles} missing item{s.recoveredFiles === 1 ? '' : 's'} from the vault {ago(s.recoveredAt)}.</p>
        )}
      </Panel>

      <section>
        <h2 className="t-head mb-3 px-1 text-md text-ink">Versions</h2>
        <Panel className="divide-y divide-white/[0.06]">
          {s.versions.map((v, i) => (
            <div key={v.name} className="flex items-center gap-4 px-6 py-3">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', v.ok ? 'bg-win' : 'bg-loss')} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {when(v.createdAt)}
                  {i === 0 && v.ok && <span className="ml-2 rounded-full bg-white/[0.12] px-2 py-0.5 text-2xs font-semibold">Latest</span>}
                </div>
                <div className="text-xs text-muted">{v.ok ? `${REASON[v.reason ?? ''] ?? v.reason} · SexyVal ${v.appVersion} · ${fmtBytes(v.size)}` : `Can’t be used: ${v.error}`}</div>
              </div>
              {v.ok && (
                <Btn
                  size="sm"
                  tone="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (!window.confirm(`Restore your SexyVal data to ${when(v.createdAt)}? Your current data is snapshotted first, so you can undo this. SexyVal restarts.`)) return;
                      const r = await act('vault:restore', v.name);
                      if (!r.ok) showToast(r.error, 'error');
                    })
                  }
                >
                  Restore
                </Btn>
              )}
            </div>
          ))}
          {!s.versions.length && <div className="px-6 py-5 text-sm text-muted">No snapshots yet.</div>}
        </Panel>
      </section>

      <section>
        <h2 className="t-head mb-3 px-1 text-md text-ink">Back up somewhere safe</h2>
        <Panel className="flex flex-col gap-4 p-6">
          <p className="text-sm text-muted">
            Export a single <span className="text-ink">.sxyval</span> file (checksummed) to keep on another drive or cloud folder. It holds your settings, saved account list, wishlist, store history, purchases, presets and MMR history. It never holds Riot logins: on a new PC you sign in again and everything else comes back.
          </p>
          <Toggle checked={withMatches} onChange={setWithMatches} label="Include cached match details" hint={`Larger file (${s.matchesMirrored.toLocaleString()} matches), so replays and lifetime stats work offline right away.`} />
          <div className="flex flex-wrap gap-2">
            <Btn tone="primary" disabled={busy} onClick={() => run(async () => { const r = await act<{ path: string; size: number } | null>('vault:export', withMatches); if (r.ok && r.data) showToast(`Exported ${fmtBytes(r.data.size)}`); else if (!r.ok) showToast(r.error, 'error'); })}>
              Export .sxyval…
            </Btn>
            <Btn
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!window.confirm('Importing replaces your current SexyVal data with the file’s (your current data is snapshotted first). SexyVal restarts. Continue?')) return;
                  const r = await act('vault:import');
                  if (!r.ok) showToast(r.error, 'error');
                })
              }
            >
              Import…
            </Btn>
          </div>
          <p className="text-xs text-faint">Old 1.6 backup .json files import too.</p>
        </Panel>
      </section>

      <Panel className="px-6">
        <Toggle checked={s.reminders} onChange={(on) => void act<VaultStatus>('vault:reminders', on).then((r) => r.ok && r.data && setS(r.data))} label="Remind me to back up" hint="An occasional tip (about once a month)." />
      </Panel>

      <Note>
        The vault lives outside the install folder, so uninstalling or reinstalling SexyVal keeps it, and a fresh install restores what’s missing on first start. It doesn’t survive deleting the folder, a disk failure or a Windows reinstall: that’s what the exported file is for. The uninstaller asks before deleting your data.
      </Note>
    </div>
  );
}

/** Occasional, dismissible backup tip (main sends 'vault-tip' about once a month). */
export function VaultTip() {
  const [tip, setTip] = useState<{ location: string } | null>(null);
  useEffect(() => window.sexyval.on<{ location: string }>('vault-tip', setTip), []);
  if (!tip) return null;
  const close = (disable: boolean) => {
    setTip(null);
    void act('vault:reminderSeen', disable);
  };
  return (
    <div className="toast-in material-thick fixed bottom-5 left-[calc(var(--sidebar-w)+20px)] z-[66] w-[400px] rounded-2xl p-4 shadow-[0_18px_50px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/10" role="status">
      <p className="text-sm text-ink/90">Your SexyVal data is saved locally in a .sxyval vault. Back it up somewhere safe if you want to preserve your accounts, settings, and history.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn size="sm" onClick={() => (void act('vault:openFolder'), close(false))}>
          <FolderOpen size={14} /> Open vault folder
        </Btn>
        <Btn size="sm" tone="ghost" onClick={() => close(false)}>
          Dismiss
        </Btn>
        <Btn size="sm" tone="ghost" onClick={() => close(true)}>
          Don’t remind me
        </Btn>
      </div>
    </div>
  );
}

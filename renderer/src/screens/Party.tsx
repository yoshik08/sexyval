import { useState } from 'react';
import type { PartyView } from '../../../shared/features';
import { queueName, queueTag } from '../../../shared/queues';
import { cx } from '../lib/format';
import { Img, Panel, RankBadge, Skeleton } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, Untested, useRpc } from '../components/kit';
import { useInterval } from '../lib/store';

export function PartyScreen({ connected, valorant }: { connected: boolean; valorant: boolean }) {
  const { data, setData, error, loading, reload } = useRpc<PartyView>('party:get', [], connected);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const [code, setCode] = useState('');
  useInterval(() => connected && void reload(), 5000, [connected, reload]);

  const run = async (name: string, arg?: string | boolean) => {
    setBusy(name);
    setErr(null);
    const r = await act<PartyView>('party:action', name, arg);
    setBusy(null);
    if (r.ok) setData(r.data);
    else setErr(r.error);
  };

  const p = data;
  const inQueue = p?.state === 'MATCHMAKING';
  const me = p?.members.find((m) => m.isMe);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 xl:px-8">
      <PageHeader label="Party" title="Party & matchmaking" right={<Untested what="Party endpoints are from valapidocs; not run against the live game" />} />
      {!connected && <ErrorNote>Needs tokens: start the Riot Client or sign in.</ErrorNote>}
      {connected && !valorant && <Note>Valorant is closed. Riot’s party service only tracks players who are online in Valorant, so there’s nothing to manage until the game is open.</Note>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {err && <div className="mb-4"><ErrorNote>{err}</ErrorNote></div>}
      {connected && valorant && !p && loading && <Skeleton className="h-64" />}
      {p?.status === 'none' && valorant && <Note>{p.error ?? 'No party found.'}</Note>}
      {p?.status === 'ready' && (
        <div className="grid grid-cols-[minmax(0,1fr)_clamp(280px,26vw,340px)] gap-4 xl:gap-5">
          <div className="flex flex-col gap-5">
            <Panel className="p-5">
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1">
                  <span className="label">Queue</span>
                  <select
                    value={p.queueId ?? ''}
                    disabled={!p.isOwner || inQueue || !!busy}
                    onChange={(e) => void run('queue', e.target.value)}
                    className="field min-w-[180px] disabled:opacity-50"
                  >
                    {[...new Set([p.queueId ?? '', ...p.eligibleQueues])].filter(Boolean).map((q) => (
                      <option key={q} value={q}>
                        {queueName(q)}
                      </option>
                    ))}
                  </select>
                </label>
                {inQueue ? (
                  <Btn tone="danger" onClick={() => void run('stop')} disabled={!!busy}>Leave queue</Btn>
                ) : (
                  <Btn tone="primary" onClick={() => void run('start')} disabled={!!busy || !p.isOwner}>Start queue</Btn>
                )}
                <Btn onClick={() => void run('ready', !me?.isReady)} disabled={!!busy}>{me?.isReady ? 'Set not ready' : 'Set ready'}</Btn>
                {p.rrPenalty != null && p.rrPenalty > 0 && (
                  <span data-rr-penalty className="ml-auto rounded-full bg-loss/[0.14] px-2.5 py-1 text-2xs font-semibold text-loss" title="Riot’s RR penalty for this party (SkillDisparityRRPenalty): every player earns and loses this much less RR">
                    RR −{Math.round(p.rrPenalty * 100)}%
                  </span>
                )}
                <span className={cx(p.rrPenalty ? '' : 'ml-auto', 'font-display text-sm font-semibold uppercase tracking-label', inQueue ? 'text-warn' : 'text-muted')}>
                  {inQueue ? `In queue · ${queueTag(p.queueId)}` : p.state ?? '—'}
                </span>
              </div>
              {!p.isOwner && <p className="mt-3 text-xs text-faint">Only the party owner can change the queue or start matchmaking.</p>}
            </Panel>

            <Panel>
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <span className="label">Members · {p.members.length}</span>
                <Btn onClick={() => void run('refresh-pings')} disabled={!!busy}>Refresh pings</Btn>
              </div>
              {p.members.map((m) => (
                <div key={m.puuid} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0 xl:gap-4">
                  {m.cardIcon ? <Img src={m.cardIcon} alt="" className="h-11 w-11 shrink-0 rounded-sm" /> : <div className="h-11 w-11 shrink-0 rounded-sm bg-white/5" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm font-medium">
                      {m.name ? <span className="min-w-0 truncate">{m.name}<span className="text-faint">#{m.tag}</span></span> : <Skeleton className="h-3.5 w-24" />}
                      {m.isOwner && <span className="font-display text-2xs font-bold uppercase tracking-label text-warn">Owner</span>}
                      {m.isMe && <span className="font-display text-2xs font-bold uppercase tracking-label text-accent">You</span>}
                    </div>
                    <div className="truncate text-xs text-muted">Level {m.level ?? '–'} · best ping {m.pings.length ? `${Math.min(...m.pings.map((x) => x.ping))} ms` : '–'}</div>
                  </div>
                  <span className="shrink-0"><RankBadge rank={m.rank} /></span>
                  <span className={cx('w-16 shrink-0 text-right font-display text-xs font-semibold uppercase tracking-label', m.isReady ? 'text-win' : 'text-faint')}>{m.isReady ? 'Ready' : 'Not ready'}</span>
                  {p.isOwner && !m.isMe && <Btn tone="danger" onClick={() => void run('kick', m.puuid)} disabled={!!busy}>Kick</Btn>}
                </div>
              ))}
              <div className="flex justify-end px-5 py-3">
                <Btn onClick={() => void run('leave')} disabled={!!busy}>Leave party</Btn>
              </div>
            </Panel>

            <Panel>
              <div className="border-b border-line px-5 py-3 label">Servers (ping per region)</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-px bg-line">
                {[...new Set(p.members.flatMap((m) => m.pings.map((x) => x.pod)))].map((pod) => {
                  const mine = me?.pings.find((x) => x.pod === pod)?.ping;
                  const preferred = p.preferredPods.includes(pod);
                  return (
                    <div key={pod} className="bg-surface px-4 py-3">
                      <div className="truncate text-sm">{pod.split('.').pop()?.replace(/-gp-/, ' · ')}</div>
                      <div className="num text-xs text-muted">
                        {mine != null ? `${mine} ms` : '–'} {preferred && <span className="ml-1 text-win">· preferred</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="px-5 py-3 text-xs text-faint">Choosing servers isn’t possible here: Riot’s docs list no endpoint for setting preferred servers. Shown read-only.</p>
            </Panel>
          </div>

          <div className="flex flex-col gap-5">
            <Panel className="p-5">
              <div className="label">Access</div>
              <div className="mt-2 flex gap-2">
                {(['OPEN', 'CLOSED'] as const).map((a) => (
                  <Btn key={a} tone={p.accessibility === a ? 'primary' : 'default'} disabled={!p.isOwner || !!busy} onClick={() => void run('accessibility', a)}>
                    {a === 'OPEN' ? 'Open' : 'Closed'}
                  </Btn>
                ))}
              </div>
              <div className="label mt-5">Party code</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="num flex-1 rounded-sm border border-line bg-black/20 px-3 py-1.5 font-display text-md font-bold tracking-[0.2em]">{p.inviteCode ?? '——'}</span>
                {p.inviteCode ? (
                  <Btn onClick={() => void run('code-disable')} disabled={!!busy}>Disable</Btn>
                ) : (
                  <Btn onClick={() => void run('code-generate')} disabled={!!busy || !p.isOwner}>Generate</Btn>
                )}
              </div>
            </Panel>
            <Panel className="p-5">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('invite', invite).then(() => setInvite(''));
                }}
              >
                <div className="label">Invite by Name#Tag</div>
                <div className="mt-2 flex gap-2">
                  <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Name#TAG" className="field min-w-0 flex-1" />
                  <Btn type="submit" disabled={!invite.includes('#') || !!busy}>Invite</Btn>
                </div>
              </form>
              <form
                className="mt-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('join-code', code);
                }}
              >
                <div className="label">Join by code</div>
                <div className="mt-2 flex gap-2">
                  <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" className="field min-w-0 flex-1 uppercase" />
                  <Btn type="submit" disabled={!code || !!busy}>Join</Btn>
                </div>
              </form>
            </Panel>
            <Panel>
              <div className="border-b border-line px-5 py-3 label">Join requests · {p.requests.length}</div>
              {p.requests.length ? (
                p.requests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 border-b border-line px-5 py-2.5 text-sm last:border-b-0">
                    <span className="truncate">{r.subjects.length} player{r.subjects.length === 1 ? '' : 's'}</span>
                    <div className="flex gap-1.5">
                      <Btn disabled title="No documented endpoint to accept a request">Accept</Btn>
                      <Btn tone="danger" onClick={() => void run('decline', r.id)} disabled={!!busy}>Decline</Btn>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-5 py-3 text-sm text-muted">None.</div>
              )}
            </Panel>
            <Note>
              Not available: accepting invites or join requests, and transferring party leadership. Riot’s docs list no endpoints for these, so SexyVal doesn’t guess. Use the game client.
            </Note>
          </div>
        </div>
      )}
    </div>
  );
}

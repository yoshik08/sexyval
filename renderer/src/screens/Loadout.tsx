import { useEffect, useMemo, useState } from 'react';
import type { CatalogSkin, CatalogWeapon, LoadoutGun, LoadoutPreset, LoadoutView } from '../../../shared/features';
import { chromaOwned, isSkinOwned, levelOwned, tierRank } from '../../../shared/collection';
import { cx } from '../lib/format';
import { img } from '../lib/media';
import { ArrowClockwise, Check, FloppyDisk, Play, Trash } from '../lib/icons';
import { ownedSets, useCatalog, useOwned } from '../lib/store';
import { Img, Panel, Select, Skeleton, Toggle, tint } from '../components/ui';
import { act, Btn, ErrorNote, Note, PageHeader, useRpc } from '../components/kit';
import { openSkin } from '../components/SkinDetail';

const GROUPS: [string, string][] = [
  ['Sidearm', 'Sidearms'],
  ['SMG', 'SMGs'],
  ['Shotgun', 'Shotguns'],
  ['Rifle', 'Rifles'],
  ['Sniper', 'Snipers'],
  ['Heavy', 'Heavy'],
  ['Melee', 'Melee'],
];

const levelLabel = (item: string | undefined, i: number) => (i === 0 ? 'Base' : (item ?? `Level ${i + 1}`).replace(/([a-z])([A-Z])/g, '$1 $2'));

function gunChanged(a: LoadoutGun | undefined, b: LoadoutGun | undefined): boolean {
  if (!a || !b) return false;
  return a.skinId !== b.skinId || a.skinLevelId !== b.skinLevelId || a.chromaId !== b.chromaId || (a.charmInstanceId ?? '') !== (b.charmInstanceId ?? '');
}
/** How many things differ between the draft and what Riot has. */
function changeCount(draft: LoadoutView | null, server: LoadoutView | null): number {
  if (!draft || !server) return 0;
  let n = draft.guns.filter((g) => gunChanged(g, server.guns.find((x) => x.weaponId === g.weaponId))).length;
  if (draft.cardId !== server.cardId) n++;
  if (draft.titleId !== server.titleId) n++;
  n += draft.sprays.filter((s, i) => s.sprayId !== server.sprays[i]?.sprayId).length;
  if (!!draft.incognito !== !!server.incognito) n++;
  if (!!draft.hideAccountLevel !== !!server.hideAccountLevel) n++;
  return n;
}

export function LoadoutScreen({ connected }: { connected: boolean }) {
  const catalog = useCatalog();
  const owned = useOwned();
  const { data: server, setData: setServer, error, loading, reload } = useRpc<LoadoutView>('loadout:get', [], connected);
  const presets = useRpc<LoadoutPreset[]>('loadout:presets', []);
  const [draft, setDraft] = useState<LoadoutView | null>(null);
  const [weaponId, setWeaponId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (server?.status === 'ready') setDraft(server);
  }, [server]);
  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);

  const sets = owned.status === 'ready' ? ownedSets(owned) : null;
  const skinById = useMemo(() => new Map(catalog.skins.map((s) => [s.id, s])), [catalog.skins]);
  const tierBy = useMemo(() => new Map(catalog.tiers.map((t) => [t.id, t])), [catalog.tiers]);
  const byGroup = useMemo(() => GROUPS.map(([cat, label]) => ({ label, weapons: catalog.weapons.filter((w) => w.category === cat).sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.weapons.length), [catalog.weapons]);

  const serverReady = server?.status === 'ready' ? server : null;
  const changes = changeCount(draft, serverReady);
  const gunOf = (wid: string) => draft?.guns.find((g) => g.weaponId === wid);
  const setGun = (wid: string, patch: Partial<LoadoutGun>) => setDraft((d) => (d ? { ...d, guns: d.guns.map((g) => (g.weaponId === wid ? { ...g, ...patch } : g)) } : d));

  const pickSkin = (wid: string, skin: CatalogSkin | 'standard') => {
    const w = catalog.weapons.find((x) => x.id === wid);
    if (skin === 'standard') {
      if (w?.defaultSkin) setGun(wid, { skinId: w.defaultSkin.id, skinLevelId: w.defaultSkin.levelId, chromaId: w.defaultSkin.chromaId });
      return;
    }
    // Highest level you own, base variant.
    let li = 0;
    for (let i = skin.levels.length - 1; i >= 0; i--) {
      if (sets && levelOwned(skin, i, sets)) {
        li = i;
        break;
      }
    }
    setGun(wid, { skinId: skin.id, skinLevelId: skin.levels[li].id, chromaId: skin.chromas[0]?.id ?? '' });
  };

  const usedInstances = new Set(draft?.guns.map((g) => g.charmInstanceId).filter(Boolean));
  const pickBuddy = (wid: string, buddyId: string) => {
    if (!buddyId) return setGun(wid, { charmId: undefined, charmLevelId: undefined, charmInstanceId: undefined });
    const b = catalog.buddies.find((x) => x.id === buddyId);
    const levelId = b?.levelId;
    const current = gunOf(wid)?.charmInstanceId;
    const copies = (levelId && owned.buddyInstances[levelId]) || [];
    const free = copies.find((i) => i === current || !usedInstances.has(i));
    if (!levelId || !copies.length) {
      setMsg({ ok: false, text: 'You don’t own that buddy.' });
      return;
    }
    if (free) {
      setGun(wid, { charmId: buddyId, charmLevelId: levelId, charmInstanceId: free });
      return;
    }
    // Every copy is on another weapon: move one over, as the game does.
    const inst = copies[0];
    const from = draft?.guns.find((g) => g.charmInstanceId === inst);
    setDraft((d) =>
      d
        ? {
            ...d,
            guns: d.guns.map((g) =>
              g.weaponId === wid ? { ...g, charmId: buddyId, charmLevelId: levelId, charmInstanceId: inst } : g.charmInstanceId === inst ? { ...g, charmId: undefined, charmLevelId: undefined, charmInstanceId: undefined } : g,
            ),
          }
        : d,
    );
    const fromName = catalog.weapons.find((w) => w.id === from?.weaponId)?.name;
    setMsg({ ok: true, text: `Buddy moved${fromName ? ` from your ${fromName}` : ''}. You own one copy, so it fits one weapon at a time.` });
  };

  const apply = async () => {
    if (!draft) return;
    setBusy(true);
    const r = await act<LoadoutView>('loadout:apply', draft);
    setBusy(false);
    if (r.ok) {
      setServer(r.data);
      setMsg({ ok: true, text: 'Loadout applied. It takes effect when your next game starts.' });
    } else setMsg({ ok: false, text: r.error });
  };

  if (!connected)
    return (
      <div className="mx-auto max-w-[1240px] px-6 xl:px-10 pb-16 pt-6">
        <PageHeader title="Loadout" />
        <Note>Your loadout needs tokens: start the Riot Client or sign in. Valorant can stay closed.</Note>
      </div>
    );

  const weapon: CatalogWeapon | undefined = weaponId ? catalog.weapons.find((w) => w.id === weaponId) : undefined;
  const gun = weaponId ? gunOf(weaponId) : undefined;
  const selSkin = gun ? skinById.get(gun.skinId) : undefined;
  const ownedForWeapon = weaponId
    ? catalog.skins
        .filter((s) => s.weaponId === weaponId && sets && isSkinOwned(s, sets))
        .sort((a, b) => tierRank(catalog.tiers, b.tierId) - tierRank(catalog.tiers, a.tierId) || a.name.localeCompare(b.name))
    : [];
  const ownedBuddies = catalog.buddies.filter((b) => b.levelId && owned.buddyInstances[b.levelId]?.length);

  const art = (w: CatalogWeapon, g?: LoadoutGun) => {
    const s = g ? skinById.get(g.skinId) : undefined;
    const chroma = s?.chromas.find((c) => c.id === g?.chromaId);
    return chroma?.render ?? s?.icon ?? w.defaultSkin?.icon ?? w.icon;
  };

  return (
    <div className="mx-auto max-w-[1280px] px-6 xl:px-10 pb-32 pt-6">
      <PageHeader
        title="Loadout"
        right={
          <Btn tone="ghost" onClick={() => void reload()} disabled={loading}>
            <ArrowClockwise size={15} weight="bold" className={cx(loading && 'animate-[spin_0.8s_linear_infinite]')} /> Reload
          </Btn>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {server?.status === 'error' && <ErrorNote>{server.error}</ErrorNote>}
      {!draft && loading && (
        <div className="grid grid-cols-[minmax(0,1fr)_clamp(320px,30vw,400px)] gap-6 xl:gap-8">
          <Skeleton className="h-[520px] rounded-[28px]" />
          <Skeleton className="h-[520px] rounded-[28px]" />
        </div>
      )}

      {draft && (
        <div className="grid grid-cols-[minmax(0,1fr)_clamp(320px,30vw,400px)] items-start gap-6 xl:gap-9">
          <div className="flex flex-col gap-10">
            {byGroup.map((g) => (
              <section key={g.label}>
                <h2 className="t-head mb-3.5 text-md text-muted">{g.label}</h2>
                <div className="grid grid-cols-3 gap-3 xl:gap-4">
                  {g.weapons.map((w) => {
                    const gn = gunOf(w.id);
                    const s = gn ? skinById.get(gn.skinId) : undefined;
                    const color = tierBy.get(s?.tierId ?? '')?.color;
                    const dirty = gunChanged(gn, serverReady?.guns.find((x) => x.weaponId === w.id));
                    const on = weaponId === w.id;
                    return (
                      <button
                        key={w.id}
                        onClick={() => setWeaponId(w.id)}
                        aria-pressed={on}
                        className={cx('press group relative flex h-[168px] flex-col overflow-hidden rounded-[22px] bg-surface text-left ring-inset transition-shadow duration-[240ms] ease-out', on ? 'ring-2 ring-white' : 'ring-1 ring-white/[0.06] hover:ring-white/[0.18]')}
                      >
                        <div className="absolute inset-0" style={{ background: color ? `radial-gradient(ellipse 80% 60% at 50% 62%, ${tint(color, 0.24)}, transparent 72%)` : undefined }} />
                        <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pt-3">
                          <Img src={img(art(w, gn))} alt={s?.name ?? w.name} className="max-h-full max-w-full object-contain drop-shadow-[0_10px_16px_rgba(0,0,0,0.55)] transition-transform duration-[420ms] ease-out [@media(hover:hover)]:group-hover:scale-[1.05]" />
                        </div>
                        <div className="relative px-4 pb-3">
                          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                            <span className="truncate">{w.name}</span>
                            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white" title="Edited" />}
                          </div>
                          <div className="truncate text-xs text-muted">{s?.name ?? 'Standard'}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}

            <section>
              <h2 className="t-head mb-3.5 text-md text-muted">Player</h2>
              <Panel className="p-6">
                <div className="grid grid-cols-[clamp(150px,16vw,260px)_minmax(0,1fr)] gap-5 xl:gap-6">
                  <div className="overflow-hidden rounded-2xl bg-white/[0.04]">
                    <Img src={img(catalog.cards.find((c) => c.id === draft.cardId)?.large ?? catalog.cards.find((c) => c.id === draft.cardId)?.icon)} alt="Player card" className="aspect-[268/640] w-full object-cover" />
                  </div>
                  <div className="flex min-w-0 flex-col gap-5">
                    <div>
                      <div className="mb-1.5 text-sm text-muted">Player card</div>
                      <Select
                        value={draft.cardId ?? ''}
                        width={340}
                        onChange={(v) => setDraft({ ...draft, cardId: v })}
                        options={catalog.cards.filter((c) => !sets || sets.extras.card.has(c.id) || c.id === draft.cardId).map((c) => ({ value: c.id, label: c.name }))}
                        className="max-w-full"
                      />
                    </div>
                    <div>
                      <div className="mb-1.5 text-sm text-muted">Title</div>
                      <Select
                        value={draft.titleId ?? ''}
                        width={340}
                        onChange={(v) => setDraft({ ...draft, titleId: v })}
                        options={catalog.titles.filter((t) => !sets || sets.extras.title.has(t.id) || t.id === draft.titleId).map((t) => ({ value: t.id, label: t.text ?? t.name }))}
                        className="max-w-full"
                      />
                    </div>
                    <div>
                      <div className="mb-2 text-sm text-muted">Sprays, in wheel order</div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
                        {draft.sprays.map((sp) => {
                          const spray = catalog.sprays.find((x) => x.id === sp.sprayId);
                          return (
                            <div key={sp.slot} className="flex flex-col items-center gap-2 rounded-2xl bg-white/[0.04] p-3">
                              <Img src={img(spray?.icon)} alt={spray?.name ?? ''} className="h-14 w-14 object-contain" />
                              <Select
                                value={sp.sprayId}
                                width={260}
                                onChange={(v) => setDraft({ ...draft, sprays: draft.sprays.map((x) => (x.slot === sp.slot ? { ...x, sprayId: v } : x)) })}
                                options={catalog.sprays.filter((s) => !sets || sets.extras.spray.has(s.id) || s.id === sp.sprayId).map((s) => ({ value: s.id, label: s.name }))}
                                className="h-8 w-full justify-between bg-white/[0.06] text-xs"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-5 divide-y divide-white/[0.06] border-t border-white/[0.06]">
                  <Toggle checked={!!draft.hideAccountLevel} onChange={(v) => setDraft({ ...draft, hideAccountLevel: v })} label="Hide account level" hint="Other players do not see your level." />
                  <Toggle checked={!!draft.incognito} onChange={(v) => setDraft({ ...draft, incognito: v })} label="Incognito" hint="Your name is hidden in agent select and in game." />
                </div>
              </Panel>
            </section>
          </div>

          <aside className="sticky top-4 flex flex-col gap-5">
            <Panel className="overflow-hidden">
              {!weapon || !gun ? (
                <div className="px-8 py-16 text-center">
                  <p className="t-head text-md text-ink">Choose a weapon</p>
                  <p className="text-pretty mt-1.5 text-sm text-muted">Pick one on the left to change its skin, level, variant and buddy. Only what you own is offered.</p>
                </div>
              ) : (
                <>
                  <div className="relative flex h-[190px] items-center justify-center" style={{ background: `radial-gradient(ellipse 70% 62% at 50% 60%, ${tint(tierBy.get(selSkin?.tierId ?? '')?.color, 0.26)}, transparent 74%)` }}>
                    <Img src={img(art(weapon, gun))} alt={selSkin?.name ?? weapon.name} className="max-h-[132px] max-w-[84%] object-contain drop-shadow-[0_16px_22px_rgba(0,0,0,0.6)]" />
                  </div>
                  <div className="flex flex-col gap-6 px-5 pb-6 xl:px-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="t-title text-[22px] [overflow-wrap:anywhere]">{selSkin?.name ?? `${weapon.name}`}</h3>
                        <p className="mt-0.5 text-sm text-muted">{selSkin ? weapon.name : 'Standard skin'}</p>
                      </div>
                      {selSkin && (
                        <Btn size="sm" onClick={() => openSkin(selSkin.id)}>
                          <Play size={11} weight="fill" /> Watch
                        </Btn>
                      )}
                    </div>

                    <div>
                      <div className="mb-2 flex items-baseline justify-between text-sm">
                        <span className="text-muted">Skin</span>
                        <span className="num text-faint">{ownedForWeapon.length} owned</span>
                      </div>
                      <div className="no-scrollbar rail-fade -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1 pr-8">
                        <SkinChip label="Standard" art={weapon.defaultSkin?.icon ?? weapon.icon} active={!selSkin} onClick={() => pickSkin(weapon.id, 'standard')} />
                        {ownedForWeapon.map((s) => (
                          <SkinChip key={s.id} label={s.name} art={s.icon} color={tierBy.get(s.tierId ?? '')?.color} active={selSkin?.id === s.id} onClick={() => pickSkin(weapon.id, s)} />
                        ))}
                      </div>
                      {!sets && <p className="mt-1 text-xs text-faint">{owned.status === 'loading' ? 'Reading what you own…' : 'Your owned skins appear here once the Riot Client is connected.'}</p>}
                    </div>

                    {selSkin && (
                      <>
                        <div>
                          <div className="mb-2 text-sm text-muted">Level</div>
                          <div className="flex flex-wrap gap-1.5">
                            {selSkin.levels.map((l, i) => {
                              const can = sets ? levelOwned(selSkin, i, sets) : false;
                              const on = gun.skinLevelId === l.id;
                              return (
                                <button
                                  key={l.id}
                                  disabled={!can}
                                  onClick={() => setGun(weapon.id, { skinLevelId: l.id })}
                                  title={can ? levelLabel(l.item, i) : `${levelLabel(l.item, i)} (not owned)`}
                                  className={cx('press h-9 rounded-full px-3.5 text-sm font-medium disabled:opacity-30', on ? 'bg-white text-black' : 'bg-white/[0.1] text-ink hover:bg-white/[0.16]')}
                                >
                                  {i + 1}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-1.5 text-xs text-faint">{levelLabel(selSkin.levels.find((l) => l.id === gun.skinLevelId)?.item, Math.max(0, selSkin.levels.findIndex((l) => l.id === gun.skinLevelId)))}</p>
                        </div>
                        {selSkin.chromas.length > 1 && (
                          <div>
                            <div className="mb-2 text-sm text-muted">Variant</div>
                            <div className="flex flex-wrap gap-2.5">
                              {selSkin.chromas.map((c, i) => {
                                const can = sets ? chromaOwned(selSkin, i, sets) : false;
                                const on = gun.chromaId === c.id;
                                return (
                                  <button
                                    key={c.id}
                                    disabled={!can}
                                    onClick={() => setGun(weapon.id, { chromaId: c.id })}
                                    title={can ? c.name : `${c.name} (not owned)`}
                                    className={cx('press h-12 w-12 overflow-hidden rounded-2xl bg-white/[0.06] disabled:opacity-30', on ? 'ring-2 ring-white' : 'ring-1 ring-white/10 hover:ring-white/30')}
                                  >
                                    {c.swatch ? <Img src={img(c.swatch)} alt={c.name} className="h-full w-full object-cover" /> : <span className="text-xs text-muted">{i + 1}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {weapon.category !== 'Melee' && (
                      <div>
                        <div className="mb-2 text-sm text-muted">Buddy</div>
                        <Select
                          value={gun.charmId ?? ''}
                          width={340}
                          onChange={(v) => pickBuddy(weapon.id, v)}
                          options={[{ value: '', label: 'None' }, ...ownedBuddies.map((b) => ({ value: b.id, label: b.name }))]}
                          className="w-full justify-between"
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
            </Panel>

            <Panel className="p-5">
              <h3 className="t-head text-md">Presets</h3>
              <p className="mt-0.5 text-xs text-faint">Saved on this PC only.</p>
              <form
                className="mt-3 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!draft) return;
                  const r = await act<LoadoutPreset[]>('loadout:savePreset', presetName || `Preset ${(presets.data?.length ?? 0) + 1}`, draft);
                  if (r.ok) {
                    presets.setData(r.data);
                    setPresetName('');
                  }
                }}
              >
                <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name this loadout" className="h-9 min-w-0 flex-1 rounded-full bg-white/[0.08] px-3.5 text-sm outline-none focus:bg-white/[0.13]" />
                <Btn type="submit">
                  <FloppyDisk size={14} weight="bold" /> Save
                </Btn>
              </form>
              <div className="mt-3 flex flex-col gap-1">
                {(presets.data ?? []).map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-xl py-1.5 pl-3.5 pr-1.5 hover:bg-white/[0.05]">
                    <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                    <Btn size="sm" tone="ghost" onClick={() => setDraft({ ...p.loadout, version: draft?.version, api: draft?.api, status: 'ready' })}>
                      Load
                    </Btn>
                    <button
                      onClick={async () => {
                        const r = await act<LoadoutPreset[]>('loadout:deletePreset', p.id);
                        if (r.ok) presets.setData(r.data);
                      }}
                      className="press flex h-8 w-8 items-center justify-center rounded-full text-faint hover:bg-white/[0.08] hover:text-loss"
                      aria-label={`Delete ${p.name}`}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
                {!presets.data?.length && <p className="py-1 text-sm text-faint">None yet. Arrange a loadout, then save it.</p>}
              </div>
            </Panel>
          </aside>
        </div>
      )}

      {/* floating apply bar: exists only while there is something to apply or to say */}
      <div className={cx('pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center transition-[opacity,transform] duration-[360ms] ease-out', changes || msg ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0')} style={{ paddingLeft: 'var(--sidebar-w)' }}>
        <div className={cx('material-thick pointer-events-auto flex items-center gap-3 rounded-full py-2 pl-5 pr-2 shadow-[0_18px_50px_-8px_rgba(0,0,0,0.9)] ring-1 ring-white/10', !changes && !msg && 'pointer-events-none')}>
          {/* A message and the change controls can show together, so a note never hides Apply. */}
          {msg && (
            <>
              <span className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', msg.ok ? 'bg-win text-black' : 'bg-loss text-black')}>{msg.ok ? <Check size={12} weight="bold" /> : <span className="text-xs font-bold">!</span>}</span>
              <span className="max-w-[360px] py-1.5 text-sm text-ink">{msg.text}</span>
              {!msg.ok && (
                <Btn size="sm" tone="ghost" onClick={() => setMsg(null)}>
                  Dismiss
                </Btn>
              )}
            </>
          )}
          {changes > 0 && (
            <>
              {msg && <span className="h-5 w-px shrink-0 bg-white/15" aria-hidden />}
              <span className="text-sm text-ink">
                <span className="num font-semibold">{changes}</span> unsaved change{changes === 1 ? '' : 's'}
              </span>
              <Btn tone="ghost" size="sm" onClick={() => serverReady && setDraft(serverReady)} disabled={busy}>
                Discard
              </Btn>
              <Btn tone="primary" size="sm" onClick={() => void apply()} disabled={busy}>
                {busy ? 'Applying…' : 'Apply'}
              </Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SkinChip({ label, art, color, active, onClick }: { label: string; art?: string; color?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-pressed={active} className={cx('press relative flex h-[84px] w-[104px] shrink-0 flex-col items-center justify-center overflow-hidden rounded-2xl bg-white/[0.05] px-2', active ? 'ring-2 ring-white' : 'ring-1 ring-white/[0.08] hover:ring-white/25')}>
      {color && <span className="absolute inset-0" style={{ background: `radial-gradient(ellipse 80% 60% at 50% 70%, ${tint(color, 0.22)}, transparent 72%)` }} />}
      <Img src={img(art)} alt="" className="relative h-9 w-full object-contain" />
      <span className="relative mt-1.5 w-full truncate text-center text-2xs text-muted">{label}</span>
    </button>
  );
}

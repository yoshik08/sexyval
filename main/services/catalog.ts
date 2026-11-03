import path from 'node:path';
import { httpRequest } from '../riot/http';
import { readJson, writeJson } from '../paths';
import { log } from '../log';
import type { Catalog, CatalogExtra, CatalogSkin, CatalogTier, CatalogWeapon, SkinSource } from '../../shared/features';

const BASE = 'https://valorant-api.com/v1';
/** Re-check the game version at most this often; a changed version forces a full refresh. */
const CHECK_EVERY = 6 * 60 * 60 * 1000;
/** Even with an unchanged version, rebuild after this long (new weekly/event content lands without a patch). */
const HARD_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
/** Bump when the cached catalog gains fields (2: skin.source, version). */
const SCHEMA = 2;
const TIER_RANK: Record<string, number> = { Select: 0, Deluxe: 1, Premium: 2, Exclusive: 3, Ultra: 4 };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const lc = (v: unknown) => String(v ?? '').toLowerCase();
const hex = (c: unknown) => (typeof c === 'string' && /^[0-9a-f]{6,8}$/i.test(c) ? `#${c.slice(0, 6)}` : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Browse = { agents: any[]; maps: any[]; weapons: any[]; missions: any[]; contracts: any[]; seasons: any[] };
const EMPTY_BROWSE = (): Browse => ({ agents: [], maps: [], weapons: [], missions: [], contracts: [], seasons: [] });

/** Contract reward -> where a skin comes from (battle pass, event pass, agent gear). Pure. */
export function skinSourcesFromContracts(contracts: any[]): Map<string, SkinSource> {
  const out = new Map<string, SkinSource>();
  for (const c of contracts ?? []) {
    const rel = c?.content?.relationType;
    const kind: SkinSource['kind'] | undefined = rel === 'Season' ? 'battlepass' : rel === 'Event' ? 'event' : rel === 'Agent' ? 'agent' : undefined;
    if (!kind) continue;
    let n = 0;
    const add = (reward: any, level: number) => {
      const id = lc(reward?.uuid);
      if (id && String(reward?.type ?? '').includes('SkinLevel') && !out.has(id)) out.set(id, { kind, name: String(c.displayName ?? ''), level });
    };
    for (const ch of c.content?.chapters ?? []) {
      for (const l of ch?.levels ?? []) add(l?.reward, ++n);
      for (const f of ch?.freeRewards ?? []) add(f?.reward ?? f, Math.max(1, n));
    }
  }
  return out;
}

/** Public catalog from valorant-api.com. Needs no login; compact copy cached on disk. */
export class CatalogService {
  catalog: Catalog = { status: 'loading', skins: [], weapons: [], tiers: [], themes: {}, buddies: [], sprays: [], cards: [], titles: [] };
  /** Extra public data for Hub browsers + progression (kept compact). */
  browse: Browse = EMPTY_BROWSE();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
  ) {}

  /** GET with two retries; the API is public but occasionally returns 5xx or resets. */
  private async fetchJson(url: string): Promise<any> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await httpRequest(url, { timeoutMs: 30000 });
        if (r.status === 200 && r.json?.data != null) return r.json.data;
        last = new Error(`HTTP ${r.status}`);
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) {
        last = e;
      }
      await sleep(400 * (attempt + 1) ** 2);
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  load(force = false): Promise<void> {
    if (this.loading && !force) return this.loading;
    this.loading = this.doLoad(force).finally(() => (this.loading = null));
    return this.loading;
  }

  private async doLoad(force: boolean): Promise<void> {
    const file = path.join(this.dir, 'catalog.json');
    const browseFile = path.join(this.dir, 'browse.json');
    const cached = await readJson<Catalog | null>(file, null);
    const cachedBrowse = await readJson<Browse | null>(browseFile, null);
    if (cached?.skins?.length) {
      this.catalog = { ...cached, status: 'ready' };
      if (cachedBrowse) this.browse = cachedBrowse;
      this.onChange();
      const age = cached.fetchedAt ? Date.now() - cached.fetchedAt : Infinity;
      const outdated = cached.schema !== SCHEMA; // built by an older app version: rebuild now
      if (!force && !outdated && age < CHECK_EVERY) return;
      // Cheap check first: same game version and not too old -> nothing to rebuild.
      if (!force && !outdated && cached.version && age < HARD_MAX_AGE) {
        const live = await this.fetchJson(`${BASE}/version`).catch(() => null);
        if (live && String(live.version) === cached.version) {
          this.catalog = { ...this.catalog, fetchedAt: Date.now() };
          await writeJson(file, this.catalog);
          log.info(`catalog: game version unchanged (${cached.version}), cache kept`);
          return;
        }
        if (!live) return; // offline: keep what we have
      }
    }
    try {
      await this.rebuild(cached, cachedBrowse);
      await writeJson(file, this.catalog);
      await writeJson(browseFile, this.browse);
    } catch (e) {
      log.warn('catalog fetch failed', e);
      if (!this.catalog.skins.length) this.catalog = { ...this.catalog, status: 'error', error: (e as Error).message };
    }
    this.onChange();
  }

  private async rebuild(cached: Catalog | null, cachedBrowse: Browse | null): Promise<void> {
    const names = ['weapons', 'contenttiers', 'themes', 'buddies', 'sprays', 'playercards', 'playertitles', 'agents?isPlayableCharacter=true', 'maps', 'missions', 'contracts', 'seasons', 'version'] as const;
    const settled = await Promise.allSettled(names.map((n) => this.fetchJson(`${BASE}/${n}`)));
    const got = (n: (typeof names)[number]): any[] | null => {
      const r = settled[names.indexOf(n)];
      return r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : null;
    };
    const failed = names.filter((n, i) => settled[i].status === 'rejected' && n !== 'version');
    // Skins live inside weapons, tiers colour them: without these the catalog is useless.
    const weapons = got('weapons');
    const tiers = got('contenttiers');
    if (!weapons || !tiers) throw new Error(`catalog: ${failed.join(', ') || 'weapons'} unavailable`);
    if (failed.length) log.warn(`catalog: partial refresh, kept cached ${failed.join(', ')}`);
    const versionRes = settled[names.indexOf('version')];
    const version = versionRes.status === 'fulfilled' ? str((versionRes.value as any)?.version) : cached?.version;

    const themes = got('themes');
    const buddies = got('buddies');
    const sprays = got('sprays');
    const cards = got('playercards');
    const titles = got('playertitles');
    const agents = got('agents?isPlayableCharacter=true');
    const maps = got('maps');
    const missions = got('missions');
    const contracts = got('contracts');
    const seasons = got('seasons');

    const firstSeenFile = path.join(this.dir, 'first-seen.json');
    const firstSeen = await readJson<Record<string, number>>(firstSeenFile, {});
    const now = Date.now();
    let newCount = 0;
    const outWeapons: CatalogWeapon[] = [];
    const skins: CatalogSkin[] = [];
    let order = 0;
    for (const w of weapons) {
      const std = (Array.isArray(w.skins) ? w.skins : []).find((s: any) => lc(s.uuid) === lc(w.defaultSkinUuid));
      outWeapons.push({
        id: lc(w.uuid),
        name: w.displayName,
        category: String(w.category ?? '').split('::').pop() ?? '',
        icon: str(w.displayIcon),
        defaultSkinId: lc(w.defaultSkinUuid),
        defaultSkin: std ? { id: lc(std.uuid), levelId: lc(std.levels?.[0]?.uuid), chromaId: lc(std.chromas?.[0]?.uuid), icon: str(std.chromas?.[0]?.fullRender) ?? str(std.displayIcon) ?? str(w.displayIcon) } : undefined,
      });
      for (const s of Array.isArray(w.skins) ? w.skins : []) {
        if (!s?.contentTierUuid) continue; // Standard + "Random Favorite" placeholders
        const id = lc(s.uuid);
        if (!firstSeen[id]) {
          firstSeen[id] = cached ? now : 0; // first ever load: everything is "old"
          if (cached) newCount++;
        }
        skins.push({
          id,
          name: s.displayName,
          weaponId: lc(w.uuid),
          tierId: lc(s.contentTierUuid) || undefined,
          themeId: lc(s.themeUuid) || undefined,
          icon: str(s.displayIcon) ?? str(s.levels?.[0]?.displayIcon) ?? str(s.chromas?.[0]?.fullRender),
          wallpaper: str(s.wallpaper),
          order: order++,
          firstSeen: firstSeen[id],
          levels: (s.levels ?? []).map((l: any) => ({
            id: lc(l.uuid),
            name: l.displayName,
            item: str(l.levelItem)?.split('::').pop(),
            icon: str(l.displayIcon),
            video: str(l.streamedVideo),
          })),
          chromas: (s.chromas ?? []).map((c: any) => ({
            id: lc(c.uuid),
            name: String(c.displayName ?? '').replace(/\s+/g, ' '),
            icon: str(c.displayIcon),
            render: str(c.fullRender),
            swatch: str(c.swatch),
            video: str(c.streamedVideo),
          })),
        });
      }
    }
    await writeJson(firstSeenFile, firstSeen);

    // Contract rewards: tells the UI "Battle Pass · Dimension Act 2" instead of a missing price.
    const contractList = contracts ?? cachedBrowse?.contracts ?? [];
    const sources = skinSourcesFromContracts(contracts ?? []);
    if (sources.size) {
      for (const s of skins) {
        const hit = s.levels.map((l) => sources.get(l.id)).find(Boolean);
        if (hit) s.source = hit;
      }
    } else if (cached?.skins) {
      const prev = new Map(cached.skins.map((s) => [s.id, s.source]));
      for (const s of skins) if (prev.get(s.id)) s.source = prev.get(s.id);
    }

    const outTiers: CatalogTier[] = tiers.map((t: any) => ({
      id: lc(t.uuid),
      name: t.devName ?? t.displayName,
      color: hex(t.highlightColor),
      icon: str(t.displayIcon),
      rank: TIER_RANK[t.devName] ?? (Number(t.rank) || 0),
    }));
    const extra = (kind: CatalogExtra['kind'], list: any[] | null, map: (x: any) => Partial<CatalogExtra>): CatalogExtra[] =>
      (list ?? []).map((x) => ({
        kind,
        id: lc(x.uuid),
        name: x.displayName ?? x.titleText ?? 'Unknown',
        themeId: lc(x.themeUuid) || undefined,
        ownIds: [lc(x.uuid), ...(Array.isArray(x.levels) ? x.levels.map((l: any) => lc(l.uuid)) : [])],
        ...map(x),
      }));
    const keep = <T>(fresh: T[], old: T[] | undefined, fell: boolean): T[] => (fell && old ? old : fresh);
    this.catalog = {
      status: 'ready',
      fetchedAt: now,
      version,
      schema: SCHEMA,
      skins,
      weapons: outWeapons,
      tiers: outTiers,
      themes: themes ? Object.fromEntries(themes.map((t: any) => [lc(t.uuid), t.displayName])) : (cached?.themes ?? {}),
      buddies: keep(extra('buddy', buddies, (b) => ({ icon: str(b.displayIcon), levelId: lc(b.levels?.[0]?.uuid) || undefined })), cached?.buddies, !buddies),
      sprays: keep(
        extra('spray', (sprays ?? []).filter((s: any) => !s.isNullSpray), (s) => ({
          icon: str(s.fullTransparentIcon) ?? str(s.displayIcon) ?? str(s.fullIcon),
          anim: str(s.animationGif) ?? str(s.animationPng),
        })),
        cached?.sprays,
        !sprays,
      ),
      cards: keep(extra('card', cards, (c) => ({ icon: str(c.smallArt) ?? str(c.displayIcon), wide: str(c.wideArt), large: str(c.largeArt) })), cached?.cards, !cards),
      titles: keep(
        extra('title', (titles ?? []).filter((t: any) => t.titleText), (t) => ({ text: t.titleText, name: t.titleText })),
        cached?.titles,
        !titles,
      ),
    };
    const old = cachedBrowse ?? EMPTY_BROWSE();
    this.browse = {
      agents: agents
        ? agents.map((a: any) => ({
            id: lc(a.uuid),
            name: a.displayName,
            role: a.role?.displayName,
            roleIcon: str(a.role?.displayIcon),
            description: a.description,
            icon: str(a.displayIcon),
            portrait: str(a.fullPortrait),
            background: str(a.background),
            colors: a.backgroundGradientColors,
            abilities: (a.abilities ?? []).map((ab: any) => ({ slot: ab.slot, name: ab.displayName, description: ab.description, icon: str(ab.displayIcon) })),
          }))
        : old.agents,
      maps: maps
        ? maps.filter((m: any) => m.tacticalDescription).map((m: any) => ({ id: m.mapUrl, uuid: lc(m.uuid), name: m.displayName, sites: m.tacticalDescription, splash: str(m.splash), icon: str(m.displayIcon), coordinates: m.coordinates }))
        : old.maps,
      weapons: weapons.map((w: any) => ({
        id: lc(w.uuid),
        name: w.displayName,
        category: String(w.category ?? '').split('::').pop(),
        icon: str(w.displayIcon),
        cost: w.shopData?.cost ?? null,
        stats: w.weaponStats
          ? {
              fireRate: w.weaponStats.fireRate,
              magazine: w.weaponStats.magazineSize,
              reload: w.weaponStats.reloadTimeSeconds,
              equip: w.weaponStats.equipTimeSeconds,
              damage: (w.weaponStats.damageRanges ?? []).map((d: any) => ({ range: `${d.rangeStartMeters}-${d.rangeEndMeters}m`, head: d.headDamage, body: d.bodyDamage, leg: d.legDamage })),
            }
          : null,
      })),
      missions: missions
        ? missions.map((m: any) => ({
            id: lc(m.uuid),
            title: m.title ?? m.displayName ?? 'Mission',
            type: String(m.type ?? '').split('::').pop(),
            xp: Number(m.xpGrant) || 0,
            target: Number(m.progressToComplete) || 0,
            activation: str(m.activationDate),
            expiration: str(m.expirationDate),
            objectives: (m.objectives ?? []).map((o: any) => ({ id: lc(o.objectiveUuid), value: Number(o.value) || 0 })),
          }))
        : old.missions,
      contracts: contracts
        ? contractList.map((c: any) => ({
            id: lc(c.uuid),
            name: c.displayName,
            icon: str(c.displayIcon),
            relationType: c.content?.relationType ?? null,
            relationId: lc(c.content?.relationUuid) || undefined,
            levels: (c.content?.chapters ?? []).flatMap((ch: any) => (ch.levels ?? []).map((l: any) => ({ xp: Number(l.xp) || 0, rewardType: l.reward?.type, rewardId: lc(l.reward?.uuid) }))),
          }))
        : old.contracts,
      seasons: seasons
        ? seasons.map((s: any) => ({
            id: lc(s.uuid),
            name: s.displayName,
            title: s.title,
            type: String(s.type ?? '').split('::').pop(),
            start: s.startTime,
            end: s.endTime,
            parentId: lc(s.parentUuid) || undefined,
          }))
        : old.seasons,
    };
    log.info(
      `catalog: ${skins.length} skins (${skins.filter((s) => s.source).length} contract rewards), ${this.catalog.buddies.length} buddies, ${this.catalog.sprays.length} sprays, ${this.catalog.cards.length} cards, ${this.catalog.titles.length} titles${newCount ? `, ${newCount} new` : ''}${version ? `, ${version}` : ''}`,
    );
  }

  /** Reward display for contract levels. */
  rewardName(type: string | undefined, id: string | undefined): { name: string; icon?: string } {
    if (!id) return { name: type ?? 'Reward' };
    const t = String(type ?? '');
    if (t.includes('Skin')) {
      const s = this.catalog.skins.find((x) => x.levels.some((l) => l.id === id) || x.id === id);
      if (s) return { name: s.name, icon: s.icon };
    }
    for (const list of [this.catalog.buddies, this.catalog.sprays, this.catalog.cards, this.catalog.titles]) {
      const x = list.find((i) => i.ownIds.includes(id));
      if (x) return { name: x.name, icon: x.icon };
    }
    if (t === 'Currency') return { name: 'Radianite / currency' };
    if (t === 'Character') return { name: this.browse.agents.find((a) => a.id === id)?.name ?? 'Agent' };
    return { name: t || 'Reward' };
  }
}

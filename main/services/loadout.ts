import crypto from 'node:crypto';
import type { LoadoutPreset, LoadoutView } from '../../shared/features';
import type { RiotApi } from '../riot/api';
import { HttpError } from '../riot/http';
import { readJson, writeJson } from '../paths';

/** Item type of sprays inside `ActiveExpressions` (same id as the spray entitlement type). */
export const SPRAY_TYPE = 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475';

const s = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
const isSpray = (e: any) => s(e?.TypeID) === SPRAY_TYPE;

/**
 * Pure: Riot playerloadout JSON -> view.
 * v3 (current): Guns, ActiveExpressions[{TypeID, AssetID}], DynamicOptions, Identity, Incognito.
 * v2 (retired): Sprays[{EquipSlotID, SprayID}] instead of ActiveExpressions. Both are understood.
 */
export function parseLoadout(j: any, api: 'v3' | 'v2' = 'v3'): LoadoutView {
  const sprays: LoadoutView['sprays'] = [];
  if (Array.isArray(j?.ActiveExpressions)) {
    for (const e of j.ActiveExpressions) if (isSpray(e)) sprays.push({ slot: sprays.length, sprayId: s(e.AssetID) });
  } else if (Array.isArray(j?.Sprays)) {
    j.Sprays.forEach((x: any, i: number) => sprays.push({ slot: i, sprayId: s(x?.SprayID) }));
  }
  return {
    status: 'ready',
    api,
    version: Number(j?.Version) || undefined,
    guns: (Array.isArray(j?.Guns) ? j.Guns : []).map((g: any) => ({
      weaponId: s(g.ID),
      skinId: s(g.SkinID),
      skinLevelId: s(g.SkinLevelID),
      chromaId: s(g.ChromaID),
      charmId: g.CharmID ? s(g.CharmID) : undefined,
      charmLevelId: g.CharmLevelID ? s(g.CharmLevelID) : undefined,
      charmInstanceId: g.CharmInstanceID ? s(g.CharmInstanceID) : undefined,
      attachments: Array.isArray(g.Attachments) ? g.Attachments : [],
    })),
    sprays,
    cardId: s(j?.Identity?.PlayerCardID) || undefined,
    titleId: s(j?.Identity?.PlayerTitleID) || undefined,
    levelBorderId: s(j?.Identity?.PreferredLevelBorderID) || undefined,
    accountLevel: Number(j?.Identity?.AccountLevel) || undefined,
    hideAccountLevel: j?.Identity?.HideAccountLevel === true,
    incognito: j?.Incognito === true,
  };
}

/**
 * Pure: the PUT body = Riot's own current loadout object with only our edits merged in.
 * Everything we do not model (Subject, Version, DynamicOptions, unknown future fields, guns the
 * user did not touch) is carried through untouched, so a schema change cannot silently wipe it.
 */
export function mergeLoadout(raw: any, v: LoadoutView): any {
  const out = JSON.parse(JSON.stringify(raw ?? {}));
  const byWeapon = new Map(v.guns.map((g) => [g.weaponId, g]));
  // Only write a field when it really differs (ids compare case-insensitively), so an unedited
  // loadout merges to exactly what Riot sent and a "no-op apply" is a true no-op.
  out.Guns = (Array.isArray(out.Guns) ? out.Guns : []).map((rg: any) => {
    const g = byWeapon.get(s(rg?.ID));
    if (!g) return rg;
    const wantCharm = !!(g.charmId && g.charmLevelId && g.charmInstanceId);
    const same =
      s(rg.SkinID) === g.skinId &&
      s(rg.SkinLevelID) === g.skinLevelId &&
      s(rg.ChromaID) === g.chromaId &&
      (wantCharm ? s(rg.CharmID) === g.charmId && s(rg.CharmLevelID) === g.charmLevelId && s(rg.CharmInstanceID) === g.charmInstanceId : !rg.CharmID && !rg.CharmLevelID && !rg.CharmInstanceID);
    if (same) return rg;
    const next = { ...rg, SkinID: g.skinId, SkinLevelID: g.skinLevelId, ChromaID: g.chromaId };
    if (wantCharm) {
      next.CharmID = g.charmId;
      next.CharmLevelID = g.charmLevelId;
      next.CharmInstanceID = g.charmInstanceId;
    } else {
      delete next.CharmID;
      delete next.CharmLevelID;
      delete next.CharmInstanceID;
    }
    return next;
  });
  if (Array.isArray(out.ActiveExpressions)) {
    let i = 0;
    out.ActiveExpressions = out.ActiveExpressions.map((e: any) => {
      if (!isSpray(e)) return e;
      const slot = i++; // once per spray expression (not once per candidate inside find)
      const want = v.sprays.find((x) => x.slot === slot);
      return want?.sprayId && s(e.AssetID) !== want.sprayId ? { ...e, AssetID: want.sprayId } : e;
    });
  } else if (Array.isArray(out.Sprays)) {
    out.Sprays = out.Sprays.map((e: any, i: number) => {
      const want = v.sprays.find((x) => x.slot === i);
      return want?.sprayId && s(e.SprayID) !== want.sprayId ? { ...e, SprayID: want.sprayId } : e;
    });
  }
  const id = { ...(out.Identity ?? {}) };
  if (v.cardId && s(id.PlayerCardID) !== v.cardId) id.PlayerCardID = v.cardId;
  if (v.titleId && s(id.PlayerTitleID) !== v.titleId) id.PlayerTitleID = v.titleId;
  if (v.levelBorderId && s(id.PreferredLevelBorderID) !== v.levelBorderId) id.PreferredLevelBorderID = v.levelBorderId;
  if ((id.HideAccountLevel === true) !== (v.hideAccountLevel === true)) id.HideAccountLevel = v.hideAccountLevel === true;
  out.Identity = id;
  if ((out.Incognito === true) !== (v.incognito === true)) out.Incognito = v.incognito === true;
  return out;
}

/** Presets saved before v3 stored sprays as {slot: <uuid>}; slots are indexes now. */
export function normalizeView(v: any): LoadoutView {
  const sprays = (Array.isArray(v?.sprays) ? v.sprays : []).map((x: any, i: number) => ({ slot: typeof x?.slot === 'number' ? x.slot : i, sprayId: s(x?.sprayId) }));
  return { ...v, status: 'ready', error: undefined, sprays };
}

/** Human message for a failed write. */
function explain(e: unknown): string {
  if (e instanceof HttpError) {
    let detail = '';
    try {
      detail = (JSON.parse(e.body)?.message as string) ?? '';
    } catch {
      detail = e.body.slice(0, 120);
    }
    if (e.status === 404) return 'Riot does not know this loadout endpoint for your account (HTTP 404).';
    return `Riot refused the change (HTTP ${e.status}${detail ? `: ${detail}` : ''}).`;
  }
  return (e as Error)?.message ?? 'Unknown error';
}

export class LoadoutService {
  view: LoadoutView = { status: 'idle', guns: [], sprays: [] };

  constructor(
    private readonly api: RiotApi,
    private readonly presetFile: string,
    private readonly afterChange: () => void,
  ) {}

  async refresh(): Promise<LoadoutView> {
    try {
      const r = await this.api.loadout();
      this.view = parseLoadout(r.json, r.apiVersion);
    } catch (e) {
      this.view = { ...this.view, status: 'error', error: explain(e) };
    }
    return this.view;
  }

  /** Manual "Apply": read the live loadout (fresh Version), merge our edits, PUT, confirm. */
  async apply(next: LoadoutView): Promise<LoadoutView> {
    const live = await this.api.loadout();
    const body = mergeLoadout(live.json, next);
    let res;
    try {
      res = await this.api.setLoadout(body);
    } catch (e) {
      // Some deployments want the body without the read-only fields; retry once that way.
      if (e instanceof HttpError && (e.status === 400 || e.status === 422)) {
        const lean = { ...body };
        delete lean.Subject;
        delete lean.Version;
        try {
          res = await this.api.setLoadout(lean);
        } catch (e2) {
          throw new Error(explain(e2));
        }
      } else {
        throw new Error(explain(e));
      }
    }
    const after = res.json?.Guns ? res.json : (await this.api.loadout()).json;
    this.view = parseLoadout(after, live.apiVersion);
    this.afterChange();
    return this.view;
  }

  async presets(): Promise<LoadoutPreset[]> {
    const list = await readJson<LoadoutPreset[]>(this.presetFile, []);
    return list.map((p) => ({ ...p, loadout: normalizeView(p.loadout) }));
  }

  async savePreset(name: string, loadout: LoadoutView): Promise<LoadoutPreset[]> {
    const list = await this.presets();
    list.push({ id: crypto.randomUUID(), name: name.trim() || 'Preset', createdAt: Date.now(), loadout: normalizeView(loadout) });
    await writeJson(this.presetFile, list);
    return list;
  }

  async deletePreset(id: string): Promise<LoadoutPreset[]> {
    const list = (await this.presets()).filter((p) => p.id !== id);
    await writeJson(this.presetFile, list);
    return list;
  }
}

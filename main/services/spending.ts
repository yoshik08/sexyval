import { BrowserWindow } from 'electron';
import { httpRequest } from '../riot/http';
import { ITEM_TYPES, type RiotApi } from '../riot/api';
import { parseOwnedItems } from '../../shared/collection';
import { FALLBACK_FX, mergePurchases, parsePurchases, type FxRates, type VpPurchase } from '../../shared/spending';
import type { SpendingState } from '../../shared/features';
import type { CatalogService } from './catalog';
import { readJson, writeJson } from '../paths';
import { log } from '../log';

/** Riot's own purchase-history article; the "Get my purchase history" button is on it (needs your Riot login). */
export const RIOT_PURCHASE_HISTORY = 'https://support.riotgames.com/en-us/valorant/billing/checking-your-purchase-history';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';
const FX_TTL = 12 * 60 * 60 * 1000;

interface Stored {
  purchases: VpPurchase[];
  /** User override for the Battle Pass count (the entitlement count is a best guess). */
  battlePassOverride?: number;
}

/**
 * Spending tab. Purchases come from Riot's support site (opened in a window with its own cookie jar; the
 * user signs in there, SexyVal only reads the page text when asked), from pasted text, or by hand.
 * Exchange rates: ECB reference rates via Frankfurter, cached 12 h, with built-in fallback numbers.
 */
export class SpendingService {
  private fx: FxRates = FALLBACK_FX;
  private fxAt = 0;
  private win: BrowserWindow | null = null;
  private bp: { at: number; puuid: string; count?: number; error?: string } | null = null;

  constructor(
    private readonly api: RiotApi,
    private readonly catalog: CatalogService,
    private readonly file: string,
    private readonly fxFile: string,
    private readonly onChange: () => void,
  ) {}

  private load(): Promise<Stored> {
    return readJson<Stored>(this.file, { purchases: [] });
  }

  private async rates(): Promise<FxRates> {
    if (Date.now() - this.fxAt < FX_TTL) return this.fx;
    const disk = await readJson<{ at: number; fx: FxRates } | null>(this.fxFile, null);
    if (disk && Date.now() - disk.at < FX_TTL) {
      this.fx = disk.fx;
      this.fxAt = disk.at;
      return this.fx;
    }
    try {
      const r = await httpRequest(FX_URL, { timeoutMs: 10000 });
      const rates = r.json?.rates;
      if (r.status === 200 && rates && typeof rates.INR === 'number') {
        this.fx = { date: String(r.json.date ?? ''), rates: { USD: 1, ...rates } };
        this.fxAt = Date.now();
        await writeJson(this.fxFile, { at: this.fxAt, fx: this.fx }).catch(() => undefined);
      } else throw new Error(`rates answered ${r.status}`);
    } catch (e) {
      log.warn('fx rates failed', e);
      if (disk) this.fx = disk.fx;
      this.fxAt = Date.now() - FX_TTL + 10 * 60 * 1000; // retry in 10 min
    }
    return this.fx;
  }

  /** Premium Battle Passes on the account: owned contract entitlements that are season (Battle Pass) contracts. */
  private async battlePasses(): Promise<{ count?: number; error?: string }> {
    const puuid = this.api.session.puuid;
    if (!puuid) return { error: 'Needs the Riot Client or a sign-in' };
    if (this.bp && this.bp.puuid === puuid && Date.now() - this.bp.at < 10 * 60 * 1000) return this.bp;
    try {
      const res = await this.api.ownedItems(ITEM_TYPES.contracts);
      const ids = new Set(parseOwnedItems(res.json, ITEM_TYPES.contracts).items.map((i) => i.itemId));
      const count = this.catalog.browse.contracts.filter((c: any) => c.relationType === 'Season' && ids.has(c.id)).length;
      this.bp = { at: Date.now(), puuid, count };
    } catch (e) {
      this.bp = { at: Date.now(), puuid, error: (e as Error).message };
    }
    return this.bp;
  }

  async state(): Promise<SpendingState> {
    const [s, fx, bp] = await Promise.all([this.load(), this.rates(), this.battlePasses()]);
    return {
      purchases: s.purchases,
      fx,
      battlePasses: s.battlePassOverride ?? bp.count,
      battlePassesDetected: bp.count,
      battlePassOverride: s.battlePassOverride,
      battlePassError: bp.error,
      region: this.api.session.region ?? undefined,
      riotWindowOpen: !!this.win && !this.win.isDestroyed(),
    };
  }

  private async save(s: Stored): Promise<SpendingState> {
    await writeJson(this.file, s);
    this.onChange();
    return this.state();
  }

  async add(p: Partial<VpPurchase>): Promise<SpendingState> {
    const vp = Math.round(Number(p.vp));
    const at = Number(p.at);
    if (!(vp > 0 && vp < 1_000_000) || !Number.isFinite(at)) throw new Error('Needs a date and a VP amount');
    const amount = p.amount != null && p.amount !== ('' as any) ? Number(p.amount) : undefined;
    if (amount != null && !(amount >= 0 && amount < 10_000_000)) throw new Error('Bad amount');
    const cur = typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : undefined;
    const s = await this.load();
    s.purchases = [{ id: `manual-${Date.now().toString(36)}`, at, vp, amount, currency: amount != null ? cur : undefined, note: typeof p.note === 'string' ? p.note.slice(0, 80) : undefined, source: 'manual' as const }, ...s.purchases].sort((a, b) => b.at - a.at);
    return this.save(s);
  }

  async remove(id: string): Promise<SpendingState> {
    const s = await this.load();
    s.purchases = s.purchases.filter((p) => p.id !== id);
    return this.save(s);
  }

  async setRefunded(id: string, refunded: boolean): Promise<SpendingState> {
    const s = await this.load();
    s.purchases = s.purchases.map((p) => (p.id === id ? { ...p, refunded: refunded || undefined } : p));
    return this.save(s);
  }

  async clear(): Promise<SpendingState> {
    const s = await this.load();
    s.purchases = [];
    return this.save(s);
  }

  async setBattlePasses(n: number | null): Promise<SpendingState> {
    const s = await this.load();
    s.battlePassOverride = n == null ? undefined : Math.max(0, Math.min(200, Math.round(n)));
    return this.save(s);
  }

  /** Parse only (preview); `commit` merges what was parsed. */
  preview(text: string, dayFirst: boolean, source: VpPurchase['source'] = 'paste'): VpPurchase[] {
    return parsePurchases(text.slice(0, 500_000), source, dayFirst);
  }

  async commit(rows: VpPurchase[]): Promise<{ state: SpendingState; added: number }> {
    const clean = (Array.isArray(rows) ? rows : [])
      .slice(0, 2000)
      .filter((r) => r && Number.isFinite(r.at) && r.vp > 0)
      .map((r) => ({ id: String(r.id).slice(0, 80), at: Number(r.at), vp: Math.round(Number(r.vp)), amount: r.amount != null ? Number(r.amount) : undefined, currency: typeof r.currency === 'string' ? r.currency.slice(0, 3) : undefined, source: r.source === 'riot' ? 'riot' : 'paste', refunded: r.refunded ? true : undefined }) as VpPurchase);
    const s = await this.load();
    const { list, added } = mergePurchases(s.purchases, clean);
    s.purchases = list;
    return { state: await this.save(s), added };
  }

  /** Riot's purchase history in its own window (persistent partition: the sign-in is remembered). */
  openRiot(parent: BrowserWindow | null): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 1100,
      height: 820,
      parent: parent ?? undefined,
      title: 'Riot purchase history',
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: { partition: 'persist:riot-support', contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      // Keep Riot's own pages (login, support) in this window; nothing else opens.
      if (/^https:\/\/([a-z0-9-]+\.)*riotgames\.com\//i.test(url)) void this.win?.loadURL(url);
      return { action: 'deny' };
    });
    this.win.on('closed', () => {
      this.win = null;
      this.onChange();
    });
    void this.win.loadURL(RIOT_PURCHASE_HISTORY).catch(() => undefined);
    this.onChange();
  }

  /** Text of the open Riot window, every frame (the history may sit in an embedded frame), parsed. */
  async scanRiot(dayFirst: boolean): Promise<VpPurchase[]> {
    const w = this.win;
    if (!w || w.isDestroyed()) throw new Error('Open Riot’s purchase history first');
    const frames = w.webContents.mainFrame.framesInSubtree;
    const texts = await Promise.all(frames.map((f) => f.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '')));
    const text = texts.filter((t): t is string => typeof t === 'string').join('\n');
    return this.preview(text, dayFirst, 'riot');
  }
}

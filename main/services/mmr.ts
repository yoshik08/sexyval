import type { MmrState } from '../../shared/types';
import { actLabel, currentAndPeak } from '../../shared/stats';
import type { RiotApi } from '../riot/api';
import type { AssetService } from './assets';
import type { CatalogService } from './catalog';
import { log } from '../log';

const TTL = 10 * 60 * 1000;
const ERROR_RETRY = 30_000;

interface Entry {
  status: MmrState['status'];
  at: number;
  currentTier: number;
  rr: number;
  peakTier: number;
  peakSeasonId?: string;
  error?: string;
}

/**
 * Current + peak rank per player for Live rows, from `mmr/v1/players/{puuid}`. Cached 10 minutes
 * per PUUID; requests go through the pd rate limiter like every other pd call. Callers must not
 * pass hidden (incognito) players; GameLoop.lookup() filters them out before this.
 */
export class MmrService {
  private entries = new Map<string, Entry>();
  private inflight = new Set<string>();

  constructor(
    private readonly api: RiotApi,
    private readonly assets: AssetService,
    private readonly catalog: CatalogService,
    private readonly onChange: () => void,
  ) {}

  private currentActId(): string | undefined {
    const now = Date.now();
    return this.catalog.browse.seasons.find((s: any) => s.type === 'Act' && Date.parse(s.start) <= now && now < Date.parse(s.end))?.id;
  }

  ensure(puuid: string): void {
    if (!puuid || this.inflight.has(puuid)) return;
    const e = this.entries.get(puuid);
    if (e && e.status === 'done' && Date.now() - e.at < TTL) return;
    if (e && e.status === 'error' && Date.now() - e.at < ERROR_RETRY) return;
    this.inflight.add(puuid);
    if (!e) this.entries.set(puuid, { status: 'loading', at: Date.now(), currentTier: 0, rr: 0, peakTier: 0 });
    void this.load(puuid).finally(() => this.inflight.delete(puuid));
  }

  private async load(puuid: string): Promise<void> {
    try {
      const res = await this.api.mmr(puuid);
      const r = currentAndPeak(res.json, this.currentActId());
      this.entries.set(puuid, { status: 'done', at: Date.now(), ...r });
    } catch (err) {
      const prev = this.entries.get(puuid);
      // Keep a previous good answer on screen; only a first failure shows "—".
      if (prev?.status === 'done') prev.at = Date.now() - TTL + ERROR_RETRY;
      else this.entries.set(puuid, { status: 'error', at: Date.now(), currentTier: 0, rr: 0, peakTier: 0, error: (err as Error).message });
      log.warn(`mmr ${puuid.slice(0, 8)} failed`, err);
    }
    this.onChange();
  }

  get(puuid: string): MmrState | undefined {
    const e = this.entries.get(puuid);
    if (!e) return undefined;
    if (e.status !== 'done') return { status: e.status, error: e.error };
    return {
      status: 'done',
      current: { rank: e.currentTier ? this.assets.rank(e.currentTier) : undefined, rr: e.rr },
      peak: { rank: e.peakTier ? this.assets.rank(e.peakTier) : undefined, act: actLabel(this.catalog.browse.seasons, e.peakSeasonId) },
    };
  }
}

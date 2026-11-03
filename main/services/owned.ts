import { parseOwnedItems } from '../../shared/collection';
import type { OwnedState } from '../../shared/features';
import { ITEM_TYPES, type RiotApi } from '../riot/api';
import { log } from '../log';

const TTL = 10 * 60 * 1000;

const EMPTY = (): OwnedState => ({
  status: 'idle',
  levels: [],
  chromas: [],
  buddies: [],
  sprays: [],
  cards: [],
  titles: [],
  agents: [],
  buddyInstances: {},
  shapes: {},
});

/** Owned items per type. Cached 10 min; refreshed after store/loadout changes. */
export class OwnedService {
  state: OwnedState = EMPTY();
  private inflight: Promise<OwnedState> | null = null;
  private puuid: string | null = null;

  constructor(
    private readonly api: RiotApi,
    private readonly onChange: (s: OwnedState) => void,
  ) {}

  signedOut(): void {
    this.puuid = null;
    this.state = { ...EMPTY(), status: 'signed-out' };
    this.onChange(this.state);
  }

  /** Call when the active account may have changed; refreshes if puuid differs or cache is stale. */
  ensure(puuid: string): void {
    if (puuid !== this.puuid) {
      this.puuid = puuid;
      this.state = EMPTY();
    }
    if (this.state.status === 'ready' && this.state.fetchedAt && Date.now() - this.state.fetchedAt < TTL) return;
    void this.refresh();
  }

  refresh(): Promise<OwnedState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doRefresh(): Promise<OwnedState> {
    if (!this.api.session.puuid) {
      this.signedOut();
      return this.state;
    }
    this.state = { ...this.state, status: 'loading' };
    this.onChange(this.state);
    const next = EMPTY();
    const types: [keyof typeof ITEM_TYPES, keyof OwnedState][] = [
      ['skins', 'levels'],
      ['chromas', 'chromas'],
      ['buddies', 'buddies'],
      ['sprays', 'sprays'],
      ['cards', 'cards'],
      ['titles', 'titles'],
      ['agents', 'agents'],
    ];
    let failures = 0;
    await Promise.all(
      types.map(async ([type, key]) => {
        try {
          const res = await this.api.ownedItems(ITEM_TYPES[type]);
          const { items, shape } = parseOwnedItems(res.json, ITEM_TYPES[type]);
          next.shapes[type] = `${shape} (${items.length})`;
          (next[key] as string[]).push(...items.map((i) => i.itemId));
          if (type === 'buddies') {
            for (const i of items) if (i.instanceId) (next.buddyInstances[i.itemId] ??= []).push(i.instanceId);
          }
        } catch (e) {
          failures++;
          next.shapes[type] = `error: ${(e as Error).message}`;
          log.warn(`owned ${type} failed`, e);
        }
      }),
    );
    next.fetchedAt = Date.now();
    next.status = failures === types.length ? 'error' : 'ready';
    if (failures) next.error = `${failures} item type(s) failed; see Debug`;
    this.state = next;
    this.onChange(this.state);
    return this.state;
  }
}

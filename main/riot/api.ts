import { RateLimiter, withRetry } from '../../shared/rateLimit';
import { httpRequest, safePath, HttpError, type HttpResult } from './http';
import { RiotSession, WaitingError } from './session';
import { log } from '../log';

type Kind = 'glz' | 'pd' | 'shared';

export const ITEM_TYPES = {
  agents: '01bb38e1-da47-4e6a-9b3d-945fe4655707',
  contracts: 'f85cb6f7-33e5-4dc8-b609-ec7212301948',
  sprays: 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475',
  buddies: 'dd3bf334-87f3-40bd-b043-682a57a8dc3a',
  cards: '3f296c07-64c3-494c-923b-fe692a4fa1bd',
  skins: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433',
  chromas: '3ad1b2b2-acdb-4524-852f-954a76ddae0a',
  titles: 'de7caa6b-adf7-4588-bbd1-143831e786c6',
} as const;

const enc = encodeURIComponent;

/**
 * Thin wrapper over glz/pd/shared + the local Riot Client API.
 * Endpoints and shapes follow valapidocs.techchrism.me / valorant-api-types (unofficial; may change).
 */
export class RiotApi {
  readonly glzLimiter = new RateLimiter({ concurrency: 2 });
  readonly pdLimiter = new RateLimiter({ concurrency: 4 });
  private lastForcedRefresh = 0;
  /** pd requests started (each call, plus the resend after a token refresh). Debug counts only. */
  pdCalls = 0;

  constructor(
    readonly session: RiotSession,
    private readonly onRaw: (key: string, data: unknown) => void,
  ) {}

  async call(kind: Kind, method: string, path: string, body?: unknown, retries = 3): Promise<HttpResult> {
    const limiter = kind === 'glz' ? this.glzLimiter : this.pdLimiter;
    const send = () =>
      withRetry(() => httpRequest(this.session.base(kind) + path, { method, headers: this.session.headers(), body }), {
        limiter,
        maxRetries: retries,
      });
    if (kind === 'pd') this.pdCalls++;
    let res = await send();
    if ((res.status === 400 || res.status === 401) && Date.now() - this.lastForcedRefresh > 30_000) {
      this.lastForcedRefresh = Date.now();
      log.warn(`${res.status} on ${safePath(res.url)}, refreshing tokens`);
      this.session.invalidateAuth();
      await this.session.refreshAuth();
      if (kind === 'pd') this.pdCalls++;
      res = await send();
    }
    return res;
  }

  /** Like call, but throws HttpError on non-2xx except allowed statuses. Raw goes to Debug. */
  async json(kind: Kind, method: string, path: string, opts: { body?: unknown; allow?: number[]; raw?: string; retries?: number } = {}): Promise<HttpResult> {
    const res = await this.call(kind, method, path, opts.body, opts.retries);
    if (opts.raw) this.onRaw(opts.raw, { status: res.status, path: safePath(res.url), body: res.json ?? res.text.slice(0, 4000) });
    if ((res.status < 200 || res.status > 299) && !(opts.allow ?? []).includes(res.status)) {
      throw new HttpError(res.status, safePath(res.url), res.text.slice(0, 500));
    }
    return res;
  }

  /** Local Riot Client API; throws WaitingError when the client isn't running. */
  async local(method: string, path: string, body?: unknown, raw?: string): Promise<HttpResult> {
    if (!this.session.localAvailable) throw new WaitingError('Needs the Riot Client running');
    const res = await this.session.local(path, { method, body });
    if (raw) this.onRaw(raw, { status: res.status, path, body: res.json ?? res.text.slice(0, 4000) });
    if (res.status < 200 || res.status > 299) throw new HttpError(res.status, path, res.text.slice(0, 500));
    return res;
  }

  private me(): string {
    const p = this.session.puuid;
    if (!p) throw new WaitingError('Not authenticated');
    return p;
  }

  // --- live (pregame / core-game) ---
  pregamePlayer(puuid: string) {
    return this.json('glz', 'GET', `/pregame/v1/players/${puuid}`, { allow: [404], raw: 'pregamePlayer', retries: 1 });
  }
  pregameMatch(id: string) {
    return this.json('glz', 'GET', `/pregame/v1/matches/${id}`, { allow: [404], raw: 'pregameMatch', retries: 1 });
  }
  coreGamePlayer(puuid: string) {
    return this.json('glz', 'GET', `/core-game/v1/players/${puuid}`, { allow: [404], raw: 'coreGamePlayer', retries: 1 });
  }
  coreGameMatch(id: string) {
    return this.json('glz', 'GET', `/core-game/v1/matches/${id}`, { allow: [404], raw: 'coreGameMatch', retries: 1 });
  }

  // --- pvp ---
  history(puuid: string, endIndex = 5, startIndex = 0, queue?: string) {
    const q = queue ? `&queue=${enc(queue)}` : '';
    return this.json('pd', 'GET', `/match-history/v1/history/${puuid}?startIndex=${startIndex}&endIndex=${endIndex}${q}`);
  }
  matchDetails(id: string) {
    return this.json('pd', 'GET', `/match-details/v1/matches/${id}`, { allow: [404] });
  }
  names(puuids: string[]) {
    return this.json('pd', 'PUT', '/name-service/v2/players', { body: puuids });
  }
  accountXp() {
    return this.json('pd', 'GET', `/account-xp/v1/players/${this.me()}`, { raw: 'accountXp' });
  }
  mmr(puuid: string) {
    return this.json('pd', 'GET', `/mmr/v1/players/${puuid}`, { raw: 'mmr' });
  }
  competitiveUpdates(puuid: string, endIndex = 20, queue = 'competitive', startIndex = 0) {
    return this.json('pd', 'GET', `/mmr/v1/players/${puuid}/competitiveupdates?startIndex=${startIndex}&endIndex=${endIndex}&queue=${enc(queue)}`, { raw: 'competitiveUpdates' });
  }
  leaderboard(seasonId: string, startIndex = 0, size = 50, query?: string) {
    const region = this.session.region ?? 'na';
    const q = query ? `&query=${enc(query)}` : '';
    return this.json('pd', 'GET', `/mmr/v1/leaderboards/affinity/${region}/queue/competitive/season/${seasonId}?startIndex=${startIndex}&size=${size}${q}`, {
      raw: 'leaderboard',
    });
  }
  content() {
    return this.json('shared', 'GET', '/content-service/v3/content', { raw: 'content' });
  }
  /**
   * Personalization moved to v3 (the game client calls it; v2 answers 404 and `Sprays` became
   * `ActiveExpressions`). v2 stays as a fallback for shards that have not moved. The version that
   * answered is remembered so the write goes to the same place.
   */
  private loadoutVersion: 'v3' | 'v2' = 'v3';
  async loadout(): Promise<HttpResult & { apiVersion: 'v3' | 'v2' }> {
    const me = this.me();
    const order: ('v3' | 'v2')[] = this.loadoutVersion === 'v2' ? ['v2', 'v3'] : ['v3', 'v2'];
    let last: HttpResult | null = null;
    for (const v of order) {
      const res = await this.json('pd', 'GET', `/personalization/${v}/players/${me}/playerloadout`, { allow: [404], raw: 'loadout', retries: 1 });
      if (res.status !== 404) {
        this.loadoutVersion = v;
        return Object.assign(res, { apiVersion: v });
      }
      last = res;
    }
    throw new HttpError(404, safePath(last?.url ?? ''), 'Neither personalization v3 nor v2 returned a loadout for this account');
  }
  setLoadout(body: unknown) {
    return this.json('pd', 'PUT', `/personalization/${this.loadoutVersion}/players/${this.me()}/playerloadout`, { body, raw: 'setLoadout', retries: 0 });
  }

  // --- store ---
  /** The game itself POSTs v3; v2 GET stays as a fallback. */
  async storefront(puuid: string): Promise<{ res: HttpResult; source: string; v2Status: number }> {
    const v3 = await this.call('pd', 'POST', `/store/v3/storefront/${puuid}`, {});
    this.onRaw('storefrontV3', { status: v3.status, path: safePath(v3.url), body: v3.json ?? v3.text.slice(0, 4000) });
    if (v3.status === 200 && v3.json) return { res: v3, source: 'v3 POST', v2Status: 0 };
    const v2 = await this.call('pd', 'GET', `/store/v2/storefront/${puuid}`);
    this.onRaw('storefrontV2', { status: v2.status, path: safePath(v2.url), body: v2.json ?? v2.text.slice(0, 4000) });
    if (v2.status === 200 && v2.json) return { res: v2, source: `v2 GET (v3 returned ${v3.status})`, v2Status: v2.status };
    throw new HttpError(v3.status, safePath(v3.url), v3.text.slice(0, 500));
  }
  /**
   * Storefront for a signed-in account that isn't the active one (stores differ per account). Same
   * v3-then-v2 order and the same pd rate limiter; the tokens are only used for this request.
   */
  async storefrontFor(auth: { accessToken: string; entitlement: string; puuid: string; region: string }): Promise<HttpResult> {
    const base = this.session.pdBaseFor(auth.region);
    const headers = this.session.headersFor(auth);
    const send = (method: string, p: string, body?: unknown) => withRetry(() => httpRequest(base + p, { method, headers, body }), { limiter: this.pdLimiter, maxRetries: 2 });
    const v3 = await send('POST', `/store/v3/storefront/${auth.puuid}`, {});
    if (v3.status === 200 && v3.json) return v3;
    const v2 = await send('GET', `/store/v2/storefront/${auth.puuid}`);
    if (v2.status === 200 && v2.json) return v2;
    throw new HttpError(v3.status, safePath(v3.url), v3.text.slice(0, 300));
  }
  wallet(puuid: string) {
    return this.json('pd', 'GET', `/store/v1/wallet/${puuid}`, { raw: 'wallet' });
  }
  ownedItems(itemTypeId: string) {
    return this.json('pd', 'GET', `/store/v1/entitlements/${this.me()}/${itemTypeId}`, { raw: `owned:${itemTypeId.slice(0, 8)}` });
  }

  // --- contracts ---
  contracts() {
    return this.json('pd', 'GET', `/contracts/v1/contracts/${this.me()}`, { raw: 'contracts' });
  }
  activateContract(contractId: string) {
    return this.json('pd', 'POST', `/contracts/v1/contracts/${this.me()}/special/${contractId}`, { raw: 'activateContract', retries: 0 });
  }

  // --- party (glz). Manual button presses only. ---
  partyPlayer() {
    return this.json('glz', 'GET', `/parties/v1/players/${this.me()}`, { allow: [404], raw: 'partyPlayer', retries: 1 });
  }
  party(partyId: string) {
    return this.json('glz', 'GET', `/parties/v1/parties/${partyId}`, { allow: [404], raw: 'party', retries: 1 });
  }
  customGameConfigs() {
    return this.json('glz', 'GET', '/parties/v1/parties/customgameconfigs', { raw: 'customGameConfigs' });
  }
  partyAction(method: string, path: string, body?: unknown) {
    return this.json('glz', method, path, { body, raw: 'partyAction', retries: 0 });
  }
}

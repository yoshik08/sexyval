import type { AppState, CoreGameView, Phase, PlayerRow, PregameView } from '../shared/types';
import { modeName, queueTag } from '../shared/queues';
import { getStartSide, isStartSideVerified } from '../shared/side';
import { HttpError } from './riot/http';
import { RiotSession, WaitingError } from './riot/session';
import type { RiotApi } from './riot/api';
import type { AssetService } from './services/assets';
import type { HistoryService, NameService } from './services/history';
import type { ShopService } from './services/shop';
import { log } from './log';

export interface LoopDeps {
  session: RiotSession;
  api: RiotApi;
  assets: AssetService;
  history: HistoryService;
  names: NameService;
  shop: ShopService;
  emit: (s: AppState) => void;
  toast: (level: 'info' | 'warn' | 'error', msg: string) => void;
  mock: boolean;
  pollMs: () => number;
  /** Tokens available for a (new) account: owned items, etc. */
  onAccount?: (puuid: string) => void;
  onNoTokens?: () => void;
}

const WAIT_MS = 3000;

interface PlayerInput {
  puuid: string;
  teamId: string;
  characterId?: string;
  selectionState?: string;
  tier?: unknown;
  incognito: boolean;
  level?: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function finite(v: unknown): number | undefined {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : undefined;
}

export class GameLoop {
  state: AppState;
  private timer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private rawPregame: { json: any; at: number } | null = null;
  private rawCore: any = null;
  private backoff = 0;
  private lastPuuid: string | null = null;
  private running = false;
  private ticking = false;

  constructor(private readonly d: LoopDeps) {
    this.state = {
      conn: { status: 'connecting', message: 'Starting…', mock: d.mock },
      phase: 'idle',
      assetsReady: d.assets.ready,
      updatedAt: Date.now(),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Force an immediate tick (used by mock controls/screenshots). */
  pollNow(): void {
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Rebuild views from the last raw JSON and push to renderer (debounced). */
  requestEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.rebuild();
      this.d.emit(this.state);
    }, 80);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let next = this.d.pollMs();
    try {
      await this.d.session.ensure();
      const me = this.d.session.puuid!;
      this.onConnected(me);
      // Only the Live view needs the game process; everything else works from tokens alone.
      let phase: Phase = 'idle';
      if (this.d.session.valorantRunning) {
        phase = await this.pollPhase(me);
      } else {
        this.rawPregame = null;
        this.rawCore = null;
        next = Math.max(next, WAIT_MS);
      }
      this.setPhase(phase);
      this.backoff = 0;
      this.state.conn = {
        ...this.connBase(),
        status: 'connected',
        message: !this.d.session.valorantRunning ? 'Valorant closed' : phase === 'idle' ? 'In menus' : phase === 'pregame' ? 'Agent select' : 'In game',
        lastPollAt: Date.now(),
      };
    } catch (e) {
      if (e instanceof WaitingError) {
        if (this.state.conn.status === 'connected') this.d.toast('warn', `Disconnected: ${e.message}`);
        this.onDisconnected();
        this.state.conn = { ...this.connBase(), status: 'waiting', message: e.message };
        this.d.onNoTokens?.();
        next = WAIT_MS;
      } else {
        const status = e instanceof HttpError ? e.status : 0;
        const transient = status === 429 || status >= 500 || status === 0;
        this.backoff = transient ? Math.min(60_000, Math.max(10_000, this.backoff * 2)) : 15_000;
        const msg = e instanceof HttpError ? `Riot API ${e.status} on ${e.path}` : `Error: ${(e as Error).message}`;
        log.error('loop tick failed', msg);
        this.d.toast(status === 429 ? 'warn' : 'error', `${msg}, retrying in ${Math.round(this.backoff / 1000)}s`);
        this.state.conn = { ...this.connBase(), status: 'error', message: msg, backoffMs: this.backoff };
        next = this.backoff;
      }
    } finally {
      this.ticking = false;
    }
    this.state.assetsReady = this.d.assets.ready;
    this.requestEmit();
    this.schedule(next);
  }

  private connBase() {
    const s = this.d.session;
    return {
      mock: this.d.mock,
      riotClient: s.riotClient,
      valorant: s.valorantRunning,
      tokenSource: s.tokenSource,
      account: s.accountLabel ?? undefined,
      regionSource: s.regionSource ?? undefined,
      region: s.region ?? undefined,
      shard: s.shard ?? undefined,
      version: s.version ?? undefined,
      versionSource: s.versionSource ?? undefined,
      puuid: s.puuid ?? undefined,
    };
  }

  private onConnected(me: string): void {
    if (this.lastPuuid === me) return;
    this.lastPuuid = me;
    log.info(`Connected (${this.d.session.tokenSource})`);
    this.d.toast('info', this.d.session.tokenSource === 'signin' ? `Signed in as ${this.d.session.accountLabel ?? 'account'}` : 'Connected to the Riot Client');
    this.d.onAccount?.(me);
    this.d.shop.start(me);
    this.d.names.request([me]);
    this.d.history.ensure(me);
  }

  private onDisconnected(): void {
    this.lastPuuid = null;
    this.rawPregame = null;
    this.rawCore = null;
    this.state.phase = 'idle';
    this.d.shop.stop();
  }

  private async pollPhase(me: string): Promise<Phase> {
    const pp = await this.d.api.pregamePlayer(me);
    const preId = pp.status === 200 ? str(pp.json?.MatchID) : '';
    if (preId) {
      const pm = await this.d.api.pregameMatch(preId);
      if (pm.status === 200 && pm.json) {
        this.rawPregame = { json: pm.json, at: Date.now() };
        this.rawCore = null;
        this.afterPregame(me, pm.json);
        return 'pregame';
      }
    }
    this.rawPregame = null;
    const cp = await this.d.api.coreGamePlayer(me);
    const coreId = cp.status === 200 ? str(cp.json?.MatchID) : '';
    if (coreId) {
      const cm = await this.d.api.coreGameMatch(coreId);
      if (cm.status === 200 && cm.json) {
        this.rawCore = cm.json;
        this.afterCore(me, cm.json);
        return 'ingame';
      }
    }
    this.rawCore = null;
    this.d.history.ensure(me);
    return 'idle';
  }

  private setPhase(phase: Phase): void {
    const prev = this.state.phase;
    if (prev === phase) return;
    log.info(`phase ${prev} -> ${phase}`);
    this.state.phase = phase;
    if (phase === 'idle' && prev === 'ingame') {
      const me = this.d.session.puuid;
      if (me) {
        this.d.history.invalidate(me);
        this.d.history.ensure(me);
      }
    }
  }

  // --- lookups ---

  private allyTeam(json: any, me: string): any {
    if (json?.AllyTeam && Array.isArray(json.AllyTeam.Players)) return json.AllyTeam;
    const teams: any[] = Array.isArray(json?.Teams) ? json.Teams : [];
    return teams.find((t) => Array.isArray(t?.Players) && t.Players.some((p: any) => p?.Subject === me)) ?? null;
  }

  private lookup(me: string, players: { puuid: string; incognito: boolean }[]): void {
    const allowed = players.filter((p) => p.puuid && (!p.incognito || p.puuid === me)).map((p) => p.puuid);
    this.d.names.request(allowed);
    for (const p of allowed) this.d.history.ensure(p);
  }

  private afterPregame(me: string, json: any): void {
    const ally = this.allyTeam(json, me);
    const players: any[] = Array.isArray(ally?.Players) ? ally.Players : [];
    // Teammates preload now; enemies are never looked up in agent select.
    this.lookup(
      me,
      players.map((p) => ({ puuid: str(p?.Subject), incognito: p?.PlayerIdentity?.Incognito === true })),
    );
  }

  private afterCore(me: string, json: any): void {
    const players: any[] = Array.isArray(json?.Players) ? json.Players : [];
    this.lookup(
      me,
      players.map((p) => ({ puuid: str(p?.Subject), incognito: p?.PlayerIdentity?.Incognito === true })),
    );
  }

  // --- view building (pure-ish, from raw JSON; safe with nulls) ---

  private row(me: string, p: PlayerInput): PlayerRow {
    const isMe = p.puuid === me;
    const hidden = p.incognito && !isMe;
    const n = hidden ? undefined : this.d.names.get(p.puuid);
    return {
      puuid: p.puuid,
      name: n?.name,
      tag: n?.tag,
      incognito: p.incognito,
      isMe,
      teamId: p.teamId,
      agent: this.d.assets.agent(p.characterId),
      selectionState: p.selectionState,
      rank: this.d.assets.rank(p.tier),
      accountLevel: p.level,
      last5: hidden ? { status: 'skipped', matches: [] } : this.d.history.get(p.puuid),
    };
  }

  private rebuild(): void {
    const me = this.d.session.puuid ?? '';
    this.state.updatedAt = Date.now();
    this.state.pregame = this.state.phase === 'pregame' && this.rawPregame ? this.buildPregame(me, this.rawPregame.json, this.rawPregame.at) : undefined;
    this.state.coregame = this.state.phase === 'ingame' && this.rawCore ? this.buildCore(me, this.rawCore) : undefined;
    this.state.me = me ? this.row(me, { puuid: me, teamId: '', incognito: false }) : undefined;
  }

  private buildPregame(me: string, json: any, at: number): PregameView {
    const ally = this.allyTeam(json, me);
    const teamId = str(ally?.TeamID);
    const players: any[] = Array.isArray(ally?.Players) ? ally.Players : [];
    const ns = finite(json?.PhaseTimeRemainingNS);
    const enemyPlayers = Array.isArray(json?.EnemyTeam?.Players) ? json.EnemyTeam.Players.length : undefined;
    const mode = str(json?.Mode);
    return {
      matchId: str(json?.ID),
      map: this.d.assets.map(str(json?.MapID)),
      mode,
      modeName: modeName(mode),
      queueId: str(json?.QueueID),
      queueTag: queueTag(json?.QueueID),
      phaseEndsAt: ns != null ? at + ns / 1e6 : undefined,
      allyTeamId: teamId,
      allies: players.map((p) =>
        this.row(me, {
          puuid: str(p?.Subject),
          teamId,
          characterId: p?.CharacterID || undefined,
          selectionState: str(p?.CharacterSelectionState),
          tier: p?.CompetitiveTier,
          incognito: p?.PlayerIdentity?.Incognito === true,
          level: finite(p?.PlayerIdentity?.AccountLevel),
        }),
      ),
      enemySize: finite(json?.EnemyTeamSize) ?? enemyPlayers ?? 5,
      enemyLocked: finite(json?.EnemyTeamLockCount) ?? 0,
      side: { side: getStartSide(teamId, str(json?.QueueID), mode), verified: isStartSideVerified(str(json?.QueueID)) },
    };
  }

  private buildCore(me: string, json: any): CoreGameView {
    const players: any[] = Array.isArray(json?.Players) ? json.Players : [];
    const myTeamId = str(players.find((p) => p?.Subject === me)?.TeamID);
    const rows = players.map((p) =>
      this.row(me, {
        puuid: str(p?.Subject),
        teamId: str(p?.TeamID),
        characterId: p?.CharacterID || undefined,
        tier: p?.SeasonalBadgeInfo?.Rank,
        incognito: p?.PlayerIdentity?.Incognito === true,
        level: finite(p?.PlayerIdentity?.AccountLevel),
      }),
    );
    const mode = str(json?.ModeID);
    return {
      matchId: str(json?.MatchID),
      map: this.d.assets.map(str(json?.MapID)),
      mode,
      modeName: modeName(mode),
      queueId: str(json?.MatchmakingData?.QueueID ?? json?.QueueID),
      queueTag: queueTag(json?.MatchmakingData?.QueueID ?? json?.QueueID),
      myTeamId,
      myTeam: rows.filter((r) => r.teamId === myTeamId),
      enemyTeam: rows.filter((r) => r.teamId !== myTeamId),
    };
  }
}

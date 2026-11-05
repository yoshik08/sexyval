import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AGENTS, BOMB_MODE, DM_MODE, MAPS, ME, nameFor, pick, rng, uuid } from './data';
import { createExtra, mockFixtures, SIGNIN_ACCESS, type Stress } from './extra';
import { attachEvents, type MockEvents } from './ws';

/** offline = Riot Client closed; noval = Riot Client open, Valorant closed; queue = party matchmaking. */
export type MockPhase = 'idle' | 'queue' | 'pregame' | 'ingame' | 'offline' | 'noval';

export interface MockOptions {
  port?: number;
  lockDir?: string;
  durations?: Partial<{ idle: number; queue: number; pregame: number; ingame: number }>;
  quiet?: boolean;
  /**
   * HenrikDev store-offers. 'removed' (default) answers 404 RiotImplementationRemoved like production
   * does today; 'offers' serves a legacy offers payload so the parsing path can be exercised.
   */
  henrik?: 'removed' | 'offers';
  /** Worst-case data for UI checks (MOCK_STRESS): long-names, radiant, unrated, nommr, hidden. */
  stress?: Stress;
}

/** Valid key for the mock HenrikDev API; anything else is 401. */
export const MOCK_HENRIK_KEY = 'HDEV-mock-0000-key';

export interface MockHandle {
  port: number;
  base: string;
  lockfilePath: string;
  setPhase(p: MockPhase | 'auto', elapsedMs?: number): void;
  phase(): MockPhase;
  events: MockEvents;
  /** Folder holding a fake VALORANT\Saved\Config (fullscreen-mode detection). */
  valorantConfigDir: string;
  close(): Promise<void>;
}

const PASSWORD = 'mock-local-password';
const ACCESS = 'mock-access-token';
const ENTITLEMENT = 'eyJhbGciOiJSUzI1NiJ9.eyJtb2NrIjp0cnVlfQ.bW9ja3NpZw';
const VERSION = 'release-13.09-shipping-11-5777412';
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const RAD = 'e59aa87c-4cbf-517a-5983-6e81511be9b7';
const KC = '85ca954a-41f2-ce94-9b45-8ca3dd39a00d';

type Color = 'Blue' | 'Red';
const other = (c: Color): Color => (c === 'Blue' ? 'Red' : 'Blue');

interface Scenario {
  id: string;
  n: number;
  team1: Color;
  myTeam: Color;
  map: string;
  queue: string;
  allies: string[];
  enemies: string[];
  agents: Map<string, string>;
  tiers: Map<string, number>;
  incognito: Set<string>;
  startedAt: number;
}

/** Plausible worst-case Riot IDs (16-char names, 5-char tags, non-Latin, no spaces to break on). */
const LONG = [
  ['Wiśniewska-Kowal', 'PL420'],
  ['WWWWWWWWWWWWWWWW', 'WWWWW'],
  ['이시하라사토미이시하라사토미', '한국'],
  ['Bartholomew Fitz', '00000'],
  ['ｆｕｌｌｗｉｄｔｈｎａｍｅ', 'ＪＰ1'],
  ['x', '1'],
  ['ÆØÅ ÆØÅ ÆØÅ ÆØÅ', 'NORD'],
  ['sixteencharsname', 'EUW1'],
  ['O\'Connor-McAlli', 'IRL'],
  ['😀😀😀😀😀😀😀😀', 'EMOJI'],
];
function longNameFor(puuid: string): { GameName: string; TagLine: string } {
  const r = rng('long' + puuid);
  const [GameName, TagLine] = LONG[Math.floor(r() * LONG.length)];
  return { GameName, TagLine };
}

interface HistEntry {
  MatchID: string;
  GameStartTime: number;
  QueueID: string;
}

export async function startMockServer(opts: MockOptions = {}): Promise<MockHandle> {
  const durations = { idle: 20_000, queue: 8_000, pregame: 45_000, ingame: 60_000, ...(opts.durations ?? {}) };
  const henrik = opts.henrik ?? (process.env.MOCK_HENRIK === 'offers' ? 'offers' : 'removed');
  const stress = (opts.stress ?? process.env.MOCK_STRESS ?? '') as Stress;
  let events: MockEvents | null = null;
  const PARTY_ID = uuid('party-me');
  const evt = (svc: string, rest: string) => events?.emit(`/riot-messaging-service/v1/message/${svc}/${rest}`);
  const lockDir = opts.lockDir ?? path.join(os.tmpdir(), 'sexyval-mock');
  const lockfilePath = path.join(lockDir, 'lockfile');
  const say = (...a: unknown[]) => !opts.quiet && console.log('[mock]', ...a);

  let phase: MockPhase = 'idle';
  let auto = true;
  let phaseStart = Date.now();
  let matchN = 0;
  let scenario: Scenario | null = null;
  let detailsHits = 0;
  const bootAt = Date.now();
  const histories = new Map<string, HistEntry[]>();
  const owners = new Map<string, string>();
  const finished = new Map<string, any>();
  let port = 0;

  const writeLock = () => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockfilePath, `Riot Client:${process.pid}:${port}:${PASSWORD}:http`);
  };
  const removeLock = () => fs.rmSync(lockfilePath, { force: true });

  function newScenario(): Scenario {
    matchN++;
    const r = rng(`scenario${matchN}${bootAt}`);
    const myTeam: Color = r() < 0.5 ? 'Blue' : 'Red';
    const allies = [ME, ...Array.from({ length: 4 }, (_, i) => uuid(`ally${matchN}-${i}`))];
    const enemies = Array.from({ length: 5 }, (_, i) => uuid(`enemy${matchN}-${i}`));
    const pool = [...AGENTS].sort(() => r() - 0.5);
    const agents = new Map<string, string>();
    [...allies, ...enemies].forEach((p, i) => agents.set(p, pool[i % pool.length]));
    const tiers = new Map<string, number>();
    for (const p of [...allies, ...enemies]) tiers.set(p, stress === 'unrated' ? 0 : stress === 'radiant' ? 27 : 9 + Math.floor(r() * 14));
    return {
      id: uuid(`match${matchN}${bootAt}`),
      n: matchN,
      team1: r() < 0.5 ? 'Blue' : 'Red',
      myTeam,
      map: pick(r, MAPS),
      queue: 'competitive',
      allies,
      enemies,
      agents,
      tiers,
      incognito: stress === 'hidden' ? new Set([...allies.slice(1), ...enemies]) : new Set([allies[3], enemies[2]]),
      startedAt: Date.now(),
    };
  }

  function enterPhase(p: MockPhase, elapsed = 0) {
    const prev = phase;
    if (prev === 'offline' && p !== 'offline') writeLock();
    if (p === 'offline') removeLock();
    if (p === 'pregame' && (prev !== 'pregame' || !scenario)) scenario = newScenario();
    if (p === 'ingame' && !scenario) scenario = newScenario();
    if (p === 'idle' && prev === 'ingame' && scenario) finishScenario(scenario);
    phase = p;
    phaseStart = Date.now() - elapsed;
    say(`phase -> ${p}`);
    // Same pushes the Riot Client sends: party state changes, pregame/core-game match updates.
    if (p !== prev) {
      if (p === 'queue' || prev === 'queue' || p === 'idle') evt('ares-parties', `parties/v1/parties/${PARTY_ID}`);
      if (p === 'pregame' && scenario) evt('ares-pregame', `pregame/v1/matches/${scenario.id}`);
      if ((p === 'ingame' || prev === 'ingame') && scenario) evt('ares-core-game', `core-game/v1/matches/${scenario.id}`);
      if (prev === 'ingame' && p === 'idle') evt('ares-core-game', `core-game/v1/players/${ME}`);
    }
  }

  function finishScenario(s: Scenario) {
    const r = rng('finish' + s.id);
    const players = [...s.allies.map((p) => ({ p, t: s.myTeam })), ...s.enemies.map((p) => ({ p, t: other(s.myTeam) }))];
    const details = buildBombDetails(s.id, r, players, s.map, s.queue, 'Red' /* Red attacks first, as in the real game */, Date.now() - durations.ingame, s.agents);
    // Details appear a few seconds after the match ends, like the real service.
    setTimeout(() => finished.set(s.id, details), 4000);
    for (const p of [...s.allies, ...s.enemies]) {
      const h = history(p);
      h.unshift({ MatchID: s.id, GameStartTime: s.startedAt, QueueID: s.queue });
    }
    scenario = null;
  }

  function tickAuto() {
    if (!auto || phase === 'offline') return;
    const t = Date.now() - phaseStart;
    if (phase === 'noval') return;
    if (phase === 'idle' && t > durations.idle) enterPhase('queue');
    else if (phase === 'queue' && t > durations.queue) enterPhase('pregame');
    else if (phase === 'pregame' && t > durations.pregame) enterPhase('ingame');
    else if (phase === 'ingame' && t > durations.ingame) enterPhase('idle');
  }

  function history(puuid: string): HistEntry[] {
    let h = histories.get(puuid);
    if (h) return h;
    const r = rng('hist' + puuid);
    const count = puuid === ME ? 18 : 8;
    h = [];
    for (let i = 0; i < count; i++) {
      const id = uuid(`${puuid}-h${i}`);
      const roll = r();
      const QueueID = puuid === ME ? (roll < 0.6 ? 'competitive' : 'unrated') : roll < 0.7 ? 'competitive' : roll < 0.85 ? 'unrated' : roll < 0.95 ? 'deathmatch' : 'swiftplay';
      h.push({ MatchID: id, GameStartTime: bootAt - (i + 1) * 47 * 60_000, QueueID });
      owners.set(id, puuid);
    }
    histories.set(puuid, h);
    return h;
  }

  /**
   * Per-round damage, economy and kills like the real match-details. Uses its own seeded generator so
   * the match outcomes (and calibration) stay exactly as before.
   */
  function roundStats(matchId: string, roundNum: number, subjects: string[]) {
    let s = 0;
    for (const ch of `${matchId}:${roundNum}`) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const killer = subjects[Math.floor(rnd() * subjects.length)];
    return subjects.map((subject) => {
      const head = Math.floor(rnd() * 3);
      const body = Math.floor(rnd() * 6);
      const leg = Math.floor(rnd() * 2);
      const loadout = [800, 2400, 3900, 4700][Math.floor(rnd() * 4)];
      return {
        subject,
        kills: subject === killer ? [{ killer: subject, victim: subjects[(subjects.indexOf(subject) + 5) % subjects.length], roundTime: 12000 + Math.floor(rnd() * 20000) }] : [],
        damage: [{ receiver: subjects[(subjects.indexOf(subject) + 5) % subjects.length], damage: head * 150 + body * 38 + leg * 30, headshots: head, bodyshots: body, legshots: leg }],
        score: 0,
        economy: { loadoutValue: loadout, weapon: '', armor: '', remaining: 200 + Math.floor(rnd() * 3000), spent: Math.floor(loadout * 0.8) },
        ability: {},
      };
    });
  }

  function buildBombDetails(
    matchId: string,
    r: () => number,
    players: { p: string; t: Color }[],
    map: string,
    queue: string,
    firstAtk: Color,
    start: number,
    agents?: Map<string, string>,
  ) {
    const swift = queue === 'swiftplay';
    const winTarget = swift ? 5 : 13;
    const half = swift ? 4 : 12;
    const winner: Color = r() < 0.52 ? players[0].t : other(players[0].t);
    const loserRounds = Math.floor(r() * (winTarget - 1));
    const seq: Color[] = [...Array(winTarget - 1).fill(winner), ...Array(loserRounds).fill(other(winner))].sort(() => r() - 0.5);
    seq.push(winner);
    const total = seq.length;
    const byTeam = (c: Color) => players.filter((x) => x.t === c).map((x) => x.p);
    const roundResults = seq.map((w, roundNum) => {
      const atk = roundNum < half ? firstAtk : other(firstAtk);
      const planted = roundNum === 1 || r() < 0.5;
      return {
        roundNum,
        roundResult: planted ? 'Bomb detonated' : 'Eliminated',
        roundCeremony: 'CeremonyDefault',
        winningTeam: w,
        bombPlanter: planted ? pick(r, byTeam(atk)) : undefined,
        plantRoundTime: planted ? 40000 : 0,
        plantSite: planted ? pick(r, ['A', 'B']) : '',
        playerStats: roundStats(matchId, roundNum, players.map((x) => x.p)),
      };
    });
    const wins = { Blue: seq.filter((c) => c === 'Blue').length, Red: seq.filter((c) => c === 'Red').length };
    return {
      matchInfo: {
        matchId,
        mapId: map,
        gamePodId: 'aresriot.mock',
        gameLoopZone: 'mock',
        gameServerAddress: 'mock',
        gameVersion: VERSION,
        gameLengthMillis: total * 100_000,
        gameStartMillis: start,
        provisioningFlowID: 'Matchmaking',
        isCompleted: true,
        customGameName: '',
        queueID: queue,
        gameMode: BOMB_MODE,
        isRanked: queue === 'competitive',
        seasonId: 'mock-season',
      },
      players: players.map(({ p, t }) => {
        const acs = 120 + Math.floor(r() * 210);
        const kills = Math.round((acs / 260) * total * 0.8 + r() * 4);
        return {
          subject: p,
          gameName: nameFor(p).GameName,
          tagLine: nameFor(p).TagLine,
          teamId: t,
          partyId: uuid('party' + p),
          characterId: agents?.get(p) ?? pick(r, AGENTS),
          stats: {
            score: acs * total,
            roundsPlayed: total,
            kills,
            deaths: Math.max(1, Math.round(total * 0.7 + (r() - 0.5) * 8)),
            assists: Math.floor(r() * 9),
            playtimeMillis: total * 100_000,
          },
          competitiveTier: 12 + Math.floor(r() * 8),
          accountLevel: 40 + Math.floor(r() * 300),
        };
      }),
      bots: [],
      coaches: [],
      teams: (['Blue', 'Red'] as Color[]).map((c) => ({ teamId: c, won: c === winner, roundsPlayed: total, roundsWon: wins[c], numPoints: wins[c] })),
      roundResults,
      kills: [],
    };
  }

  function buildDmDetails(matchId: string, r: () => number, owner: string, map: string, start: number) {
    const subjects = [owner, ...Array.from({ length: 13 }, (_, i) => uuid(matchId + 'dm' + i))];
    const kills = subjects.map(() => 5 + Math.floor(r() * 36));
    const best = subjects[kills.indexOf(Math.max(...kills))];
    return {
      matchInfo: { matchId, mapId: map, gameStartMillis: start, queueID: 'deathmatch', gameMode: DM_MODE, isCompleted: true },
      players: subjects.map((s, i) => ({
        subject: s,
        teamId: s, // DM: teamId is the player's puuid
        characterId: pick(r, AGENTS),
        stats: { score: kills[i] * 100, roundsPlayed: 1, kills: kills[i], deaths: 10 + Math.floor(r() * 25), assists: Math.floor(r() * 5) },
      })),
      teams: subjects.map((s, i) => ({ teamId: s, won: s === best, roundsPlayed: 0, roundsWon: 0, numPoints: kills[i] })),
      roundResults: [],
    };
  }

  function details(matchId: string): any | null {
    if (finished.has(matchId)) return finished.get(matchId);
    const owner = owners.get(matchId);
    if (!owner) return null;
    const entry = history(owner).find((h) => h.MatchID === matchId)!;
    const r = rng('det' + matchId);
    const map = pick(r, MAPS);
    if (entry.QueueID === 'deathmatch') return buildDmDetails(matchId, r, owner, map, entry.GameStartTime);
    const mine: Color = r() < 0.5 ? 'Blue' : 'Red';
    const players = [
      { p: owner, t: mine },
      ...Array.from({ length: 4 }, (_, i) => ({ p: uuid(matchId + 'a' + i), t: mine })),
      ...Array.from({ length: 5 }, (_, i) => ({ p: uuid(matchId + 'e' + i), t: other(mine) })),
    ];
    return buildBombDetails(matchId, r, players, map, entry.QueueID, 'Red', entry.GameStartTime);
  }

  function identity(p: string, s: Scenario) {
    return {
      Subject: p,
      PlayerCardID: '9fb348bc-41a0-91ad-8a3e-818035c4e561',
      PlayerTitleID: 'd13e579c-435e-44d4-cec2-6eae5a3c5ed4',
      AccountLevel: 20 + (rng('lvl' + p)() * 400) | 0,
      PreferredLevelBorderID: '',
      Incognito: s.incognito.has(p),
      HideAccountLevel: false,
    };
  }

  function pregameJson(s: Scenario) {
    const t = (Date.now() - phaseStart) / 1000;
    const players = s.allies.map((p, i) => {
      const lockAt = i === 0 ? 18 : 8 + i * 5;
      const selAt = 2 + i * 3;
      const state = t >= lockAt ? 'locked' : t >= selAt ? 'selected' : '';
      return {
        Subject: p,
        CharacterID: state ? s.agents.get(p) : '',
        CharacterSelectionState: state,
        PregamePlayerState: 'joined',
        CompetitiveTier: s.tiers.get(p),
        PlayerIdentity: identity(p, s),
        SeasonalBadgeInfo: { SeasonID: '', NumberOfWins: 0, WinsByTier: null, Rank: 0, LeaderboardRank: 0 },
        IsCaptain: i === 0,
      };
    });
    const team = { TeamID: s.myTeam, Players: players };
    return {
      ID: s.id,
      Version: Date.now(),
      Teams: [team],
      AllyTeam: team,
      EnemyTeam: null,
      ObserverSubjects: [],
      MatchCoaches: [],
      EnemyTeamSize: 5,
      EnemyTeamLockCount: Math.min(5, Math.floor(t / 7)),
      PregameState: 'character_select_active',
      LastUpdated: new Date().toISOString(),
      // The real pregame match can arrive before the map is filled in; the app must show it the moment it is.
      MapID: t < 1.5 ? '' : s.map,
      MapSelectPool: [],
      BannedMapIDs: [],
      CastedVotes: {},
      MapSelectSteps: [],
      MapSelectStep: 0,
      Team1: s.team1,
      GamePodID: 'aresriot.aws-rclusterprod-euc1-1.eu-gp-frankfurt-1',
      Mode: BOMB_MODE,
      VoiceSessionID: uuid('voice' + s.id),
      MUCName: `${s.id}@ares-pregame.eu1.pvp.net`,
      TeamMatchToken: ENTITLEMENT,
      QueueID: s.queue,
      ProvisioningFlowID: 'Matchmaking',
      IsRanked: true,
      PhaseTimeRemainingNS: Math.max(0, durations.pregame / 1000 - t) * 1e9,
      StepTimeRemainingNS: 0,
      altModesFlagADA: false,
      TournamentMetadata: null,
      RosterMetadata: null,
    };
  }

  function coreJson(s: Scenario) {
    const players = [...s.allies.map((p) => ({ p, t: s.myTeam })), ...s.enemies.map((p) => ({ p, t: other(s.myTeam) }))];
    return {
      MatchID: s.id,
      Version: Date.now(),
      State: 'IN_PROGRESS',
      MapID: s.map,
      ModeID: BOMB_MODE,
      ProvisioningFlow: 'Matchmaking',
      GamePodID: 'aresriot.aws-rclusterprod-euc1-1.eu-gp-frankfurt-1',
      AllMUCName: `${s.id}-all@ares-coregame.eu1.pvp.net`,
      TeamMUCName: `${s.id}-${s.myTeam}@ares-coregame.eu1.pvp.net`,
      TeamVoiceID: uuid('tv' + s.id),
      TeamMatchToken: ENTITLEMENT,
      IsReconnectable: true,
      ConnectionDetails: { GameServerHosts: ['127.0.0.1'], GameServerHost: '127.0.0.1', GameServerPort: 7000, GameServerObfuscatedIP: 0, GameClientHash: 0, PlayerKey: 'mock-player-key' },
      PostGameDetails: null,
      Players: players.map(({ p, t }) => ({
        Subject: p,
        TeamID: t,
        CharacterID: s.agents.get(p),
        PlayerIdentity: identity(p, s),
        SeasonalBadgeInfo: { SeasonID: 'mock-season', NumberOfWins: 12, WinsByTier: null, Rank: s.tiers.get(p), LeaderboardRank: 0 },
        IsCoach: false,
        IsAssociated: true,
      })),
      MatchmakingData: { QueueID: s.queue, IsRanked: true },
    };
  }

  function storefront() {
    // Fixture shop mixes skins with and without streamedVideo (see scripts/make-mock-fixtures.mjs).
    const daily: string[] = mockFixtures.shop.daily;
    const price = (id: string) => mockFixtures.prices[id] ?? 1775;
    const remaining = Math.max(60, 3 * 3600 + 17 * 60 - Math.floor((Date.now() - bootAt) / 1000));
    const bundleIds: string[] = mockFixtures.shop.bundle;
    const bundle = {
      ID: uuid('bundle-offer'),
      DataAssetID: mockFixtures.shop.bundleAsset ?? uuid('bundle-asset'),
      CurrencyID: VP,
      Items: bundleIds.map((id) => ({
        Item: { ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: id, Amount: 1 },
        BasePrice: price(id),
        CurrencyID: VP,
        DiscountPercent: 0.33,
        DiscountedPrice: Math.round(price(id) * 0.67),
        IsPromoItem: false,
      })),
      ItemOffers: null,
      TotalBaseCost: { [VP]: bundleIds.reduce((a, id) => a + price(id), 0) },
      TotalDiscountedCost: { [VP]: bundleIds.reduce((a, id) => a + Math.round(price(id) * 0.67), 0) },
      TotalDiscountPercent: 0.33,
      DurationRemainingInSeconds: 9 * 86400,
      WholesaleOnly: false,
    };
    return {
      FeaturedBundle: { Bundle: bundle, Bundles: [bundle], BundleRemainingDurationInSeconds: 9 * 86400 },
      SkinsPanelLayout: {
        SingleItemOffers: daily,
        SingleItemStoreOffers: daily.map((id) => ({
          OfferID: id,
          IsDirectPurchase: true,
          StartDate: new Date(bootAt).toISOString(),
          Cost: { [VP]: price(id) },
          Rewards: [{ ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: id, Quantity: 1 }],
        })),
        SingleItemOffersRemainingDurationInSeconds: remaining,
      },
      UpgradeCurrencyStore: { UpgradeCurrencyOffers: [] },
      AccessoryStore: { AccessoryStoreOffers: [], AccessoryStoreRemainingDurationInSeconds: 0 },
      BonusStore: {
        BonusStoreOffers: (mockFixtures.shop.night as string[]).map((id, i) => {
          const base = price(id);
          const pct = [32, 18, 41, 25, 12, 36][i];
          return {
            BonusOfferID: uuid('bonus' + id),
            Offer: {
              OfferID: id,
              IsDirectPurchase: true,
              StartDate: new Date(bootAt).toISOString(),
              Cost: { [VP]: base },
              Rewards: [{ ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: id, Quantity: 1 }],
            },
            DiscountPercent: pct,
            DiscountCosts: { [VP]: Math.round((base * (100 - pct)) / 100) },
            IsSeen: true,
          };
        }),
        BonusStoreRemainingDurationInSeconds: 5 * 86400 + 4 * 3600,
      },
    };
  }

  /** Legacy store/v1/offers shape (v1) or HenrikDev's flattened array (v2), from the fixture price list. */
  function henrikOffers(v: 'v1' | 'v2') {
    // Leave a few skins out so the app's coverage report has something to list.
    const entries = Object.entries(mockFixtures.prices as Record<string, number>).filter((_, i) => i % 97 !== 5);
    if (v === 'v2') return { status: 200, data: entries.map(([level, cost]) => ({ offer_id: level, cost, name: '', icon: null, type: 'skin_level', skin_id: null, content_tier: null })) };
    return {
      status: 200,
      data: {
        Offers: entries.map(([level, cost]) => ({
          OfferID: level,
          IsDirectPurchase: true,
          StartDate: '2020-06-02T00:00:00Z',
          Cost: { [VP]: cost },
          Rewards: [{ ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: level, Quantity: 1 }],
        })),
        UpgradeCurrencyOffers: [],
      },
    };
  }

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const notFound = (res: http.ServerResponse, msg = 'resource not found') => json(res, 404, { httpStatus: 404, errorCode: 'RESOURCE_NOT_FOUND', message: msg });

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        try {
          resolve(d ? JSON.parse(d) : null);
        } catch {
          resolve(null);
        }
      });
    });

  const extra = createExtra({
    phase: () => phase,
    queueSince: () => (phase === 'queue' ? phaseStart : null),
    goto: (p) => enterPhase(p as MockPhase),
    emitParty: () => evt('ares-parties', `parties/v1/parties/${PARTY_ID}`),
    partyId: PARTY_ID,
    stress,
    json,
    notFound,
    readBody,
    ENTITLEMENT,
  });

  const server = http.createServer(async (req, res) => {
    tickAuto();
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (p.startsWith('/__mock/')) {
      if (p === '/__mock/phase') {
        const set = url.searchParams.get('set') as MockPhase | 'auto' | null;
        if (set === 'auto') auto = true;
        else if (set) {
          auto = false;
          enterPhase(set, Number(url.searchParams.get('elapsed') ?? 0) * 1000);
        }
      }
      return json(res, 200, { phase, auto, match: scenario?.id ?? null });
    }

    // Local Riot Client API (Basic riot:password)
    if (p === '/entitlements/v1/token' || p === '/product-session/v1/external-sessions') {
      const expected = 'Basic ' + Buffer.from(`riot:${PASSWORD}`).toString('base64');
      if (req.headers.authorization !== expected) return json(res, 401, { errorCode: 'UNAUTHORIZED' });
      if (phase === 'offline') return json(res, 503, {});
      if (p === '/entitlements/v1/token') {
        return json(res, 200, { accessToken: ACCESS, entitlements: [], issuer: 'https://entitlements.auth.riotgames.com', subject: ME, token: ENTITLEMENT });
      }
      return json(res, 200, {
        host_app: { exitCode: 0, launchConfiguration: { arguments: [], executable: '' }, productId: 'riot_client', version: '111.0.0' },
        ...(phase === 'noval' ? {} : { '7c1a5f2e-mock': {
          exitCode: 0,
          exitReason: null,
          isInternal: false,
          launchConfiguration: {
            arguments: [
              '-ares-deployment=eu',
              '-config-endpoint=https://shared.eu.a.pvp.net',
              '-remoting-auth-token=mock-remoting-secret',
              `-remoting-app-port=${port}`,
              `-subject=${ME}`,
              '-locale=en_US',
            ],
            executable: 'C:/Riot Games/VALORANT/live/ShooterGame/Binaries/Win64/VALORANT-Win64-Shipping.exe',
            locale: 'en_US',
            voiceLocale: null,
            workingDirectory: 'C:/Riot Games/VALORANT/live',
          },
          patchlineFullName: 'VALORANT',
          patchlineId: 'live',
          phase: 'Gameplay',
          productId: 'valorant',
          version: VERSION,
        } }),
      });
    }

    // Remote glz/pd: require the full header set
    if (p.startsWith('/riotclient/') || p.startsWith('/chat/')) {
      const expected = 'Basic ' + Buffer.from(`riot:${PASSWORD}`).toString('base64');
      if (req.headers.authorization !== expected) return json(res, 401, { errorCode: 'UNAUTHORIZED' });
      if (phase === 'offline') return json(res, 503, {});
    }
    if (p.startsWith('/glz/') || p.startsWith('/pd/') || p.startsWith('/shared/')) {
      const h = req.headers;
      if (h.authorization !== `Bearer ${ACCESS}` && h.authorization !== `Bearer ${SIGNIN_ACCESS}`) return json(res, 401, { httpStatus: 401, errorCode: 'BAD_CLAIMS', message: 'bearer' });
      if (h['x-riot-entitlements-jwt'] !== ENTITLEMENT || !h['x-riot-clientversion'] || !h['x-riot-clientplatform']) {
        return json(res, 400, { httpStatus: 400, errorCode: 'BAD_PARAMETER', message: 'missing riot headers' });
      }
    }

    // ---- HenrikDev (unofficial third-party API), mounted at /henrik ----
    if (/^\/henrik\/valorant\/v[12]\/store-offers$/.test(p)) {
      const auth = req.headers.authorization ?? url.searchParams.get('api_key');
      if (auth !== MOCK_HENRIK_KEY) return json(res, 401, { errors: [{ code: 0, message: 'Unauthorized', status: 401, details: null }] });
      if (henrik === 'removed') return json(res, 404, { errors: [{ code: 0, message: 'RiotImplementationRemoved', status: 404, details: 'Removed by Riot' }] });
      return json(res, 200, henrikOffers(p.includes('/v2/') ? 'v2' : 'v1'));
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/glz\/pregame\/v1\/players\/([^/]+)$/.exec(p))) {
      if (phase !== 'pregame' || !scenario || m[1] !== ME) return notFound(res);
      return json(res, 200, { Subject: ME, MatchID: scenario.id, Version: Date.now() });
    }
    if ((m = /^\/glz\/pregame\/v1\/matches\/([^/]+)$/.exec(p))) {
      if (phase !== 'pregame' || !scenario || m[1] !== scenario.id) return notFound(res);
      return json(res, 200, pregameJson(scenario));
    }
    if ((m = /^\/glz\/core-game\/v1\/players\/([^/]+)$/.exec(p))) {
      if (phase !== 'ingame' || !scenario || m[1] !== ME) return notFound(res);
      return json(res, 200, { Subject: ME, MatchID: scenario.id, Version: Date.now() });
    }
    if ((m = /^\/glz\/core-game\/v1\/matches\/([^/]+)$/.exec(p))) {
      if (phase !== 'ingame' || !scenario || m[1] !== scenario.id) return notFound(res);
      return json(res, 200, coreJson(scenario));
    }
    if ((m = /^\/pd\/match-history\/v1\/history\/([^/]+)$/.exec(p))) {
      const start = Number(url.searchParams.get('startIndex') ?? 0);
      const end = Number(url.searchParams.get('endIndex') ?? 20);
      const queue = url.searchParams.get('queue');
      const h = history(m[1]).filter((x: any) => !queue || x.QueueID === queue);
      return json(res, 200, { Subject: m[1], BeginIndex: start, EndIndex: end, Total: h.length, History: h.slice(start, end) });
    }
    if ((m = /^\/pd\/match-details\/v1\/matches\/([^/]+)$/.exec(p))) {
      detailsHits++;
      if (detailsHits % 17 === 0) return json(res, 429, { httpStatus: 429, errorCode: 'RATE_LIMITED' }, { 'Retry-After': '1' });
      const d = details(m[1]);
      return d ? json(res, 200, d) : notFound(res, 'match not found');
    }
    if (p === '/pd/name-service/v2/players' && method === 'PUT') {
      const ids: unknown = await readBody(req);
      const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
      return json(
        res,
        200,
        list.map((s) => ({ DisplayName: '', Subject: s, ...(s === ME ? { GameName: 'Vibe', TagLine: '0001' } : stress === 'long-names' ? longNameFor(s) : nameFor(s)) })),
      );
    }
    if (/^\/pd\/store\/v2\/storefront\/[^/]+$/.test(p)) return notFound(res, 'v2 retired (mock)');
    if (/^\/pd\/store\/v3\/storefront\/[^/]+$/.test(p) && method === 'POST') return json(res, 200, storefront());
    if (/^\/pd\/store\/v1\/wallet\/[^/]+$/.test(p)) return json(res, 200, { Balances: { [VP]: 4350, [RAD]: 120, [KC]: 2800 } });

    if (await extra(req, res, p, method, url)) return;
    return notFound(res, `mock: no route ${method} ${p}`);
  });

  events = attachEvents(server, PASSWORD);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  port = (server.address() as any).port;
  writeLock();
  // Fake Valorant settings: exclusive Fullscreen (0), so the overlay warning can be seen in mock mode.
  const valorantConfigDir = path.join(lockDir, 'VALORANT-Config');
  const acct = path.join(valorantConfigDir, `${ME}-eu`, 'WindowsClient');
  fs.mkdirSync(acct, { recursive: true });
  fs.writeFileSync(path.join(acct, 'GameUserSettings.ini'), '[/Script/ShooterGame.ShooterGameUserSettings]\r\nLastConfirmedFullscreenMode=0\r\nPreferredFullscreenMode=0\r\nFullscreenMode=0\r\n');
  say(`listening on 127.0.0.1:${port}, lockfile ${lockfilePath}`);

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    lockfilePath,
    setPhase(p, elapsedMs = 0) {
      if (p === 'auto') {
        auto = true;
        return;
      }
      auto = false;
      enterPhase(p, elapsedMs);
    },
    phase: () => phase,
    events: events!,
    valorantConfigDir,
    close: () =>
      new Promise<void>((resolve) => {
        removeLock();
        events?.close();
        server.close(() => resolve());
      }),
  };
}

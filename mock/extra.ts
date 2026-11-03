// Mock routes: region-locale, sign-in, owned items, contracts, XP, loadout (v3), MMR, leaderboard,
// content, party and local chat/friends. Shapes follow the LIVE API, including what it no longer has:
// personalization v2 and /store/v1/offers answer 404 exactly like production, so the app cannot lean on them.
import type http from 'node:http';
import { AGENTS, ME, nameFor, rng, uuid } from './data';
import fixtures from './fixtures/collection.json';

const fx: any = fixtures;

export const SIGNIN_ACCESS = 'mock-signin-access';
const TYPES: Record<string, string> = {
  'e7c63390-eda7-46e0-bb7a-a6abdacd2433': 'levels',
  '3ad1b2b2-acdb-4524-852f-954a76ddae0a': 'chromas',
  'dd3bf334-87f3-40bd-b043-682a57a8dc3a': 'buddies',
  'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475': 'sprays',
  '3f296c07-64c3-494c-923b-fe692a4fa1bd': 'cards',
  'de7caa6b-adf7-4588-bbd1-143831e786c6': 'titles',
  '01bb38e1-da47-4e6a-9b3d-945fe4655707': 'agents',
};
const SPRAY_TYPE = 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475';
const GONE = { httpStatus: 404, errorCode: 'RESOURCE_NOT_FOUND', message: 'resource not found' };

export interface ExtraCtx {
  phase(): string;
  json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  notFound(res: http.ServerResponse, msg?: string): void;
  readBody(req: http.IncomingMessage): Promise<any>;
  ENTITLEMENT: string;
}

export function createExtra(ctx: ExtraCtx) {
  const { json, notFound } = ctx;
  const friendsList = Array.from({ length: 9 }, (_, i) => uuid(`friend-${i}`));
  let outgoing: { puuid: string; name: string; tag: string }[] = [];
  const buddyInstances = new Map<string, string>(fx.owned.buddies.map((b: any) => [b.level, uuid('inst' + b.level)]));
  const partyId = uuid('party-me');
  const party = {
    queue: 'competitive',
    accessibility: 'CLOSED' as 'OPEN' | 'CLOSED',
    code: '',
    state: 'DEFAULT',
    ready: true,
    members: [ME, friendsList[0], friendsList[2]],
    requests: [{ ID: uuid('req-1'), PartyID: partyId, RequestedBySubject: friendsList[5], Subjects: [friendsList[5]], CreatedAt: new Date().toISOString(), RefreshedAt: new Date().toISOString(), ExpiresIn: 600 }],
    queueEntry: '0001-01-01T00:00:00Z',
  };
  let loadout = {
    Subject: ME,
    Version: 172,
    Guns: fx.loadout.guns.map((g: any) => (g.CharmLevelID ? { ...g, CharmInstanceID: buddyInstances.get(g.CharmLevelID) } : g)),
    ActiveExpressions: fx.loadout.sprays.map((s: string) => ({ TypeID: SPRAY_TYPE, AssetID: s })),
    DynamicOptions: {},
    Identity: { PlayerCardID: fx.loadout.card, PlayerTitleID: fx.loadout.title, AccountLevel: 187, PreferredLevelBorderID: '00000000-0000-0000-0000-000000000000', HideAccountLevel: false },
    Incognito: false,
  };
  let activeContract = fx.progression.agents[0];

  const presence = (p: string, i: number) => {
    const states = ['MENUS', 'INGAME', 'PREGAME', 'MENUS'];
    const priv = {
      isValid: true,
      sessionLoopState: states[i % 4],
      partyOwnerSessionLoopState: states[i % 4],
      partyOwnerMatchScoreAllyTeam: 7,
      partyOwnerMatchScoreEnemyTeam: 5,
      partyId: uuid('p' + p),
      partyState: i === 3 ? 'MATCHMAKING' : 'DEFAULT',
      partySize: 1 + (i % 3),
      maxPartySize: 5,
      queueId: 'competitive',
      accountLevel: 40 + i * 31,
      competitiveTier: 8 + i * 2,
      isIdle: i === 4,
    };
    return {
      actor: null,
      basic: '',
      details: null,
      game_name: nameFor(p).GameName,
      game_tag: nameFor(p).TagLine,
      location: null,
      msg: null,
      name: '',
      patchline: null,
      pid: `${p}@eu1.pvp.net`,
      platform: null,
      private: Buffer.from(JSON.stringify(priv)).toString('base64'),
      privateJwt: null,
      product: 'valorant',
      puuid: p,
      region: 'eu1',
      resource: 'RC-1',
      state: i === 4 ? 'away' : 'chat',
      summary: '',
      time: Date.now(),
    };
  };

  const partyJson = () => ({
    ID: partyId,
    MUCName: `${partyId}@ares-parties.eu1.pvp.net`,
    VoiceRoomID: uuid('voice-party'),
    Version: Date.now(),
    ClientVersion: 'release-13.09-shipping-11-5777412',
    Members: party.members.map((m, i) => ({
      Subject: m,
      CompetitiveTier: 14 + i * 3,
      PlayerIdentity: { Subject: m, PlayerCardID: fx.owned.cards[i % fx.owned.cards.length], PlayerTitleID: fx.owned.titles[0], AccountLevel: 90 + i * 40, PreferredLevelBorderID: '', Incognito: false, HideAccountLevel: false },
      SeasonalBadgeInfo: null,
      IsOwner: i === 0,
      QueueEligibleRemainingAccountLevels: 0,
      Pings: [
        { Ping: 18 + i * 3, GamePodID: 'aresriot.aws-euc1-prod.eu-gp-frankfurt-1' },
        { Ping: 31 + i * 2, GamePodID: 'aresriot.aws-euw2-prod.eu-gp-london-1' },
        { Ping: 44 + i, GamePodID: 'aresriot.aws-eun1-prod.eu-gp-stockholm-1' },
      ],
      IsReady: m === ME ? party.ready : true,
      IsModerator: false,
      UseBroadcastHUD: false,
      PlatformType: 'PC',
    })),
    State: party.state,
    PreviousState: 'DEFAULT',
    StateTransitionReason: '',
    Accessibility: party.accessibility,
    CustomGameData: null,
    MatchmakingData: { QueueID: party.queue, PreferredGamePods: ['aresriot.aws-euc1-prod.eu-gp-frankfurt-1'], SkillDisparityRRPenalty: 0 },
    Invites: null,
    Requests: party.requests,
    QueueEntryTime: party.queueEntry,
    ErrorNotification: { ErrorType: '', ErroredPlayers: null },
    RestrictedSeconds: 0,
    EligibleQueues: ['competitive', 'unrated', 'swiftplay', 'spikerush', 'deathmatch', 'hurm', 'ggteam'],
    QueueIneligibilities: [],
    CheatData: { GamePodOverride: '', ForcePostGameProcessing: false },
    XPBonuses: [],
    InviteCode: party.code,
  });

  /** Returns true when the route was handled. */
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, p: string, method: string, url: URL): Promise<boolean> {
    const phase = ctx.phase();
    let m: RegExpExecArray | null;

    // ---- sign-in flow (mock of auth.riotgames.com etc) ----
    if (p === '/__auth/authorize') {
      res.writeHead(302, { Location: `https://playvalorant.com/opt_in#access_token=${SIGNIN_ACCESS}&scope=account+openid&iss=mock&id_token=mock-id-token&token_type=Bearer&session_state=x&expires_in=3600` });
      res.end();
      return true;
    }
    if (p === '/__auth/entitlements' && method === 'POST') {
      if (req.headers.authorization !== `Bearer ${SIGNIN_ACCESS}`) return json(res, 401, {}), true;
      return json(res, 200, { entitlements_token: ctx.ENTITLEMENT }), true;
    }
    if (p === '/__auth/userinfo') {
      if (req.headers.authorization !== `Bearer ${SIGNIN_ACCESS}`) return json(res, 401, {}), true;
      return json(res, 200, { country: 'deu', sub: ME, email_verified: true, acct: { type: 0, state: 'ENABLED', adm: false, game_name: 'Vibe', tag_line: '0001', created_at: 1600000000000 }, affinity: { pp: 'eu' } }), true;
    }
    if (p === '/__auth/geo' && method === 'PUT') {
      return json(res, 200, { token: 'mock-geo', affinities: { pbe: 'na', live: 'eu' } }), true;
    }

    // ---- local Riot Client ----
    if (p === '/riotclient/region-locale') return json(res, 200, { locale: 'en_US', region: 'EU', webLanguage: 'en', webRegion: 'eu' }), true;
    if (p === '/chat/v4/friends') {
      return (
        json(res, 200, {
          friends: friendsList.map((f, i) => ({ activePlatform: null, displayGroup: '', game_name: nameFor(f).GameName, game_tag: nameFor(f).TagLine, group: '', last_online_ts: Date.now() - i * 3600_000, name: '', note: i === 1 ? 'duo' : '', pid: `${f}@eu1.pvp.net`, puuid: f, region: 'eu1' })),
        }),
        true
      );
    }
    if (p === '/chat/v4/presences') return json(res, 200, { presences: friendsList.slice(0, 5).map(presence) }), true;
    if (p === '/chat/v4/friendrequests') {
      if (method === 'POST') {
        const b = await ctx.readBody(req);
        outgoing.push({ puuid: uuid('req' + b?.game_name), name: String(b?.game_name ?? ''), tag: String(b?.game_tag ?? '') });
        return json(res, 200, { requests: [] }), true;
      }
      if (method === 'DELETE') {
        const b = await ctx.readBody(req);
        outgoing = outgoing.filter((o) => o.puuid !== b?.puuid);
        res.writeHead(204);
        res.end();
        return true;
      }
      const incoming = { game_name: 'nightowl', game_tag: '7788', name: '', note: '', pid: 'x@eu1.pvp.net', puuid: uuid('incoming-1'), region: 'eu1', subscription: 'pending_in' };
      return json(res, 200, { requests: [incoming, ...outgoing.map((o) => ({ game_name: o.name, game_tag: o.tag, name: '', note: '', pid: '', puuid: o.puuid, region: 'eu1', subscription: 'pending_out' }))] }), true;
    }

    // ---- pd: store ----
    if ((m = /^\/pd\/store\/v1\/entitlements\/([^/]+)\/([^/]+)$/.exec(p))) {
      const key = TYPES[m[2].toLowerCase()];
      let ids: { ItemID: string; InstanceID?: string }[] = [];
      if (key === 'buddies') ids = fx.owned.buddies.map((b: any) => ({ ItemID: b.level, InstanceID: buddyInstances.get(b.level) }));
      else if (key === 'agents') ids = AGENTS.map((a) => ({ ItemID: a }));
      else if (key) ids = (fx.owned[key] ?? []).map((id: string) => ({ ItemID: id }));
      return json(res, 200, { EntitlementsByTypes: [{ ItemTypeID: m[2], Entitlements: ids.map((x) => ({ TypeID: uuid('type' + x.ItemID), ...x })) }] }), true;
    }
    // Retired upstream (404 in production): the app must not depend on a full price list.
    if (p === '/pd/store/v1/offers/' || p === '/pd/store/v1/offers') return json(res, 404, GONE), true;

    // ---- pd: progression ----
    if ((m = /^\/pd\/contracts\/v1\/contracts\/([^/]+)\/special\/([^/]+)$/.exec(p)) && method === 'POST') {
      activeContract = m[2];
    }
    if ((m = /^\/pd\/contracts\/v1\/contracts\/([^/]+)(?:\/special\/[^/]+)?$/.exec(p))) {
      const now = Date.now();
      const weeklies = fx.progression.weeklies.filter((w: any) => Date.parse(w.a) <= now && now < Date.parse(w.e)).slice(0, 3);
      const r = rng('missions');
      const missions = [
        ...fx.progression.dailies.slice(0, 1).map((d: any) => ({ ID: d.id, Objectives: { [uuid('obj' + d.id)]: Math.floor(d.target * 0.6) }, Complete: false, ExpirationTime: new Date(now + 9 * 3600_000).toISOString() })),
        ...weeklies.map((w: any, i: number) => ({ ID: w.id, Objectives: { [uuid('obj' + w.id)]: i === 0 ? w.target : Math.floor(w.target * r()) }, Complete: i === 0, ExpirationTime: w.e })),
      ];
      const contract = (id: string, level: number, into: number) => ({
        ContractDefinitionID: id,
        ContractProgression: { TotalProgressionEarned: level * 10000 + into, TotalProgressionEarnedVersion: 1, HighestRewardedLevel: {} },
        ProgressionLevelReached: level,
        ProgressionTowardsNextLevel: into,
      });
      return (
        json(res, 200, {
          Version: 1,
          Subject: ME,
          Contracts: [
            contract(fx.progression.season, 23, 4100),
            ...(fx.progression.event ? [contract(fx.progression.event, 6, 900)] : []),
            ...fx.progression.agents.map((a: string, i: number) => contract(a, [10, 4, 0, 7, 2, 1][i] ?? 0, 1500 * i)),
          ],
          ProcessedMatches: [],
          ActiveSpecialContract: activeContract,
          Missions: missions,
          MissionMetadata: { NPECompleted: true, WeeklyCheckpoint: weeklies[0]?.a ?? new Date().toISOString(), WeeklyRefillTime: weeklies[0]?.e ?? new Date().toISOString() },
        }),
        true
      );
    }
    if (/^\/pd\/account-xp\/v1\/players\/[^/]+$/.test(p)) {
      return json(res, 200, { Version: 1, Subject: ME, Progress: { Level: 187, XP: 3400 }, History: [], LastTimeGrantedFirstWin: new Date().toISOString(), NextTimeFirstWinAvailable: new Date(Date.now() + 8 * 3600_000).toISOString() }), true;
    }
    if (/^\/pd\/personalization\/v2\/players\/[^/]+\/playerloadout$/.test(p)) return json(res, 404, GONE), true;
    if (/^\/pd\/personalization\/v3\/players\/[^/]+\/playerloadout$/.test(p)) {
      if (method === 'PUT') {
        const b = await ctx.readBody(req);
        if (!b || !Array.isArray(b.Guns) || !b.Identity || !Array.isArray(b.ActiveExpressions)) return json(res, 400, { httpStatus: 400, errorCode: 'BAD_LOADOUT', message: 'invalid loadout' }), true;
        loadout = { ...loadout, ...b, Subject: ME, Version: loadout.Version + 1 };
      }
      return json(res, 200, loadout), true;
    }
    if ((m = /^\/pd\/mmr\/v1\/players\/([^/]+)$/.exec(p))) {
      const r = rng('mmr' + m[1]);
      const tier = 12 + Math.floor(r() * 10);
      const seasons = Object.fromEntries(
        fx.progression.acts.map((a: string, i: number) => [a, { SeasonID: a, NumberOfWins: 20 + i, NumberOfWinsWithPlacements: 25 + i, NumberOfGames: 48, Rank: 0, CapstoneWins: 0, LeaderboardRank: 0, CompetitiveTier: tier - 3 + i, RankedRating: Math.floor(r() * 99), WinsByTier: { [tier - 2 + i]: 4, [tier + 2]: i === 1 ? 1 : 0 }, GamesNeededForRating: 0, TotalWinsNeededForRank: 0 }]),
      );
      return (
        json(res, 200, {
          Version: 1,
          Subject: m[1],
          NewPlayerExperienceFinished: true,
          QueueSkills: { competitive: { TotalGamesNeededForRating: 5, TotalGamesNeededForLeaderboard: 0, CurrentSeasonGamesNeededForRating: 0, SeasonalInfoBySeasonID: seasons } },
          LatestCompetitiveUpdate: null,
          IsLeaderboardAnonymized: false,
          IsActRankBadgeHidden: false,
        }),
        true
      );
    }
    if ((m = /^\/pd\/mmr\/v1\/players\/([^/]+)\/competitiveupdates$/.exec(p))) {
      const r = rng('cu' + m[1]);
      let tier = 15;
      let rr = 40;
      const out = [];
      for (let i = 0; i < 20; i++) {
        const delta = Math.round((r() - 0.45) * 40);
        rr += delta;
        if (rr >= 100) {
          tier++;
          rr -= 100;
        } else if (rr < 0) {
          tier--;
          rr += 100;
        }
        out.push({ MatchID: uuid(`${m[1]}-h${19 - i}`), MapID: '/Game/Maps/Ascent/Ascent', SeasonID: fx.progression.act, MatchStartTime: Date.now() - (20 - i) * 47 * 60_000, TierAfterUpdate: tier, TierBeforeUpdate: tier, RankedRatingAfterUpdate: rr, RankedRatingBeforeUpdate: rr - delta, RankedRatingEarned: delta, RankedRatingPerformanceBonus: 0, CompetitiveMovement: 'MOVEMENT_UNKNOWN', AFKPenalty: 0 });
      }
      return json(res, 200, { Version: 1, Subject: m[1], Matches: out.reverse() }), true;
    }
    if ((m = /^\/pd\/mmr\/v1\/leaderboards\/affinity\/([^/]+)\/queue\/competitive\/season\/([^/]+)$/.exec(p))) {
      const start = Number(url.searchParams.get('startIndex') ?? 0);
      const size = Math.min(100, Number(url.searchParams.get('size') ?? 50));
      const players = Array.from({ length: size }, (_, i) => {
        const id = uuid(`lb-${start + i}`);
        return { PlayerCardID: fx.owned.cards[i % fx.owned.cards.length], TitleID: fx.owned.titles[0], IsBanned: false, IsAnonymized: i % 7 === 3, puuid: id, gameName: nameFor(id).GameName, tagLine: nameFor(id).TagLine, leaderboardRank: start + i + 1, rankedRating: 1200 - (start + i) * 4, numberOfWins: 180 - i, competitiveTier: start + i < 10 ? 27 : 26 };
      });
      return json(res, 200, { Deployment: m[1], QueueID: 'competitive', SeasonID: m[2], Players: players, totalPlayers: 25000, immortalStartingPage: 0, immortalStartingIndex: 0, topTierRRThreshold: 550, tierDetails: {}, startIndex: start, query: url.searchParams.get('query') ?? '' }), true;
    }
    if (p === '/shared/content-service/v3/content') {
      return json(res, 200, { DisabledIDs: [], Seasons: fx.progression.acts.map((a: string, i: number) => ({ ID: a, Name: `Act ${i + 1}`, Type: 'act', StartTime: '2026-01-01T00:00:00Z', EndTime: '2027-01-06T00:00:00Z', IsActive: a === fx.progression.act })), Events: [] }), true;
    }

    // ---- glz: party (only while Valorant is running) ----
    if (p.startsWith('/glz/parties/')) {
      if (phase === 'noval' || phase === 'offline') return notFound(res, 'player not in a party'), true;
      if (p === '/glz/parties/v1/parties/customgameconfigs') {
        return json(res, 200, { Enabled: true, EnabledMaps: ['/Game/Maps/Ascent/Ascent'], EnabledModes: ['/Game/GameModes/Bomb/BombGameMode.BombGameMode_C'], Queues: [], GamePodPingServiceInfo: {} }), true;
      }
      if ((m = /^\/glz\/parties\/v1\/players\/([^/]+)$/.exec(p))) {
        if (method === 'DELETE') {
          party.members = party.members.filter((x) => x !== m![1]);
          res.writeHead(204);
          res.end();
          return true;
        }
        return json(res, 200, { Subject: m[1], Version: 1, CurrentPartyID: partyId, Invites: null, Requests: [], PlatformInfo: { platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0', platformChipset: 'Unknown' } }), true;
      }
      if ((m = /^\/glz\/parties\/v1\/players\/joinbycode\/([^/]+)$/.exec(p))) {
        if (m[1].toUpperCase() !== 'MOCK42') return json(res, 404, { httpStatus: 404, errorCode: 'ERR_MISSING_INVITE_CODE_MAPPING', message: 'No PartyID <--> InviteCode mapping found' }), true;
        return json(res, 200, partyJson()), true;
      }
      const base = `/glz/parties/v1/parties/${partyId}`;
      if (p === base) return json(res, 200, partyJson()), true;
      if (!p.startsWith(base)) return notFound(res, 'party not found'), true;
      const rest = p.slice(base.length);
      const b = method === 'POST' ? await ctx.readBody(req) : null;
      if (rest === '/queue') party.queue = String(b?.queueId ?? party.queue);
      else if (rest === '/matchmaking/join') {
        party.state = 'MATCHMAKING';
        party.queueEntry = new Date().toISOString();
      } else if (rest === '/matchmaking/leave') {
        party.state = 'DEFAULT';
        party.queueEntry = '0001-01-01T00:00:00Z';
      } else if (rest === '/accessibility') party.accessibility = b?.accessibility === 'OPEN' ? 'OPEN' : 'CLOSED';
      else if (rest === '/invitecode') party.code = method === 'DELETE' ? '' : 'MOCK42';
      else if (/^\/invites\/name\/[^/]+\/tag\/[^/]+$/.test(rest)) {
        /* accepted; real client sends an invite */
      } else if ((m = /^\/request\/([^/]+)\/decline$/.exec(rest))) party.requests = party.requests.filter((r) => r.ID !== m![1]);
      else if ((m = /^\/members\/([^/]+)\/setReady$/.exec(rest))) party.ready = b?.ready === true;
      else if (/^\/members\/[^/]+\/refreshPings$/.test(rest)) {
        /* pings unchanged in mock */
      } else return notFound(res, `mock: no party route ${rest}`), true;
      return json(res, 200, partyJson()), true;
    }
    return false;
  };
}

export const mockFixtures = fx;

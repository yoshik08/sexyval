// Dev only: replays stored competitive updates in order and checks how well the estimate's sign
// (above / at / below rank) predicts the RR asymmetry of the next 5 matches. Then grid-searches the two
// blend weights and RR_PER_DIVISION.
//
//   npm run build:main
//   node scripts/mmr-backtest.mjs              # your data: %APPDATA%\SexyVal\mmr-updates + matches
//   node scripts/mmr-backtest.mjs --mock       # the mock profile (%APPDATA%\SexyVal-mock)
//   node scripts/mmr-backtest.mjs --synthetic  # mock careers generated in memory (no app run needed)
//   node scripts/mmr-backtest.mjs --team [--synthetic]  # 1.4 team blend vs the 1.3 blend (see the end of this file)
//
// SexyVal stores competitive updates per player (mmr-updates/<puuid>.json) whenever the MMR tab or a chip
// loads them; match details come from the existing matches/ cache.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const dist = (p) => path.join(root, 'dist-electron', p);
if (!fs.existsSync(dist('shared/mmr.js'))) {
  console.error('Build first: npm run build:main');
  process.exit(1);
}
const mmr = require(dist('shared/mmr.js'));
const teamMod = require(dist('shared/team.js'));
const { trimDetails } = require(dist('shared/last5.js'));

const args = new Set(process.argv.slice(2));
const HORIZON = 5;
const MIN_PREFIX = 6;
const ACTUAL_DEADBAND_RR = 2.5;

/** players: { puuid, updates: CompUpdate[] (any order), facts: { [matchId]: MatchFacts } }[] */
function loadStored(dir) {
  const upDir = path.join(dir, 'mmr-updates');
  const matchDir = path.join(dir, 'matches');
  if (!fs.existsSync(upDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(upDir).filter((x) => x.endsWith('.json'))) {
    const puuid = f.replace(/\.json$/, '');
    const stored = JSON.parse(fs.readFileSync(path.join(upDir, f), 'utf8'));
    const facts = {};
    for (const u of stored.updates ?? []) {
      const file = path.join(matchDir, `${u.matchId}.v2.json`);
      if (fs.existsSync(file)) facts[u.matchId] = mmr.factsFromDetails(JSON.parse(fs.readFileSync(file, 'utf8')), puuid);
    }
    out.push({ puuid, updates: stored.updates ?? [], facts });
  }
  return out;
}

function loadSynthetic() {
  const { career, PERSONA } = require(dist('mock/career.js'));
  const acts = ['act-prev', 'act-now'];
  const out = [];
  const ids = [...Object.values(PERSONA), ...Array.from({ length: 24 }, (_, i) => `synthetic-${i}`)];
  for (const [k, puuid] of ids.entries()) {
    for (const me of ['above', 'at', 'below']) {
      // 'off': the 1.3 careers (no mock squad), so this number stays comparable with the 1.3 README.
      const list = career(k === 0 ? 'a1b2c3d4-5e6f-4a1b-8c2d-0000000000aa' : puuid, acts, Date.UTC(2026, 10, 6), me, 'off').filter((m) => m.queue === 'competitive');
      const updates = list.map((m) => ({ matchId: m.id, startTime: m.start, seasonId: m.actId, tierBefore: m.tierBefore, tierAfter: m.tierAfter, rrBefore: m.rrBefore, rrAfter: m.rrAfter, rrEarned: m.rrEarned, perfBonus: m.perfBonus, afkPenalty: m.afk }));
      const facts = Object.fromEntries(
        list.map((m) => [m.id, { result: m.draw ? 'D' : m.win ? 'W' : 'L', roundDiff: m.myRounds - m.theirRounds, totalRounds: m.myRounds + m.theirRounds, acs: m.acs, otherTiers: Array.from({ length: 9 }, (_, i) => m.lobbyTier + ((i * 7) % 3) - 1), partySize: m.partySize }]),
      );
      out.push({ puuid: `${puuid}:${me}`, updates, facts });
      if (k !== 0) break; // only "you" changes persona; everyone else is one career
    }
  }
  return out;
}

const sign = (x, dead) => (x > dead ? 1 : x < -dead ? -1 : 0);

function backtest(players, params, team = false) {
  let hits = 0;
  let total = 0;
  for (const p of players) {
    const ups = [...p.updates].sort((a, b) => a.startTime - b.startTime);
    for (let i = MIN_PREFIX; i + HORIZON < ups.length; i++) {
      const prefix = ups.slice(0, i + 1);
      const last = prefix[prefix.length - 1];
      if (last.tierAfter < 3) continue;
      const e = mmr.estimateMmr({ updates: prefix, facts: p.facts, myTier: last.tierAfter, myRR: last.rrAfter, ...(team ? { team: p.team, puuid: p.puuid } : {}) }, params);
      if (!e.usable) continue;
      const next = ups.slice(i + 1, i + 1 + HORIZON).filter((u) => !mmr.excludeReason(u, p.facts[u.matchId]) && u.rrEarned !== 0);
      const w = next.filter((u) => u.rrEarned > 0).map((u) => u.rrEarned);
      const l = next.filter((u) => u.rrEarned < 0).map((u) => -u.rrEarned);
      if (!w.length || !l.length) continue;
      const asym = w.reduce((a, b) => a + b, 0) / w.length - l.reduce((a, b) => a + b, 0) / l.length;
      const predicted = sign(e.estTierDecimal - e.myTier, 0.5);
      // Fixed target: "at rank" means wins and losses within 2.5 RR of each other (half a division at the
      // default 5 RR/division). It must not move with the parameter being tuned.
      const actual = sign(asym, ACTUAL_DEADBAND_RR);
      total++;
      if (predicted === actual) hits++;
    }
  }
  return { hits, total, rate: total ? hits / total : 0 };
}

const dataDir = path.join(process.env.APPDATA ?? '', args.has('--mock') ? 'SexyVal-mock' : 'SexyVal');
if (args.has('--team')) {
  await runTeam();
  process.exit(0);
}
const players = args.has('--synthetic') ? loadSynthetic() : loadStored(dataDir);
if (!players.length) {
  console.log(`No stored competitive updates in ${dataDir}. Open the MMR tab in SexyVal 1.3 once, or run with --synthetic.`);
  process.exit(0);
}
console.log(`${players.length} player histories, ${players.reduce((a, p) => a + p.updates.length, 0)} competitive updates`);
const base = backtest(players, mmr.DEFAULT_PARAMS);
console.log(`defaults (W_LOBBY ${mmr.W_LOBBY}, W_SPLIT ${mmr.W_SPLIT}, RR_PER_DIVISION ${mmr.RR_PER_DIVISION}): ${(base.rate * 100).toFixed(1)}% (${base.hits}/${base.total})`);

const grid = [];
for (const wLobby of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  for (const rrPerDivision of [3, 4, 5, 6, 7]) {
    const r = backtest(players, { wLobby, wSplit: Math.round((1 - wLobby) * 10) / 10, rrPerDivision });
    grid.push({ wLobby, rrPerDivision, ...r });
  }
}
grid.sort((a, b) => b.rate - a.rate);
console.log('best 5:');
for (const g of grid.slice(0, 5)) console.log(`  W_LOBBY ${g.wLobby} / W_SPLIT ${(1 - g.wLobby).toFixed(1)} / RR_PER_DIVISION ${g.rrPerDivision}: ${(g.rate * 100).toFixed(1)}% (${g.hits}/${g.total})`);

// ---------- 1.4: --team ----------
//
//   node scripts/mmr-backtest.mjs --team              # your data (party data from the cached match details)
//   node scripts/mmr-backtest.mjs --team --synthetic  # the mock squad (MOCK_SQUAD on), through the mock server
//
// Same hit-rate method and ±2.5 RR deadband as above, old blend vs team blend, then PARTY_TOP_WEIGHT
// ∈ {0, 0.25, 0.5}. The ridge (RIDGE_LAMBDA ∈ {1, 3, 10}) is scored out of sample: fit the squad report on a
// prefix, then check the sign of each premade's adjusted impact against your RR in your next (up to 5)
// games with them, minus your RR per game without them in the prefix (direction only; differences
// inside ±2.5 RR are skipped).

async function loadSyntheticTeam() {
  const os = await import('node:os');
  const { startMockServer } = require(dist('mock/server.js'));
  const { SQUAD } = require(dist('mock/data.js'));
  const { RiotSession } = require(dist('main/riot/session.js'));
  const { RiotApi } = require(dist('main/riot/api.js'));
  process.env.SEXYVAL_QUIET = '1';
  const out = [];
  for (const persona of ['above', 'at', 'below']) {
    const mock = await startMockServer({ quiet: true, mmr: persona, squad: 'on', lockDir: path.join(os.tmpdir(), `sexyval-backtest-${process.pid}-${persona}`) });
    mock.setPhase('noval');
    const session = new RiotSession({ lockfilePath: mock.lockfilePath, shooterLogPath: path.join(os.tmpdir(), 'sexyval-no-log'), overrideGlz: `${mock.base}/glz`, overridePd: `${mock.base}/pd`, overrideShared: `${mock.base}/shared`, loadCache: async () => ({}) });
    const api = new RiotApi(session, () => undefined);
    await session.ensure();
    const me = 'a1b2c3d4-5e6f-4a1b-8c2d-0000000000aa';
    for (const puuid of [me, SQUAD.drain, SQUAD.carry, SQUAD.neutral, SQUAD.five]) {
      const updates = [];
      for (let start = 0; start < 200; start += 20) {
        const page = ((await api.competitiveUpdates(puuid, start + 20, 'competitive', start)).json?.Matches ?? []).map(mmr.parseUpdate).filter(Boolean);
        updates.push(...page);
        if (page.length < 20) break;
      }
      const facts = {};
      const team = {};
      for (const u of updates) {
        const res = await api.matchDetails(u.matchId);
        if (res.status !== 200) continue;
        const d = trimDetails(res.json, u.matchId);
        facts[u.matchId] = mmr.factsFromDetails(d, puuid);
        team[u.matchId] = teamMod.teamFactsFromDetails(d, puuid);
      }
      out.push({ puuid: `${puuid.slice(0, 8)}:${persona}`, updates, facts, team });
    }
    await mock.close();
  }
  return out;
}

/** Stored histories plus team facts from the same cached details (party data only where the cache has it). */
function withTeam(players, dir) {
  const matchDir = path.join(dir, 'matches');
  for (const p of players) {
    p.team = {};
    for (const u of p.updates) {
      const file = path.join(matchDir, `${u.matchId}.v2.json`);
      if (fs.existsSync(file)) p.team[u.matchId] = teamMod.teamFactsFromDetails(JSON.parse(fs.readFileSync(file, 'utf8')), p.puuid.split(':')[0]);
    }
  }
  return players;
}

/** Ridge sign vs what came next with each premade (out of sample). */
function ridgeBacktest(players, lambda) {
  let hits = 0;
  let total = 0;
  for (const p of players) {
    const ups = [...p.updates].sort((a, b) => a.startTime - b.startTime);
    for (let i = 9; i < ups.length - 1; i++) {
      const prefix = ups.slice(0, i + 1);
      const window = prefix.slice(-25).filter((u) => !mmr.excludeReason(u, p.facts[u.matchId]) || mmr.excludeReason(u, p.facts[u.matchId]) === '5-stack');
      const wm = window.map((u) => {
        const tf = p.team[u.matchId];
        return { matchId: u.matchId, startTime: u.startTime, rr: u.rrEarned, result: u.rrEarned > 0 ? 'W' : u.rrEarned < 0 ? 'L' : 'D', stack: tf?.stack ?? 'unknown', tf };
      });
      const sq = teamMod.buildSquad({ matches: wm, you: { puuid: p.puuid, tier: prefix.at(-1).tierAfter }, lambda });
      for (const r of sq.squad) {
        if (!r.eligible || r.beta == null || r.without.rrPerGame == null) continue;
        const next = ups.slice(i + 1).filter((u) => p.team[u.matchId]?.premades.some((x) => x.puuid === r.puuid)).slice(0, 5);
        if (!next.length) continue;
        // Direction only: outcomes inside the deadband are skipped, and the ridge's (shrunk) coefficient
        // counts by its sign, so a larger λ isn't scored down just for shrinking.
        const actual = sign(next.reduce((a, u) => a + u.rrEarned, 0) / next.length - r.without.rrPerGame, ACTUAL_DEADBAND_RR);
        if (actual === 0) continue;
        const predicted = Math.sign(r.beta);
        total++;
        if (predicted === actual) hits++;
      }
    }
  }
  return { hits, total, rate: total ? hits / total : 0 };
}

async function runTeam() {
  const players = args.has('--synthetic') ? await loadSyntheticTeam() : withTeam(loadStored(dataDir), dataDir);
  if (!players.length) {
    console.log(`No stored competitive updates in ${dataDir}.`);
    return;
  }
  const withParty = players.reduce((a, p) => a + Object.values(p.team).filter((t) => t && t.stack !== 'unknown').length, 0);
  const stacked = players.reduce((a, p) => a + Object.values(p.team).filter((t) => t && typeof t.stack === 'number' && t.stack >= 2).length, 0);
  console.log(`--team (${args.has('--synthetic') ? 'synthetic: mock squad through the mock server' : `real: ${dataDir}`}): ${players.length} histories, ${players.reduce((a, p) => a + p.updates.length, 0)} updates, ${withParty} with party data (${stacked} stacked)`);
  const old = backtest(players, mmr.DEFAULT_PARAMS);
  console.log(`  1.3 blend (no team data):  ${(old.rate * 100).toFixed(1)}% (${old.hits}/${old.total})`);
  for (const w of [0, 0.25, 0.5]) {
    const r = backtest(players, { ...mmr.DEFAULT_PARAMS, partyTopWeight: w }, true);
    console.log(`  team blend, PARTY_TOP_WEIGHT ${w}: ${(r.rate * 100).toFixed(1)}% (${r.hits}/${r.total})${w === teamMod.PARTY_TOP_WEIGHT ? '  <- shipped' : ''}`);
  }
  for (const lambda of [1, 3, 10]) {
    const r = ridgeBacktest(players, lambda);
    console.log(`  ridge sign, out of sample, RIDGE_LAMBDA ${lambda}: ${(r.rate * 100).toFixed(1)}% (${r.hits}/${r.total})${lambda === teamMod.RIDGE_LAMBDA ? '  <- shipped' : ''}`);
  }
}

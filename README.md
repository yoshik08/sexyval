# SexyVal

Personal, unofficial Valorant companion for Windows, in a normal desktop window, plus an optional small overlay during agent select (map and starting side). It covers the store with skin videos, your collection, loadout, missions, party, profiles and match history, friends, leaderboard and lineups, plus a live queue / agent-select / in-game view with a starting-side (ATK/DEF) indicator, current and peak ranks and SexyVal's own SV Score for every visible player.

> Not affiliated with Riot Games. Uses unofficial endpoints (valapidocs.techchrism.me / valorant-api-types) that can change or break at any time. Personal use only. No instalock, no gameplay automation; the only overlay is the optional agent-select pill (map + starting side) described below. Agent select/lock endpoints are deliberately not implemented. Party, queue and loadout changes only happen when you press a button.

## Install

- `release/SexyVal-Setup-1.4.0.exe` is the NSIS installer (per-user, lets you pick the folder). It upgrades earlier versions in place; close SexyVal (tray icon, Quit) first.
- `release/SexyVal-Portable-1.4.0.exe` runs without installing.

The builds are unsigned, so Windows SmartScreen will warn. Click "More info", then "Run anyway".

## What needs what

| Screen | Needs |
| --- | --- |
| Collection catalog, videos, agents/maps/weapons browsers, lineups | Nothing. Public valorant-api.com data, always loads. |
| Shop, wallet, owned items, loadout, missions/passes, profiles, history, leaderboard | Tokens + region + shard + client version: the Riot Client running, **or** a signed-in account. Valorant can be closed. |
| Friends, presence, friend requests | Riot Client running (local chat API). |
| Party & matchmaking | Valorant running (Riot's party service only knows online players). |
| Live (queue / agent select / in game) | Valorant running. This is the only tab that shows "Waiting for Valorant". |
| Skin prices | Nothing. A price list (Valorant wiki, 5 Nov 2026) ships with the app; prices seen in your store replace it. A HenrikDev key is optional. |

The header chip shows both states: **Client** (Riot Client local API reachable and signed in) and **Valorant** (game process in external-sessions).

## Run from source

Requires Node 20+ (tested with Node 26 for tooling; Electron 33 runs Node 20.18 internally).

```bash
npm install
npm start            # build + launch against the real Riot Client
npm run mock         # build + launch against the built-in mock Riot server
npm run check        # lint + typecheck + tests
npm run screenshots  # mock mode, captures every screen to ./screenshots, then quits
npm run dist         # icons + build + electron-builder --win (NSIS + portable) into ./release
npm run mock:update  # fake update feed for manually testing the auto-updater against a packaged build
npm run build:helper # helper/stretch.exe (Stretch / Boost) with Windows' own C# compiler; part of build and dist
```

Troubleshooting first install:
- **npm 11 skips install scripts** (`npm warn install-scripts … electron`). Run `node node_modules/electron/install.js` once.
- **Electron download hangs extracting on very new Node**: unzip `%LOCALAPPDATA%\electron\Cache\*\electron-v33*-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.
- **App starts as plain Node** (`Cannot read properties of undefined (reading 'setPath')`): your shell has `ELECTRON_RUN_AS_NODE=1` (VS Code terminals set it). The npm scripts use `scripts/run-electron.mjs`, which strips it.

## What changed in 1.4

- **Team-based MMR and Squad.** The MMR tab gets Solo view | Team view for your own account: an estimate corrected for who you queued with, a breakdown by stack size (solo / duo / trio / 5-stack), and a Squad report for everyone you queued with over your last 25 competitive matches (who costs you RR, who carries, with numbers and a confidence level). See [Team-based MMR and Squad](#team-based-mmr-and-squad-14).
- **25 matches per estimate** (two pages of competitive updates), for the solo view and the chips too.
- **Party RR penalty.** Party and the Live queue banner show "RR −25%" when Riot reports a `SkillDisparityRRPenalty` for your party; the MMR forecast uses it for your next match.
- **Match details cached before 1.3** (no party data) are fetched once more when the team view needs them.
- **Mock squad** (`MOCK_SQUAD`): five regulars whose own careers share your matches, so every number on the team view can be seen and tested.

## What changed in 1.3

- **Silent auto-update.** `electron-updater` against GitHub Releases (`.github/workflows/release.yml` publishes on a `v*` tag). Checks 30 s after start and every 4 h, downloads in the background (differential, via the NSIS blockmap), and never shows a dialog or OS notification. Once downloaded, it waits for a safe moment — Valorant idle, no video playing, no unsaved loadout edits, and either hidden in the tray or unfocused/idle 5+ minutes (`isSafeToInstall`, `shared/update.ts`) — before saving window bounds, tab, scroll position and the video/loadout flags to `resume.json` and calling `quitAndInstall(true, true)`. The relaunch restores that state and shows a brief "Updated to x.y.z" toast; nothing else is visible. If no safe moment ever comes, it installs on the next normal quit. Settings → General → Updates has an "Install updates automatically" toggle (on by default) and "Check now"; the portable build shows a plain "New version on GitHub" link instead, since it can't replace itself.
- **Fix: sidebar highlight stuck after resize/maximize.** The sliding highlight behind the active sidebar tab only re-measured on tab change, so maximizing (or any resize) left it behind — worst on Settings, which sits at the bottom. It now also watches the sidebar's size with a `ResizeObserver` and re-measures when fonts finish loading, snapping instantly for a layout-driven move instead of sliding (tab changes still slide).
- **Estimated MMR (new MMR tab).** See [Estimated MMR](#estimated-mmr-our-own-estimate) below. Profiles and an opened Live row get an "Estimated MMR" chip that opens the tab for that player.
- **Lifetime profile for every visible player in your match.** Open a Live row (agent select: your 5; in game: all 10) and it shows a lifetime line (matches, win rate, K/D, ACS, ADR), the Estimated MMR chip and **Full profile**, which opens Profiles on the new **Lifetime** tab by PUUID. Lifetime = competitive updates and match history paged 20 at a time until a short page (every act), then match details 20 at a time ("Load 20 more"), all from Riot's own `pd` endpoints with your session, through the pd rate limiter and the existing disk cache (a match seen for anyone is never fetched again). It shows totals (matches, win rate from every act, K/D, ACS, ADR, HS%, first bloods), current-act form (last 10 / 20), per-agent and per-map tables, best / worst agent and map (3+ games), rank across acts with act boundaries, and the full match list. Pure aggregation: `shared/lifetime.ts`. It is fetched only when a row is opened (rows that start open in Detailed density wait for a click), never for a whole roster. Opponents appear only once the match starts: Riot's pregame endpoint has no enemy roster.
- **Hidden players stay hidden.** Players who turned on Valorant's hide-name setting (`PlayerIdentity.Incognito`) are still not looked up anywhere: not in Live, and the Profiles / MMR / lifetime lookups refuse a player the live match marks hidden (`GameLoop.isHidden`). They show "Hidden", agent, level and the rank badge the game sends, as in 1.2.
- **Store archive: past bundles and a daily-shop calendar.** Every featured bundle (`bundles.json`) and every daily shop + night market per account and day (`shop-history.json`) is kept forever, merged, never overwritten; every price seen also goes to `prices.json`. Store → **Past bundles** lists them (art, every item incl. cards/buddies, exact base and discounted prices, dates seen, which account). Store → **History** is a month calendar per account: four tier-tinted thumbnails and the day's VP per day, a marker for night market days, a star when a watchlist skin showed up, a dash for days not captured, arrow / Page Up / Page Down keys. Click a day for its skins (opens the skin sheet), prices, night market discounts and what you own now. Search highlights every day a skin appeared ("Horizon Vandal · seen 14 times · last Nov 6"); the skin sheet says how often a skin was seen. Stats: days captured, most repeated skin, highest-value day, watchlist days. Shops are keyed by their rotation date (UTC, from the time left), never local midnight. A new bundle gives a toast + Windows notification (notifications setting respected).
- **Store fetch cadence.** A minute after every daily / bundle / night-market rotation, at least hourly, on start, when tokens appear, and after a game update — for every signed-in account (one after another, through the pd rate limiter; the active account through the normal store). After a game update SexyVal also refreshes the valorant-api catalog and bundle names and re-runs the wiki price scrape once per game version into the user data folder (`skin-prices.json`; the bundled list stays the fallback, a thin result never replaces a good list). Files that fail to parse are kept as `<name>.corrupt-<timestamp>.json`; a failed write is retried and the in-memory copy kept.
- **Stretch (Settings → Stretch).** See [Stretched resolution](#stretched-resolution).
- **Boost (Settings → Boost).** See [Game boost](#game-boost).
- **Fix: launch at startup is now on by default.** `launchAtStartup` defaulted to `false` and was only pushed to Windows' login items when the setting *changed*, so the default never actually registered. Fresh installs and upgrades from before this change now get it turned on once (a `settingsVersion` migration — `shared/settingsMigration.ts`); after that, whatever you pick sticks. Every start also re-syncs Windows' login item to the setting, so a moved install folder or an updated install path can't silently disable it.

## Estimated MMR (our own estimate)

Riot doesn't expose MMR; everything here is SexyVal's estimate and the screen says so. Riot has said RR = base win/loss + round margin + a small performance effect + a convergence term that pulls your rank toward your MMR (MMR above rank: wins pay more than losses cost). `shared/mmr.ts` reads that back out of your current act's competitive matches (`competitiveupdates`, the last 25 since 1.4, paged 0–20 then 20–25) and their details:

1. **Exclusions** (still listed, greyed): placements, AFK penalties, draws / remakes, 5-stacks (match-details `partyId`), other acts.
2. **Cleaned RR:** least squares per side, `RR = base + a·roundDiff + b·(ACS − 200)/100`, evaluated at roundDiff 0 and ACS 200. Under 6 wins or 6 losses with details: raw averages minus `RankedRatingPerformanceBonus`.
3. **Split gap** = (avg win − avg loss) / `RR_PER_DIVISION` (5).
4. **Lobby average:** mean competitive tier of the other 9 players per match (unranked ignored), averaged.
5. **Blend:** `0.6 · lobby + 0.4 · (your tier + gap)`, clamped to Iron 1…Radiant; the headline rounds to a division.
6. **Confidence:** Low under 5 usable matches, in the first 3 days of an act, or over 40% excluded; High over 10 with a per-match spread ≤ 1.5 divisions; else Medium.
7. **Forecast:** wins to the next division at your raw win RR, the cost of a loss, "Division skip possible" at a gap ≥ 2.

**Self-check:** `node scripts/mmr-backtest.mjs` (after `npm run build:main`) replays stored competitive updates (SexyVal keeps them in `%APPDATA%\SexyVal\mmr-updates\` from 1.3 on) and checks whether the estimate's sign (above / at / below, ±0.5 division) predicts the RR asymmetry of the next 5 usable matches (±2.5 RR), then grid-searches the weights and `RR_PER_DIVISION`. On 6 Nov 2026 there was no real data yet (1.3 had never run against a live account), so it ran on the mock careers only (`--synthetic`, 684 updates, 325 predictions): **71.1% with the shipped values** (W_LOBBY 0.6, W_SPLIT 0.4, RR_PER_DIVISION 5). The best grid point scored 74.2% (0.4 / 0.6 / 7), but tuning on data generated by SexyVal's own mock would be circular, so the defaults stay until the script has run on real updates.

## Team-based MMR and Squad (1.4)

The 1.3 estimate treats you as a solo player. Matchmaking doesn't: it balances your whole team (your party plus the randoms who fill it) against an enemy team of about the same average MMR, so your lobby reflects your **party's** MMR, not yours. RR stays personal, but wins and losses are shared. The MMR tab now has **Solo view | Team view** for your own account (remembered in settings; auto = Team view when your window has stacked games). Solo view is the 1.3 screen on the same matches. Everything below is SexyVal's own estimate; Riot doesn't expose MMR, and the screen says so.

**Window.** The last 25 competitive matches (`competitiveupdates` paged as 0–20, then 20–25 only if the first page was full; one call never assumed to return more than 20), current act only, no placements / AFK / remakes; draws count as games but not wins or losses. The solo estimate (and the chips) now use the same 25. Party size per match comes from match-details `partyId` (same party as you, your team). No `partyId` means the stack is "unknown": never guessed, kept out of every party number. Match details cached by SexyVal before 1.3 had `partyId` trimmed away; the team view fetches those once more (`TrimmedDetails.partyData` marks copies that already went through it). Stack sizes are 1, 2, 3 and 5; a 4 is kept only if the data says so.

**Model (`shared/team.ts`, wired into `estimateMmr` when `MmrInput.team` is present; without it every 1.3 step runs unchanged):**

1. **Team facts per match** (`teamFactsFromDetails`): your premades, randoms and enemies with tier, ACS, K/D/A, ADR, HS%, first bloods; team and enemy average tier (ranked only); your ACS place on your team; every player's ACS z-score inside the match (sd floored at 25).
2. **Team-adjusted lobby signal.** Stacked games: `impliedMe = 5 · enemyAvg − Σ proxy(teammate)` (= `enemyAvg + 4 · (enemyAvg − teamOthersAvg)`), where a premade's proxy is their estimated MMR once looked up, else their rank, and a random's is their rank. Unranked players are dropped and the 5 is rescaled to the players actually ranked; a match needs 4 ranked enemies and 3 ranked teammates. Solo games (and games without party data) use the plain lobby average, which is what the formula collapses to in expectation when nobody is a premade, with about a quarter of the noise. Aggregated with a Huber mean (δ = `HUBER_DELTA` 1.5 divisions) and its standard error. `PARTY_TOP_WEIGHT` (default 0 = plain mean) lets the party enter the balance as `(1 − w)·mean + w·max`; it is a backtest knob, not a belief.
3. **Blend.** `est = (split/var_s + team/var_t) / (1/var_s + 1/var_t)` with `var_s = spread²/n + SPLIT_FLOOR²` (0.6) and `var_t = se² + TEAM_FLOOR²` (0.8). These inverse-variance weights are scaled in by the share of stacked games: a solo-only window keeps the tuned 1.3 weights (0.6 lobby / 0.4 split), so it reproduces the 1.3 estimate exactly (a test checks ≤ 0.3 divisions on noisy lobbies with an outlier). The headline shows the weights it used ("Split 61% · Team lobbies 39%").
4. **5-stacks rescaled instead of excluded.** `f5 = median |RR| in 5-stacks / median |RR| in solo, duo and trio games`, per side, when each side has 3+ matches in both groups. Under `FIVE_PENALTY_BELOW` (0.85) the 5-stacks join the RR split divided by `f5` ("5-stack · RR ×0.75 (penalty)"); at or above it they join as they are ("no penalty seen"); if it can't be measured they stay excluded as in 1.3. The factor applies to every 5-stack in the window (the model can't tell which ones Riot docked).
5. **Live party.** `PartyService` and the live loop read `MatchmakingData.SkillDisparityRRPenalty`, normalise it to a 0–1 fraction (above 1 is read as a percentage; the raw value goes to the log at debug level) and expose it as `PartyView.rrPenalty` / `QueueView.rrPenalty`. Party and the Live queue banner show "RR −25%"; the MMR forecast uses it for the next match only ("With your current party: RR ×0.75").
6. **How you queue** (`stackBreakdown`): per stack size, games, W-L-D, win rate, average win / loss RR, net RR, RR per game, round margin, your ACS place, team and enemy average tier. Empty groups say "Never this act".
7. **Squad** (`buildSquad`), for every premade in the window:
   - *Raw:* games, record, your net RR and RR per game with them; the same without them; `delta = with − without`.
   - *Shrunk:* `delta · n / (n + K_SHRINK)` (5), with an 80% interval: bootstrap over their games (1000 resamples, seeded) under 8 games, normal approximation from 8.
   - *Adjusted impact:* ridge regression ("adjusted plus-minus") of your RR on an intercept, one indicator per premade (penalised, `RIDGE_LAMBDA` 3), a 5-stack indicator and lobby difficulty (enemy average − your team's average, both unpenalised, controls dropped when they have no variance). Lobby difficulty counts premades at their estimated MMR once known: by rank alone it moves with any premade whose MMR differs from their rank (the matchmaker balances MMR) and soaks up exactly their effect; the mock showed this with the carry. A second fit with y = ±1 for wins / losses is reported too.
   - *Performance in shared games* (your match details only): their ACS, ADR, K/D, HS%, first bloods per game, mean z, z in your losses, bottom-frag rate in losses, top-frag rate in wins; the same numbers for you.
   - *MMR / rank gap* (their own data, looked up lazily): their rank, their estimated MMR (the 1.3 model on their own updates), above / at / below their rank (estimate vs rank), your estimate − theirs, their own RR in the shared matches (joined on MatchID), and "5-stack penalty risk" when a 5-stack with them would sit outside the rank window below or include an Immortal+.
   - *Drain score:* `0.45·norm(−β) + 0.25·norm(−shrunk Δ) + 0.20·norm(−z in losses) + 0.10·norm(gap)`, each clamped to ±1 after dividing by 8 RR, 8 RR, 1.0 and 2 divisions; ×100, positive = costs you. Every input is on the card.
   - *Headline:* "11 games together · cost you about −88 RR" = Σ over shared games of (your RR − what the ridge expects from stack size and lobby alone, with no premade effects). The spec's intercept-only expectation was changed on purpose: it charged the 5-stack RR penalty to whoever happened to be in the stack ("Helps you" next to "cost you −20 RR").
   - *Verdicts:* Biggest drain / Costs you RR / Neutral (|drain| < 10) / Helps you / Best partner / Not enough games. The two extremes need |drain| ≥ 25 and 5+ games. Ranked only with 3+ games together **and** 3+ without (someone in nearly every match has no baseline). Random teammates appear only as one aggregate row.

**Hidden players.** A premade the live match marks hidden (`PlayerIdentity.Incognito`) shows as "Hidden teammate": no name lookup, rank, competitive updates, history or estimate; their lines in your own match details still count, because that's your data. Tests prove a hidden PUUID never reaches `api.mmr`, `api.competitiveUpdates`, `api.history` or `names` (spy `RiotApi`, and `MOCK_STRESS=hidden` against the mock).

**Service (`main/services/squad.ts`, IPC `mmr:team`, push event `mmr-team`).** The first answer (your window, stacks, squad raw + ridge + performance) never waits for premade lookups. Then, at most `MAX_SQUAD_LOOKUPS` (6) premades with 2+ shared games, most games first: `mmr/v1/players` + their 25 competitive updates (same paging), their estimate from details already on disk plus at most `MAX_PREMADE_DETAIL_FETCH` (10) new details (always their newest games without you, so a second open fetches none). Each lookup that lands pushes a fuller view; the squad list holds its order while lookups run and re-sorts once, with a FLIP (240 ms, reduced motion respected). Lookups are cached 5 min per player with in-flight dedupe and the last good result kept on error; a 4xx shows "RR data unavailable" and the card falls back to your RR. Only on screen open and Refresh, never on a timer, always through the pd limiter. Measured against the mock: **98 pd calls for a cold open** (worst case in the spec: 2 + 25 + 6 × (2 + 10) = 99, plus retried 429s), **19 for an app restart** (ranks and update pages only; every match from the disk cache), **0 within 5 minutes**. The count is logged at debug level.

**Community-reported party rules (not official).** Riot doesn't publish the formula. Players report: a 5-stack inside the normal party rank window with everyone Ascendant 3 or below gets no RR reduction; outside the window about 25% less; any Immortal about 25% less; any Radiant about 75–90% less. Duos and trios must stay inside the window (about 2 ranks / 6 tiers up to Gold, about 1 rank / 3 tiers from Platinum, no trios at Immortal+); 4-stacks can't queue Competitive. `RANK_WINDOWS` and `FIVE_STACK_RULES` in `shared/team.ts` encode this as named constants for the penalty-risk flag and the mock; the estimate itself measures the 5-stack factor from your matches.

**Backtest** (`node scripts/mmr-backtest.mjs --team [--synthetic]`, 7 Nov 2026), same hit-rate method and ±2.5 RR deadband as 1.3:

| Data | 1.3 blend | Team blend (`PARTY_TOP_WEIGHT` 0 / 0.25 / 0.5) | Ridge sign out of sample (λ 1 / 3 / 10) |
| --- | --- | --- | --- |
| Synthetic: the mock squad through the mock server, 15 histories, 683 updates (292 stacked) | 81.4% (354/435) | **82.1%** / 83.0% / 81.4% | 44.6% / **44.9%** / 43.9% (of 719) |
| Real: `%APPDATA%\SexyVal`, 3 histories, 60 updates, 8 with party data (4 stacked) | 42.3% (11/26) | 42.3% / 42.3% / 42.3% | no premade with 3+ games yet |

The synthetic set is SexyVal's own mock, so it can't justify new defaults (circular, as in 1.3): the shipped values stay until the script has run on real stacked games. The real set is too small to say anything: most of those matches were cached before party data was kept, and the stored updates stop at 20 per player. The ridge's out-of-sample direction is at chance on the synthetic set: per-premade effects over a 25-match window are noisy (single games swing ±20 RR), which is why the screen calls teammate impact "a rough signal, not a verdict". The plain 1.3 synthetic backtest (`--synthetic`, mock squad off) still scores 71.1%.

## Stretched resolution

Settings → Stretch: on/off, 1440×1080 / 1280×960 / 1280×1024 / 1080×1080 / custom, monitor, "Native while alt-tabbed". One status line ("Stretched to 1440×1080 @ 144 Hz" / "Native") and errors only when something failed.

- **Valorant's ini** (only while the game is closed; queued until it closes otherwise): every `GameUserSettings.ini` under `%LOCALAPPDATA%\VALORANT\Saved\Config` (per account `WindowsClient` or `Windows`, plus the machine-wide one) gets `ResolutionSizeX/Y`, `LastUserConfirmedResolutionSizeX/Y`, `DesiredScreenWidth/Height`, `LastUserConfirmedDesiredScreenWidth/Height`, `bShouldLetterbox=False`, `bLastConfirmedShouldLetterbox=False`, `FullscreenMode=1`, `LastConfirmedFullscreenMode=1`, `PreferredFullscreenMode=1` (Windowed Fullscreen, so the overlay keeps working). All of these keys were checked on a real install (Nov 2026). The original is backed up once (`GameUserSettings.sexyval-backup.ini`), then the file is made read-only. Off: read-only removed, backup restored.
- **Display:** when `VALORANT-Win64-Shipping.exe` appears (process list polled every 2 s, not the Riot API, no handle to the game), `helper/stretch.exe` switches the chosen monitor with `ChangeDisplaySettingsExW` + `dmDisplayFixedOutput = DMDFO_STRETCH`, at that size's highest refresh rate. The change is not saved to the registry, so a reboot always comes back native. When Valorant exits, the native mode saved at start comes back.
- **Crash safety:** a detached watchdog (`stretch.exe watchdog <pid>`) restores native if SexyVal dies while stretched; every start restores native if the desktop is still stretched with no game running; quitting SexyVal restores native before it exits.
- **Helper:** `helper/stretch.cs`, built with the .NET Framework C# compiler that ships with Windows (`npm run build:helper`), unsigned, shipped in `extraResources`. `--dry-run` everywhere (CI, mock mode).
- **Not done (needs real hardware):** the vendor fallbacks. If the driver ignores `DMDFO_STRETCH` (read back after the switch), SexyVal says "The graphics driver kept black bars: set its scaling to Full-screen" instead of calling NvAPI / AMD ADLX, and a resolution the monitor doesn't list is reported, not created as a custom resolution. Writing NvAPI/ADLX struct code that changes display configuration without a machine to test it on was not worth the risk.

## Game boost

Settings → Boost: one master switch, then a switch and a status dot per tweak (green = active, amber = waiting for Valorant, red = failed). Nothing opens, reads or changes the Valorant process; no injection; nothing touches Vanguard. Every change is written to a journal (`boost-journal.json`) with the original value **before** it is made, and reverted from it (`shared/boost.ts`).

| Tweak | When | How |
| --- | --- | --- |
| SexyVal gets out of the way | while Valorant runs | videos paused, hover previews off, no video caching, background catalog / price work deferred, renderer throttled, Below Normal priority, minimise goes to tray |
| High performance power plan | while Valorant runs | Ultimate Performance (created with `powercfg -duplicatescheme e9a42b02-…` if missing), else High performance; your plan back after |
| Pause Windows Search indexing (opt-in) | while Valorant runs | `sc stop WSearch` if it was running, started again after |
| Pause update delivery optimization (opt-in) | while Valorant runs | `sc stop DoSvc` the same way |
| High CPU priority | while on | `HKLM\…\Image File Execution Options\VALORANT-Win64-Shipping.exe\PerfOptions\CpuPriorityClass = 3` (Windows applies it at launch) |
| High-performance GPU | while on | `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, `GpuPreference=2;` for the Valorant exe (path from the Riot Client's product settings) |
| Windows Game Mode | while on | `HKCU\Software\Microsoft\GameBar` `AutoGameModeEnabled=1`, `AllowAutoGameMode=1` |
| Game Bar recording off | while on | `GameConfigStore\GameDVR_Enabled=0`, `GameDVR\AppCaptureEnabled=0` |
| Optimizations for windowed games | while on | `DirectXUserGlobalSettings` gets `SwapEffectUpgradeEnable=1;` (other flags in that value are kept) |
| Hardware-accelerated GPU scheduling | while on | `GraphicsDrivers\HwSchMode=2`; shows its current state and "takes effect after restart" |

**Admin with one prompt:** tweaks that need admin (CPU priority, HAGS, the two services) go through one Windows Scheduled Task registered with Highest privileges the first time one is needed (`SexyVal\Helper`, created from an XML definition through one UAC prompt). After that SexyVal writes the commands to a file and runs the task: no prompts. The helper only accepts an allow-list from that file: `reg query/add/delete` on exactly the IFEO PerfOptions key and the GraphicsDrivers key (values `CpuPriorityClass` / `HwSchMode`, DWORD only), `sc query/stop/start` for `WSearch` / `DoSvc`, and deleting its own task. Everything else is refused (tested). SexyVal itself never runs elevated.

**Crash / uninstall:** on start, session tweaks left in the journal with no game running are reverted. The NSIS uninstaller (`build/installer.nsh`, not on updates) runs `SexyVal.exe --sexyval-uninstall`: native display, Valorant's original ini, every Boost tweak reverted, the task removed.

**Competitive FPS preset** (game closed, backup first): sets every `[ScalabilityGroups]` `sg.*` quality to 0 (view distance, anti-aliasing, shadows, global illumination, reflections, post-process, textures, effects, foliage, shading). Those keys were verified on a real install; bloom, vignette, distortion and anisotropic filtering are not in the local ini files there, so they are not written. Resolution, stretch and NVIDIA Reflex live in other keys and aren't touched. "Restore my settings" puts back only the `[ScalabilityGroups]` values from the backup.

Not done, on purpose: timer-resolution hacks, "network throttling" registry tweaks, RAM cleaners, killing processes, editing game files, overclocking. No FPS numbers are shown: they can't be measured from outside the game.

## What changed in 1.2

**Queue detection and 1 s sync.** A new `queue` phase: when there is no pregame or core-game match, the loop reads your party (`parties/v1/players/{puuid}` → `CurrentPartyID`, cached until a party call returns 404, then `parties/v1/parties/{id}`); `State: MATCHMAKING` means you're queuing. Live shows "In queue · Competitive" with the time since `QueueEntryTime`; the header chip and tray say "In queue". Queue and agent select tick every **1 s** on their own cadence (the poll-rate setting and its 2–30 s clamp no longer apply there); menus and running matches keep the poll setting. A 429/5xx backoff always wins over the fast cadence. On top of polling, SexyVal listens to the Riot Client's local WebSocket (`wss://127.0.0.1:{lockfile port}`, Basic `riot:{password}`, `[5, "OnJsonApiEvent"]`) and polls at once on any `ares-parties` / `ares-pregame` / `ares-core-game` event, reconnecting with backoff when the client restarts. Events that arrive during a backoff are dropped. The map is pushed to the screen the moment `MapID` appears, without the 80 ms debounce.

**Overlay: map + side, "Match found", fullscreen check.** The agent-select pill now shows the map (name and its small list image) next to the starting side; modes without sides show the map alone. When the queue pops it appears at once with "Match found" (Settings toggle, on by default). It re-claims the top of the z-order (`setAlwaysOnTop('screen-saver')` + `moveTop()`) every time it is shown. SexyVal reads Valorant's `GameUserSettings.ini` (read-only, see below); if the game is in exclusive Fullscreen and the overlay is on, it shows a one-time toast and a note in Settings: "Valorant is in Fullscreen. Switch Display Mode to Windowed Fullscreen to see the overlay."

**Prices: a bundled price list, approximations for newer skins.** The 1.1 tier tables are gone. Every skin's price now comes from, best first:
1. your own store (daily, night market, bundles; remembered in `prices.json`): "Price as shown in your store";
2. HenrikDev store offers (`api.henrikdev.xyz/valorant/v1|v2/store-offers`, optional key in Settings → Accounts, cached in `offers.json` per game version or 24 h);
3. **the bundled price list** `shared/data/skin-prices.json`: 686 skins, scraped on 5 Nov 2026 from the "Store" table of every weapon page on the Valorant wiki (`node scripts/scrape-prices.mjs` rebuilds it), matched to valorant-api.com skins by name; it covers 686 of the 860 skins that are sold;
4. contract rewards keep their source ("Battle Pass · …");
5. **approximations (≈, muted)** for skins newer than the list: the price the rest of its collection sells for, else the usual price of its edition (the median of listed prices for that tier, guns and melee apart). The skin sheet says it is approximate, and a price seen in your store replaces it;
6. otherwise "Price not available" (nothing to go on; none on today's catalog).

On the current catalog that is 670 skins from the list, 531 contract rewards and 169 approximations (137 of them VCT team Classics, which are sold only inside team capsules). HenrikDev's own OpenAPI spec (checked 5 Nov 2026) documents `store-offers` as *"Removed by Riot. This endpoint unconditionally returns 404 with RiotImplementationRemoved."*, so that source is empty today; its client stays in place in case it returns. Weapon credit costs in Hub come from the game files (`shopData.cost`); melee shows no cost.

**Overlay look.** The pill is now a minimal AMOLED panel: a solid black rectangle with a 1 px hairline border, the map image large on the left, the map name, and "Attack first" / "Defense first" in red or blue with "Starting side" under it. No gradients, glow or shadow; it fades in with a 4 px drop (200 ms).

**Friends.** The Riot Client's chat reports a "product" for every online friend, and for someone who only has the Riot Client open it is often `riot_client` or even `league_of_legends`. Hub used to print that as "Playing riot_client". Now only a Valorant presence gives a status (In menus, In queue, Agent select, In game 7-5); anything else is "Online", "Away" or "On Riot Mobile", and when a friend has several presences the Valorant one wins.

**Players in Live.** Every visible player row (allies in agent select, both teams in game) shows current rank, peak rank, **SV Score** and the last-5 pips, with a "Open on tracker.gg" button. Rows are compact by default (one line; details in tooltips). Click a row, or Enter/Space, to expand it in place: rank names + RR, peak + the act it was reached in, the SV Score breakdown, the last five matches, tracker.gg. Esc or another click closes it; one open row per team. The Live header has **Auto / Compact / Detailed** (remembered); Auto is compact when the Live area is under 1100 px wide or a 10-player match is on screen. Expanding animates the measured height (220 ms open, 170 ms close, `expo.out`; content fades in 60 ms after the height starts; rows below slide), rank icons scale with a transform, and `prefers-reduced-motion` swaps instantly. Hidden players show "Hidden", agent, level and the rank badge the game sends, nothing else.

## SV Score (our own metric)

SV Score is SexyVal's own 0–1000 rating, computed in `shared/score.ts` from the last five matches SexyVal already loads for the last-5 pips. It is **not Tracker Score** (that formula is proprietary, and nothing here talks to tracker.gg except the button that opens its page in your browser).

| Part | Weight | 0 at | 1000 at |
| --- | --- | --- | --- |
| ACS (combat score per round) | 30% | 130 | 300 |
| K/D | 20% | 0.6 | 1.6 |
| ADR (damage per round) | 15% | 90 | 180 |
| HS% | 10% | 10% | 35% |
| First bloods per round | 10% | 0.04 | 0.20 |
| Win rate (decided matches) | 15% | 30% | 70% |

Each stat is mapped linearly onto 0–1 between its two reference points and clamped, then weighted. ACS, ADR and HS% are averaged per round across the matches. Only matches with round data count (deathmatch has none); with fewer than three, the score is "—". The tooltip and the expanded row show every part.

## What changed in 1.1

Three pipelines were broken against the live API (release 13.09) while the old mock still answered, so nothing flagged them. The mock now mirrors production, including the 404s.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Loadout never loaded | `personalization/v2/.../playerloadout` returns 404; the game uses **v3**, where `Sprays` became `ActiveExpressions` | GET/PUT v3 (v2 kept as fallback). Apply re-reads the live loadout first and merges only your edits into Riot's own object, so unknown fields survive. Verified on a live account: read, and a no-op write (Version 172 → 173, content identical). |
| "Price unknown" on almost every skin | `store/v1/offers/` returns 404 and the error was swallowed | Price book: exact prices seen in your store are remembered (`prices.json`); contract rewards say where they come from ("Battle Pass · Season 2026 Act III"). 1.1 filled the rest with a tier price; 1.2 replaces that with a bundled price list (see above). |
| Videos slow or never starting | Videos are 1080p, 3–147 MB (median ~22 MB). With "Cache videos" on, the whole file was downloaded into memory before the first byte, and hover previews did the same | Range streaming with upstream cancel; hover previews (`?p=1`) are never cached and capped at two; deliberate plays are tee'd to disk only when complete, with an LRU size limit (Settings). |

Also: valorant-api.com refreshes are keyed to the game version and tolerate a failing endpoint; the store is fetched with v3 first (what the game calls).

The interface was rebuilt: true-black (AMOLED) ground, Archivo (variable, set expanded) for titles and numbers with Geist for UI text, Phosphor icons, tier colour used only as light behind the renders, a sliding-highlight sidebar, popover selects, a skin sheet whose render travels from its tile (View Transitions), and a custom video player. Design and motion guidance came from the project skills in `.claude/skills`.

## Connection (Part 1)

- **Tokens**: Riot Client local API (`lockfile` → Basic `riot:<password>` → `/entitlements/v1/token`). This works with Valorant closed. Self-signed TLS is accepted only for `127.0.0.1` (scoped undici Agent).
- **Region/shard, in order**: Valorant session launch args (`-ares-deployment`, `-config-endpoint`) → riot-geo region of the signed-in account → per-account disk cache → `ShooterGame.log` (glz URL line) → `GET /riotclient/region-locale`. Anything not from the game is **verified**: the account must have owned agents on that shard. If nothing verifies, SexyVal probes na/eu/ap/kr. latam/br use shard `na`. Only verified regions are cached, per PUUID, in `connection-cache.json`.
- **Why region-locale is last**: on a real AP account the Riot Client reported `region: "NA"` (it's the client UI region, not the Valorant shard). Requests then hit `pd.na`, which answers 200 with empty data, so everything looked "not owned". The shard check catches this.
- **Client version, in order**: Valorant session `version` (only if `release-*`) → disk cache → `ShooterGame.log` `CI server version:` → `valorant-api.com/v1/version` `riotClientVersion`.
- **Shop failures**: `POST /store/v3/storefront` first (what the game calls), `GET /store/v2/storefront` as fallback. Errors show the HTTP status and body snippet; raw responses (`storefrontV2`, `storefrontV3`) are in Settings → Debug. Last good items stay on screen.

## Sign in with Riot (Part 2)

Settings → Accounts → **Sign in with Riot** opens Riot's own login page in a window with a persistent partition (`persist:riot-<id>`). SexyVal never touches the password. It captures the `playvalorant.com/opt_in#access_token=…&id_token=…` redirect, then:
`POST entitlements.auth.riotgames.com/api/token/v1` → entitlement, `GET auth.riotgames.com/userinfo` → PUUID + Name#Tag, `PUT riot-geo.pas.si.riotgames.com/pas/v1/product/valorant` → `affinities.live` region.

- Silent re-auth every ~50 min and on 401: the authorize URL loads in a hidden window on the same partition. If Riot asks for a login, the account is marked expired and an alert offers "Sign in again" / "Remove account".
- Multi-account: add, switch, remove (removal clears the partition).
- Token priority: Riot Client if running, else the active signed-in account. Settings shows which is active.
- Tokens live only in main-process memory. Only account metadata (name, tag, region) is written to `accounts.json`; cookies live in the Electron partition.
- **Warning:** this is an unofficial login flow. Riot can show captchas or change it at any time.

## Features (Parts 3 and 4)

| Area | What's there | Endpoints |
| --- | --- | --- |
| Store | Daily, bundles, night market (discounts), wallet, owned badges, watchlist with toast + Windows notification when a watched skin shows up, every tile opens the skin sheet. Past bundles (kept forever, exact prices) and a per-account daily-shop calendar with search and stats, for every signed-in account | store v3/v2 storefront, wallet, owned items |
| Collection | Every skin with owned/not-owned state, counters overall / per weapon / per collection, filters (owned, weapon, tier, collection, search), sort (tier, name, newest*), virtualized grid, lazy images, hover preview video. Buddies, sprays (animated on hover), cards, titles. | valorant-api.com + `store/v1/entitlements/{puuid}/{type}` |
| Skin sheet | Large render (pointer parallax), tier, collection, price (your store, store offers or the bundled list) / approximate price (≈) / contract source, level list, variant swatches, owned markers per level/variant, custom video player (Space, arrows, M, F), "Play all", sound preference | valorant-api.com |
| Loadout | Card, title, sprays (wheel order), per-weapon skin/level/variant, buddies (uses owned InstanceIDs), incognito/hide level, local presets, floating apply bar with change count | `personalization/v3/players/{puuid}/playerloadout` GET/PUT |
| Missions | Daily checkpoints, weeklies, queued weeklies, future weeklies by date, battle pass, event pass, agent contracts (activate), account level | `contracts/v1/contracts`, `account-xp/v1/players`, valorant-api missions/contracts/seasons |
| Party | Queue select, start/stop queue, ready, open/closed, code generate/disable, join by code, invite Name#Tag, decline requests, kick, leave, member card/level/rank, pings per server, the party's RR penalty when Riot reports one | `parties/v1/...` |
| Profiles | Self or Name#Tag, "Open on tracker.gg", title, card, level, rank, peak, RR, RR graph, history with RR impact, filters (queue/agent/map/result/date), full scoreboard (K/D/A, ACS, ADR, HS%, first bloods, avg loadout), analysis (per-agent/map win rate, K/D and ACS trends), Lifetime tab (every act, paged), Estimated MMR chip | `mmr/v1/players`, `competitiveupdates` (paged), match history (paged)/details, name-service |
| MMR | Estimated MMR (our own estimate) for you or any player SexyVal can resolve: headline vs rank, RR split, lobby average, win rate, rank / lobby / estimate graph, forecast, every match with why its RR was what it was. For you: Solo view / Team view (team-adjusted estimate, how you queue by stack size, Squad report per premade) | `mmr/v1/players`, `competitiveupdates` (paged), match details (party data) |
| Hub | Friends + presence + requests (send/cancel), leaderboard by act, agents/maps/weapons browsers, local lineups library (images + links) | local `chat/v4/*`, `mmr/v1/leaderboards`, valorant-api.com |
| Live | Queue timer; agent select with starting-side ATK/DEF badge (hardcoded, see below) + "Loadout & skins" shortcut; current + peak rank, SV Score, last 5 and a tracker.gg button per visible player (allies in agent select, everyone in game), compact / expandable rows; full lifetime profile and Estimated MMR for every visible player in the match when a row is opened. Optional agent-select overlay (map + side). | pregame / core-game, `parties/v1`, `mmr/v1/players`, local WebSocket |
| App | Icon picker (4 colours, tray + window), session-expired alert, poll rate, history queue filter, launch at startup, notifications, video cache toggle with size + clear, platform selector, HenrikDev key, Stretch, Boost, Debug | — |

\* No release date exists in the catalog. "Newest" = first time SexyVal saw the skin, then catalog order.

**Not implemented (no documented endpoint, so nothing is guessed):** accepting party invites or join requests, transferring party leadership, choosing preferred servers, removing a friend, and accepting an incoming friend request. The UI says so and points to the game client.

**Name#Tag lookup:** Riot documents no direct lookup. SexyVal resolves players you've seen (name-service results, scoreboards) and leaderboard players.

## Media rules

- No Riot assets are bundled. Images go through `svasset://` (only `*.valorant-api.com`, cached on disk). Videos go through `svvideo://`: Range requests stream from the URLs valorant-api.com provides, which point at `valorant.dyn.riotcdn.net`. Playback starts from the first chunks; hover previews are never cached and at most two run at once. With **Keep watched videos** on, a video you open is written to disk as it streams and kept only if every byte arrived; the cache is LRU-limited (Settings shows usage, the limit, and a clear button). 58% of skins (mostly Select and Deluxe) have no video in the game data; those show the still render.
- The still render sits under every video and the video fades in on its first frame; errors show a retry. Hover previews start after a 350 ms rest, use `preload="none"`, and drop their connection when the pointer leaves (pausing alone keeps downloading). One video plays at a time.

## Mock mode

`MOCK=1` starts a fake Riot server (`mock/server.ts` + `mock/extra.ts`) inside the app, writes a fake lockfile, and points glz/pd/shared/auth at it. Shapes follow valorant-api-types. It covers: local entitlements, external-sessions, region-locale, chat friends/presences/requests, sign-in (authorize redirect, entitlement, userinfo, geo), pregame/core-game, history/details (with a 429), name-service, storefront (v3, bundles, night market), wallet, owned items (docs `EntitlementsByTypes` shape), contracts, account XP, loadout v3 GET/PUT (`ActiveExpressions`), MMR, competitive updates, leaderboard, content, the party endpoints (with a real `MATCHMAKING` state and `QueueEntryTime` in the queue phase), the local WebSocket (same handshake and `OnJsonApiEvent` frames as the Riot Client, sent on every phase change and party action), and HenrikDev store offers at `/henrik` (401 for a bad key; with the key `HDEV-mock-0000-key` it answers 404 RiotImplementationRemoved like production, or a v1/v2 offers payload with `MOCK_HENRIK=offers`). It also writes a fake `GameUserSettings.ini` in exclusive Fullscreen so the overlay warning can be seen. Retired routes (`store/v1/offers`, personalization v2) answer 404 as they do in production.

1.3 mock additions: every player has a deterministic career (`mock/career.ts`) that drives history, `competitiveupdates` (paged with `startIndex`/`endIndex`) and match details together, so RR sign, score, lobby ranks and party size agree; you have 52 matches and each persona 48, across two acts. One persona is flagged `trackerPrivate` in mock data only (the app never reads that flag or any tracker; a test asserts only `pd` endpoints were called). A second featured bundle rotates every 90 s (30 s with `MOCK_FAST`) and includes a card and a buddy; the daily store resets at 00:00 UTC like Riot's. The app seeds 60 days of shop history for two accounts (with gaps and a night market) into the mock profile. Stretch runs the real helper with `--dry-run` (it reads your monitors but never changes them) and Boost runs against a pretend Windows (`mock/fakeWindows.ts`). The mock server logs every request path (`mock.requests`) for tests.

1.4 mock additions: a fixed squad (`SQUAD` in `mock/data.ts`: Rahul#drain, Arjun#carry, Kabir#mid, Dev#rare, Zoya#five). Your newest 25 competitive matches follow a fixed plan (8 solo, 7 duo, 4 trio, 6 five-stack; Dev in 2 games only; drain and carry together in four 5-stacks), with the drain about 2 divisions under you and below his rank, ACS z about −0.7, fewer wins; the carry above you, z about +0.8, more wins. Each member's own career contains those matches (same MatchID, result, score and map) with their own RR from their own persona, and their other games keep them near their rank offset from you. Match details put them in your party slots (shared `partyId`) at their own rank and ACS, and fill both teams around the party's MMR, so the lobby reflects the party. A 5-stack outside the community rank window (decided from the ranks it actually had) gives everyone RR × 0.75. With the squad on, your live party is your squad, and squad-mode matches get their own ids so a profile cached by an older mock run can't leak in. `MOCK_STRESS=radiant` now also makes every lobby in match details Radiant.

`mock/fixtures/collection.json` (from `scripts/make-mock-fixtures.mjs`) holds only real UUIDs, dates and prices: owned items, shop skins with and without videos, loadout, missions and contracts.

| Env var | Effect |
| --- | --- |
| `MOCK=1` | Use the mock server. Separate data dir `%APPDATA%\SexyVal-mock`. |
| `MOCK_PHASE=pregame` | Pin a phase at startup: `idle`, `queue`, `pregame`, `ingame`, `offline` (Riot Client closed), `noval` (Riot Client open, Valorant closed). The automatic scenario runs idle → queue → pregame → ingame. |
| `MOCK_FAST=1` | Short scenario (6 s / 4 s / 12 s / 10 s). |
| `MOCK_HENRIK=offers` | Mock HenrikDev serves an offers payload instead of production's 404. |
| `MOCK_MMR=<persona>` | Your own MMR persona: `above` (default: +23/−11, lobbies ~2 divisions up), `at` (+18/−18), `below` (+12/−23, low lobbies), `excluded` (mostly AFK / 5-stack / placements). The at / below / excluded personas and a tracker-private player always sit in the mock match, so Live can open each. |
| `SEXYVAL_DRY_RUN=1` | Not mock: Stretch and Boost only report what they would do (helper `--dry-run`, pretend Windows). Mock mode always does this. |
| `MOCK_SQUAD=<mode>` | Who you queue with: `on` (default, the squad above), `off` (1.3: random parties, no squad), `solo` (no premades this act), `penalty` (on, plus a 5-stack party with `SkillDisparityRRPenalty: 0.25`), `many` (12 regulars), `five` (only 5-stacks). |
| `MOCK_STRESS=<case>` | Worst-case data for UI checks: `long-names` (16-character, non-Latin, emoji Riot IDs), `radiant` (everyone Radiant, peak Radiant), `unrated` (no rank anywhere), `nommr` (MMR answers 503), `hidden` (everyone but you hidden). |
| `SEXYVAL_SHOT_ONLY=04,08` | Only run those screenshot steps. |
| `SEXYVAL_USER_DATA=<dir>` | Use a separate profile (own single-instance lock), e.g. to test next to an installed copy. |
| `SEXYVAL_LIVE_SHOTS=<dir>` | Not mock: capture Store, Collection, Loadout and Live against the real Riot Client, then quit. Opens without taking focus. |
| `SEXYVAL_EVAL=<js>` | In either capture mode, log what this page expression returns after every step. |

## ATK/DEF (starting side)

Riot's API has no attacker/defender field, so the rule is hardcoded in `shared/side.ts` (`getStartSide(teamId, queueID, modeId)`): **Red attacks first, Blue defends first.** Your team comes from the pregame match (`AllyTeam.TeamID`, or the `Teams` entry with your PUUID).

- Spike queues: competitive, unrated, premier, swiftplay, spikerush (decided by queue, not by "Bomb" in the mode name, which Swiftplay lacks). Deathmatch, Escalation and other modes, and blank/custom queues, show no side.
- Only competitive is verified (15 of 15 matches, Nov 2026). Other spike queues get the same answer with the tooltip "assumed from competitive, unverified".
- If Riot changes sides, this will be wrong silently; it has no self-check.

## Agent select overlay

A small black panel with the map (image + name) and "Attack first" (red) or "Defense first" (blue), at the top of the primary display or the one you pick. It appears during agent select as soon as the map or the side is known (custom and no-side modes show the map only), with "Match found" for a few seconds when your queue pops, and hides the moment the phase changes; it never shows enemy info or anything in game. The window (400×62 medium, 330×50 small) is exactly as tall as the panel and wider than it; the panel sizes to its content and hugs the chosen edge, the rest is transparent and click-through. Measured: medium 305×62 (Breeze, Attack first) to 331×62 (Fracture, Defense first).

- It is a normal frameless, transparent, always-on-top window: no injection, no hooks, no memory reading, no screen capture. It can't take focus (shown inactive, `focusable: false`), lets every click through and has no taskbar entry.
- Works over Valorant in **Windowed** or **Windowed Fullscreen** (borderless). Windows cannot draw it over **exclusive Fullscreen**; that is an OS limit and SexyVal does not work around it.
- **Fullscreen check** (read-only, local file, nothing touches the game): Valorant keeps its display mode in `%LOCALAPPDATA%\VALORANT\Saved\Config\<puuid>-<region>\WindowsClient\GameUserSettings.ini` (on the install checked it is `WindowsClient`, not `Windows`; both are read) and a machine-wide `Config\WindowsClient\GameUserSettings.ini`. The newest of these wins. `FullscreenMode` (then `LastConfirmedFullscreenMode`) uses Unreal's values: 0 Fullscreen, 1 Windowed Fullscreen, 2 Windowed. If no file is found, nothing is said.
- Settings → General: on/off (default on), "Match found" (default on), position (top center/left/right), size (small/medium), display (when you have more than one). The tray menu has an on/off toggle too.
- Mock: `MOCK_PHASE=pregame` shows it; the screenshot run saves `21a-overlay-match-found.png`, `21b-agent-select-overlay.png` and `21c-agent-select-overlay-small.png`.

Side data saved by earlier versions (`calibration.json`) is deleted on first start.

## Verified against a live account

- Riot Client tokens with Valorant closed; version from ShooterGame.log; region via ShooterGame.log plus the shard check.
- Owned items per type: HTTP 200, flat `{ ItemTypeID, Entitlements: [...] }` (not the docs' `EntitlementsByTypes`; both are parsed). Skins, variants, buddies, sprays, cards, titles and agents all return data.
- **1.4 (from the data SexyVal 1.3 cached on a real AP account, 6–7 Nov 2026):** match-details `players[].partyId` is there: every match fetched since 1.3 has it (32 matches, 16 competitive; party sizes 1, 2 and 3 seen); copies cached before 1.3 don't, because older versions trimmed it. `competitiveupdates` for other players works with your token (two teammates' lists were stored by real calls). `RankedRatingPerformanceBonus` is present, mostly 0, and was +4 on a loss.

## Untested against the live game

Built from the docs and verified only against the mock:
- **1.2:** the party `MATCHMAKING` state and `QueueEntryTime` during a real queue; the Riot Client WebSocket (handshake, subscription, event URIs) on a real client; how fast `MapID` fills in on a real pregame match.
- **1.2:** the fullscreen value mapping. A real install read `FullscreenMode=1` while in Windowed Fullscreen; 0 = Fullscreen and 2 = Windowed come from Unreal and were not confirmed by switching modes in game.
- **1.2:** the overlay over a real borderless Valorant after alt-tab (the z-order re-claim).
- **1.2:** the bundled price list's accuracy beyond spot checks (it mirrors the wiki's Store tables).
- **1.2:** HenrikDev store offers with a real key. Without a key both versions answer 401; HenrikDev's spec says the endpoint now always returns 404, so the offers coverage (how many store skins get a price) could not be measured. Both shapes are parsed from HenrikDev's docs and Riot's legacy offers body.
- **1.2:** `mmr/v1/players` for other players (current rank, peak and the act it was reached in), and tier numbering for acts before Episode 5.
- **1.3:** the whole silent auto-update path against a real NSIS install: a published GitHub release, the differential blockmap download, and `quitAndInstall(true, true)` actually relaunching a packaged build. `scripts/mock-update-server.mjs` exercises check → download → `update-downloaded` → safe-moment wait → resume.json against a locally faked feed, but someone has to watch a real installed copy do the relaunch at least once before this is trusted. `isSafeToInstall` itself (`shared/update.ts`) is fully unit-tested.
- **1.3:** Estimated MMR against real competitive updates (the backtest has only run on mock data plus 60 real updates).
- **1.4:** `competitiveupdates` / `match-history` page size: assumed to be at most 20 per request (the mock enforces it); never tested whether one call with `endIndex=25` would return 25. SexyVal pages anyway.
- **1.4:** `MatchmakingData.SkillDisparityRRPenalty`: its scale (0–1 fraction or a percentage) and when Riot sets it. No real value has been captured yet (the mock sends 0 or 0.25); the Party screen logs the raw value at debug level whenever it changes, and the full party JSON is in Settings → Debug.
- **1.4:** the team-adjusted estimate and the Squad report on real stacked games: the real backtest had 8 matches with party data (4 stacked), and no premade with 3+ games, so the ridge and the drain score have only run on mock data. The community party rules (rank windows, 5-stack RR factors) are unofficial.
- **1.4:** a premade's `competitiveupdates` answering 4xx (handled as "RR data unavailable", not seen live).
- **1.3:** the paginated lifetime fetch against a real account with a long competitive history: rate-limit behaviour over 100+ matches, and whether Riot throttles `competitiveupdates` paging. It pages sequentially through the pd limiter (4 at a time) and caps at 50 pages per list.
- **1.3:** store sync for a second signed-in account on a real store (`storefrontFor`, tokens per account); bundle rotation times from `DurationRemainingInSeconds` on the live store; the per-game-version wiki scrape inside the app.
- **1.3 Stretch:** `DMDFO_STRETCH` on real drivers (on the dev laptop the panel is driven by an NVIDIA RTX 3050; only `list` and `--dry-run` were run, never a real switch, since the game may be running), Valorant accepting a read-only `GameUserSettings.ini`, the watchdog restoring after a real crash, the uninstaller hook. NvAPI / AMD ADLX fallbacks and custom resolutions are not implemented (see Stretch).
- **1.3 Boost:** every tweak against real Windows (all were tested only against the pretend Windows), the scheduled task registration (XML, one UAC prompt) and whether a standard user can trigger it with `schtasks /Run`, Ultimate Performance duplication on Home editions, `sc stop` on `DoSvc`, and SexyVal's own CPU use while quiet (the < 1% target is not measured).
- Everything in Part 2 (the real Riot login page, captchas, cookie lifetime, silent re-auth, riot-geo).
- `auth.riotgames.com/userinfo` `affinity` (live value `{"pp":"as"}`, undocumented, not used).
- Bundle `DiscountPercent` scale (fraction vs percent), bundle names (valorant-api `/bundles/{DataAssetID}`).
- Loadout edits that change buddies (InstanceIDs). Reading and writing the loadout itself is verified (1.1).
- All party actions, custom game configs.
- Contracts/missions field mapping, account XP, MMR/peak, competitive updates, leaderboard.
- Friends/presence decoding, friend request send/cancel.
- Console platform values for `X-Riot-ClientPlatform` (only PC is documented).
- The external-sessions `version` format, and real 429 behaviour.
- The starting side for queues other than competitive.

## Limits

- Endpoints are unofficial; shapes are handled defensively (missing fields fall back, never crash), but Riot can change things.
- The starting side is hardcoded (Red attacks first). If Riot changes sides, it is wrong silently; there is no self-check.
- The overlay can't appear over exclusive Fullscreen.
- Prices: the bundled list is a snapshot of the Valorant wiki (5 Nov 2026) and can be wrong where the wiki is; newer skins show an approximation (≈) until they appear in your store. Run `node scripts/scrape-prices.mjs` to refresh the list.
- SV Score is a fixed-range blend of five recent matches: a small sample, comparable only with other SV Scores.
- Estimated MMR is an estimate from RR changes and lobby ranks; Riot doesn't show real MMR.
- The Squad report works from your last 25 competitive matches: one premade's effect rests on a handful of games that each swing about ±20 RR, so it is a rough signal, not a verdict. The party rank windows and 5-stack RR factors it mentions are community-reported, not Riot's.
- Lifetime profiles only work for players in your live match (allies in agent select, everyone once the match starts) or players you've played with (via stored match details, friends, the leaderboard). It is not a way to look up an arbitrary stranger, and hidden-name players are never looked up.
- A bundle or daily shop is captured only if SexyVal runs with valid tokens at least once while it's in the store; start-with-Windows + the tray keep that near 100%. Days SexyVal never saw stay empty on the calendar.
- Valorant may sync its settings from the cloud and override the ini (stretch keys are read-only against that; the FPS preset isn't).
- Windows only. Unsigned builds.

# SexyVal

Personal, unofficial Valorant companion for Windows, in a normal desktop window, plus an optional small overlay during agent select (map and starting side). It covers the store with skin videos, your collection, loadout, missions, party, profiles and match history, friends, leaderboard and lineups, plus a live queue / agent-select / in-game view with a starting-side (ATK/DEF) indicator, current and peak ranks and SexyVal's own SV Score for every visible player.

> Not affiliated with Riot Games. Uses unofficial endpoints (valapidocs.techchrism.me / valorant-api-types) that can change or break at any time. Personal use only. No instalock, no gameplay automation; the only overlay is the optional agent-select pill (map + starting side) described below. Agent select/lock endpoints are deliberately not implemented. Party, queue and loadout changes only happen when you press a button.

## Install

- `release/SexyVal-Setup-1.2.0.exe` is the NSIS installer (per-user, lets you pick the folder). It upgrades earlier versions in place; close SexyVal (tray icon, Quit) first.
- `release/SexyVal-Portable-1.2.0.exe` runs without installing.

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
```

Troubleshooting first install:
- **npm 11 skips install scripts** (`npm warn install-scripts … electron`). Run `node node_modules/electron/install.js` once.
- **Electron download hangs extracting on very new Node**: unzip `%LOCALAPPDATA%\electron\Cache\*\electron-v33*-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.
- **App starts as plain Node** (`Cannot read properties of undefined (reading 'setPath')`): your shell has `ELECTRON_RUN_AS_NODE=1` (VS Code terminals set it). The npm scripts use `scripts/run-electron.mjs`, which strips it.

## What changed in 1.3 (so far)

Three standalone fixes/features, independent of the rest of 1.3:

- **Silent auto-update.** `electron-updater` against GitHub Releases (`.github/workflows/release.yml` publishes on a `v*` tag). Checks 30 s after start and every 4 h, downloads in the background (differential, via the NSIS blockmap), and never shows a dialog or OS notification. Once downloaded, it waits for a safe moment — Valorant idle, no video playing, no unsaved loadout edits, and either hidden in the tray or unfocused/idle 5+ minutes (`isSafeToInstall`, `shared/update.ts`) — before saving window bounds, tab, scroll position and the video/loadout flags to `resume.json` and calling `quitAndInstall(true, true)`. The relaunch restores that state and shows a brief "Updated to x.y.z" toast; nothing else is visible. If no safe moment ever comes, it installs on the next normal quit. Settings → General → Updates has an "Install updates automatically" toggle (on by default) and "Check now"; the portable build shows a plain "New version on GitHub" link instead, since it can't replace itself.
- **Fix: sidebar highlight stuck after resize/maximize.** The sliding highlight behind the active sidebar tab only re-measured on tab change, so maximizing (or any resize) left it behind — worst on Settings, which sits at the bottom. It now also watches the sidebar's size with a `ResizeObserver` and re-measures when fonts finish loading, snapping instantly for a layout-driven move instead of sliding (tab changes still slide).
- **Fix: launch at startup is now on by default.** `launchAtStartup` defaulted to `false` and was only pushed to Windows' login items when the setting *changed*, so the default never actually registered. Fresh installs and upgrades from before this change now get it turned on once (a `settingsVersion` migration — `shared/settingsMigration.ts`); after that, whatever you pick sticks. Every start also re-syncs Windows' login item to the setting, so a moved install folder or an updated install path can't silently disable it.

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
| Store | Daily, bundles, night market (discounts), wallet, owned badges, watchlist with toast + Windows notification when a watched skin shows up, every tile opens the skin sheet | store v3/v2 storefront, wallet, owned items |
| Collection | Every skin with owned/not-owned state, counters overall / per weapon / per collection, filters (owned, weapon, tier, collection, search), sort (tier, name, newest*), virtualized grid, lazy images, hover preview video. Buddies, sprays (animated on hover), cards, titles. | valorant-api.com + `store/v1/entitlements/{puuid}/{type}` |
| Skin sheet | Large render (pointer parallax), tier, collection, price (your store, store offers or the bundled list) / approximate price (≈) / contract source, level list, variant swatches, owned markers per level/variant, custom video player (Space, arrows, M, F), "Play all", sound preference | valorant-api.com |
| Loadout | Card, title, sprays (wheel order), per-weapon skin/level/variant, buddies (uses owned InstanceIDs), incognito/hide level, local presets, floating apply bar with change count | `personalization/v3/players/{puuid}/playerloadout` GET/PUT |
| Missions | Daily checkpoints, weeklies, queued weeklies, future weeklies by date, battle pass, event pass, agent contracts (activate), account level | `contracts/v1/contracts`, `account-xp/v1/players`, valorant-api missions/contracts/seasons |
| Party | Queue select, start/stop queue, ready, open/closed, code generate/disable, join by code, invite Name#Tag, decline requests, kick, leave, member card/level/rank, pings per server | `parties/v1/...` |
| Profiles | Self or Name#Tag, "Open on tracker.gg", title, card, level, rank, peak, RR, RR graph, history with RR impact, filters (queue/agent/map/result/date), full scoreboard (K/D/A, ACS, ADR, HS%, first bloods, avg loadout), analysis (per-agent/map win rate, K/D and ACS trends) | `mmr/v1/players`, `competitiveupdates`, match history/details, name-service |
| Hub | Friends + presence + requests (send/cancel), leaderboard by act, agents/maps/weapons browsers, local lineups library (images + links) | local `chat/v4/*`, `mmr/v1/leaderboards`, valorant-api.com |
| Live | Queue timer; agent select with starting-side ATK/DEF badge (hardcoded, see below) + "Loadout & skins" shortcut; current + peak rank, SV Score, last 5 and a tracker.gg button per visible player (allies in agent select, everyone in game), compact / expandable rows. Optional agent-select overlay (map + side). | pregame / core-game, `parties/v1`, `mmr/v1/players`, local WebSocket |
| App | Icon picker (4 colours, tray + window), session-expired alert, poll rate, history queue filter, launch at startup, notifications, video cache toggle with size + clear, platform selector, HenrikDev key, Debug | — |

\* No release date exists in the catalog. "Newest" = first time SexyVal saw the skin, then catalog order.

**Not implemented (no documented endpoint, so nothing is guessed):** accepting party invites or join requests, transferring party leadership, choosing preferred servers, removing a friend, and accepting an incoming friend request. The UI says so and points to the game client.

**Name#Tag lookup:** Riot documents no direct lookup. SexyVal resolves players you've seen (name-service results, scoreboards) and leaderboard players.

## Media rules

- No Riot assets are bundled. Images go through `svasset://` (only `*.valorant-api.com`, cached on disk). Videos go through `svvideo://`: Range requests stream from the URLs valorant-api.com provides, which point at `valorant.dyn.riotcdn.net`. Playback starts from the first chunks; hover previews are never cached and at most two run at once. With **Keep watched videos** on, a video you open is written to disk as it streams and kept only if every byte arrived; the cache is LRU-limited (Settings shows usage, the limit, and a clear button). 58% of skins (mostly Select and Deluxe) have no video in the game data; those show the still render.
- The still render sits under every video and the video fades in on its first frame; errors show a retry. Hover previews start after a 350 ms rest, use `preload="none"`, and drop their connection when the pointer leaves (pausing alone keeps downloading). One video plays at a time.

## Mock mode

`MOCK=1` starts a fake Riot server (`mock/server.ts` + `mock/extra.ts`) inside the app, writes a fake lockfile, and points glz/pd/shared/auth at it. Shapes follow valorant-api-types. It covers: local entitlements, external-sessions, region-locale, chat friends/presences/requests, sign-in (authorize redirect, entitlement, userinfo, geo), pregame/core-game, history/details (with a 429), name-service, storefront (v3, bundles, night market), wallet, owned items (docs `EntitlementsByTypes` shape), contracts, account XP, loadout v3 GET/PUT (`ActiveExpressions`), MMR, competitive updates, leaderboard, content, the party endpoints (with a real `MATCHMAKING` state and `QueueEntryTime` in the queue phase), the local WebSocket (same handshake and `OnJsonApiEvent` frames as the Riot Client, sent on every phase change and party action), and HenrikDev store offers at `/henrik` (401 for a bad key; with the key `HDEV-mock-0000-key` it answers 404 RiotImplementationRemoved like production, or a v1/v2 offers payload with `MOCK_HENRIK=offers`). It also writes a fake `GameUserSettings.ini` in exclusive Fullscreen so the overlay warning can be seen. Retired routes (`store/v1/offers`, personalization v2) answer 404 as they do in production.

`mock/fixtures/collection.json` (from `scripts/make-mock-fixtures.mjs`) holds only real UUIDs, dates and prices: owned items, shop skins with and without videos, loadout, missions and contracts.

| Env var | Effect |
| --- | --- |
| `MOCK=1` | Use the mock server. Separate data dir `%APPDATA%\SexyVal-mock`. |
| `MOCK_PHASE=pregame` | Pin a phase at startup: `idle`, `queue`, `pregame`, `ingame`, `offline` (Riot Client closed), `noval` (Riot Client open, Valorant closed). The automatic scenario runs idle → queue → pregame → ingame. |
| `MOCK_FAST=1` | Short scenario (6 s / 4 s / 12 s / 10 s). |
| `MOCK_HENRIK=offers` | Mock HenrikDev serves an offers payload instead of production's 404. |
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

## Untested against the live game

Built from the docs and verified only against the mock:
- **1.2:** the party `MATCHMAKING` state and `QueueEntryTime` during a real queue; the Riot Client WebSocket (handshake, subscription, event URIs) on a real client; how fast `MapID` fills in on a real pregame match.
- **1.2:** the fullscreen value mapping. A real install read `FullscreenMode=1` while in Windowed Fullscreen; 0 = Fullscreen and 2 = Windowed come from Unreal and were not confirmed by switching modes in game.
- **1.2:** the overlay over a real borderless Valorant after alt-tab (the z-order re-claim).
- **1.2:** the bundled price list's accuracy beyond spot checks (it mirrors the wiki's Store tables).
- **1.2:** HenrikDev store offers with a real key. Without a key both versions answer 401; HenrikDev's spec says the endpoint now always returns 404, so the offers coverage (how many store skins get a price) could not be measured. Both shapes are parsed from HenrikDev's docs and Riot's legacy offers body.
- **1.2:** `mmr/v1/players` for other players (current rank, peak and the act it was reached in), and tier numbering for acts before Episode 5.
- **1.3:** the whole silent auto-update path against a real NSIS install: a published GitHub release, the differential blockmap download, and `quitAndInstall(true, true)` actually relaunching a packaged build. `scripts/mock-update-server.mjs` exercises check → download → `update-downloaded` → safe-moment wait → resume.json against a locally faked feed, but someone has to watch a real installed copy do the relaunch at least once before this is trusted. `isSafeToInstall` itself (`shared/update.ts`) is fully unit-tested.
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
- Windows only. Unsigned builds.

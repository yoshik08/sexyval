# SexyVal

Personal, unofficial Valorant companion for Windows, in a normal desktop window, plus an optional tiny ATK/DEF overlay during agent select. It covers the store with skin videos, your collection, loadout, missions, party, profiles and match history, friends, leaderboard and lineups, plus a live agent-select / in-game view with a starting-side (ATK/DEF) indicator.

> Not affiliated with Riot Games. Uses unofficial endpoints (valapidocs.techchrism.me / valorant-api-types) that can change or break at any time. Personal use only. No instalock, no gameplay automation; the only overlay is the optional agent-select ATK/DEF pill described below. Agent select/lock endpoints are deliberately not implemented. Party, queue and loadout changes only happen when you press a button.

## Install

- `release/SexyVal-Setup-1.1.1.exe` is the NSIS installer (per-user, lets you pick the folder). It upgrades earlier versions in place; close SexyVal (tray icon, Quit) first.
- `release/SexyVal-Portable-1.1.1.exe` runs without installing.

The builds are unsigned, so Windows SmartScreen will warn. Click "More info", then "Run anyway".

## What needs what

| Screen | Needs |
| --- | --- |
| Collection catalog, videos, agents/maps/weapons browsers, lineups | Nothing. Public valorant-api.com data, always loads. |
| Shop, wallet, owned items, loadout, missions/passes, profiles, history, leaderboard | Tokens + region + shard + client version: the Riot Client running, **or** a signed-in account. Valorant can be closed. |
| Friends, presence, friend requests | Riot Client running (local chat API). |
| Party & matchmaking | Valorant running (Riot's party service only knows online players). |
| Live (agent select / in game) | Valorant running. This is the only tab that shows "Waiting for Valorant". |

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
```

Troubleshooting first install:
- **npm 11 skips install scripts** (`npm warn install-scripts … electron`). Run `node node_modules/electron/install.js` once.
- **Electron download hangs extracting on very new Node**: unzip `%LOCALAPPDATA%\electron\Cache\*\electron-v33*-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.
- **App starts as plain Node** (`Cannot read properties of undefined (reading 'setPath')`): your shell has `ELECTRON_RUN_AS_NODE=1` (VS Code terminals set it). The npm scripts use `scripts/run-electron.mjs`, which strips it.

## What changed in 1.1

Three pipelines were broken against the live API (release 13.09) while the old mock still answered, so nothing flagged them. The mock now mirrors production, including the 404s.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Loadout never loaded | `personalization/v2/.../playerloadout` returns 404; the game uses **v3**, where `Sprays` became `ActiveExpressions` | GET/PUT v3 (v2 kept as fallback). Apply re-reads the live loadout first and merges only your edits into Riot's own object, so unknown fields survive. Verified on a live account: read, and a no-op write (Version 172 → 173, content identical). |
| "Price unknown" on almost every skin | `store/v1/offers/` returns 404 and the error was swallowed | Price book: exact prices seen in your store are remembered (`prices.json`); contract rewards say where they come from ("Battle Pass · Season 2026 Act III"); everything else shows the tier's standard price as an estimate (≈). Nothing says "unknown". |
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
| Skin sheet | Large render (pointer parallax), tier, collection, price / estimate / contract source, level list, variant swatches, owned markers per level/variant, custom video player (Space, arrows, M, F), "Play all", sound preference | valorant-api.com |
| Loadout | Card, title, sprays (wheel order), per-weapon skin/level/variant, buddies (uses owned InstanceIDs), incognito/hide level, local presets, floating apply bar with change count | `personalization/v3/players/{puuid}/playerloadout` GET/PUT |
| Missions | Daily checkpoints, weeklies, queued weeklies, future weeklies by date, battle pass, event pass, agent contracts (activate), account level | `contracts/v1/contracts`, `account-xp/v1/players`, valorant-api missions/contracts/seasons |
| Party | Queue select, start/stop queue, ready, open/closed, code generate/disable, join by code, invite Name#Tag, decline requests, kick, leave, member card/level/rank, pings per server | `parties/v1/...` |
| Profiles | Self or Name#Tag, title, card, level, rank, peak, RR, RR graph, history with RR impact, filters (queue/agent/map/result/date), full scoreboard (K/D/A, ACS, ADR, HS%, first bloods, avg loadout), analysis (per-agent/map win rate, K/D and ACS trends) | `mmr/v1/players`, `competitiveupdates`, match history/details, name-service |
| Hub | Friends + presence + requests (send/cancel), leaderboard by act, agents/maps/weapons browsers, local lineups library (images + links) | local `chat/v4/*`, `mmr/v1/leaderboards`, valorant-api.com |
| Live | Agent select with starting-side ATK/DEF badge (hardcoded, see below) + "Loadout & skins" shortcut, in-game last 5 for everyone. Optional agent-select overlay. | pregame / core-game |
| App | Icon picker (4 colours, tray + window), session-expired alert, poll rate, history queue filter, launch at startup, notifications, video cache toggle with size + clear, platform selector, Debug | — |

\* No release date exists in the catalog. "Newest" = first time SexyVal saw the skin, then catalog order.

**Not implemented (no documented endpoint, so nothing is guessed):** accepting party invites or join requests, transferring party leadership, choosing preferred servers, removing a friend, and accepting an incoming friend request. The UI says so and points to the game client.

**Name#Tag lookup:** Riot documents no direct lookup. SexyVal resolves players you've seen (name-service results, scoreboards) and leaderboard players.

## Media rules

- No Riot assets are bundled. Images go through `svasset://` (only `*.valorant-api.com`, cached on disk). Videos go through `svvideo://`: Range requests stream from the URLs valorant-api.com provides, which point at `valorant.dyn.riotcdn.net`. Playback starts from the first chunks; hover previews are never cached and at most two run at once. With **Keep watched videos** on, a video you open is written to disk as it streams and kept only if every byte arrived; the cache is LRU-limited (Settings shows usage, the limit, and a clear button). 58% of skins (mostly Select and Deluxe) have no video in the game data; those show the still render.
- The still render sits under every video and the video fades in on its first frame; errors show a retry. Hover previews start after a 350 ms rest, use `preload="none"`, and drop their connection when the pointer leaves (pausing alone keeps downloading). One video plays at a time.

## Mock mode

`MOCK=1` starts a fake Riot server (`mock/server.ts` + `mock/extra.ts`) inside the app, writes a fake lockfile, and points glz/pd/shared/auth at it. Shapes follow valorant-api-types. It covers: local entitlements, external-sessions, region-locale, chat friends/presences/requests, sign-in (authorize redirect, entitlement, userinfo, geo), pregame/core-game, history/details (with a 429), name-service, storefront (v3, bundles, night market), wallet, owned items (docs `EntitlementsByTypes` shape), contracts, account XP, loadout v3 GET/PUT (`ActiveExpressions`), MMR, competitive updates, leaderboard, content, and the party endpoints. Retired routes (`store/v1/offers`, personalization v2) answer 404 as they do in production.

`mock/fixtures/collection.json` (from `scripts/make-mock-fixtures.mjs`) holds only real UUIDs, dates and prices: owned items, shop skins with and without videos, loadout, missions and contracts.

| Env var | Effect |
| --- | --- |
| `MOCK=1` | Use the mock server. Separate data dir `%APPDATA%\SexyVal-mock`. |
| `MOCK_PHASE=pregame` | Pin a phase at startup: `idle`, `pregame`, `ingame`, `offline` (Riot Client closed), `noval` (Riot Client open, Valorant closed). |
| `MOCK_FAST=1` | Short scenario (6 s / 12 s / 10 s). |
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

A tiny pill (about 140×48, or smaller) that shows ATK (red) or DEF (blue) with a "starting side" label, at the top of the primary display or the one you pick. It is visible only during agent select when a side is known, and hides the moment the phase changes; it never shows enemy info or anything in game.

- It is a normal frameless, transparent, always-on-top window: no injection, no hooks, no memory reading, no screen capture. It can't take focus (shown inactive, `focusable: false`), lets every click through and has no taskbar entry.
- Works over Valorant in **Windowed** or **Windowed Fullscreen** (borderless). Windows cannot draw it over **exclusive Fullscreen**.
- Settings → General: on/off (default on), position (top center/left/right), size (small/medium), display (when you have more than one). The tray menu has an on/off toggle too.
- Mock: `MOCK_PHASE=pregame` shows it; the screenshot run saves it as `21b-agent-select-overlay.png`.

Side data saved by earlier versions (`calibration.json`) is deleted on first start.

## Verified against a live account

- Riot Client tokens with Valorant closed; version from ShooterGame.log; region via ShooterGame.log plus the shard check.
- Owned items per type: HTTP 200, flat `{ ItemTypeID, Entitlements: [...] }` (not the docs' `EntitlementsByTypes`; both are parsed). Skins, variants, buddies, sprays, cards, titles and agents all return data.

## Untested against the live game

Built from the docs and verified only against the mock:
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
- Windows only. Unsigned builds.

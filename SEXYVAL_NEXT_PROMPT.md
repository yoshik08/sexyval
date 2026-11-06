# SexyVal 1.2: build prompt

You are working in the SexyVal repo (Electron 33 + React 18 + Vite + Tailwind + TypeScript, Windows only). Read `README.md` first; it documents the connection pipeline, mock server, and the rules this app follows. Keep the existing architecture: main-process services in `main/services`, pure logic in `shared/` with tests in `tests/`, UI in `renderer/src`. Every new Riot endpoint must also be added to the mock (`mock/server.ts` / `mock/extra.ts`) so `npm run mock` and `npm run screenshots` cover it. Finish with `npm run check` passing and updated screenshots for every screen you touched.

Make targeted changes. Do not rewrite working modules, do not restyle the app, do not rename things that aren't part of these tasks.

## Hard rules (unchanged, do not break)

- Players with `PlayerIdentity.Incognito === true` (hidden name / streamer mode) stay hidden: no name-service lookup, no match history, no stats, no score, no tracker link for them. They render as "Hidden" with agent, team, rank badge (as the game itself provides) and level only. `GameLoop.lookup()` and `row()` already enforce this; keep it that way and add a test that proves an incognito PUUID never reaches `names.request`, `history.ensure`, or the new score/price code.
- No injection, hooks, memory reading, or screen capture. The overlay stays a normal transparent, click-through, non-focusable window.
- No agent select/lock endpoints, no gameplay automation.
- The overlay never shows enemy information.

---

## Task 1: Matchmaking detection + 1 s fast sync

**Current state:** `main/loop.ts` polls `pregame/v1/players` → `core-game/v1/players` every `settings.pollMs` (default 5000, clamped 2000–30000). It has no idea you are queuing, so agent select can be detected up to 5 s late.

**Do this:**

1. Add a `queue` phase: `Phase = 'idle' | 'queue' | 'pregame' | 'ingame'` in `shared/types.ts`. Update every switch/consumer (Live screen, overlay, tray, header chip text "In queue").
2. In `GameLoop.pollPhase`, when neither pregame nor core-game has a match, check the party:
   - `GET glz /parties/v1/players/{puuid}` → `CurrentPartyID`
   - `GET glz /parties/v1/parties/{partyId}` → `State === 'MATCHMAKING'` means queuing; also keep `MatchmakingData.QueueID` and `QueueEntryTime` (show elapsed queue time in Live → Idle/Queue view).
   - Reuse what `main/services/party.ts` already parses instead of duplicating it. Cache `CurrentPartyID` and only re-fetch it when a party call returns 404.
3. Cadence: a separate fast cadence that the user's `pollMs` clamp does not apply to.
   - `queue` and `pregame`: tick every **1000 ms**.
   - `ingame`: normal `pollMs`.
   - `idle` with Valorant running: normal `pollMs` (party check included).
   - Existing 429/5xx backoff in `tick()` must still win over the fast cadence. Keep `glzLimiter` concurrency as is.
4. Instant push (preferred over polling, polling stays as fallback): connect to the Riot Client local WebSocket (`wss://127.0.0.1:{lockfile port}`, Basic `riot:{password}`, self-signed TLS accepted only for 127.0.0.1 like the existing undici agent). Send `[5, "OnJsonApiEvent"]` and on any event whose `uri` contains `ares-parties`, `ares-pregame` or `ares-core-game` call `loop.pollNow()`. Reconnect with backoff when the client restarts. Put it in `main/riot/events.ts`. The mock server should emit the same events.
5. Map: the moment `pregame/v1/matches/{id}` returns a `MapID`, emit immediately (don't wait for the 80 ms debounce if the map just changed from empty to set).

**Tests:** phase transitions idle → queue → pregame → ingame → idle (pure function over fake responses), cadence selection, backoff overriding fast cadence.

## Task 2: Overlay shows map + side, and works "fullscreen"

**Current state:** `main/overlay.ts` shows a small ATK/DEF pill in agent select only. It already uses `setAlwaysOnTop(true, 'screen-saver')`, full display bounds, click-through. This works over **Windowed Fullscreen (borderless)**. Windows cannot draw any normal window over **exclusive Fullscreen**; that is an OS limit and must not be worked around with injection.

**Do this:**

1. Overlay content during `pregame`: map name (and the map's small `listViewIcon` from valorant-api.com via `svasset://`) + starting side. Widen the pill to fit (keep small/medium sizes, re-measure both). Show the map as soon as it's known, even if the side isn't (custom/no-side modes show map only).
2. Optional "Match found" state: when the phase goes `queue` → `pregame`, the overlay appears instantly with a short fade (reuse `FADE_MS`). Setting: on by default.
3. Fullscreen-mode detection (read-only, local file, no game interaction): read Valorant's `GameUserSettings.ini` under `%LOCALAPPDATA%\VALORANT\Saved\Config\<account folder>\Windows\` and parse `FullscreenMode` / `LastConfirmedFullscreenMode`. Verify the value mapping on a real install by switching modes in-game (expected Unreal mapping: 0 = Fullscreen, 1 = Windowed Fullscreen, 2 = Windowed; confirm, don't trust this). If it's exclusive Fullscreen and the overlay is enabled, show a one-time toast + a Settings note: "Valorant is in Fullscreen. Switch Display Mode to Windowed Fullscreen to see the overlay." If the file or folder can't be found, say nothing.
4. Re-assert `setAlwaysOnTop(true, 'screen-saver')` and `moveTop()` each time the overlay is shown (borderless games can steal z-order after alt-tab).

## Task 3: Exact skin prices, remove every estimate

**Current state:** `shared/pricing.ts` has hardcoded `GUN_PRICE` / `MELEE_PRICE` tier tables and shows them as `≈ 1,775 VP` (kind `'typical'`). These are wrong for many skins (special editions, melee that aren't 2× the gun tier, newer price points). `store/v1/offers` on Riot's pd returns 404, so the app only learns exact prices from your own storefront (`main/services/prices.ts`, `prices.json`).

**Price source to add: HenrikDev store offers**
- `GET https://api.henrikdev.xyz/valorant/v1/store-offers` (also try `v2` and keep whichever parses), header `Authorization: <key>`.
- Response: `data.Offers[]` with `OfferID`, `Cost` (map of currency ID → amount; VP currency ID is `85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741`), `Rewards[]` with `ItemTypeID`, `ItemID`. Skin offers have `ItemTypeID === 'e7c63390-eda7-46e0-bb7a-a6abdacd2433'` and `ItemID` = the skin's **first level UUID**; map level → skin via the catalog (`skin.levels[0].uuid`).
- Key: new Settings field "HenrikDev API key" (Settings → Accounts or General). Stored in `settings.json`, never logged (add it to `shared/redact.ts`). Free basic key is 30 req/min; this endpoint is called once per game version or once per 24 h, cached to `offers.json` with the game version it was fetched for.
- First, verify it's complete: after implementing, log how many catalog skins that are not contract rewards got a price, and list any that didn't. If recent skins are missing, report that in your final message.

**New price precedence (`quoteFor`):**
1. `exact` from your own storefront (already there, most trusted; shows "Price as shown in your store")
2. `exact` from offers (`source: 'offers'`)
3. `reward` (contract / battle pass / event pass, already there)
4. no price → `{ kind: 'none' }`, shown as **"Not sold separately"** if the skin has no offer and is a default/reward-like item, otherwise **"Price not available"**. Never a number.

**Remove everywhere:** the `'typical'` kind, `typicalPrice`, `GUN_PRICE`, `MELEE_PRICE`, the `≈` prefix, the `estimate` flag in `describeQuote` and its muted styling in `renderer/src/components/ui.tsx`, the "Estimated from the standard … price" captions in `ui.tsx` and `SkinDetail.tsx`, and the estimate/≈ wording in `README.md` (rows for 1.1 and Skin sheet) and the comments in `shared/features.ts` / `shared/pricing.ts`. Grep for `≈`, `estimate`, `Estimated`, `typical`, `approx` afterwards and confirm zero hits outside git history. Rewrite `tests/pricing.test.ts` for the new precedence.

Weapon **credit** costs in the Hub weapons browser already come from valorant-api.com `shopData.cost` (exact, from game files). Leave them, and make sure the melee (`shopData: null`) shows nothing instead of 0.

## Task 4: Player scores in Live

There is no public tracker.gg API for Valorant and Tracker Score's formula is proprietary, so **do not scrape tracker.gg and do not label anything "Tracker Score"**. Build our own, clearly named.

1. **SV Score** (0–1000), computed in a new pure module `shared/score.ts` from the data `HistoryService` already has (last 5 matches, `TrimmedDetails`): weighted blend of ACS (per round), K/D, ADR, HS%, first bloods per round and win rate, normalized against fixed reference ranges defined as constants in that file with a comment explaining each. Return `{ score, sample: number of matches used }`. If fewer than 3 matches have round data, return `null` and show "—". Unit-test it with fixture matches (strong, average, weak player; missing round data).
2. **Live → agent select (allies) and in game (both teams):** every non-hidden player row shows SV Score next to the existing last-5 pips, with a tooltip breaking down the parts (ACS, K/D, ADR, HS%, FB/round, W–L). Also show current rank and peak rank (from `mmr/v1/players/{puuid}`, already used in Profiles; cache per PUUID for 10 min, respect the pd rate limiter). Fetch for enemies only once in-game (agent select keeps enemies unlooked-up, as now).
3. **"Open on tracker.gg" button** on each non-hidden player row (and in Profiles): opens `https://tracker.gg/valorant/profile/riot/{encodeURIComponent(name#tag)}/overview` in the default browser via `shell.openExternal`. No fetching from tracker.gg.
4. Hidden players: row shows "Hidden", agent, level, team. No score, no button.

## Deliverables

- Code for tasks 1–4, mock coverage for every new endpoint (party state with a MATCHMAKING phase, WebSocket events, HenrikDev offers including a 401 for a bad key).
- New mock phase `MOCK_PHASE=queue` and a screenshot step for: Live in queue, overlay with map + side, Live in game with SV Scores, Settings with the HenrikDev key field and the fullscreen-mode note.
- `npm run check` green. Bump version to 1.2.0, update README (features table, "What changed in 1.2", remove estimate wording, document SV Score as our own metric).
- Final message: what changed per task, the offers coverage numbers from Task 3, and anything you couldn't verify against the live game (put those under "Untested against the live game" in the README too).

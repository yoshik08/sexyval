# SexyVal 1.3: build prompt

You are working in the SexyVal repo (Electron 33 + React 18 + Vite + Tailwind + TypeScript, Windows only). 1.2 is shipped; read `README.md` first, including "What changed in 1.2". Keep the existing architecture: main-process services in `main/services`, pure logic in `shared/` with tests in `tests/`, UI in `renderer/src`. Every new or newly used Riot endpoint must be covered by the mock (`mock/server.ts` / `mock/extra.ts`) so `npm run mock` and `npm run screenshots` exercise it. Finish with `npm run check` green and screenshots for every screen you touched.

Make targeted changes. Don't rewrite working modules, restyle the app, or rename things outside these tasks. Reuse the existing design system, components (`components/ui.tsx`, `kit.tsx`, `charts.tsx`) and motion helpers (`lib/motion.ts`); use the project skills in `.claude/skills` for motion and visual polish.

## Hard rules (unchanged)

- Players with `PlayerIdentity.Incognito === true` stay hidden: no name lookup, history, stats, SV Score or estimated MMR for them. Add tests proving an incognito PUUID never reaches any new code path.
- No injection, hooks, memory reading or screen capture. No agent select/lock endpoints, no gameplay automation.
- Riot doesn't expose real MMR. Everything in Task 1 is our own estimate and must say so on screen.

---

## Task 1: MMR tab (estimated MMR)

A new sidebar tab **MMR** (after Profiles). Defaults to you; a player picker reuses Profiles' Name#Tag resolution so any *visible* player can be viewed. Profiles and the expanded Live row get a small "Estimated MMR" chip that links here.

### Data (all already fetched elsewhere, reuse the services and caches)

- `pd /mmr/v1/players/{puuid}/competitiveupdates?queue=competitive&endIndex=20` → per match: `MatchID`, `TierBeforeUpdate`, `TierAfterUpdate`, `RankedRatingBeforeUpdate`, `RankedRatingAfterUpdate`, `RankedRatingEarned`, `RankedRatingPerformanceBonus` (if present), `AFKPenalty`, `MatchStartTime`, `SeasonID`.
- Match details (`HistoryService` trimmed details, cached forever on disk) → round scores (`teams[].roundsWon`), your ACS, every player's `tier`, party info if present.
- Current rank/RR from `mmr/v1/players/{puuid}` (already used for current + peak).
- Only the current Act (`SeasonID` of the active act). Earlier acts are ignored.

### Model (new pure module `shared/mmr.ts`, fully unit-tested)

Riot confirms RR = base win/loss + round margin + a small performance effect + a **convergence** term that pulls rank toward MMR (MMR above rank → wins give more than losses take; at rank → about even, about 50% win rate; below → losses take more; far above → division skips). Riot publishes no formula, so:

1. **Exclude** matches that are placements, AFK/leaver-penalised (`AFKPenalty != 0`), remakes/draws, 5-stacks (from match details party data if present) and anything before the current act. Mark them as excluded with a reason; they still show in the table, greyed.
2. **Clean the RR.** Using the remaining matches, fit two small least-squares regressions, one for wins and one for losses: `RR = base + a·roundDiff + b·(ACS − 200)/100`. If there are fewer than 6 wins or 6 losses, skip the regression and use raw averages (subtract `RankedRatingPerformanceBonus` when the field exists). `Gw` = mean adjusted win RR (evaluated at roundDiff = 0, ACS = 200), `Gl` = mean adjusted loss RR (absolute).
3. **RR-split gap:** `gapDivisions = (Gw − Gl) / RR_PER_DIVISION`, with `RR_PER_DIVISION = 5` as a named constant (heuristic from public MMR calculators; e.g. +25/−13 ≈ +2 divisions, +19/−18 ≈ 0, +13/−24 ≈ −2).
4. **Lobby average:** for each match, the mean `tier` of the other 9 players (ignore 0/unranked), then average across matches. Tier numbers are the game's `CompetitiveTier` (3 = Iron 1 … top = Radiant); map to names/icons via the existing rank assets.
5. **Blend:** `estTier = W_LOBBY · lobbyAvg + W_SPLIT · (myTier + gapDivisions)` with `W_LOBBY = 0.6`, `W_SPLIT = 0.4` as named constants. Round to the nearest division for the headline; keep the decimal for the graph. Clamp to the valid tier range.
6. **Confidence:** Low (< 5 usable matches, or start of act, or > 40% excluded), Medium (5–10), High (> 10 and the per-match gap estimates have low spread). Expose the spread too.
7. **Forecast:** wins to next division at the current win RR (`ceil((100 − RR) / GwRaw)`), the cost of the next loss (`GlRaw`), and a "division skip possible" flag when `gapDivisions ≥ 2`.
8. **Gap label:** `≥ +1.5` "well above rank", `+0.5…+1.5` "above rank", `−0.5…+0.5` "at rank", `−1.5…−0.5` "below rank", `≤ −1.5` "well below rank".
9. **Self-check:** add a dev-only script (`scripts/mmr-backtest.mjs`) that replays your stored competitive updates in order and reports how well the model's sign (above/below) predicts the RR asymmetry of the next 5 matches. Print the hit rate; use it to tune the two weights and `RR_PER_DIVISION`, and write the final values and the hit rate into the README.

Return a single object: `{ estTier, estTierDecimal, myTier, myRR, gapDivisions, label, confidence, spread, Gw, Gl, GwRaw, GlRaw, lobbyAvg, winRate10, winRate20, forecast, matches: [...per-match rows with exclusion reason and an explanation tag] }`.

### Screen (top to bottom)

1. **Headline card:** big "Estimated MMR · Plat 2" with the rank icon, next to "Your rank · Gold 3 · 64 RR". Gap badge ("▲ about 2 divisions above", green / grey / red). Confidence chip with "based on N matches". One plain sentence explaining what it means for climbing, e.g. "You gain more than you lose, so you'll keep climbing faster than usual until your rank catches up."
2. **Signals ("why"):**
   - RR split: two bars, average win RR vs average loss RR (cleaned), raw values in the tooltip.
   - Lobby average: rank icon + "Your lobbies average Plat 1 vs your Gold 3".
   - Win rate: last 10 / last 20 with a note that ~50% means you're where you belong.
3. **Graph:** three lines across this act's competitive matches: your rank (tier + RR as a fraction), lobby average, estimated MMR (running estimate after each match). One point per match; hover shows map, result + score, RR change, lobby average. Use `components/charts.tsx` and the existing colour tokens.
4. **Forecast:** "About 3 wins to Gold 3 → Plat 1", "A loss costs about −14 RR", and "Division skip possible" when flagged.
5. **Match table:** date, map, agent, result + score, RR change, lobby average, and a short tag explaining the RR (e.g. "+4 from round margin", "performance bonus +3", "excluded: 5-stack", "excluded: placement"). Excluded rows greyed with the reason.
6. **Footer note:** "Estimate from your RR changes and lobby ranks. Riot doesn't show real MMR."

States: loading skeletons; "Play a few competitive matches this act to get an estimate" when there are no usable matches; errors show the HTTP status like other screens and keep the last good result. Hidden players can't be opened here.

### Mock

Add competitive updates + matching details to the mock for three personas: MMR well above rank (+25/−12, high lobbies), at rank (+19/−18), below rank (+13/−24, low lobbies), plus one with mostly excluded matches. Screenshot each.

### Tests

`shared/mmr.ts`: each persona gives the expected label; regression vs raw-average fallback; exclusions; tier clamping; confidence thresholds; forecast math; incognito players never counted by name (lobby average uses tiers only).

---

## Task 2: New bundles always synced and saved

Goal: every featured bundle (and every daily / night-market offer) that any signed-in account can see is captured with exact prices and kept forever on disk, even after it leaves the store.

1. **Bundle archive** `main/services/bundles.ts` → `bundles.json` (versioned, atomic write like the other JSON files): per bundle `DataAssetID`, name, items (skin/level/buddy/card/spray/title IDs), each item's base and discounted price, bundle total, `DiscountPercent`, first seen, last seen, `DurationRemainingInSeconds` → computed end time, which account saw it. Merge, never overwrite: a re-seen bundle updates `lastSeen` and fills any missing fields.
2. Every price seen in any bundle/daily/night market is also written to the existing `PriceBook` (`prices.json`), so those skins show exact prices immediately and forever.
3. **When it fetches the storefront:** on app start, when tokens appear (Riot Client or signed-in account), at every rotation time computed from `DurationRemainingInSeconds` (daily, bundle, night market, + 60 s), after every game-version change, and every 60 min as a safety net. If the app was off, fetch on next start; if a known bundle end time passed while off, fetch immediately. Do this for **every** signed-in account (sequentially, through the pd rate limiter), since stores differ.
4. **Catalog follow-up:** after a game-version change, refresh the valorant-api.com catalog and the bundles endpoint so new skins/bundle names/art resolve; re-run the wiki price scrape (`scripts/scrape-prices.mjs` logic, moved into a main-process service) once per game version and save it to the user data dir (bundled `shared/data/skin-prices.json` stays as the fallback). Never block the UI on it; failures keep the previous list.
5. **Store tab:** a "Past bundles" section from the archive (newest first, art, items, exact prices, dates seen). New bundle → in-app toast + Windows notification (respect the existing notifications setting).
6. **Integrity:** on write failure, retry and keep the in-memory copy; on startup, validate and back up a corrupt file instead of dropping it (`bundles.corrupt-<ts>.json`). Tests for merge, rotation-time scheduling, multi-account, and the offline-then-restart path. Mock: a bundle that rotates during the mock run.
7. README: state the one limit honestly. A bundle is only captured if SexyVal runs with valid tokens at least once while it's in the store (start-with-Windows + tray keeps this near 100%).

## Task 3: Silent auto-update from GitHub Releases

Goal: updates install by themselves with **zero dialogs and zero clicks**, and the user never sees the app close.

1. Use `electron-updater` (electron-builder's updater). `electron-builder.yml`: `publish: { provider: github, owner: <owner>, repo: SexyVal }`; NSIS stays **per-user** (no admin → no UAC prompt). Add a GitHub Actions workflow that builds and publishes on a `v*` tag (`electron-builder --win --publish always`, `GH_TOKEN` from repo secrets) and uploads `latest.yml` + blockmap. Releases must be in a **public** repo; never embed a token in the app.
2. Behaviour: `autoDownload = true`, `autoInstallOnAppQuit = true`, check on start (after 30 s) and every 4 h, differential downloads via blockmap. No `dialog` calls anywhere in the update path; errors only go to the log and Settings → Debug.
3. **Seamless apply:** an update can't replace the running main process, so it relaunches invisibly at a safe moment:
   - Safe = Valorant not in `queue`/`pregame`/`ingame`, no video playing, no unsaved loadout edits, and either the window is hidden in the tray or has been unfocused for 5+ min, or the system is idle (`powerMonitor.getSystemIdleTime() > 300`).
   - Then `quitAndInstall(true, true)` (silent NSIS, relaunch). Before quitting, save window bounds, current tab, scroll position and Live/Store state to `resume.json`; on relaunch restore them, and if the window was hidden, relaunch straight to the tray (`--hidden`). Keep the single-instance lock working across the relaunch.
   - If no safe moment comes, it installs on the next normal quit (`autoInstallOnAppQuit`).
4. The only visible trace: a small "Updated to 1.3.1" toast after relaunch (no buttons, auto-dismiss) and the version in Settings, plus a Settings toggle "Install updates automatically" (default on) and "Check now" for manual use.
5. Portable build can't self-update: it just shows a non-blocking "New version on GitHub" line in Settings with a link.
6. Mock: a fake update feed (local `latest.yml` server) to test download → safe-moment wait → relaunch → state restore. Tests for the safe-moment rules.

## Fix 4: Sidebar highlight stuck after resize/maximize

**Bug:** maximizing (or resizing) the window leaves the sliding highlight where it was; it only moves after you click another tab. Most visible on Settings, which sits at the bottom (`mt-auto`), so its `offsetTop` changes with the window height.

**Cause:** `Sidebar` in `renderer/src/App.tsx` measures the active item in a `useLayoutEffect` that depends only on `[view]`, so it never re-measures when layout changes.

**Fix (targeted, keep the existing transition):**
- Move the measurement into a `measure()` callback; call it from the `[view]` effect as now.
- Add a `ResizeObserver` on the `wrap` element (and the active button) that calls `measure()`, disconnected on unmount. Also re-measure on `document.fonts.ready` (font swap shifts heights).
- On resize-driven re-measures, skip the 360 ms slide (set `transition: none` for that update, restore next frame) so the highlight snaps with the layout instead of lagging; tab changes still slide.
- Check: maximize, restore, drag-resize, Windows snap, and DPI change all keep the highlight on the active tab for every tab including Settings.

## Task 5: One-click stretched resolution

Goal: the user picks a resolution (e.g. 1440×1080, 1280×960, 1080×1080, custom) in Settings → Stretch and it **just works**: stretched, full screen, no black bars, no guide, no extra steps. Off = everything back to native.

**Flow (fully automatic):**
1. **Valorant config (only while the game is closed):** for every account folder under `%LOCALAPPDATA%\VALORANT\Saved\Config\*\Windows\GameUserSettings.ini`, set `ResolutionSizeX/Y`, `LastUserConfirmedResolutionSizeX/Y`, `DesiredScreenWidth/Height`, `LastUserConfirmedDesiredScreenWidth/Height`, `bShouldLetterbox=False`, `bLastConfirmedShouldLetterbox=False`, `FullscreenMode=1` / `LastConfirmedFullscreenMode=1` (Windowed Fullscreen, keeps the overlay working; verify the key names and values on a real install before writing). Back up the original once (`GameUserSettings.sexyval-backup.ini`), then mark the file read-only so Valorant can't revert it. If Valorant is running when the user picks a resolution, queue the write for when it closes and apply the display part immediately.
2. **Desktop resolution:** when Valorant's process starts (`VALORANT-Win64-Shipping.exe`, watch with WMI/process polling, not the Riot API), switch the selected monitor to the stretch resolution with `ChangeDisplaySettingsExW` and **force stretching** via `DEVMODE.dmDisplayFixedOutput = DMDFO_STRETCH` (`DM_DISPLAYFIXEDOUTPUT`). If the driver ignores that (black bars detected by reading back the mode), fall back to the vendor API: NVIDIA NvAPI scaling = full-screen, AMD ADLX GPU scaling + scaling mode full panel; Intel via `DMDFO_STRETCH` only. If the resolution doesn't exist on the monitor, create it (NvAPI custom resolution / AMD custom resolution).
3. **Restore:** when Valorant exits, switch back to the native mode saved at start (resolution, refresh rate, scaling). Optional toggle "Native while alt-tabbed" (off by default): native when Valorant loses focus, stretch again when it regains it.
4. **Crash safety:** a tiny watchdog process restores native if SexyVal dies while stretched; on every SexyVal start, if the desktop is still in the stretch mode and Valorant isn't running, restore native. Turning the feature off restores native, removes read-only and restores the backed-up ini.
5. **Keep refresh rate:** pick the stretch mode with the monitor's highest refresh rate (never drop 240 Hz → 60 Hz).

**Admin, with zero prompts after setup:** write a small native helper (`helper/stretch.exe`, C# or Rust, signed by nothing, shipped in `extraResources`) that does the display + vendor-API calls. If any step needs admin, register it once as an elevated Windows Scheduled Task (`/RL HIGHEST`, run on demand) when the user first enables Stretch; that's the one and only UAC prompt. After that SexyVal triggers the task + passes args via a file/named pipe with no prompts. Electron itself stays non-admin. Uninstall removes the task and restores native.

**UI:** Settings → Stretch: on/off, resolution chips (1440×1080, 1280×960, 1280×1024, 1080×1080, Custom), monitor picker. Nothing else: no explanations, no guides. A single status line ("Stretched to 1440×1080 @ 240 Hz" / "Native") and errors only if something actually failed.

**Tests/mock:** pure logic for ini editing (round-trip, preserves other keys, multiple account folders, read-only toggling), mode selection (highest refresh), state machine (game start/exit/crash/disable). The helper gets a `--dry-run` mode for CI.

## Task 6: Daily shop calendar

Goal: every daily shop (and night market) each account gets is saved, and the Store tab shows them on a calendar.

1. **Archive:** extend Task 2's store capture: per account per day, save the 4 daily skins (skin id, level id, exact price) plus the night market items and discounts when active, keyed by the shop's rotation date (from `SingleItemOffersRemainingDurationInSeconds`, in the shop's reset timezone, not local midnight). File `shop-history.json`, merge-only, same integrity rules as `bundles.json`. If the app was off at a reset, the next fetch still records that day; days never seen stay empty ("not captured").
2. **Calendar view** (Store → History): month grid, each day cell shows the 4 skin thumbnails (tier-tinted like the shop tiles) and the day's total VP; days with night market get a marker. Account switcher when more than one account is signed in. Today highlighted; empty days show a faint dash. Keyboard navigation between days/months.
3. **Day detail:** click a day → sheet with the 4 skins (opens the existing skin sheet on click), prices, night market items with discount, and which of them you own now.
4. **Search & stats:** a search box highlights every day a skin appeared ("Prime Vandal · seen 3 times · last 12 Oct"); per-skin "seen N times" also shows in the skin sheet. Small stats row: days captured, most repeated skin, highest-value day, how often watchlist skins showed up.
5. **Watchlist link:** when a watched skin appears, its day gets a star on the calendar.
6. Mock: 60 days of fake history across 2 accounts, including gaps and a night market. Tests for date keying across timezones/DST, merge, and gaps. Screenshots of the month view and day sheet.

## Fix 7: Launch at startup on by default

Currently `main/settings.ts` defaults `launchAtStartup: false`, and `app.setLoginItemSettings` is only called when the value *changes*, so the default is never registered with Windows.

- Default `launchAtStartup: true` (started by Windows → `--hidden`, straight to the tray, as now).
- Apply it on first run: if the settings file has no `launchAtStartup` key yet (fresh install), register the login item. For existing installs, turn it on once via a settings migration (`settingsVersion` bump), then respect whatever the user picks afterwards.
- On every start (packaged only), sync Windows' login item to the setting (`app.getLoginItemSettings()` vs setting), so a moved install folder or an auto-update path change doesn't silently break startup.
- Tests for the default, the one-time migration, and the user's "off" sticking.

<!-- More tasks get appended below as they're decided. -->

## Deliverables

- Code, mock coverage, screenshots, `npm run check` green.
- Bump to 1.3.0, README: features table row, "What changed in 1.3", an "Estimated MMR (our own model)" section with the formula, constants and backtest hit rate, and anything untested against the live game under "Untested against the live game".
- Final message: what changed per task and the backtest result.

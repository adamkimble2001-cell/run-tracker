# RUN_TRACKER.EXE — Dev Log

Complete architectural record of all work across sessions 1–10+. For next steps, see [[TODO]]. For Claude context, see [[CLAUDE]]. For Megabonk OCR testing, see [[MEGABONK-OCR-TEST]].

---

## Overview

A locally-running roguelite run tracker built as a single HTML file with no dependencies. Runs directly in the browser via `file://` or the bundled PowerShell dev server.

**File:** `roguelite-tracker/index.html`
**Server:** `roguelite-tracker/server.ps1` (PowerShell TCP server)
**Launch config:** `.claude/launch.json`
**Storage:** `localStorage` key `rlt_v2`

---

## Work Log

### 1. Base App

Built the initial single-file HTML application to track roguelite game runs.

**Features:**
- Add/edit/delete games with icons (letter initial fallback)
- Log runs per game with result (WIN / LOSS / QUIT), date, notes, tags
- Filter runs by result; sort by date or result
- Stats strip: total runs, wins, losses, win rate, current streak
- Full localStorage persistence — no server required
- Demo seed: Hades + Slay the Spire with sample runs on first load

**Data model (`rlt_v2`):**
```js
{
  profile: { name, avatar, bio, status, currentGame },
  games:   [{ id, name, icon, fields }],
  runs:    [{ id, gameId, result, date, notes, tags, fields }]
}
```

---

### 2. Feature Expansion

- **Game icons:** Replaced emoji with image file uploads (JPEG, PNG, GIF, WEBP). Images are resized to 256px max via `canvas.toDataURL('image/jpeg', 0.88)` and stored as base64.
- **Avatar uploads:** Profile picture via same resize pipeline (300px max).
- **Generic fields:** Toggleable per-game fields (Character/Build, Difficulty, Stage/Floor, Score, Duration, Seed, Run#).
- **Custom fields:** User-defined text fields per game with stable UIDs.
- **Run form:** Dynamically generated from game field definitions — no hardcoded inputs.

**Generic field definitions (`GENERIC_FIELDS`):**
```js
[
  { id: 'char',     label: 'Character / Build', type: 'text'   },
  { id: 'diff',     label: 'Difficulty',         type: 'text'   },
  { id: 'floor',    label: 'Stage / Floor',      type: 'text'   },
  { id: 'score',    label: 'Score',              type: 'number' },
  { id: 'duration', label: 'Duration',           type: 'text'   },
  { id: 'seed',     label: 'Seed',               type: 'text'   },
  { id: 'runnum',   label: 'Run #',              type: 'number' },
]
```

---

### 3. Cyber / Matrix Theme

Full CSS overhaul. Black and green color scheme with terminal aesthetics.

**Color tokens:**
```css
--bg:          #000000
--surface:     #030d06
--surface2:    #07160a
--border:      #0c3018
--border-hi:   #165c2c
--accent:      #00ff70   /* matrix green */
--win:         #00ff70
--loss:        #ff2840
--text:        #a0ffbe
--text-dim:    #3d7a52
--font:        'Courier New', 'Consolas', 'Lucida Console', monospace
--radius:      2px
```

**UI details:**
- Scanline overlay via `body::after` repeating-linear-gradient
- Glow effects (`text-shadow`, `box-shadow`) on all active/focus states
- Run card left accent bar via `::before` pseudo-element with glow
- Blinking cursor block (`@keyframes blink`) on the no-game-selected state
- Terminal text: `RUN_TRACKER.EXE`, `// games`, `[ + add game ]`, `> ` character prefix on run cards
- Outlined button style (transparent background + colored border)
- Active sidebar items with inset green glow

---

### 4. Profile Modal — Full Profile System

Expanded the profile from name-only to a full user profile.

**Fields added:**
| Field | Type | Notes |
|-------|------|-------|
| Display Name | text input | existing |
| Avatar | image upload | existing |
| Current Game | select dropdown | populated from games list |
| Bio | textarea | freeform text |
| Status | text input (disabled) | placeholder — coming soon |

**Sidebar profile sub-line (dynamic):**
- If `currentGame` is set → shows `▶ GAME NAME` in green
- Else if `bio` is set → shows truncated bio preview (italic)
- Else → falls back to `>> edit_profile`

**Delete game** also clears `profile.currentGame` if that game is deleted.

---

### 5. Dev Server

No Python or Node.js available on the system (Windows Store stub intercepts `python`). Built a raw PowerShell TCP server instead.

**`roguelite-tracker/server.ps1`:**
- Uses `System.Net.Sockets.TcpListener` (avoids `HttpListenerResponse` content-length bugs)
- Reads HTTP request headers line-by-line with a 3-second receive timeout
- Responds with `HTTP/1.0` (always closes connection — no keep-alive issues)
- Serves files from `$PSScriptRoot` with correct MIME types
- Handles 404 for missing files

**`.claude/launch.json`:**
```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "roguelite-tracker",
      "runtimeExecutable": "powershell",
      "runtimeArgs": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "roguelite-tracker/server.ps1"],
      "port": 3400
    }
  ]
}
```

**Issues resolved:**
- `python` — not available (Windows Store stub)
- `HttpListenerResponse` — `ContentLength64` conflict caused write errors regardless of approach (Close, SendChunked, manual ContentLength)
- PowerShell execution policy — fixed with `-ExecutionPolicy Bypass`
- Solution: raw `TcpListener` writing HTTP/1.0 responses directly to the socket

**Server URL:** `http://localhost:3400/`

---

## File Map

```
hollow's mind/
├── .mcp.json                              ← Supabase MCP server config
├── .agents/skills/
│   ├── supabase/                          ← Supabase agent skill
│   └── supabase-postgres-best-practices/  ← Postgres Best Practices skill
└── Projects/roguelite-tracker/
    ├── index.html                         ← entire app (~6050 lines, HTML + CSS + JS)
    ├── server.ps1                         ← PowerShell TCP dev server (port 3400)
    ├── CLAUDE.md                          ← Claude Code guidance, schema, line map
    ├── DEVLOG.md                          ← this file — complete dev history
    ├── TODO.md                            ← current next steps and open items
    ├── roguelite-landing-page.md          ← notes on the marketing landing page
    ├── MEGABONK-OCR-TEST.md              ← step-by-step OCR kill tracking test
    └── SESS SUM 1–10.md                  ← per-session raw notes (superseded by DEVLOG)
```

---

### 6. Profile UI Polish + Right Panel (Games by Picture)

Major UI overhaul and layout expansion.

**Profile Section (sidebar):**
- Avatar upgraded to 44px with accent glow on hover
- Stats row added below name: `games · runs · win rate`
- Dynamic sub-line: current game name → bio preview → `>> edit_profile`
- Profile modal cleaned up: Status field removed, All-Time Stats grid (4 tiles) + Favorite Game added

**Right Panel (`#right-panel`, 272px):**
- Opens when a game is selected via its sidebar icon
- Contains: large 62px clickable game icon (upload via `#file-rp-icon`), inline name input, per-game stats, field toggles (generic + custom), Save / Delete buttons
- Separate file input from the game modal to avoid conflicts
- `saveRightPanel()` flashes "Saved!" for 1.6s on success

**Run isolation hardened:**
- New runs: `gameId: activeGameId` always locked at creation
- Edits: `{ ...existingRun, ...runData, gameId: existingRun.gameId }` preserves game
- `renderRuns()` strictly filters `db.runs.filter(r => r.gameId === game.id)`
- `promptDeleteGame()` removes only runs belonging to that game

---

### 7. Supabase Integration + UI Animation Polish

**Infrastructure:**
- Node.js installed; Vercel plugin + Supabase MCP connected and authenticated
- Supabase project: `wbbfkyzdmpnyiizifijz`
- MCP server registered at `https://mcp.supabase.com/mcp?project_ref=wbbfkyzdmpnyiizifijz`
- Supabase agent skills installed (Supabase + Postgres Best Practices)

**Database schema (Supabase):**
```sql
profiles  (id UUID → auth.users, name, avatar, bio, current_game_id)
games     (id TEXT PK, user_id UUID, name, icon, fields JSONB)
runs      (id TEXT PK, game_id → games, user_id, result, date, notes, tags JSONB, fields JSONB)
```
- Row-Level Security enabled on all tables — users only see their own data
- `ON DELETE CASCADE` from games → runs
- `update_updated_at()` trigger on all tables

**Auth modal (`#auth-modal`):**
- Sign In / Sign Up tabs with cyber aesthetic
- Email + password fields; Enter-key navigation between fields
- `[ Use Offline ]` fallback (seeds demo data, skips Supabase)
- `[ sign out ]` button appears in profile modal footer when authenticated
- `onAuthStateChange` listener handles post-login boot

**Sync layer (all async, fire-and-forget):**
- `loadFromSupabase()` — full data pull on login; shows `◌ syncing...` badge
- `syncProfile()` — upserts profile on every profile save
- `syncGame(game)` — upserts game on add/edit/right-panel save
- `syncRun(run)` — upserts run on add/edit
- `deleteGameFromSb(id)` — deletes game (runs cascade server-side)
- `deleteRunFromSb(id)` — deletes single run
- Sync badge (`#sync-badge`) in topbar: `syncing / synced / error` states with pulse animation

**UI Animation Polish:**
- `.game-thumb`: spring transition `cubic-bezier(0.34,1.56,0.64,1)` — hover `scale(1.1)`, active `scale(1.18)` with layered glow box-shadow
- `.game-item.active`: `@keyframes active-game-pulse` — slow alternating inset glow
- `.run-card`: `cursor: pointer`, hover `translateY(-2px)` lift + 4px shadow
- `.btn`: `transition` added to all, `:active` scale(0.97), hover opacity nudge
- `.filter-chip`, `#add-game-btn`: `:active` scale(0.97)
- `.result-option`: `:active` scale(0.96)
- `#profile-section`: smooth background transition
- Sync badge pulse animation (`@keyframes pulse-sync`) on syncing state

---

---

### 8. Appearance System (Settings Modal)

New `// appearance` section added to Settings modal (visible offline and online).

**HSL Color Wheel:**
- `<canvas id="settings-color-wheel" width="140" height="140">` with pixel-by-pixel `ImageData` HSL→RGB rendering (no banding)
- Drag picks hue (angle from center) + saturation (radius), updates 14 CSS custom properties live via `applyAccentHue(h, s)`
- Selector dot, swatch preview, reset to default green (145°, 100%)
- Persisted to `db.settings.accentHue` / `db.settings.accentSat` in localStorage
- `--scanline-tint` extracted to a CSS variable so it follows the accent color

**Background Image:**
- `<div id="app-bg">` fixed fullscreen layer at `z-index:-1` with 58% black overlay for readability
- Upload zone in Settings; thumbnail preview with `[ Remove ]` button
- Stored in `localStorage['rlt_bgimg']` (separate from `rlt_v2`) to avoid bloating main DB

---

### 9. Background Animations, Modal Overhaul, Polish (Sessions 8–9)

**Background Canvas Animations:**
- `<canvas id="bg-canvas">` at `z-index:-1`; 5 selectable effects via chip row in Settings
- Effects: `rain` (Matrix Katakana), `grid` (Pulse Grid), `wave` (Wave Scan), `pulse` (Radial Pulse), `starfield` (Warp Streaks)
- All read `db.settings.accentHue/Sat` every frame; `applyBgEffect(name)` cancels old RAF + starts new
- Persisted in `db.settings.bgEffect`

**Transparency Pass:**
- Topbar, stats strip, filter bar, run cards, build cards all converted to `rgba` + `backdrop-filter:blur` so animations show through

**Game Settings → Popup Modal:**
- Right panel converted from persistent sidebar (272px) to a modal (`#game-settings-modal`) triggered by `[ ⚙ game settings ]` in topbar
- `renderRightPanel()` populates data but no longer auto-shows

**Layout Changes:**
- `[ + New Run ]` moved to `position:fixed; bottom:24px; right:24px` with accent glow
- `#sync-badge` gets `margin-left:auto` in topbar

**Delete Run from Grid:**
- `[ delete ]` button on every run card; confirms → removes from `db.runs` → `save(db)` → `deleteRunFromSb` → re-renders

**Edit Build from Builds Tab:**
- `[ edit build ]` in each build card header → sets `rpExpandedBuildId` → opens game settings modal scrolled to that build

**Modal Entrance Animations:**
- `.modal-overlay`: `opacity` transition + `backdrop-filter:blur(2px)`
- `.modal`: `translateY(8px) scale(0.985)` → `translateY(0) scale(1)` on `.open`

**Supabase migration applied:**
```sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS build_id text;
```

---

### 10. Player Tags, Security, Generic Watcher (Session 9)

**Player Tag System:**
- Every user gets a unique 4-char `[A-Z0-9]` tag (excludes confusable chars 0/O/1/I/L)
- `assign_profile_tag` BEFORE INSERT trigger auto-assigns; user can edit in profile modal
- Sidebar shows `#XXXX` in accent monospace below display name
- `23505` error caught on save → `// tag taken` inline

**Input Sanitization + Rate Limiting:**
- `_sanitizeProfile/Game/Run` clamp all field lengths and whitelist-validate before every Supabase write
- `_RateLimiter` class (sliding window): `_syncLimiter = new _RateLimiter(60, 60_000)` — 60 writes/min, checked at top of every sync function

**Security Hardening:**
- CSP meta tag added: `connect-src` locked to Supabase URL, `script-src` allows only jsdelivr.net, `frame-src`/`object-src` blocked
- All `innerHTML` injections confirmed to use `esc()` — audited clean
- Megabonk debug console logs removed

**Generic File Watcher:**
- `generic` game type added to `GAME_TYPE_META` and both game-type selects
- `readGenericState(dirHandle)` — returns `{ latestMtime }` from max `lastModified` across all top-level files
- `detectRunEnd` generic branch fires `{ result: null }` on mtime change; user quick-logs or reviews manually

**Add Game Modal — Inline File Connect:**
- Game type select + path hint + `⬡ Connect Game Files` button added directly to Add Game modal
- Eliminates need to open game settings after adding a game

**Pending Supabase SQL (must be run manually):**
```sql
-- Block 1: Tag column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tag TEXT;
ALTER TABLE profiles ADD CONSTRAINT profiles_tag_key UNIQUE (tag);
-- + gen_profile_tag() function + assign_profile_tag trigger + backfill

-- Block 2: DB-level CHECK constraints
-- profiles: name_len, bio_len, tag_format
-- games: name_len, fields_size, builds_size
-- runs: result_valid, date_format, notes_len, comment_len, tags_count, fields_size
```

---

### 11. RoR2 Deltas + Hades 2 Weapon Detection (Session 10)

**Risk of Rain 2 — Delta-Based Tracking:**
- `readRoR2State` now reads cumulative counters (`totalStagesCompleted`, `totalKills` / `totalMonstersKilled` / `totalKillCount`) instead of `highestStagesCompleted`
- `detectRunEnd` for `ror2` computes deltas: `stagesDelta = curr.totalStages - prev.totalStages`, `killsDelta = curr.totalKills - prev.totalKills`
- Pre-fills `fields.floor` (stages this run) and `fields.score` (kills this run)
- Caveat: XML tag names need verification against a real `UserProfile.xml`

**Hades 2 — Separate Reader + Weapon Pre-Fill:**
- `readHades2State(dirHandle)` split from `readHadesState`; calls `extractHades2Weapon(file)`
- `extractHades2Weapon` reads up to 2 MB of `Profile0.sav` as latin-1, searches for `HADES2_WEAPONS` key strings (`WeaponStaff`, `WeaponDagger`, `WeaponAxe`, `WeaponTorch`, `WeaponSkull`, `WeaponSpear`) → maps to display names
- Detection now fires **only** when temp file disappears (false-positive second branch removed)
- Caveat: weapon ID strings unconfirmed against a real Hades 2 save

**Symbols added:**
| Symbol | Purpose |
|--------|---------|
| `HADES2_WEAPONS` | Map of weapon ID string → display name |
| `extractHades2Weapon(file)` | Binary scan of Profile0.sav |
| `readHades2State(dirHandle)` | Hades 2 reader (separate from Hades 1) |

---

### 12. Megabonk Kills + OCR Tracking (Session 10+)

**Kill Detection:**
- `server.ps1` parses `stats.json` as JSON (`-Depth 10`) and returns full `statsData` object
- `extractMegabonkKills()` tries a per-run kill field first, falls back to cumulative delta between watcher states
- `ensureMegabonkKillsField()` guarantees a `Kills` field (id: `score`) on any Megabonk game at connect + startup

**Run Editing Removed:**
- `[ edit ]` button removed from run cards and builds view rows
- `openRunModal` hard-blocks edit calls — runs are now create-only (delete still available)

**Raw statsData in Watcher State:**
- Watcher stores full parsed `stats.json` object so delta calculation always has prev vs. curr values for accurate kill counting

---

### 13. Browser Compatibility + server.ps1 BOM Fix (Session 11)

**Problem:** App was Chromium-only (Chrome/Edge) due to `showDirectoryPicker` (File System Access API). Firefox, Brave, Opera GX users hit confusing `alert()` dialogs or saw a broken UI.

**Note:** Brave and Opera GX already had full support — they are Chromium-based. Only Firefox is genuinely incompatible with the file watcher. Megabonk uses a localhost `fetch` instead, so it works in all browsers without any changes.

**CSS added (after `.gm-connect-btn.connected:hover`):**
```css
.gm-connect-btn.unavailable { border-color: var(--border-hi); color: var(--text-faint); cursor: default; opacity: 0.75; font-size: 0.78em; letter-spacing: 0.04em; }
.gm-connect-btn.unavailable:hover { background: transparent; box-shadow: none; }
```

**`renderWatcherBlock` changes:**
- Added `const hasPicker = ('showDirectoryPicker' in window);`
- `rp-select-folder-btn` is now hidden (`display: none`) in Firefox for non-Megabonk games; shown normally in Chromium
- Added `!hasPicker && !isMegabonk` branch to the dot/label state machine: shows `// watcher requires Brave, Chrome, Edge, or Opera GX` instead of "no folder selected"

**`openGameModal` connect button init:**
- On modal open, if `!hasPicker` and game type is set and not Megabonk → renders with `.unavailable` class and browser requirement text immediately, rather than appearing active and failing on click

**`gm-game-type` change handler:**
- Switching to a non-Megabonk type in Firefox instantly applies `.unavailable` state to the connect button (no waiting for a click)

**`gm-connect-btn` click guard:**
- Updated inline hint from `// requires Chrome or Edge` → `// file watcher not supported — use Brave, Chrome, Edge, or Opera GX`

**`topbar-watch-btn` click:**
- Removed `alert('File System Access API is not supported...')` → silent return (button is meaningless in Firefox and should not pop a dialog)
- Removed `alert('Set the game type in game settings first...')` → silent return + focus

**`rp-select-folder-btn` click:**
- Removed `alert('Select a game type above first.')` → silent return + focus (button is hidden in Firefox anyway; this is just a safety guard)
- Removed `alert('File System Access API is not supported in this browser...')` → silent return (redundant with button being hidden)

**`server.ps1` UTF-8 BOM fix (same session):**
- Root cause: file saved without BOM. PowerShell 5.1 read it as CP1252. Em dash (`—`, bytes `E2 80 94`) decoded as `â€"` where `0x94` = RIGHT DOUBLE QUOTATION MARK in CP1252, prematurely closing string literals. Caused 4 cascading parse errors.
- Fix: re-saved with `New-Object System.Text.UTF8Encoding($true)` via `[System.IO.File]::WriteAllText()` — adds UTF-8 BOM so PS5.1 reads it correctly.
- All WinRT type-loading syntax (`[TypeName, Assembly, ContentType=WindowsRuntime]`) is valid PS5.1 — was a red herring during debugging.

**CLAUDE.md updated:** "Chrome/Edge only" note replaced with accurate Chromium browser list; Known limits section updated to match.

---

### 14. Supabase Migrations + Code Cleanup (Session 11+)

**Supabase SQL Migrations (run via Management REST API with PAT):**

- **Block 1 — Tag column + trigger:**
  - `ALTER TABLE profiles ADD COLUMN tag TEXT` + `UNIQUE` constraint
  - `gen_profile_tag()` — generates a unique 4-char `[A-Z0-9]` tag (charset excludes confusable 0/O/1/I/L); uses `_tag` local variable to avoid name collision with `profiles.tag` column; loops up to 100 attempts
  - `assign_profile_tag` — BEFORE INSERT trigger; sets `NEW.tag` via `gen_profile_tag()` if null
  - Backfilled existing profile: `UPDATE profiles SET tag = gen_profile_tag() WHERE tag IS NULL` → assigned `22XK`

- **Block 2 — DB-level CHECK constraints:**
  - `profiles`: `chk_profiles_name_len` (≤50), `chk_profiles_bio_len` (≤300), `chk_profiles_tag_format` (`^[A-Z0-9]{4}$`)
  - `games`: `chk_games_name_len` (≤80)
  - `runs`: `chk_runs_result` (`IN ('win','loss','quit')`), `chk_runs_date_format` (`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`), `chk_runs_notes_len` (≤1000), `chk_runs_comment_len` (≤500)

- **Block 3 — Function search_path fix:**
  - `ALTER FUNCTION public.update_updated_at() SET search_path = public` — resolves Supabase linter warning about mutable search_path

**Code Cleanup (−114 lines net):**

- Extracted `getGameStats(gameId)`, `renderGenericFieldsList(containerId, enabledSet, labelsObj)`, `renderCustomFieldList(containerId, fieldsArr, onDelete)` as shared helpers
- Collapsed 4 near-duplicate field renderer functions (`renderRpFields`, `renderRpCustomList`, `renderFieldsEditor`, `renderCustomFieldsList`) to delegate to the shared helpers
- `openRunModal` dead code removed — `if (runId) return` at top meant `run` was always null; simplified to direct new-run initialization
- `extractMegabonkKills` and `pickStat` removed — dead code replaced by OCR path (`getMegabonkKillsFromOCR`)
- `today()` inline fixed in quick-log handler
- Streak fix: `renderStats` now uses `for...of` with `break` instead of `forEach`, correctly breaking streak on result change; Best W streak card added as 6th stat

**GitHub repo + Pages:**
- Repo created: `gh repo create run-tracker --public --source=. --remote=origin --push`
- Pages enabled via `gh api`: source branch `master`, path `/`
- Live URL: `https://adamkimble2001-cell.github.io/run-tracker/`
- URL added to Supabase Auth → URL Configuration allowlist

---

## Known Limitations

- `preview_screenshot` times out consistently in this environment (Claude Preview tool issue). The app renders correctly — confirmed via `preview_eval` and `preview_snapshot`.
- `Status` field in profile is a placeholder (UI stub, not persisted meaningfully — marked "coming soon").
- localStorage has a ~5MB browser limit; large base64 images can fill it quickly.
- Single-threaded server: handles one request at a time (fine for local use).

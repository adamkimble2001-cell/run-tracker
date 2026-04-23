# RUN_TRACKER.EXE — Dev Log

All work completed across this Claude session.

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
├── .claude/
│   └── launch.json          # preview server config
└── roguelite-tracker/
    ├── index.html           # entire application (HTML + CSS + JS)
    ├── server.ps1           # PowerShell TCP dev server
    └── DEVLOG.md            # this file
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

## Known Limitations

- `preview_screenshot` times out consistently in this environment (Claude Preview tool issue). The app renders correctly — confirmed via `preview_eval` and `preview_snapshot`.
- `Status` field in profile is a placeholder (UI stub, not persisted meaningfully — marked "coming soon").
- localStorage has a ~5MB browser limit; large base64 images can fill it quickly.
- Single-threaded server: handles one request at a time (fine for local use).

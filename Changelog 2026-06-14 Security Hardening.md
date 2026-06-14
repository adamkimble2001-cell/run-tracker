---
tags: [run-tracker, security, changelog]
date: 2026-06-14
---

# Security Hardening — 2026-06-14

Pentest + stress test of the run-tracker, followed by fixes. All changes committed to `master` (`0fabf5d`) and pushed to GitHub.

## Summary

Ran a full penetration test against the live app and Supabase backend, plus a load/fuzz stress test. Found and fixed source-file disclosure and a missing header, scoped down what share links expose, and added database-level abuse limits. RLS and the app's existing defenses all held under direct attack.

---

## Changes Made

### Server (`server.ps1`)
- **File allowlist** — the dev server now only serves known web assets (`.html`, `.css`, `.js`, `.json`, images). Requests for `server.ps1`, `index.html.bak`, `CLAUDE.md`, `.git/config`, etc. now return **403** instead of leaking source.
- **Security headers added** — `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every response.
- Deleted the stale `index.html.bak` backup file.

### Client (`index.html` / `app.js` / `live-reload.js`)
- **SRI on the Supabase SDK** — pinned to version `2.108.1` with a `sha384` integrity hash + `crossorigin`. A tampered CDN copy will now be rejected by the browser.
- **`app.js` now tracked in git** — the previously-extracted external script (IIFE-wrapped, `'use strict'`, no globals on `window`, frozen `LIMITS`) is now committed. `live-reload.js` too.

### Shared profiles (`get_shared_profile` RPC + `loadSharedProfile`)
- **Private run notes no longer leave your account.** The share RPC's `runs` select dropped `notes` — verified the word "notes" no longer appears anywhere in the function source.
- Share links now expose exactly: avatar + game icons (pictures), accent color + bg effect (animations), run results/dates/tags + game fields (stats), and bio. Nothing else.

### Database (Supabase migrations — live, not in repo)
- **Per-user row caps** — `BEFORE INSERT` triggers cap each account at 10,000 runs / 200 games. Can't be bypassed via direct API calls. No effect on read speed or other users.
- **Trigger functions sealed** — revoked `EXECUTE` on `check_runs_per_user` / `check_games_per_user` from `anon`/`authenticated` so they're not callable as REST endpoints (were auto-exposed; now 404).

---

## Test Results

### Penetration probes — all passed
| Attack | Result |
|---|---|
| Path traversal (`../`, encoded, deep) | 403 ✅ |
| Read Windows hosts file via traversal | 403 Forbidden ✅ |
| Download `server.ps1` / `.bak` / `.md` / `.git` | 403 ✅ |
| Read all profiles/runs/games/share_tokens with anon key | `[]` — RLS blocks ✅ |
| Insert run as anon (no login) | 401 ✅ |
| PATCH / DELETE every row as anon | `[]` — 0 rows ✅ |
| Share RPC with junk / empty / SQL-injection token | `null` ✅ |
| Call internal trigger functions | 404 ✅ |

### Stress test — passed
- 400 concurrent requests (40 in flight): **400/400 OK, 0 failures**
- Oversized 8 KB path, null bytes, garbage HTTP method, partial-header slowloris: **no crash, server stayed at 200**

---

## What a user still *cannot* do
- Read or change another user's data (RLS, database-level)
- Inject scripts via data (every `innerHTML` uses `esc()`)
- Access app variables from the browser console (IIFE)
- Modify app files or path-traverse the server
- Exceed their own row caps no matter how they call the API

## Known/accepted (not code flaws)
- **Anon key visible in DevTools** — unavoidable in any client-side app; RLS is the real boundary.
- **`get_shared_profile` is anon-callable** — by design; share links must work logged-out. Safe (no valid token → no data).
- **Client-side rate limiter is bypassable** — but RLS + DB row caps are the real limit.

---

## TODO

- [ ] **Enable leaked-password protection** in Supabase → Auth → Security (requires Pro tier, ~$25/mo). Only outstanding security item.
- [x] **Lower auth rate limits** in Supabase → Authentication → Rate Limits — sign up/in and OTP verification set to ~10/5min. *(done 2026-06-14)*
- [ ] Consider moving to a real static host (Netlify / Cloudflare Pages / GitHub Pages) — removes `server.ps1` and its whole attack surface; it's a static site.
- [ ] Move image uploads (avatar/icons/bg) to Supabase Storage — base64 in DB/localStorage hits the 5 MB cap fast.
- [ ] Optional: surface a clear UI error when a row cap is hit, instead of the generic `✗ sync failed` badge.
- [ ] Optional: run OWASP ZAP against `localhost:3400` for automated scanning (free).

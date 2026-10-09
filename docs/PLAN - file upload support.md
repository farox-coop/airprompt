# AirPrompt — File Upload Support (phone → host path)

> Status: **implemented** — shipped as a single commit on `main`. Decisions were locked with the user before implementation; the order below is what was built, not a commit sequence. Deviations found during implementation are noted inline.

## Problem

Driving a terminal session from the phone today requires the image to already exist on the host filesystem: the user takes a screenshot on the phone, manually transfers the JPG to the PC, then types the absolute host path into the prompt.

Goal: attach a file from the phone (screenshot, camera photo, any image) in the mobile web UI, so the prompt carries what the CLI needs — an absolute path on the host — with no manual transfer.

## Verdict: feasible

A browser can never expose the phone's filesystem as a path the host can resolve, so a path cannot be handed over — bytes can. The upload is materialized on the host first, and the path is what travels into the prompt:

```
phone picker → File object → POST /api/upload (LAN, token-gated) → host FS
  → absolute host path returned → typed into the pty as keystrokes
  → the CLI reads the image from that path
```

No terminal-protocol change and no provider-specific code: the path is text typed into the session, exactly like the manual workflow it replaces, so claude / codex / cursor / windsurf behave identically. The uploaded file also resolves from **any** session on that host — the path is host-global; session scoping exists only to bound the file's lifetime.

## Research — mechanism options

| Mechanism                                                                        | Android Chrome                                                                                                                                                                                                        | Verdict                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `<input type="file" accept="image/*">` → Android photo picker                    | Reliable, no permission prompt, returns a real `File`                                                                                                                                                                 | **primary path**                                     |
| `navigator.clipboard.read()` (button)                                            | Supported (Chrome 76+) but gallery→clipboard image copy on Android is inconsistent; needs `clipboard-read`, shows a read reminder, and Android 10+ allows clipboard reads only from the focused app                   | **secondary**, error fallback required               |
| `paste` event → `clipboardData.items` / `.files`                                 | Same Android clipboard uncertainty; solid on desktop                                                                                                                                                                  | desktop paste + drag&drop; Android paste best-effort |
| PWA `share_target` (share a screenshot from the gallery straight into AirPrompt) | **Broken on Chrome 153+** — shared files arrive as an empty multipart body (Chromium regression after the September 2026 URI-permission verification change). Also needs a manifest + service worker, neither present | **deferred**                                         |

Android 14+ caveat: a strict `accept="image/*"` input can route straight to the Android photo picker, which has no camera entry. Screenshots live in the gallery, so the primary use case is unaffected; in-app camera capture would need the known dummy-MIME workaround.

Host-clipboard injection (`xclip` / `wl-copy` with `image/png`, so the CLI's own image paste reads a real image rather than a path) is a possible follow-up, out of scope here.

## Constraints found in the codebase

- `express.json()` is the only body parser (`server.js:334`) and `/api` is loopback-gated except `/api/pair` (`server.js:358-362`). A LAN-reachable upload endpoint must be exempted from that gate **and** independently authenticated. `express.raw` exists (express 4.22.2); no multer/form-data dependency is added.
- The only LAN-authenticated surface is the WebSocket: ECDSA P-256 challenge-response with a per-device key (`server.js:854-930`, `src/auth.js`); the browser holds a non-extractable device key in IndexedDB (`public/auth.js`).
- Keystrokes reach the terminal through one `send()` choke point (`public/client.js:535-548`), capped at 64 KiB. The repo's idiom for injecting text is a direct `send({ type: 'input', data })` — that is how dictation delivers transcripts (`public/dictation.js:490`, `:549-551`) and how keybar buttons work (`public/keybar.js:233-242`).
- `#mobile-input` (`public/index.html:20-26`) is **not** a composer: `display: none` with `opacity: 0.01` (`public/styles.css:736-757`), shown only on coarse-pointer devices (`public/client.js:982-988`), and on a fine-pointer device the diff listener at `public/client.js:1118` is never registered (the early return at `:986` precedes it). There is no desktop text composer at all.
- Enter semantics on mobile (`public/client.js:1211-1239`): the first Enter queues `'\n'` after a 400 ms debounce — a **literal newline**, which the server pastes as bracketed paste (`server.js:950-970`); only the second Enter within 400 ms sends `'\r'`, the real submit. The keybar Send button sends `'\r'` (`public/keybar.js:38-44`), as does dictation's send action (`public/dictation.js:549-551`).
- HTTPS is on by default with a self-signed cert (`bin/generate-cert.sh`), so the origin is a secure context after the cert bypass — usable for the Clipboard API, but self-signed origins are erratic around permission-backed APIs, hence the fallback.
- Claude Code reads images by absolute or relative path in the prompt; the vision API caps a single image at 5 MB, downscales to 1568px long edge, and many-image requests hard-reject above 2000px. Client-side downscale is a correctness guard, not cosmetics.
- Session marker dirs (`~/.airprompt/sessions/<provider>-<safeTmux>/`, `src/providers/provider.js:123-127`) hold `mirror` / `active` files read by `sessionToJSON` (`src/utils.js:115-163`), `src/hooks/core/activate.js:303-305,386-387,455-456`, `src/sweep.js:51-63`, `server.js:482-491` and `bin/airprompt-off.sh:67`. Uploads must not be mixed into them.
- Disk-deletion guards: Node `isSafeRmTarget` allows only `[resolveInstallDir(), sessionsRootDir(), stateDir()]` (`src/utils.js:38-58`); shell `_safe_rm_rf` allows `$HOME/.airprompt`, `$AIRPROMPT_INSTALL_DIR`, `$AIRPROMPT_STATE_DIR`, `$AIRPROMPT_SESSIONS_DIR`, each required to contain `airprompt` (`bin/lib/protocol.sh:136-168`). A new root is not covered by either.
- `daemon_env()` (`bin/lib/protocol.sh:71-84`) forwards a fixed allowlist to the tmux-spawned daemon (tmux does not inherit client env), so a new `AIRPROMPT_UPLOADS_DIR` would otherwise leave the daemon and the shell scripts resolving **different** roots.
- `bin/airprompt-off.sh` removes the session's own marker dir (`:91`) **and** sweeps every other session whose tmux is dead (`:95-128`); `clean.sh` removes `SESSIONS_DIR` and the state dir, and in the install-dir branch (`:97-105`) only those two subdirs; provider `--uninstall` deletes every entry under the install dir except `state` (`src/providers/claude.js:632-645`).
- No Express error middleware exists anywhere in `server.js`, and an over-limit `express.raw` body rejects with `status 413` / `type: 'entity.too.large'` from `raw-body` — without a scoped handler the phone receives Express's default **HTML** error page.
- `bin/airprompt-agnostic-check.sh` scans `public/` too (`test/` and `docs/` exempt) — new modules must stay provider-name-free or `make test-all` fails.
- Repo rules that bind this feature: no hardcoded user paths, extract-don't-bloat, isolated tests (`createApp()`, port 3211, `airprompt-test-*` tmux names), `make -C <abs> test-all` as the final check.

## Locked decisions

| Decision         | Choice                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport + auth | One-time upload token minted over the authenticated WS, then `POST /api/upload` with the file as a raw body (`express.raw`, no new dependency)                              |
| Storage root     | `~/.airprompt/uploads/<providerId>-<sessionId>/` — new root, session-scoped, `AIRPROMPT_UPLOADS_DIR` override                                                               |
| Prompt insertion | Type the absolute path into the terminal as keystrokes (dictation/keybar idiom), no trailing Enter — the user adds their instruction and submits                            |
| Deletion trigger | Previous turn's files are released on the next prompt submit, then reaped by the sweep after a grace window; plus session end, plus a 24h TTL backstop                      |
| MVP extras       | Desktop paste + drag&drop, clipboard button (`navigator.clipboard.read()`), client-side resize to ≤1568px (pref-gated), progress bar that disappears once the path is typed |

### Why deletion is heuristic (and why there is a grace window)

The daemon sees only keystrokes going into the pty — whether the CLI actually read a file, and when, is invisible from AirPrompt, and detecting it would need provider-specific instrumentation, breaking the agnostic layer. The trigger is therefore an event heuristic:

- Files uploaded in the current turn are `pending`.
- A submit (`'\r'` only — see below) releases the **previous** turn's files: they stay readable at their original path and are reaped by the sweep `graceMs` later (default 10 min, `AIRPROMPT_UPLOAD_GRACE_MS`).
- The grace window is what makes this safe: immediate unlinking could delete a file that a still-running turn reads late, and because the path is what the CLI resolves, moving files to a trash dir would break the same read.
- Session end and the 24h TTL cover abandoned sessions, so nothing outlives the daemon indefinitely.

## Architecture

### New modules (extract, don't bloat)

| Module                    | Responsibility                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/uploads.js`          | Server-side store: root/session-dir resolution, filename sanitization, atomic write, per-session manifest (pending/released + deadlines), sweep (deadlines, TTL, dead-session dirs). Injectable `{ now, dir, fs }` for tests |
| `public/upload.js`        | Browser side: picker/paste/drag sources, WS token request, XHR upload with progress, keystroke injection of the path, failure UX                                                                                             |
| `public/upload-resize.js` | Client-side downscale (`createImageBitmap` + canvas, `imageOrientation: 'from-image'`), transparency-aware format choice, decode-failure passthrough                                                                         |

`server.js` gains a thin route, two WS message types, and the sweep call; `public/client.js` gains `\r`-submit detection and the injection helper; `public/index.html` / `public/styles.css` gain the buttons, hidden input and progress element.

### Transport: WS token → REST POST

1. Client sends `{ type: 'upload_token', sessionId }` over the authenticated WS.
2. Server validates that the session is registered, mints `crypto.randomBytes(32).toString('base64url')`, stores `{ devicePublicKey, sessionId, expiresAt: now + 120s }`, replies `{ type: 'upload_token', token, expiresAt }`.
3. Client `POST`s to `/api/upload?name=<name>&mime=<mime>` with header `X-AirPrompt-Upload-Token`, body = raw bytes, `Content-Type: application/octet-stream`.
4. Server: token valid, unexpired, session still registered, **and the token's device still paired** → sanitize name → extension from the MIME whitelist → write file → append to the session manifest → discard the token → reply `{ path, bytes, mime }`.
5. Tokens are single-use (one token per file) and **re-validated against the paired-device list when redeemed**, so `airprompt auth revoke` also kills an in-flight upload (the revoke path additionally drops the device's outstanding tokens); a small per-device cap bounds memory. A failed upload consumes its token, so a retry re-mints.

`/api/upload` joins `/api/pair` in the loopback exemption list — the token is the authentication, bound to a paired device's public key.

### Server-side guards

- MIME whitelist (images for the MVP): `image/png`, `image/jpeg`, `image/webp`, `image/gif`. The extension is derived from the whitelist entry, never from client input.
- Size cap `AIRPROMPT_UPLOAD_MAX_BYTES` (default 25 MB), enforced against `Content-Length` **and** the streamed length, so a missing or lying header cannot bypass it. A scoped error handler maps `entity.too.large` (and other body-parser failures) to a JSON error instead of Express's HTML page.
- Filename: basename only, `[^A-Za-z0-9_.-]` → `-`, capped, never empty; stored as `<epoch-ms>-<4-byte-hex>-<sanitized>` so identical screenshot names never collide and traversal is impossible.
- Session key: `<providerId>-<sessionId>`. The sessionId is already constrained to `[A-Za-z0-9_-]{1,64}` at registration (`server.js:374`) and on disk recovery (`server.js:285`), so it is used **verbatim** — sanitizing an already-validated id would only collide distinct sessions, and it also cannot collide across providers sharing one tmux. Marker dirs stay tmux-keyed (`sessionDir()`), because the shell scripts only ever know the tmux name; the two key schemes are deliberately separate now.
- Dir `0700`, file `0600`, created with `fs.mkdirSync(..., { recursive: true, mode: 0o700 })`.
- Errors return a generic message; details only via the `AIRPROMPT_DEBUG` log.

### Lifecycle: one cleanup authority

Rather than patching every sweep (shell `on`/`off` dead-dir sweeps, `activate.js`/`deactivate.js` hooks, `recoverSessionsFromDisk`, `runStaleSweep`), uploads cleanup lives in **one** place: `sweepUploads()`, called from the existing 60 s `staleInterval` (`server.js:1102-1104`), driven by ground truth — does the tmux session still exist.

| Event                  | Where                                                                                                                                                                   | Action                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt submitted       | Server, in the existing `case 'input'` branch: a payload with `'\r'` and no `'\n'` is a submit (a payload containing `'\n'` is bracketed paste, i.e. a literal newline) | Stamps `deadline = now + graceMs` on the uploading device's pending entries (manifest)                                                                                                                                                     |
| Sweep (every 60 s)     | `staleInterval`                                                                                                                                                         | Reap entries past their deadline or older than the TTL; delete session dirs whose tmux is **definitively** gone (`tmux has-session` exit 1 — other codes/timeouts keep the dir, same discipline as `src/sweep.js:38-47`); prune empty dirs |
| `airprompt off`        | `bin/airprompt-off.sh`                                                                                                                                                  | Purge this session's uploads dir, keyed on `<providerId>-<sessionId>` (globbed on the sessionId, so an unknown provider still matches) **before** the `SESSION_ID` early exit; otherwise the daemon's sweep reaps it from the manifest     |
| `airprompt clean`      | `bin/airprompt-clean.sh`                                                                                                                                                | Remove the resolved uploads root in **both** branches (install-dir branch `:97-105` and full-remove branch)                                                                                                                                |
| Daemon restart / crash | `recoverSessionsFromDisk` (`server.js:237-330`)                                                                                                                         | Uploads are untouched; session dirs whose tmux is gone are reaped by the sweep                                                                                                                                                             |
| Provider `--uninstall` | `src/providers/claude.js:632-645`                                                                                                                                       | Uploads are removed with the rest of the install dir — intended for a full uninstall, documented as such                                                                                                                                   |
| Revoked device         | socket close on revoke (`server.js:1144-1156`)                                                                                                                          | Outstanding tokens dropped; a token whose device is no longer paired is rejected at POST even if it has not expired                                                                                                                        |

Because the manifest is on disk, a crash between upload and submit does not lose track of pending files: the sweep still finds them by age, so the TTL remains the backstop it claims to be.

### Guards to extend

- `uploadsRootDir()` added to the Node roots in `src/utils.js:46` (in a dev checkout `resolveInstallDir()` is the checkout, so the default `~/.airprompt/uploads` is under no Node root today and `safeRmSync` would silently no-op).
- `${AIRPROMPT_UPLOADS_DIR:-}` added to the shell roots in `bin/lib/protocol.sh:154-160`. The default root already passes via `$HOME/.airprompt`, but a custom dir would be refused.
- `AIRPROMPT_UPLOADS_DIR`, `AIRPROMPT_UPLOAD_MAX_BYTES`, `AIRPROMPT_UPLOAD_TTL_MS`, `AIRPROMPT_UPLOAD_GRACE_MS` added to `daemon_env()` (`bin/lib/protocol.sh:71-84`) and to the README env table (`README.md:136-141`), so shell and daemon never resolve different roots.

### Client UX

- **Attach button** (`📎`) in `#session-bar` next to `#prefs-btn` / `#keybar-toggle` / `#dictate-btn` (`public/index.html:57-59`), plus a hidden `<input type="file" accept="image/*" multiple>`. Disabled while an upload is in flight, so a double tap cannot double-upload.
- **Clipboard button** (`📋`), rendered only when `navigator.clipboard?.read` exists; `read()` → first `image/*` type → `getType()` → `File`. On failure (denied, text-only clipboard, Android gallery-copy flakiness) show an inline message pointing at the attach button instead of a silent no-op.
- **Desktop paste**: a `document` `paste` listener scanning `clipboardData.items` for `kind === 'file'` with an `image/*` type (`items[0]` is never assumed to be the image).
- **Drag&drop**: `dragover` / `drop` on `#terminal-container`, capture-phase with `preventDefault`, so xterm cannot swallow the event.
- **Progress bar**: a thin bar under `#session-bar`, driven by `XMLHttpRequest.upload.onprogress` (fetch exposes no upload progress), removed once the path has been typed. Network loss or a locked screen surfaces as an error and leaves the terminal untouched.
- **Path injection**: `send({ type: 'input', data: path + ' ' })`, the dictation/keybar idiom — nothing is written into `#mobile-input` (it is invisible, and on desktop it has no diff listener at all), so one mechanism covers phone and desktop. The path is appended at the terminal's current cursor position, which is the "insert, no auto-send" behaviour that was chosen: the user adds their instruction and submits. Names are sanitized, so the path never needs quoting.
- **Resize**: images whose long edge exceeds 1568px or whose blob exceeds ~2 MB are downscaled on a canvas from `createImageBitmap(file, { imageOrientation: 'from-image' })` (Chrome applies EXIF orientation by default); PNG stays PNG so UI screenshots keep crisp text, other formats become JPEG q0.92; a decode failure (HEIC, exotic formats) passes the original through untouched. Preference `airprompt-upload-resize` (default on), stored with the existing `airprompt-*` JSON `localStorage` convention (`public/dictation-macros.js:239-240`) and rendered as a static row in the preferences modal next to `#pref-enable-all`; `public/preferences.js` only wires that row, it owns no storage.

## Files changed

| File                                             | Change                                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/uploads.js`                                 | **new** — store, sanitization, write, manifest, sweep                                                                                                                                                                                              |
| `public/upload.js`                               | **new** — sources, token + XHR upload, path injection, progress UI                                                                                                                                                                                 |
| `public/upload-resize.js`                        | **new** — client-side downscale                                                                                                                                                                                                                    |
| `server.js`                                      | `/api/upload` route (rate limit → token → device re-check → raw body) + JSON error handler, loopback exemption, `upload_token` WS handler, submit detection in `case 'input'`, token drop on device revoke, `sweepUploads()` on the stale interval |
| `src/utils.js`                                   | `uploadsRootDir()` in `isSafeRmTarget` roots                                                                                                                                                                                                       |
| `src/providers/provider.js`                      | `uploadsRootDir()` + `uploadsSessionDir(providerId, sessionId)`; `sanitizeSessionName()` named for the tmux-keyed marker dirs (uploads need none)                                                                                                  |
| `public/client.js`                               | `send()` refuses a submit while an upload is in flight; `_airpromptRequest` one-shot WS reply helper; `_airpromptActiveSession` accessor                                                                                                           |
| `src/auth.js`                                    | pair rate limiter generalized into `createRateLimiter()`, reused as `checkUploadRate`                                                                                                                                                              |
| `public/index.html`, `public/styles.css`         | attach + clipboard buttons, file input, progress bar, resize pref row, script tags                                                                                                                                                                 |
| `bin/lib/protocol.sh`                            | `AIRPROMPT_UPLOADS_DIR` guard root; upload env vars in `daemon_env()`; shared `_purge_uploads_dir()`                                                                                                                                               |
| `bin/airprompt-off.sh`, `bin/airprompt-clean.sh` | uploads purge (off: by `<providerId>-<sessionId>` glob, before the early exit; clean: whole root, via the guarded helper)                                                                                                                          |
| `test/unit/uploads.test.js`                      | **new** — naming, collisions, manifest release + grace, TTL, dead-vs-unknown tmux, unlisted files, guard roots, tokens                                                                                                                             |
| `test/unit/server.test.js`                       | upload route: tokenless/expired/reused/revoked token, unknown session, MIME + content-type rejection, JSON 413, chunked body, token-decides-destination, `\r`-releases / `\n`-does-not                                                             |
| `test/integration/run.sh`                        | tokenless upload rejected with JSON + guard refuses a non-airprompt root (installs run `clean.sh`, which removes `~/bin` symlinks, so it is deliberately not invoked)                                                                              |
| `README.md`, `CHANGELOG.md`                      | feature section + env var table                                                                                                                                                                                                                    |

## Implementation notes (deviations from the reviewed plan)

The review pass changed four things; they are settled, not open:

1. **Submit detection moved into the server** (`case 'input'`), not a `turn_submitted` WS message from the client. A payload with `'\r'` and no `'\n'` is a submit; anything with `'\n'` is bracketed paste (a literal newline), which the first-draft rule would have misread as a submit and released files early. Server-side detection also cannot be spoofed by a buggy client.
2. **Release is attributed per device** (`manifest.entries[].device`), so one tab or phone submitting a prompt cannot release another's unsent files.
3. **The path is typed with `send({type:'input'})`**, never written into `#mobile-input`. That element is an invisible IME capture (`display:none`, `opacity:0.01`) and on a fine-pointer device its diff listener is never registered at all — textarea insertion would have been a no-op on desktop and an IME race on mobile. Direct injection is what dictation already does, so one mechanism covers both.
4. **Uploads are keyed on the `sessionId`, not the tmux name** (`uploadsSessionDir(providerId, sessionId)` → `~/.airprompt/uploads/<providerId>-<sessionId>/`). Registering and disk recovery both constrain the sessionId to `[A-Za-z0-9_-]{1,64}`, so it is a safe path component verbatim; sanitizing it (the first draft reused `sessionDir()`'s sanitizer) would have mangled distinct ids into one directory and bought no safety. Marker dirs stay tmux-keyed because the shell scripts only know the tmux name — the two schemes are separate on purpose now.
5. **Cleanup converges in one place**: `sweepUploads()` on the existing 60 s interval, keyed on tmux liveness (definitive `exit 1` only, `unknown` keeps files). The dead-dir sweeps in `on.sh` / `off.sh` / `activate.js` / `deactivate.js` and `recoverSessionsFromDisk` therefore need no per-site uploads logic; only `off.sh` (immediate, before its `SESSION_ID` early exit) and `clean.sh` purge explicitly.

Adjudicated during review, with primary evidence: `createImageBitmap`'s `imageOrientation` **defaults to `from-image`** (spec/MDN), so the claimed EXIF-rotation bug does not exist — the option is passed explicitly for intent only. The claim that a sanitized path "never contains spaces" was scoped instead: filenames are sanitized, but a `$HOME`/`AIRPROMPT_UPLOADS_DIR` with spaces still yields an ambiguous path, which the README now warns about. `bin/airprompt-clean.sh` is not executed by the integration suite because it removes `~/bin` symlinks and would damage a developer checkout — the shared purge helper is tested directly instead.

## Implementation order (single commit)

**Server** — `src/uploads.js` + root helpers and guards; `/api/upload` + token lifecycle + error handler; submit detection + `sweepUploads()` wiring; shell purge in `off`/`clean` + `daemon_env()`.
**Browser** — `public/upload.js` (sources, token, XHR, progress, injection); `public/upload-resize.js` + pref row; clipboard / paste / drag&drop.
**Finish** — unit + integration tests, lint/format, `README.md` + `CHANGELOG.md`, then `make test-all` from the repo root.

Acceptance for the finished commit:

- Upload from the phone lands in `~/.airprompt/uploads/<providerId>-<sessionId>/`, `0700`/`0600`, and the returned absolute path is typed into the terminal (padded and wrapped in backticks, `` `/path` ``) without submitting.
- One mechanism works on phone and desktop; no insertion ever depends on `#mobile-input` being visible or on a diff listener existing.
- Oversize, wrong-MIME, traversal-shaped, expired, reused and revoked-device uploads are all rejected, in JSON, with nothing written to disk.
- Files are reaped by the sweep after the grace window following the next submit, and by the TTL, `off` and `clean`; a daemon restart preserves a live session's uploads and loses no pending tracking.
- `rg -n '/home/' src/uploads.js public/upload.js public/upload-resize.js` is empty; the agnostic check passes; `make test-all` is green.

## Edge cases handled

- Two screenshots with the same name in one turn — random prefix, no collision.
- Upload with no active session, or a session killed between token mint and POST — token rejected, no orphan file.
- Token minted and never used — expires in 120 s, nothing written; device revoked mid-flight — rejected at POST.
- Multiple files selected — one token per file, sequential uploads, the bar reflects the batch; the attach button is disabled while in flight.
- Very large photo (> cap) — rejected before any disk write, terminal untouched.
- Phone screen locks or the network drops mid-upload — error surfaced, terminal untouched, no partial file (single `writeFile` of a fully buffered body).
- Two providers registered on one tmux session (`server.js:407-414`) — distinct `<providerId>-` prefixes keep their uploads and purges separate.
- Session renamed via `airprompt name` — display name only, the key is the tmux name, so nothing is orphaned.
- User submits an empty prompt, or submits while the previous turn is still running — files are released, never unlinked immediately, and the grace window covers the late read.
- Daemon crash/restart between upload and submit — the manifest on disk keeps the files tracked.
- Path with spaces — impossible by construction, nothing to quote.
- Provider divergence — none: only text enters the prompt.

## Out of scope

- PWA `share_target` (manifest + service worker, and broken on Chrome 153+ for files).
- Host clipboard injection (`xclip` / `wl-copy`) so the CLI pastes a real image instead of a path.
- Non-image files (PDF, logs) — the whitelist is deliberately narrow; widening is a one-line change plus an `accept` update.
- Uploading into the session's working directory (pollutes user repos) or `/tmp` (may be reaped mid-session).
- Serving uploaded files back to the browser (thumbnails are client-side and pre-upload only).
- **Making the marker dirs sessionId-keyed too**, which would delete `sanitizeSessionName` outright. Reviewed and consciously deferred (user's call, 2026-10-08): the uploads root is id-keyed, the marker root stays tmux-keyed, and the two schemes are documented as separate. Blockers for a swap: the marker dir is created before any sessionId exists (`src/hooks/core/activate.js` creates it, then generates `${Date.now()}-${pid}-${cwd}`), `bin/airprompt-on.sh` derives the id from the tmux name instead, and every finder only knows the tmux name (`off.sh` derive-or-glob, `deactivate.js findMyDir`, `on.sh`'s own-dir comparison in its dead-dir sweep). A real swap therefore needs content-based scans (`<dir>/tmux` — two places already do this) plus a migration story for existing tmux-keyed dirs.

## Verification

1. `make test-all` from the repo root (lint, format-check, agnostic-check, unit, integration).
2. On the real phone over HTTPS: attach a screenshot, watch the progress bar, confirm the path appears in the terminal (not submitted), add an instruction, submit, confirm the CLI reads the image.
3. Cleanup: the file exists after upload, is released on submit, disappears after the grace window, and the session dir is gone after `airprompt off` / `clean`; a `restart` keeps a live session's files.
4. Guards: `AIRPROMPT_UPLOADS_DIR` pointing outside any `*airprompt*` root is refused by `_safe_rm_rf`; the default root purges cleanly.
5. `rg -n '/home/'` over the new files returns nothing.

## Proposed PR description

### Summary

Adds file upload from the mobile web UI: an attach button (plus desktop paste/drag&drop and a clipboard button) sends the file to the daemon over a token-gated LAN endpoint, the daemon writes it under `~/.airprompt/uploads/<providerId>-<sessionId>/`, and the returned absolute host path is typed into the session — no manual transfer of the screenshot to the host.

### Tasks

- [x] `src/uploads.js` store: sanitization, atomic naming, per-session manifest with grace deadlines, sweep (deadlines, TTL, dead-session dirs)
- [x] `upload_token` WS message + `POST /api/upload` raw-body endpoint, loopback-exempt but token-authenticated, JSON error handler for body-parser failures
- [x] Token hardening: single-use, device-bound, re-validated against the paired-device list at POST, dropped on device revoke
- [x] Cleanup: submit release + grace, sweep on the existing 60 s interval, `off` purge before its early exit, `clean` purge via the guarded helper
- [x] Guard roots extended (Node `isSafeRmTarget`, shell `_safe_rm_rf`) and upload env vars forwarded to the tmux-spawned daemon via `daemon_env()`
- [x] `public/upload.js` + `public/upload-resize.js`, attach/clipboard buttons, progress bar, keystroke injection of the path
- [x] Desktop paste and drag&drop sources funnelling through the same pipeline
- [x] Unit + integration tests, README env table, CHANGELOG

### Notes / Out of Scope

- Deletion is heuristic: the previous turn's files are released on the next submit (`'\r'` only — a bare `\n` is a literal newline on mobile) and reaped after a grace window, plus session end and a 24 h TTL. The daemon cannot observe when the CLI actually reads a file, and detecting it would require provider-specific instrumentation.
- PWA share-target and host-clipboard image injection are deliberately deferred.
- Images only for the MVP (png/jpeg/webp/gif) with a 25 MB cap, all configurable via env vars.

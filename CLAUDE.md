# AirPrompt

## CRITICAL: NO QUESTIONS. JUST EXECUTE.

When using `/airprompt <command>` or `~/bin/airprompt <command>`: **execute immediately, never ask confirmation.** Not even for `clean`. The user typed it — run it. No "are you sure?", no warnings, no "proceed?".

## Entrypoint

ALL AirPrompt commands go through `~/bin/airprompt` dispatcher. NEVER call sub-scripts directly.

And since `~/bin/airprompt` can be called simply with `airprompt` then:

```
airprompt on [<name>]      # start daemon + register (optional name)
airprompt on --name <name> # same, explicit flag form
airprompt off              # unregister + stop
airprompt status           # show status
airprompt name [<text>]    # name/rename session (empty or "" clears)
airprompt clean            # full teardown
airprompt restart          # restart daemon — sessions survive via disk recovery
airprompt autostart on|off # enable/disable auto-start on SessionStart
airprompt auth list|allow|deny|revoke|name  # manage paired devices
airprompt update [<tag>]   # update install to a release tag (or latest main)
airprompt help             # show usage
```

## Tests

- Run: `make test-all`
- Tests are ISOLATED — never kill the real daemon. Unit tests use `createApp()` (fresh server, no PID file). Integration tests use port 3211 + `/tmp/airprompt-server-test.pid`. Tmux sessions: `airprompt-test-*` / `airprompt-integtest-*` — never match real daemon sessions.

## Code organization

**Extract, don't bloat.** When a single file accumulates too many responsibilities or a clear module boundary exists, extract dedicated code into a separate file. Never cram everything into one file when there's an obvious opportunity to split.

Examples from this project:

- Notification toasts → `public/notify.js` (not crammed into `client.js`)
- Keyboard bar → `public/keybar.js` (already separated)
- Voice dictation → `public/dictation.js` (extracted from `client.js`)
- Dictation macros → `public/dictation-macros.js` (voice formatting & punctuation commands)
- Touch scroll → `public/scroll.js` (adaptive: SGR mouse wheel / viewport scroll / arrow keys, by terminal state)
- Stale session sweep → `src/sweep.js` (extracted from `server.js`)
- Session management could be `public/sessions.js`

Smaller focused files > one giant file.

## CRITICAL: NO hardcoded user paths

AirPrompt is a tool to be used by ANY user. **NEVER** hardcode `/home/<user>/` or any user-specific absolute path. Always use:

| Context       | Use                                                                 |
| ------------- | ------------------------------------------------------------------- |
| Shell scripts | `$HOME`, `$CLAUDE_CONFIG_DIR` (fallback `$HOME/.claude`)            |
| Node.js / JS  | `os.homedir()`, `process.env.HOME`, `process.env.CLAUDE_CONFIG_DIR` |
| Config / docs | `~`, `$HOME`, `$CLAUDE_CONFIG_DIR` — never `/home/<user>/`          |

Also applies to: `$AIRPROMPT_PORT`, `$AIRPROMPT_DEBUG`, `$AIRPROMPT_PID_FILE` — use env vars, never hardcoded values specific to one machine.

## Web UI strings MUST be translatable (i18n)

**Every user-facing string in `public/` goes through `Dictation.tr(key)`.** Never leave a new label hardcoded in English — a bare `<span>Some label</span>` or a literal in a JS toast is a bug the moment the app is used in Spanish.

- **The table** lives in `public/dictation.js`: `const T = { 'en-US': {…}, 'es-AR': {…} }`. Add the key to **both** entries. `tr()` resolves `T[currentLang][key] → T['en-US'][key] → key` (dictation.js:91), so a missing translation silently falls back to English — it will not throw, it will just be wrong.
- **Language selection**: `setLang(code)` persists to `localStorage['airprompt-lang']`; `normalizeLang()` maps bare codes to region codes (`es` → `es-AR`), and languages with no table entry fall back to `en-US`. Only `en-US` and `es-AR` are actually translated today.
- **Where labels get applied**: static markup keeps an English default in `public/index.html` with an `id` on the element, and JS overwrites it — `public/preferences.js` `render()` (runs on **every** modal open, so it follows the current language) or `public/dictation.js` `updateAllLabels()`.
- **A new preferences row** = markup with an id + a `tr()` assignment in `render()` + both table entries. The checkbox's own behaviour can live in another module (e.g. the upload-resize pref is wired in `public/upload.js`); the label is still the preferences modal's job.
- **Known gap**: the upload error/diagnostic toasts in `public/upload.js` (`MSG.*`) are English-only. Extend them through the same table if that becomes a problem.

Before committing, `grep -r '/home/'` in changed files. Any hit is a bug.

## Development

- Always `AIRPROMPT_DEBUG=1` when running scripts in dev. Use: `AIRPROMPT_DEBUG=1 airprompt <cmd>`
- **After editing server-side code (`server.js`, `src/**`), restart the daemon: `AIRPROMPT_DEBUG=1 airprompt restart`.** Static files under `public/` are served no-cache from disk, so the browser picks up client changes on a plain reload — which is exactly what makes a stale daemon confusing: the new UI loads fine while its new routes 404. A feature that "works in tests but fails on the phone" is almost always this. Sessions survive the restart via disk recovery; `make refresh` is not needed for it (and it wipes pairing + sessions + `node_modules`).

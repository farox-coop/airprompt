# AirPrompt — Public Readiness Report

Working document. Written 2026-10-09, before the repo was opened to the public. Supersedes [REPORT - open readiness.md](<REPORT - open readiness.md>) (2026-08-18), which was scoped to the coop; this one covers the public audience — strangers on shared networks running this on their own machines.

Findings came from four audits (secrets/history, docs, current-code security, repo hygiene) plus a full `make test-all` run on this tree. The fixes landed in the single "public readiness" commit; what was deliberately deferred is marked below.

## Verdict

**Ready to open.** The engineering was already the hard part and it holds up: 1123 unit + 60 integration tests green on a Node 20/22/24 matrix, no secret anywhere in the tree or in the 88-commit history, a device-pairing auth model that is genuinely well built, no shell-injection surface, and a clean, lean repository. The work for public was identity hygiene, dependency health, community files, and a small set of hardening items — all of it landed.

| Dimension                   | State           | Notes                                                                                                                                                                                                    |
| --------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code quality / architecture | Ready           | Provider registry, extracted modules, consistent conventions, zero TODO/FIXME in tracked source                                                                                                          |
| Tests / CI                  | Ready           | 1123 unit + 60 integration, 0 failures, with lint + format-check + agnostic-check gated. Node 20/22/24, `contents: read`, concurrency + timeouts                                                         |
| Secrets                     | Clean           | No secret in the working tree or anywhere in history. Every `token`/`privateKey`/`secret` hit is the pairing feature or a test fixture. Commits are authored with the coop address, never a personal one |
| Dependencies                | Clean           | `npm audit` → 0 vulnerabilities (was 4: 3 moderate, 1 critical)                                                                                                                                          |
| Security model              | Documented      | Per-device ECDSA P-256 pairing, host-only approval, fingerprint pinning, loopback-only host routes, guarded recursive deletes. Two accepted risks written down in `SECURITY.md`                          |
| Identity                    | Clean           | No personal paths, no personal profile URLs, no old org slug left in the tree. `CODEOWNERS` intentionally keeps the maintainer as owner                                                                  |
| Docs (public-facing)        | Ready           | README carries a status line and a security model section; requirements completed                                                                                                                        |
| Docs (internal `docs/`)     | Kept on purpose | The 15 existing files all stay — they are the project's history — and this report is the 16th. Only personal data was removed; nothing deleted                                                           |
| Community files             | Ready           | `SECURITY.md` added. PR + issue templates, CONTRIBUTING, CHANGELOG, CODEOWNERS, editorconfig, gitattributes already present                                                                              |
| Repo size / history         | Lean            | 143 tracked files, ~16 MB `.git`, no binary blobs, largest file 88 KB, `node_modules` ignored                                                                                                            |

## What was fixed before going public

### Identity

Every personal reference in the tree was removed: absolute author home-directory paths in `docs/PLAN - file upload support.md` (two lines) and in `CLAUDE.md` (now a generic placeholder), and the personal profile URLs plus the stale personal repo slug across `docs/PLAN - caveman spirit.md` and the two open-readiness docs (now either the current org slug or phrased as "the previous personal account", so the historical sentences still read correctly).

`CODEOWNERS` keeps the maintainer as the owner — intentional, and correct: the maintainer remains the owner alongside the coop.

### Dependencies

`npm audit` is clean. `npm audit fix` bumped `express` 4.22.2 → 4.22.3, `qs` 6.15.3 → 6.16.0, `proxy-addr` 2.0.7 → 2.0.8, `body-parser` → 1.20.8, which clears the `proxy-addr` critical (IP spoofing) and the two `qs` DoS advisories. Note the critical was never reachable in this codebase — it only affects trust decisions when Express's `trust proxy` is enabled, and AirPrompt never enables it, so `req.ip` is the socket address — but a public repo should not show a red Security tab.

### Third-party attribution

The installer files (`install.sh`, `install.ps1`, `bin/install.js`, `bin/lib/settings.js`) take caveman's installer approach, and the four files say so in their own headers. That in-file notice is the attribution, and it stays; no extra third-party document was added.

Worth recording for the future: this was checked against caveman itself. The files derive from caveman's pre-3.0.0 line, when everything outside its engine directories was MIT (`install.sh`, `install.ps1`, `bin/install.js` and `bin/lib/settings.js` were all in that MIT set — caveman only moved to Apache-2.0 on 2026-09-30, and 3.x relocated the Node installer to `installer/install.js`, a path the derived code does not reference). So the applicable notice is MIT, and it lives in the file headers. If AirPrompt's installer is ever re-derived from a 3.x caveman, that changes to Apache-2.0 and would need the Apache attribution.

### Security

Three items landed; two were deliberately deferred and are documented in `SECURITY.md` instead.

Landed:

- **JSON error handler** (`server.js`) — Express's default handler answers a malformed request with an HTML stack trace containing absolute `node_modules` paths; a malformed body to `/api/pair` was enough to trigger it. Now every thrown error returns JSON: client errors keep their status but never their message, an oversized body is reported as `Payload too large` (the same wording the upload route already used), 5xx stay generic, and the detail goes to the host log only. An unmatched route still gets Express's plain HTML 404 — no stack and no data, so nothing leaks, but the error surface is not uniformly JSON.
- **Security headers** (`server.js`) — `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `X-Powered-By` disabled. `script-src` is strict (`'self'`, no inline scripts — the XSS-relevant half). `style-src` keeps `'unsafe-inline'`: the vendored xterm DOM renderer builds its `.xterm-rows` rules by injecting `<style>` elements and sets true-color cells through the style attribute, so a bare `'self'` there renders the terminal unstyled. The `public/dictation.js` sheet that used to duplicate `styles.css` rules was removed anyway (dead code), and a unit test pins the `style-src` value so a future tightening cannot silently break the terminal. HSTS is deliberately **not** sent: with a self-signed certificate and an optional plain-HTTP fallback, pinning HTTPS for a year could lock a browser out of its own daemon.
- **Log permissions** — the daemon log is created under `umask 077` (`bin/airprompt-on.sh`, `bin/airprompt-restart.sh`, `Makefile`, `package.json`), so it is `0600` instead of world-readable. It can contain session working directories, tmux names and absolute upload paths when `AIRPROMPT_DEBUG=1`.

Deferred, and documented as accepted risk in `SECURITY.md`:

- **Loopback routes trust the source address.** The host-only REST routes accept anything arriving from `127.0.0.1`, which is what lets the hooks call them without a token. On a network shared with an attacker, a page in the victim's browser could use DNS rebinding to reach them and kill/unregister/register sessions or spoof notifications — but not type into the terminal, which still requires the pairing handshake. The fix is a `Host`-header allowlist (plus an env var for unusual hostnames); it is planned, and the assumption is written down.
- **`AIRPROMPT_NO_TLS=1` is cleartext.** With TLS off, the terminal stream and the upload token cross the LAN unencrypted, and pairing cannot work in that mode at all. Both the README and `SECURITY.md` now say this plainly rather than implying the fallback is equivalent.

### Shipped bugs

- **Duplication removed while touching the launchers:** the daemon launch command (env assignments + the log redirect) is now built once in `bin/lib/protocol.sh` as `daemon_cmd()`, instead of the identical string being written out four times across `bin/airprompt-on.sh` and `bin/airprompt-restart.sh`. New behaviour is pinned by unit tests: the security headers (including the `style-src` value the terminal depends on), the JSON error surface for malformed input, and the `413 → Payload too large` mapping.

- `install.sh` and `install.ps1` guarded Node with `< 18` while the message, `engines.node` and the README all said ≥ 20 — Node 18/19 slipped past the shim and only failed deeper inside `bin/install.js`. Both now check 20.
- `release-assets.yml` interpolated the release tag directly into `run:`. The tag now reaches the shell through `env:`.
- `test.yml` gained `permissions: contents: read`, a `concurrency` group and `timeout-minutes`; the release workflow gets `cancel-in-progress: false` (a cancelled release run can leave a release with only one of its two install assets, and every `workflow_dispatch` run shares the `refs/heads/main` group). Actions stay on their major version tags (`@v4`).
- `package.json` carried a vestigial `files` array implying npm publication. It now declares `repository`, `homepage`, `bugs` and `private: true` instead — `private` is an npm publish guard (unrelated to the GitHub repo's visibility); note the name `airprompt` is already taken on npm, so publishing would need a scope.

### Docs

`SECURITY.md` is new: reporting route (GitHub private vulnerability reporting, with an email fallback), what running the daemon actually means, the threat model and mitigations, the accepted risks, and an operator hardening checklist. The README gained a status line, a security model section, `git` and `make` in requirements, and a fixed Commands table row whose unescaped `|` had been splitting the table into wrong columns.

The internal `docs/` set is kept in full, deliberately: the plans and audits are the project's history, and they stay. Only personal data inside them was removed.

## Still open

- **GitHub UI settings** — description, topics, homepage, social preview, branch protection, private vulnerability reporting, Dependabot alerts. Handled outside the repo.
- **CI platform coverage.** CI is Linux-only, while the project claims macOS and WSL and ships `install.ps1`. Publishing first is a reasonable way to get the reports that make this worth doing.
- **Optional later hardening:** per-device upload quota, a registered-session cap, IPv6-aware rate-limit keying, shorter certificate validity.

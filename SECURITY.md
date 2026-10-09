# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

- Preferred: use GitHub's private vulnerability reporting — **Security** tab → **Report a vulnerability**. This opens a private thread visible only to the maintainers.
- Fallback: email **info@farox.coop**.

Useful in a report: the affected version or commit, your environment (OS, browser, how the daemon was started), the steps you took, what you expected versus what happened, and the impact you believe it has. A proof of concept helps a lot; if you have one, include it.

This is a small project without a paid security team, so there is no response-time guarantee — but reports are taken seriously and acknowledged. If you want credit in the fix's release notes, say so; if you prefer to stay anonymous, that is fine too.

**Supported versions:** the latest release tag and `main`. Older tags do not receive backports.

## What AirPrompt is, and what running it means

AirPrompt's daemon is a remote terminal. A device that is paired **and** approved on the host gets an interactive, tmux-backed shell **as the OS user running the daemon** — it can type into your IDE session, read what is on screen, spawn sessions, and upload images into the session's working context.

The design assumptions, stated plainly:

- **Single user.** There are no user accounts and no roles. One device keypair = one device.
- **Trusted local network.** The threat model is a shared home or office LAN, not the open internet.
- **Self-hosted.** You run the daemon on your own machine, and you are the one who approves devices.

**Do not expose the daemon to the internet.** There is no supported story for it: no reverse-proxy authentication, no hardening against internet-scale scanning, and a self-signed certificate. If you need remote access from outside your network, put it behind a VPN.

## Threat model — what is covered

| Attack                                              | Mitigation                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rogue device on the LAN connects and gets a shell   | Every WebSocket must complete a device handshake. Unauthenticated sockets are terminated after 5 s and may send only `hello`/`auth`; nothing else is accepted, and no session data is broadcast to them.                                                                                                                                                                                  |
| A device approving itself                           | A pairing request only _adds_ an entry to the pending list. Approval happens on the host, outside the API (`airprompt auth list` → `airprompt auth allow <seq>`) — there is no approval route for a browser to call, and an already-paired browser only shows a notice prompting that command. The requesting device therefore cannot approve itself.                                     |
| Sniffing the QR code or its URL                     | The QR carries only the server's public-key fingerprint. There is no shared secret to steal.                                                                                                                                                                                                                                                                                              |
| A malicious page impersonating the daemon (MITM)    | The browser pins the server's key fingerprint from the QR and verifies the server's signature over both nonces on every connect. A mismatch stops the connection with an "identity changed" overlay instead of proceeding.                                                                                                                                                                |
| A paired device being stolen or lost                | Revoke it (`airprompt auth list` → `airprompt auth revoke <seq>`); live sockets from that device are closed and its in-flight upload tokens are dropped.                                                                                                                                                                                                                                  |
| Cross-site WebSocket hijacking                      | The WS upgrade requires the `Origin` host to match the `Host` header.                                                                                                                                                                                                                                                                                                                     |
| Abusing the host-only REST API from another machine | `/api/sessions*`, `/api/notify` require a loopback source address. The only LAN-reachable REST surfaces are `/api/pair` (adds a pending request), `/api/pair/:id` (status of an unguessable id), and `/api/upload`.                                                                                                                                                                       |
| Upload abuse                                        | `/api/upload` requires a single-use, device-bound token minted over the authenticated WebSocket. Images only (PNG/JPEG/WebP/GIF), size-capped, stored under a unique name (timestamp plus a random component) with an exclusive-create flag into `0700` directories as `0600` files, with the filename sanitized and the extension taken from a MIME whitelist — never from client input. |
| Flooding / resource exhaustion                      | Pairing is limited to 5 requests/min/IP with 8 pending globally and 2 per IP (each expiring after 1 min); uploads to 30/min/IP; WebSockets to 32 concurrent with 8 per IP; frames to 1 MiB; 5 s to authenticate.                                                                                                                                                                          |
| Destructive operations                              | Recursive deletes are confined to airprompt-owned roots whose path contains `airprompt`. Force-killing a session only ever touches `airprompt-*` tmux sessions — never a real IDE session.                                                                                                                                                                                                |
| Command injection from request data                 | Every process spawn uses an argv array; no request data is ever interpolated into a shell string.                                                                                                                                                                                                                                                                                         |

Additional hardening in the current tree: a Content-Security-Policy with a strict `script-src 'self'` (no inline scripts) — `style-src` has to keep `'unsafe-inline'` because the vendored xterm terminal renderer builds its rules as injected `<style>` elements — plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, no `X-Powered-By`, JSON error responses that never include stack traces, and a daemon log created with mode `0600`.

## Known limitations and accepted risk

These are known, deliberate, and not currently mitigated. They are listed here so you can judge whether AirPrompt fits your environment.

1. **Loopback routes trust the source address.** The host-only REST routes (`/api/sessions*`, `/api/notify`) accept anything that arrives from `127.0.0.1`, and the OS/browser sandbox is what makes that meaningful. On a network shared with an attacker, a page opened in _your_ browser could use DNS rebinding to reach those routes and kill/unregister sessions, register new ones, or spoof notifications. It cannot type into your terminal — that needs the pairing handshake. The assumption is a network you trust; a Host-header allowlist is the planned fix.
2. **`AIRPROMPT_NO_TLS=1` is cleartext.** With TLS disabled (or when certificate generation fails and the daemon falls back to HTTP), the terminal stream and the upload token cross the LAN unencrypted. Pairing cannot work in that mode at all — browser WebCrypto requires a secure context — so this mode is only sensible for CLI-only use on a trusted network.
3. **Self-signed certificate, trust on first use.** The browser shows a certificate warning that must be accepted once. Trust then rests on the pinned fingerprint, so scanning the QR from the real host screen matters.
4. **No HSTS**, deliberately: with a self-signed certificate and an optional plain-HTTP fallback, pinning HTTPS for a year could lock a browser out of its own daemon.
5. **No per-device upload quota.** A paired device can upload up to the size and rate limits; there is no cumulative byte budget.
6. **Daemon logs from older installs may be world-readable.** Log files are created `0600` from this version on, but a file created by an earlier version keeps its old permissions until it is removed.
7. **No third-party security audit** has been performed on this codebase.
8. **The local privilege boundary is unchanged.** Anything that can already run as your user, or read your user's files, has everything the daemon offers.

## Hardening checklist for operators

- Keep the daemon on a trusted network; never port-forward it.
- Use TLS (the default) — never `AIRPROMPT_NO_TLS=1` for phone use.
- Review paired devices occasionally (`airprompt auth list`) and revoke what you no longer use.
- Run the daemon as your normal user, not as root, and not on a machine where you would not accept a remote shell.
- `airprompt clean` wipes all pairing state; every device must re-pair afterwards.
- Treat the mobile URL and its QR as sensitive while pairing is pending — approval requires your action on the host, but the QR is what tells a browser which key to trust.

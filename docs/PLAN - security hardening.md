# AirPrompt — Security Hardening Plan (Device Auth)

> Expands [PLAN - open readiness.md](<PLAN - open readiness.md>) Stage 1.1 "Security hardening".

## Goal

Replace the unauthenticated WebSocket terminal with SSH-style device pairing: each device holds a keypair, the host whitelists authorized devices, and every connect is a silent mutual challenge-response. No password, no secret in the QR, per-device revocation.

## Locked decisions

- **Option C** (device pairing) — not token-in-URL (B) or password (A).
- **Client curve:** ECDSA P-256 (universal WebCrypto support; Ed25519 not in older Safari).
- **Mutual** challenge-response — both keypairs prove possession on every connect.
- **Host approval via filesystem** — `airprompt auth` writes `devices.json`/`pending.json` directly. Never through unauthenticated REST (a rogue device could otherwise approve itself).
- **Command surface under `auth`:** `list` (alias `devices`), `allow`, `deny`, `revoke`. No `accept` — not even as an alias.
- **Stable ordinals:** a monotonic `seq` assigned at creation, ordered `createdAt ASC`, never reused — so `list`/`allow` never shift.
- **`/api/pair` is the only LAN-reachable REST endpoint**, request-only, rate-limited.
- **`clean` wipes all auth state**; `restart`/`autostart` unaffected.
- **ECDH session-key encryption for `NO_TLS` mode:** out of scope. `NO_TLS` users get authenticated-but-not-encrypted, documented as a caveat.
- **Friendly "server identity changed" overlay** in the web UI.

## Threat model

Covers:
- Rogue LAN device gets a terminal → blocked (needs a whitelisted keypair).
- QR/token sniping → QR carries only a fingerprint, no secret.
- MITM page impersonating the daemon → client pins + verifies the server key each connect.
- Per-device revocation → drop one phone without touching others.

Does NOT cover (documented, out of scope):
- REST hooks endpoints (`/api/sessions/register|kill|notify|name`, …) are host-internal; they are now **restricted to loopback** (a middleware rejects non-loopback requests, exempting only `/api/pair`). No shared secret needed since the hooks already call `localhost`.
- `NO_TLS` mode: browser pairing **requires TLS** — WebCrypto `crypto.subtle` is secure-context-only (HTTPS or `localhost`), so a phone reaching `http://<LAN-IP>:3210` cannot generate/sign keys at all. `NO_TLS` is effectively CLI-only now.
- Device auth ≠ user accounts (one keypair = one device).

## Architecture

### Keys

| Holder | Key | Storage |
|---|---|---|
| Daemon | ECDSA P-256 server keypair | `state/server-key.json` (0600), generated on first start |
| Device | ECDSA P-256 device keypair | browser IndexedDB, `extractable: false` |

Fingerprint = SHA-256 of the public key (SPKI), formatted `aa:bb:…` (first 16 bytes shown).

### State files (`~/.airprompt/state/`)

`server-key.json`

```json
{ "algorithm": "ECDSA", "curve": "P-256",
  "publicKey": "<base64 SPKI>", "privateKey": "<base64 PKCS8>", "createdAt": "…" }
```

`devices.json` (the whitelist)

```json
{ "devices": [
  { "seq": 1, "id": "<uuid>", "publicKey": "<base64 SPKI>", "name": "iPhone",
    "fingerprint": "aa:bb:…", "createdAt": "…", "lastSeen": "…" } ] }
```

`pending.json` (pairing requests awaiting approval)

```json
{ "pending": [
  { "seq": 3, "id": "<uuid>", "publicKey": "<base64 SPKI>", "name": "iPhone",
    "fingerprint": "aa:bb:…", "createdAt": "…", "expiresAt": "…" } ] }
```

### `seq` (stable ordinal)

One monotonic counter shared by `devices` and `pending`. Assigned at creation, never reused: `nextSeq = max(existing seq) + 1`. `auth list` sorts each section `createdAt ASC` (which equals `seq ASC`). `allow|deny|revoke <seq>` resolve by `seq`, so removals never renumber other entries.

### Pairing flow (one-time per device)

```
phone                        daemon                              host
  │ generate keypair          │                                   │
  │ POST /api/pair            │                                   │
  │   {publicKey, name}       │                                   │
  │                           │  rate-limit check                 │
  │                           │  pubkey already in devices.json?  │
  │                           │    → 200 {status:"paired"}        │
  │                           │  else append pending (seq N)      │
  │                           │  fire desktop notification        │
  │                           │  (banner → already-paired devices)│
  │◄── 202 {status:"pending", │                                   │
  │        seq, requestId}    │                                   │
  │  poll GET /api/pair/:id   │              airprompt auth allow N│
  │                           │  (CLI moves pending→devices       │
  │                           │   directly on the filesystem)     │
  │◄── 200 {status:"allowed"} │                                   │
  │  store "paired" + pin     │                                   │
  │  server fingerprint       │                                   │
```

The phone drives retry: `POST /api/pair` → `pending` → poll `GET /api/pair/:requestId` (or just retry the WS handshake) → `allowed`. The WS handshake is the real gate; the status endpoint returns `pending`/`allowed`/`closed` (denied and expired both collapse to `closed`).

### Auth flow (every WS connect after pairing)

Mutual challenge-response:

```
phone                                    daemon
  │ WS connect                            │
  │ → {type:"hello", publicKey, nonce}    │
  │                                       │  pubkey in devices.json?
  │                                       │    no → {type:"auth_error",
  │                                       │           reason:"unauthorized"} + close
  │                                       │  sign(serverNonce + clientNonce)
  │◄─ {type:"challenge", serverPublicKey, │
  │     serverNonce, serverSignature}     │
  │  verify serverSignature vs pinned     │
  │    mismatch → "identity changed"      │
  │  sign(serverNonce) with device key    │
  │ → {type:"auth", signature}            │
  │                                       │  verify → {type:"auth_ok"} (or close)
```

Only after `auth_ok` does the daemon send `session_list` / allow `switch_session` / spawn a PTY. The `nonce` is random per-connect, so a captured signature cannot replay.

## Host approval — three layers

The daemon has no TTY (`nohup … > /tmp/airprompt.log`). Approval rides existing channels, all local/trusted:

1. **Desktop notification** (primary popup) — `notify-send` invoked inline from the daemon (no separate `notify.sh`). Body: `New device "iPhone" (seq 3) wants to pair — airprompt auth allow 3`. Where the DE supports action buttons, add `Allow`/`Deny` that invoke the CLI; where not, the command is in the body.
2. **CLI** (universal, always works) — `airprompt auth list` → `airprompt auth allow <seq>`.
3. **Browser banner** (only for **already-authenticated** browsers, for approving *additional* devices) — pushed over the WS to paired sessions only. **Never** pushed to unauthenticated sockets, or a rogue device's own browser could approve itself. First device is always approved via (1) or (2).

The approval *always* executes as a local filesystem write (the CLI, or the daemon acting on a paired browser's instruction). Granting never flows through the unauthenticated `/api/pair` surface.

## Anti-flood (`/api/pair`)

- Per-IP rate limit: max 5 `/api/pair` per 60s → 429.
- Pending list cap: 8 entries. At cap → 429 with a "approve or deny existing requests" hint (no silent eviction).
- Duplicate `publicKey` → refresh the existing pending entry's `createdAt`/`expiresAt` (no new `seq`).
- Pending TTL: **1 minute** (`PENDING_TTL_MS = 60_000`, defined in `src/auth.js`); expired entries auto-rejected and removed on read/write, so the pending list self-cleans if the host user never acts on a request.

## Command surface

```
airprompt auth list          # alias: devices — PAIRED + PENDING, seq ASC, no shift
airprompt auth allow <seq>   # pending  → devices.json
airprompt auth deny   <seq>  # drop pending entry
airprompt auth revoke <seq>  # drop a paired device
```

`list` prints two sections (PAIRED: `seq name fingerprint lastSeen`; PENDING: `seq name fingerprint created`). `allow|deny|revoke` read/write `devices.json`/`pending.json` directly — no REST, no daemon round-trip, no self-approval hole.

## Lifecycle interaction

- **`clean`** — wipes `server-key.json`, `devices.json`, `pending.json` (full auth reset). Next start regenerates the keypair; every device re-pairs.
- **`restart`** — unaffected. Keypair + whitelist live in `state/`, survive restart (like session recovery).
- **`autostart`** — unaffected. Controls *when* the daemon starts, not auth.
- **`help`** + `commands/airprompt.md` + README + docs — new `auth` subcommands documented.

## Identity-changed UX

When a paired client verifies the server signature and it does not match the pinned fingerprint, show a full-screen overlay (not a raw 401, not a terminal line), before any PTY spawns:

> **Server identity changed.** The daemon at `192.168.0.10` is presenting a different key than when you first paired. If you reinstalled or rotated the server key, re-pair this device. Otherwise someone may be impersonating the daemon — do not continue.
>
> [Re-pair] [Disconnect]

This is the SSH `REMOTE HOST IDENTIFICATION HAS CHANGED` equivalent: hard block, user decides.

## File map

| File | Change |
|---|---|
| `src/auth.js` | new — keygen/load, fingerprint, challenge nonce, sign/verify, devices/pending read-write, `seq`, TTL/eviction, rate-limit helper |
| `server.js` | wire `/api/pair` + status endpoint; WS `hello`/`challenge`/`auth` handshake; reject before PTY; QR carries server fingerprint |
| `public/auth.js` | new — WebCrypto keygen/sign, IndexedDB storage, handshake, pairing UI, identity overlay |
| `public/client.js` | gate terminal init behind auth; hook `auth.js` |
| `public/index.html` | script tag + pairing/identity overlay DOM |
| `public/styles.css` | overlay styles |
| `bin/airprompt` | dispatch `auth` subcommand |
| `bin/airprompt-auth.sh` | new — `list|allow|deny|revoke` (filesystem ops) |
| `bin/airprompt-clean.sh` | wipe auth state |
| `server.js` | pairing-request notification (`notify-send` inline) |
| `commands/airprompt.md`, `README.md`, `docs/*` | help + docs |

## Stages (atomic commits)

Each stage is one commit.

### Stage 1 — Server auth + host CLI

- **Commit:** `feat(auth): device pairing engine, WS challenge-response, host approval CLI`
- **Scope:** `src/auth.js`, `server.js`, `bin/airprompt`, `bin/airprompt-auth.sh`, `bin/airprompt-clean.sh`, `bin/lib/protocol.sh`, tests.
- **What lands:** server keypair gen/load; `devices.json`/`pending.json`; `/api/pair` (rate-limited, request-only) + status endpoint; WS `hello`/`challenge`/`auth` mutual handshake (reject before PTY); QR carries fingerprint; `airprompt auth list|allow|deny|revoke` (filesystem, stable `seq`); pairing desktop notification; `clean` wipes auth state.
- **Acceptance:** unauthenticated WS → closed with `auth_error`; `/api/pair` rate-limited + capped + deduped; `allow 2` moves the entry by `seq` with no shift; `revoke` drops a device; `make test-all` green.

### Stage 2 — Browser client

- **Commit:** `feat(auth): browser pairing, handshake, identity overlay`
- **Scope:** `public/auth.js`, `public/client.js`, `public/index.html`, `public/styles.css`, tests.
- **What lands:** WebCrypto ECDSA P-256 keygen (non-extractable) + sign; IndexedDB persistence; pairing flow (generate → POST → poll → "waiting/denied/expired" UI); WS handshake integration; server-fingerprint pinning; identity-changed overlay.
- **Acceptance:** a fresh phone scans the QR, shows "waiting for approval", host runs `airprompt auth allow N`, phone pairs and gets the terminal; a subsequent reload reconnects silently (no re-pair); a tampered server key shows the identity overlay.

### Stage 3 — Docs + help

- **Commit:** `docs(auth): help, command reference, README, plan sync`
- **Scope:** `bin/airprompt` help text, `commands/airprompt.md`, `README.md`, docs cross-links.
- **What lands:** `airprompt auth` subcommands in help; command reference; README pairing section; `NO_TLS` unencrypted caveat; cross-link to this plan.

## Acceptance checklist

- [x] 1.1 Server auth + host CLI (WS handshake, `/api/pair` rate-limited, `auth` CLI, clean)
- [x] 1.2 Browser client (pairing, handshake, identity overlay)
- [x] 1.3 Docs + help

## Proposed PR description

### Summary

- add SSH-style device pairing: per-device ECDSA P-256 keypairs, host whitelist, mutual challenge-response on every WS connect
- host approval via local `airprompt auth allow/deny/revoke` (filesystem, stable ordinals) + desktop notification + paired-browser banner
- `/api/pair` is the only LAN-reachable REST endpoint — request-only, rate-limited, capped, deduped
- friendly "server identity changed" overlay; `clean` resets all auth state

### Tasks

- [x] server auth engine + WS handshake + `/api/pair` + QR fingerprint
- [x] host CLI `auth list|allow|deny|revoke` + notification + clean
- [x] browser keygen/sign/IndexedDB + pairing UI + handshake + identity overlay
- [x] help + command reference + README + docs

### Notes / Out of Scope

- REST hooks endpoints restricted to loopback (implemented) — `/api/pair` is the only LAN surface
- `NO_TLS` mode: browser pairing requires TLS (WebCrypto secure-context) — effectively CLI-only
- no user accounts — device-level auth only

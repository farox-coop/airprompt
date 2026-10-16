---
description: Send realistic simulated Claude notifications. Auto-detects notify.sh for full pipeline (sound+desktop+WS) or falls back to direct API post (WS only).
---

# notification-test

Send simulated Claude notifications with realistic data. If `$CLAUDE_CONFIG_DIR/hooks/notify.sh` is executable, pipes through it — sound, desktop notification, and AirPrompt WS broadcast. Otherwise, POSTs directly to the AirPrompt daemon `/api/notify` endpoint (WS-only delivery).

## Execution

```bash
bash .claude/skills/notification-test/send.sh [options]
```

## Options (all optional)

| Flag                | Default               | Description                                                                                                                          |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--type`            | `idle_prompt`         | `idle_prompt`, `permission_prompt`, `agent_needs_input`, `agent_completed`                                                           |
| `--message`         | auto                  | Custom notification message text                                                                                                     |
| `--session-id`      | first from API        | AirPrompt session ID to attribute to                                                                                                 |
| `--cwd`             | resolved from session | Working directory (shown in webUI label fallback)                                                                                    |
| `--ai-title`        | auto timestamp        | Simulated Claude transcript `aiTitle`                                                                                                |
| `--duration-ms`     | random 500-5000       | Simulated turn duration in ms                                                                                                        |
| `--tokens`          | random 10k-200k       | Simulated session context size in tokens (a positive integer — `0`, `007`, non-numeric is rejected, since the badge is read from it) |
| `--permission-mode` | `default`             | `acceptEdits`, `bypassPermissions`, `default`, `plan`                                                                                |
| `--effort`          | `medium`              | `low`, `medium`, `high`, `xhigh`, `max`                                                                                              |
| `--count`           | `1`                   | Send N notifications                                                                                                                 |
| `--delay`           | `100`                 | Delay in ms between notifications (count > 1)                                                                                        |
| `--auto-dismiss`    | `0`                   | Set `1` for auto-dismiss after 6s, `0` for manual swipe (sent as a real boolean — the server compares `=== true`)                    |
| `--dry-run`         | off                   | Print JSON payload without sending                                                                                                   |
| `--help`            |                       | Show usage                                                                                                                           |

## What it simulates

Creates a temp transcript file with fake `ai-title`, `turn_duration` and assistant-usage events so `notify.sh` extracts:

- **Session label:** `[AirPromptName]` — resolved from `/api/sessions` by session-id
- **Subtitle:** `(project @ aiTitle)` — cwd basename + simulated aiTitle
- **Turn info:** `duration — 115k` — turn duration plus the session's current context tokens, read from the simulated usage record by `src/hooks/airprompt-session-tokens.js` (the same provider-agnostic reader the real hook uses; on the direct path the same helper formats the `--tokens` value instead, since no transcript is read)
- **Mode/effort:** shown in meta line — from `--permission-mode` and `--effort`

## Examples

```bash
# Basic: idle notification on first session
bash .claude/skills/notification-test/send.sh

# Permission prompt targeting specific session by name
bash .claude/skills/notification-test/send.sh \
  --type permission_prompt \
  --session-id claude-32142-1785341055 \
  --message "Approve: rm -rf /tmp/build"

# Agent completed with auto-dismiss
bash .claude/skills/notification-test/send.sh \
  --type agent_completed \
  --auto-dismiss 1 \
  --effort max

# Dry-run: see what JSON would be sent
bash .claude/skills/notification-test/send.sh --dry-run

# Burst: 3 notifications, 500ms apart
bash .claude/skills/notification-test/send.sh --count 3 --delay 500
```

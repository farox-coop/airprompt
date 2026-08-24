---
description: Send realistic simulated Claude notifications. Auto-detects notify.sh for full pipeline (sound+desktop+WS) or falls back to direct API post (WS only).
---

# notification-test

Send simulated Claude notifications with realistic data. If `~/.claude/hooks/notify.sh` exists, pipes through it — sound, desktop notification, and AirPrompt WS broadcast. Otherwise, POSTs directly to the AirPrompt daemon `/api/notify` endpoint (WS-only delivery).

## Execution

```bash
bash .claude/skills/notification-test/send.sh [options]
```

## Options (all optional)

| Flag                | Default               | Description                                                                |
| ------------------- | --------------------- | -------------------------------------------------------------------------- |
| `--type`            | `idle_prompt`         | `idle_prompt`, `permission_prompt`, `agent_needs_input`, `agent_completed` |
| `--message`         | auto                  | Custom notification message text                                           |
| `--session-id`      | first from API        | AirPrompt session ID to attribute to                                       |
| `--cwd`             | resolved from session | Working directory (shown in webUI label fallback)                          |
| `--ai-title`        | auto timestamp        | Simulated Claude transcript `aiTitle`                                      |
| `--duration-ms`     | random 500-5000       | Simulated turn duration in ms                                              |
| `--message-count`   | random 1-20           | Simulated turn message count                                               |
| `--permission-mode` | `default`             | `acceptEdits`, `bypassPermissions`, `default`, `plan`                      |
| `--effort`          | `medium`              | `low`, `medium`, `high`, `xhigh`, `max`                                    |
| `--count`           | `1`                   | Send N notifications                                                       |
| `--delay`           | `100`                 | Delay in ms between notifications (count > 1)                              |
| `--auto-dismiss`    | `0`                   | Set `1` for auto-dismiss after 6s, `0` for manual swipe                    |
| `--dry-run`         | off                   | Print JSON payload without sending                                         |
| `--help`            |                       | Show usage                                                                 |

## What it simulates

Creates a temp transcript file with fake `ai-title` and `turn_duration` events so `notify.sh` extracts:

- **Session label:** `[AirPromptName]` — resolved from `/api/sessions` by session-id
- **Subtitle:** `(project @ aiTitle)` — cwd basename + simulated aiTitle
- **Turn info:** `duration — N msgs` — from simulated turn_duration
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

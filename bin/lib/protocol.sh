#!/bin/bash
# protocol.sh — Shared protocol detection for AirPrompt shell scripts.
# Source this file, then use $AP_PROTO and $AP_CURL_OPTS.
#
# Usage:
#   source "$(dirname "$0")/lib/protocol.sh"
#   detect_protocol
#   curl "${AP_CURL_OPTS[@]}" "${AP_PROTO}://localhost:${AP_PORT}/..."
#
# State dir: ~/.airprompt/state/ (daemon.json, certs)

# Default port — callers may override before sourcing or after.
AP_PORT="${AIRPROMPT_PORT:-3210}"
AP_PROTO="http"
AP_CURL_OPTS=()

detect_protocol() {
  local state_dir="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
  local daemon_json="${state_dir}/daemon.json"
  local cert_file="${state_dir}/airprompt-cert.pem"
  local key_file="${state_dir}/airprompt-key.pem"

  # daemon.json is SSOT for running daemon's protocol. Cert files are fallback.
  # NO_TLS overrides everything — skip daemon.json when set.
  if [ "${AIRPROMPT_NO_TLS:-}" = "1" ]; then
    AP_PROTO="http"
    AP_PORT="${AIRPROMPT_PORT:-3210}"
  elif [ -f "$daemon_json" ]; then
    AP_PROTO=$(jq -r '.protocol // "http"' "$daemon_json" 2>/dev/null || echo "http")
    local jq_port
    jq_port=$(jq -r '.port // ""' "$daemon_json" 2>/dev/null || echo "")
    AP_PORT="${jq_port:-${AIRPROMPT_PORT:-3210}}"
  elif [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    AP_PROTO="https"
  fi
  [ "$AP_PROTO" = "https" ] && AP_CURL_OPTS=(-k) || true
}

# ── Daemon environment forwarding ─────────────────────────────────────
# Tmux does NOT inherit client env by default. Use this to build the
# env prefix string passed to `tmux new-session` / `tmux respawn-pane`.
# Caller must have DEBUG set.
daemon_env() {
  # Build env assignments with values single-quoted so spaces in paths
  # survive the unquoted word-splitting in `tmux new-session` commands.
  # Output format: KEY='val' KEY2='val2' ...
  local parts=()
  parts+=("AIRPROMPT_DEBUG='${AIRPROMPT_DEBUG:-0}'")
  [ -n "${AIRPROMPT_STATE_DIR:-}" ]    && parts+=("AIRPROMPT_STATE_DIR='$AIRPROMPT_STATE_DIR'")
  [ -n "${AIRPROMPT_PORT:-}" ]         && parts+=("AIRPROMPT_PORT='$AIRPROMPT_PORT'")
  [ -n "${AIRPROMPT_PID_FILE:-}" ]     && parts+=("AIRPROMPT_PID_FILE='$AIRPROMPT_PID_FILE'")
  [ -n "${AIRPROMPT_SESSIONS_DIR:-}" ] && parts+=("AIRPROMPT_SESSIONS_DIR='$AIRPROMPT_SESSIONS_DIR'")
  [ -n "${AIRPROMPT_NO_TLS:-}" ]       && parts+=("AIRPROMPT_NO_TLS='$AIRPROMPT_NO_TLS'")
  # PORT removed — AIRPROMPT_PORT is the single source of truth
  printf '%s' "${parts[*]}"
}

# ── Ensure ~/bin/ binaries exist ────────────────────────────────────────
# Called by on.sh and autostart.sh after clean to restore symlinks + wrappers.
# Idempotent — only creates if missing.
_ensure_bin_symlinks() {
  local home_bin="${HOME}/bin"
  local repo_bin
  repo_bin="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)" || repo_bin="${AIRPROMPT_INSTALL_DIR:-$HOME/.airprompt}"
  local bin_dir="${repo_bin}/bin"
  local launch="${bin_dir}/airprompt-launch"
  local dispatcher="${bin_dir}/airprompt"

  mkdir -p "$home_bin"

  # airprompt dispatcher symlink
  if [ ! -e "$home_bin/airprompt" ]; then
    ln -s "$dispatcher" "$home_bin/airprompt" 2>/dev/null || true
    echo "  restored $home_bin/airprompt → $dispatcher"
  fi

  # airprompt-launch symlink
  if [ ! -e "$home_bin/airprompt-launch" ]; then
    ln -s "$launch" "$home_bin/airprompt-launch" 2>/dev/null || true
    echo "  restored $home_bin/airprompt-launch → $launch"
  fi

  # Provider wrappers
  for prov in claude codex cursor windsurf; do
    local wrapper="$home_bin/airprompt-$prov"
    if [ ! -e "$wrapper" ]; then
      cat > "$wrapper" << PROVIDEREOF
#!/bin/bash
exec airprompt-launch --provider $prov "\$@"
PROVIDEREOF
      chmod +x "$wrapper"
      echo "  restored $wrapper"
    fi
  done
}

# ── Safe rm -rf ─────────────────────────────────────────────────────────
# Canonicalize path then verify it lives under an AirPrompt-owned root before
# allowing rm -rf. Prevents disaster on misconfigured env vars and blocks the
# trivial `*airprompt*` substring bypass via `..` traversal.
#
# Roots: $HOME/.airprompt (default install/state/sessions), plus custom
# AIRPROMPT_INSTALL_DIR / AIRPROMPT_STATE_DIR / AIRPROMPT_SESSIONS_DIR when
# set — each must contain "airprompt" in its path (blocks /, /home, /tmp).
#
# Usage: _safe_rm_rf "/path/to/dir" && echo "ok"
# Returns 0 (safe, caller should rm -rf) or 1 (blocked, already printed).
_safe_rm_rf() {
  local path="$1"
  local canonical root

  # Resolve .. first, then canonicalize. `readlink -f` works on nonexistent
  # paths on GNU; on macOS readlink -f fails on nonexistent, so resolve
  # parent first then append basename.
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 1  # nothing to delete — safe to skip
  fi

  canonical="$(cd "$(dirname "$path")" 2>/dev/null && pwd -P 2>/dev/null)" || {
    echo "  SAFETY: cannot resolve parent of ${path} — refusing rm -rf" >&2
    return 1
  }
  canonical="${canonical%/}/$(basename "$path")"

  # Allowed roots, in priority order. Every root must be clearly
  # airprompt-owned ("airprompt" in the path) — blocks misconfigured
  # AIRPROMPT_*_DIR=/ , /home , /tmp from ever passing the guard.
  for root in \
    "$HOME/.airprompt" \
    "${AIRPROMPT_INSTALL_DIR:-}" \
    "${AIRPROMPT_STATE_DIR:-}" \
    "${AIRPROMPT_SESSIONS_DIR:-}"; do
    [ -n "$root" ] || continue
    case "$root" in *airprompt*) ;; *) continue ;; esac
    case "$canonical" in
      "$root"|"$root/"*) return 0 ;;
    esac
  done

  echo "  SAFETY: refusing to rm -rf ${path} (canonical: ${canonical})" >&2
  return 1
}

# ── Portable LAN IP detection ─────────────────────────────────────────
# Linux: `hostname -I` (filter out Docker 172./VPN 10. when possible).
# macOS: `ipconfig getifaddr` (en0 first). Falls back to localhost.
# Usage: LAN_IP="$(_lan_ip)"
_lan_ip() {
  local ip=""
  if command -v hostname &>/dev/null; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1 || true)
    [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  fi
  if [ -z "$ip" ] && command -v ipconfig &>/dev/null; then
    local iface
    for iface in en0 en1 en2; do
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
      [ -n "$ip" ] && break
    done
  fi
  [ -z "$ip" ] && ip="localhost"
  printf '%s' "$ip"
}

# ── PID identity guard ────────────────────────────────────────────────
# Verify a PID actually belongs to the AirPrompt daemon before killing it,
# so a reused PID (stale pidfile) is never killed. Portable: `ps -p -o
# command=` works on Linux and macOS — no /proc dependency.
# Usage: _is_airprompt_pid "$PID" && echo "is airprompt daemon"
_is_airprompt_pid() {
  local pid="${1:-}"
  local cmd
  [ -n "$pid" ] || return 1
  # COLUMNS=9999 stops GNU/BSD ps from truncating `command` to terminal width
  # (tmux exports a small COLUMNS in narrow panes), which would cut the trailing
  # "server.js" and false-negative a live daemon. /proc/cmdline was immune.
  cmd=$(COLUMNS=9999 ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *server\.js*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Web UI URL + QR ────────────────────────────────────────────────────
# _webui_info <proto> <port> <ip> → sets $AP_URL (with #fp=) and $AP_PAIRED (1|0)
# _print_qr <url>                 → prints the QR code for <url>
_webui_info() {
  local repo_dir out
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
  out=$(node "$repo_dir/bin/lib/url.js" info "$1" "$2" "$3" 2>/dev/null || true)
  AP_URL=$(printf '%s\n' "$out" | sed -n '1s/^URL=//p')
  AP_PAIRED=$(printf '%s\n' "$out" | sed -n '2s/^PAIRED=//p')
  [ -n "$AP_URL" ] || AP_URL="${1:-http}://${3:-localhost}:${2:-3210}"
  AP_PAIRED="${AP_PAIRED:-0}"
}

_print_qr() {
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
  node "$repo_dir/bin/lib/url.js" qr "$1" 2>/dev/null || true
}

# ── Portable md5 ───────────────────────────────────────────────────────
# GNU `md5sum` on Linux, BSD `md5 -q` on macOS. Prints the hex digest
# (or nothing on failure). Usage: digest="$(_md5 /path/to/file)"
_md5() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" 2>/dev/null | awk '{print $1}' || true
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$1" 2>/dev/null || true
  fi
  :  # always return 0 — print the digest, or nothing on failure
}

# ── Package install hint (cross-platform) ──────────────────────────────
# Prints the right "how to install" command for the current OS.
# Usage: _pkg_hint tmux  →  "sudo apt install tmux" (Linux) / "brew install tmux" (macOS)
_pkg_hint() {
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    echo "brew install $*"
  else
    echo "sudo apt install $*"
  fi
}

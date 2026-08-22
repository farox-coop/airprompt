#!/bin/bash
# protocol.sh — Shared protocol detection for AirPrompt shell scripts.
# Source this file, then use $AP_PROTO and $AP_CURL_OPTS.
#
# Usage:
#   source "$(dirname "$0")/lib/protocol.sh"
#   detect_protocol
#   curl $AP_CURL_OPTS "${AP_PROTO}://localhost:${AP_PORT}/..."
#
# State dir: ~/.airprompt/state/ (daemon.json, certs)

# Default port — callers may override before sourcing or after.
AP_PORT="${AIRPROMPT_PORT:-3210}"
AP_PROTO="http"
AP_CURL_OPTS=""

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
  [ "$AP_PROTO" = "https" ] && AP_CURL_OPTS="-k" || true
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

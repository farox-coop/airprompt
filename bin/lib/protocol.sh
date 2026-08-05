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
AP_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
AP_PROTO="http"
AP_CURL_OPTS=""

detect_protocol() {
  local state_dir="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
  local daemon_json="${state_dir}/daemon.json"
  local cert_file="${state_dir}/airprompt-cert.pem"
  local key_file="${state_dir}/airprompt-key.pem"

  # daemon.json is SSOT for running daemon's protocol. Cert files are fallback.
  if [ -f "$daemon_json" ] && command -v jq >/dev/null 2>&1; then
    AP_PROTO=$(jq -r '.protocol // "http"' "$daemon_json" 2>/dev/null || echo "http")
    AP_PORT=$(jq -r '.port // 3210' "$daemon_json" 2>/dev/null || echo "$AP_PORT")
  elif [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    AP_PROTO="https"
  fi
  [ "$AP_PROTO" = "https" ] && AP_CURL_OPTS="-k" || true
}

# ── Daemon environment forwarding ─────────────────────────────────────
# Tmux does NOT inherit client env by default. Use this to build the
# env prefix string passed to `tmux new-session` / `tmux respawn-pane`.
# Caller must have DEBUG set.
daemon_env() {
  local env_str="AIRPROMPT_DEBUG=${AIRPROMPT_DEBUG:-0}"
  [ -n "${AIRPROMPT_STATE_DIR:-}" ]    && env_str="$env_str AIRPROMPT_STATE_DIR=$AIRPROMPT_STATE_DIR"
  [ -n "${AIRPROMPT_PORT:-}" ]         && env_str="$env_str AIRPROMPT_PORT=$AIRPROMPT_PORT"
  [ -n "${AIRPROMPT_PID_FILE:-}" ]     && env_str="$env_str AIRPROMPT_PID_FILE=$AIRPROMPT_PID_FILE"
  [ -n "${AIRPROMPT_SESSIONS_DIR:-}" ] && env_str="$env_str AIRPROMPT_SESSIONS_DIR=$AIRPROMPT_SESSIONS_DIR"
  [ -n "${AIRPROMPT_NO_TLS:-}" ]       && env_str="$env_str AIRPROMPT_NO_TLS=$AIRPROMPT_NO_TLS"
  [ -n "${PORT:-}" ]                   && env_str="$env_str PORT=$PORT"
  printf '%s' "$env_str"
}

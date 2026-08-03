#!/bin/bash
# protocol.sh — Shared protocol detection for AirPrompt shell scripts.
# Source this file, then use $AP_PROTO and $AP_CURL_OPTS.
#
# Usage:
#   source "$(dirname "$0")/lib/protocol.sh"
#   detect_protocol
#   curl $AP_CURL_OPTS "${AP_PROTO}://localhost:${AP_PORT}/..."
#
# Priority: daemon.json SSOT → cert fallback → http (plaintext)

# Default port — callers may override before sourcing or after.
AP_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
AP_PROTO="http"
AP_CURL_OPTS=""

detect_protocol() {
  local config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local airprompt_conf="${config_dir}/.airprompt/daemon.json"

  if [ -f "$airprompt_conf" ] && command -v jq >/dev/null 2>&1; then
    AP_PROTO=$(jq -r '.protocol // "http"' "$airprompt_conf" 2>/dev/null || echo "http")
    AP_PORT=$(jq -r '.port // 3210' "$airprompt_conf" 2>/dev/null || echo "$AP_PORT")
  elif [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && \
       [ -f "${config_dir}/.airprompt/airprompt-cert.pem" ] && \
       [ -f "${config_dir}/.airprompt/airprompt-key.pem" ]; then
    AP_PROTO="https"
  fi
  [ "$AP_PROTO" = "https" ] && AP_CURL_OPTS="-k"
}

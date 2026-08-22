#!/bin/bash
# airprompt-auth.sh — Device pairing auth (list/allow/deny/revoke).
# Use: /airprompt auth list
#      /airprompt auth allow <seq>
#      /airprompt auth deny <seq>
#      /airprompt auth revoke <seq>
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: airprompt auth <list|allow|deny|revoke> [seq]"
  echo ""
  echo "  list (alias: devices)  List paired devices + pending pairing requests."
  echo "  allow <seq>            Approve a pending device (grants terminal access)."
  echo "  deny  <seq>            Reject a pending device."
  echo "  revoke <seq>           Remove a paired device's access."
  echo ""
  echo "  seq is the stable ordinal shown by 'auth list' — it never shifts."
  echo ""
  echo "This is an internal script. Use 'airprompt auth <command>' directly."
  exit 0
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/lib/auth-cli.js" "$@"

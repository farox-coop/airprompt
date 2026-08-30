#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/lib/protocol.sh"

CERT_DIR="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
CERT_FILE="${CERT_DIR}/airprompt-cert.pem"
KEY_FILE="${CERT_DIR}/airprompt-key.pem"

if ! command -v openssl &>/dev/null; then
  echo "Error: openssl is required but not installed." >&2
  echo "  $(_pkg_hint openssl)" >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

# Detect LAN IP for SAN (filter out Docker/VPN)
LAN_IP="$(_lan_ip)"

echo "Generating self-signed TLS certificate..."
echo "  IP:   $LAN_IP"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -days 3650 \
  -subj "/CN=airprompt/O=Farox" \
  -addext "subjectAltName=IP:${LAN_IP},IP:127.0.0.1,DNS:localhost" \
  2>/dev/null

chmod 600 "$KEY_FILE" 2>/dev/null || true
chmod 644 "$CERT_FILE" 2>/dev/null || true

echo "TLS certificate created."
echo "  cert: $CERT_FILE"
echo "  key:  $KEY_FILE"

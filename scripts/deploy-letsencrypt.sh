#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERTS_DIR="${POSTOFFICEX_CERTS_DIR:-${PROJECT_DIR}/data/certs}"

if [[ -z "${RENEWED_LINEAGE:-}" ]]; then
  echo "RENEWED_LINEAGE is not set. This hook must be run by certbot." >&2
  exit 1
fi

install -d -m 0755 "${CERTS_DIR}"
install -m 0644 "${RENEWED_LINEAGE}/fullchain.pem" "${CERTS_DIR}/server.crt"
install -m 0600 "${RENEWED_LINEAGE}/privkey.pem" "${CERTS_DIR}/server.key"

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet postofficex.service; then
  systemctl kill -s HUP postofficex.service
fi

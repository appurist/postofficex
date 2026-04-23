#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <domain> <email> [webroot]" >&2
  exit 1
fi

DOMAIN="$1"
EMAIL="$2"
WEBROOT="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_HOOK="${PROJECT_DIR}/scripts/deploy-letsencrypt.sh"

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot is not installed. Install certbot first and rerun this script." >&2
  exit 1
fi

if [[ ! -x "${DEPLOY_HOOK}" ]]; then
  echo "Deploy hook is missing or not executable: ${DEPLOY_HOOK}" >&2
  exit 1
fi

if [[ -n "${WEBROOT}" ]]; then
  certbot certonly \
    --webroot \
    -w "${WEBROOT}" \
    -d "${DOMAIN}" \
    -m "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    --deploy-hook "${DEPLOY_HOOK}"
else
  certbot certonly \
    --standalone \
    -d "${DOMAIN}" \
    -m "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    --deploy-hook "${DEPLOY_HOOK}"
fi

echo "Certificate installed into ${PROJECT_DIR}/data/certs."

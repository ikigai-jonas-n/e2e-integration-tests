#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env quietly
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -o allexport
  source "${SCRIPT_DIR}/.env"
  set +o allexport
fi

# AI-Friendly Argument Parsing
DOMAIN="${MAINTENANCE_API_DOMAIN:-localhost:8080}"
GAME_CODE="${MAINTENANCE_GAME_CODE:-LGS-006}"
JSON_OUT="false"

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift ;;
    --game-code) GAME_CODE="$2"; shift ;;
    --json-out) JSON_OUT="true" ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

if [[ "${DOMAIN}" != http://* && "${DOMAIN}" != https://* ]]; then
  DOMAIN="http://${DOMAIN}"
fi
BASE_URL="${DOMAIN%/}"
SIGNATURE="${API_SIGNATURE:-rgs-local-signature}"
CACHE_FILE="${SCRIPT_DIR}/.am-token-cache.json"

log() {
  if [[ "$JSON_OUT" == "false" ]]; then
    echo "$*"
  fi
}

die() {
  local code=$1
  local msg=$2
  if [[ "$JSON_OUT" == "true" ]]; then
    jq -n --arg error "$msg" --arg code "$code" '{status: "error", code: $code, message: $error}'
  else
    echo "ERROR: $msg"
  fi
  exit "$code"
}

require_env() {
  if [[ -z "${!1:-}" ]]; then
    die 1 "$1 is required."
  fi
}

# Dependency checks
if ! command -v jq >/dev/null 2>&1; then die 1 "jq is required."; fi

require_env "IS_MAINTENANCE"
require_env "AM_ACCOUNT"
require_env "AM_CODE"

http_post() { curl --silent --show-error --location --request POST "$1" "${@:2}" --write-out 'HTTPSTATUS:%{http_code}'; }
http_patch() { curl --silent --show-error --location --request PATCH "$1" "${@:2}" --write-out 'HTTPSTATUS:%{http_code}'; }
parse_body() { printf '%s' "$1" | sed 's/HTTPSTATUS:[0-9]\{3\}$//'; }
parse_status() { printf '%s' "$1" | sed -n 's/.*HTTPSTATUS:\([0-9]\{3\}\)$/\1/p'; }

# 1. Token Request
log "[1/2] Requesting AM token..."
PAYLOAD=$(jq -n --arg acc "${AM_ACCOUNT}" --arg code "${AM_CODE}" --arg key "${AM_ROUTE_KEY:-V1_INTERNAL_GAME_MAINTENANCE}" --argjson uid "${AM_USER_ID:-0}" '{userId: $uid, account: $acc, code: $code, permission: [{routeKey: $key, methods: ["*"]}]}')

RES=$(http_post "${BASE_URL}/v1/service/am/token" --header "x-signature: ${SIGNATURE}" --header "Content-Type: application/json" --data "${PAYLOAD}")
STATUS=$(parse_status "$RES")
BODY=$(parse_body "$RES")

if [[ "$STATUS" != "200" ]]; then die 2 "AM token failed with HTTP $STATUS. Body: $BODY"; fi
AM_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // empty')

# 2. Patch Maintenance
log "[2/2] Patching maintenance state to $IS_MAINTENANCE..."
PATCH_PAYLOAD=$(jq -n --argjson isM "${IS_MAINTENANCE}" '{isMaintenance: $isM}')
PATCH_RES=$(http_patch "${BASE_URL}/v1/internal/game/${GAME_CODE}/maintenance" --header "x-access-token: ${AM_TOKEN}" --header "Content-Type: application/json" --data "${PATCH_PAYLOAD}")
PATCH_STATUS=$(parse_status "$PATCH_RES")
PATCH_BODY=$(parse_body "$PATCH_RES")

if [[ "$PATCH_STATUS" != "200" ]]; then die 2 "Maintenance PATCH failed with HTTP $PATCH_STATUS. Body: $PATCH_BODY"; fi

# Final Output
if [[ "$JSON_OUT" == "true" ]]; then
  jq -n \
    --arg status "success" \
    --argjson tokenResp "$BODY" \
    --argjson patchResp "${PATCH_BODY:-"{}"}" \
    '{status: $status, token_response: $tokenResp, maintenance_response: $patchResp}'
else
  log "Done. Maintenance state updated successfully."
fi
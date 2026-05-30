#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables from the script directory .env if present.
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +o allexport
fi

DEFAULT_DOMAIN="${API_DOMAIN:-localhost:19080}"
SIGNATURE="${API_SIGNATURE:-rgs-local-signature}"
CONTENT_TYPE="application/json"
CACHE_FILE="${SCRIPT_DIR}/.lobby-token-cache.json"

DOMAIN="${1:-${DEFAULT_DOMAIN}}"
if [[ "${DOMAIN}" != http://* && "${DOMAIN}" != https://* ]]; then
  DOMAIN="http://${DOMAIN}"
fi
BASE_URL="${DOMAIN%/}"

if [[ -z "${GAME_CODE:-}" ]]; then
  echo "ERROR: GAME_CODE is required. Please set it in ${SCRIPT_DIR}/.env."
  exit 1
fi

RTP_CONFIG_CODE="RTP_97"
if [[ "${GAME_CODE}" == "LGS-004" ]]; then
  RTP_CONFIG_CODE="RTP_97"
fi

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required to parse responses."
    exit 1
  fi
}

parse_body() {
  printf '%s' "$1" | sed 's/HTTPSTATUS:[0-9]\{3\}$//'
}

parse_status() {
  printf '%s' "$1" | sed -n 's/.*HTTPSTATUS:\([0-9]\{3\}\)$/\1/p'
}

http_post() {
  local url="$1"; shift
  curl --silent --show-error --location --request POST "$url" "$@" --write-out 'HTTPSTATUS:%{http_code}'
}

extract_token_from_launch_url() {
  local url="$1"
  printf '%s' "$url" | grep -o 'token=[^&]*' | cut -d'=' -f2 || true
}

session_start_payload() {
  jq -n \
    --arg gameCode "${GAME_CODE}" \
    --arg rtpConfigCode "${RTP_CONFIG_CODE}" \
    '{
      gameCode: $gameCode,
      lang: "en",
      gameSetting: {
        rtpConfigCode: $rtpConfigCode,
        isGeoBlocking: true
      },
      country: "GB",
      isTestingPlayer: false,
      mode: "real",
      operator: "QARealGameOperator",
      brand: "QARealGameBrand",
      playerId: "QARealGameOperator:QARealGameBrand:kyle0c",
      currency: "EUR",
      currencyId: 1,
      externalPlayerId: "kyle0c",
      balance: "10000",
      maxExposure: 0,
      licenseConfig: {},
      callback: "http://localhost"
    }'
}

save_lobby_tokens() {
  jq -n \
    --arg baseUrl "${BASE_URL}" \
    --arg gameCode "${GAME_CODE}" \
    --arg sessionId "${SESSION_ID}" \
    --arg sessionToken "${SESSION_TOKEN}" \
    --arg gameAccessToken "${GAME_ACCESS_TOKEN}" \
    --arg tokenType "${LOBBY_TOKEN_TYPE}" \
    --arg lobbyAccessToken "${LOBBY_ACCESS_TOKEN}" \
    --arg lobbyRefreshToken "${LOBBY_REFRESH_TOKEN}" \
    --arg refreshedAccessToken "${REFRESHED_ACCESS_TOKEN:-}" \
    --arg refreshedRefreshToken "${REFRESHED_REFRESH_TOKEN:-}" \
    --argjson expiresIn "${LOBBY_EXPIRES_IN:-0}" \
    '{
      baseUrl: $baseUrl,
      gameCode: $gameCode,
      sessionId: $sessionId,
      sessionToken: $sessionToken,
      gameAccessToken: $gameAccessToken,
      lobby: {
        tokenType: $tokenType,
        accessToken: $lobbyAccessToken,
        refreshToken: $lobbyRefreshToken,
        expiresIn: $expiresIn
      },
      refresh: {
        accessToken: $refreshedAccessToken,
        refreshToken: $refreshedRefreshToken
      },
      savedAt: now
    }' > "${CACHE_FILE}"
}

start_session() {
  local response
  local body
  local status
  local launch_url

  printf "[1/4] Starting RGS session...\n"
  response=$(http_post "${BASE_URL}/v2/service/session/start" \
    --header "x-signature: ${SIGNATURE}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "$(session_start_payload)")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Session start response:\n%s\n" "${body}"

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: session start failed with HTTP status ${status}."
    exit 1
  fi

  SESSION_TOKEN=$(printf '%s' "${body}" | jq -r '.token // .sessionToken // .data.token // empty')
  if [[ -z "${SESSION_TOKEN}" ]]; then
    launch_url=$(printf '%s' "${body}" | jq -r '.data.launchUrl // empty')
    if [[ -n "${launch_url}" ]]; then
      SESSION_TOKEN=$(extract_token_from_launch_url "${launch_url}")
    fi
  fi

  SESSION_ID=$(printf '%s' "${body}" | jq -r '.session // .sessionId // .data.session // .data.sessionId // empty')

  if [[ -z "${SESSION_TOKEN}" ]]; then
    echo "ERROR: 無法從 session start 回傳中擷取 token。"
    exit 1
  fi

  printf "session token: %s\n" "${SESSION_TOKEN}"
  if [[ -n "${SESSION_ID}" ]]; then
    printf "session id: %s\n" "${SESSION_ID}"
  fi
}

activate_session() {
  local payload
  local response
  local body
  local status

  printf "[2/4] Activating RGS session...\n"
  payload=$(jq -n \
    --arg token "${SESSION_TOKEN}" \
    --arg timezone "us" \
    --arg language "us" \
    --arg device "mobile" \
    --arg orientation "landscape" \
    --arg connection "slow-2g" \
    '{token: $token, ts: 0, timezone: $timezone, analytics: {language: $language, device: $device, resolution: {w:0, h:0}, orientation: $orientation, connection: $connection}}')

  response=$(http_post "${BASE_URL}/v2/exp/session/activate" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Session activate response:\n%s\n" "${body}"

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: session activate failed with HTTP status ${status}."
    exit 1
  fi

  GAME_ACCESS_TOKEN=$(printf '%s' "${body}" | jq -r '.token // .accessToken // .data.token // .data.accessToken // empty')
  if [[ -z "${GAME_ACCESS_TOKEN}" ]]; then
    echo "ERROR: 無法從 session activate 回傳中擷取 access token。"
    exit 1
  fi

  if [[ -z "${SESSION_ID}" ]]; then
    SESSION_ID=$(printf '%s' "${body}" | jq -r '.session // .sessionId // .data.session // .data.sessionId // empty')
  fi

  printf "game access token: %s\n" "${GAME_ACCESS_TOKEN}"
}

activate_session_token() {
  local response
  local body
  local status

  printf "[3/4] Activating lobby session token...\n"
  response=$(http_post "${BASE_URL}/v1/exp/session-token/activate" \
    --header "Authorization: Bearer ${GAME_ACCESS_TOKEN}")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Session-token activate response:\n%s\n" "${body}"

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: session-token activate failed with HTTP status ${status}."
    exit 1
  fi

  LOBBY_TOKEN_TYPE=$(printf '%s' "${body}" | jq -r '.data.tokenType // "Bearer"')
  LOBBY_ACCESS_TOKEN=$(printf '%s' "${body}" | jq -r '.data.accessToken // empty')
  LOBBY_REFRESH_TOKEN=$(printf '%s' "${body}" | jq -r '.data.refreshToken // empty')
  LOBBY_EXPIRES_IN=$(printf '%s' "${body}" | jq -r '.data.expiresIn // 0')

  if [[ -z "${LOBBY_ACCESS_TOKEN}" ]]; then
    echo "ERROR: 無法從 session-token activate 回傳中擷取 data.accessToken。"
    exit 1
  fi

  if [[ -z "${LOBBY_REFRESH_TOKEN}" ]]; then
    echo "ERROR: 無法從 session-token activate 回傳中擷取 data.refreshToken。"
    exit 1
  fi

  printf "lobby access token: %s\n" "${LOBBY_ACCESS_TOKEN}"
  printf "lobby refresh token: %s\n" "${LOBBY_REFRESH_TOKEN}"
}

refresh_session_token() {
  local payload
  local response
  local body
  local status

  printf "[4/4] Refreshing lobby session token...\n"
  printf "Waiting 5 seconds before refresh"
  for _ in 1 2 3 4 5; do
    sleep 1
    printf "."
  done
  printf "\n"

  payload=$(jq -n --arg refreshToken "${LOBBY_REFRESH_TOKEN}" '{refreshToken: $refreshToken}')
  printf "refreshToken source: session-token activate response data.refreshToken\n"

  response=$(http_post "${BASE_URL}/v1/exp/session-token/refresh" \
    --header "Authorization: Bearer ${LOBBY_ACCESS_TOKEN}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Session-token refresh response:\n%s\n" "${body}"

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: session-token refresh failed with HTTP status ${status}."
    exit 1
  fi

  REFRESHED_ACCESS_TOKEN=$(printf '%s' "${body}" | jq -r '.data.accessToken // empty')
  REFRESHED_REFRESH_TOKEN=$(printf '%s' "${body}" | jq -r '.data.refreshToken // empty')

  if [[ -z "${REFRESHED_ACCESS_TOKEN}" ]]; then
    echo "ERROR: 無法從 session-token refresh 回傳中擷取 data.accessToken。"
    exit 1
  fi

  printf "refreshed access token: %s\n" "${REFRESHED_ACCESS_TOKEN}"
  if [[ -n "${REFRESHED_REFRESH_TOKEN}" ]]; then
    printf "refreshed refresh token: %s\n" "${REFRESHED_REFRESH_TOKEN}"
  fi
}

require_jq
start_session
activate_session
activate_session_token
refresh_session_token
save_lobby_tokens

printf "Done. Lobby tokens saved to %s\n" "${CACHE_FILE}"

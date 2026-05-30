#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables from the script directory .env if present
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +o allexport
fi

DEFAULT_DOMAIN="${API_DOMAIN:-localhost:19080}"
SIGNATURE="${API_SIGNATURE:-rgs-local-signature}"
CONTENT_TYPE="application/json"

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

SESSION_START_PAYLOAD=$(jq -n \
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
  }')

BET_PAYLOAD_TEMPLATE='{
  "session": "%s",
  "bet": {
    "type": "regular",
    "value": "2"
  },
  "stakeMode": {
    "type": "commonGame",
    "multiplier": 1,
    "name": "regular bet",
    "rtp": 96.56
  },
  "ts": 177445520478
}'

CACHE_FILE="${SCRIPT_DIR}/.token-cache.json"
RESULT_DIR="${SCRIPT_DIR}/result"
MAX_RESULT_FILES=10

cleanup_old_results() {
  local count=0
  local file

  while IFS= read -r file; do
    count=$((count + 1))
    if ((count > MAX_RESULT_FILES)); then
      rm -f "${file}"
    fi
  done < <(find "${RESULT_DIR}" -maxdepth 1 -type f -name '*-bet-*.json' -print | sort -r)
}

save_play_result() {
  local body="$1"
  local action_body="${2:-}"
  local finish_body="${3:-}"
  local timestamp
  local game_code
  local output_file

  mkdir -p "${RESULT_DIR}"
  timestamp=$(date '+%Y%m%d%H%M%S')
  game_code="${GAME_CODE:-unknown}"
  output_file="${RESULT_DIR}/${timestamp}-bet-${game_code}.json"

  if jq -n \
    --arg betRaw "${body}" \
    --arg actionRaw "${action_body}" \
    --arg finishRaw "${finish_body}" \
    --arg maintenanceStep "${MAINTENANCE_BLOCK_STEP:-}" \
    --arg maintenanceStatus "${MAINTENANCE_BLOCK_STATUS:-}" \
    --arg maintenanceMessage "${MAINTENANCE_BLOCK_MESSAGE:-}" \
    --arg maintenanceCode "${MAINTENANCE_BLOCK_CODE:-}" \
    '
      {bet: ($betRaw | fromjson? // $betRaw)}
      + (if $actionRaw != "" then {action: ($actionRaw | fromjson? // $actionRaw)} else {} end)
      + (if $finishRaw != "" then {finish: ($finishRaw | fromjson? // $finishRaw)} else {} end)
      + (
        if $maintenanceStep != "" then
          {
            maintenanceBlock: {
              step: $maintenanceStep,
              status: $maintenanceStatus,
              message: $maintenanceMessage,
              code: $maintenanceCode
            }
          }
        else
          {}
        end
      )
    ' > "${output_file}"; then
    printf "Bet result saved: %s\n" "${output_file}"
    cleanup_old_results
  fi
}

load_cached_tokens() {
  if [[ -f "${CACHE_FILE}" ]]; then
    local cached_base_url
    local cached_game_code

    cached_base_url=$(jq -r '.baseUrl // empty' "${CACHE_FILE}" 2>/dev/null || true)
    cached_game_code=$(jq -r '.gameCode // empty' "${CACHE_FILE}" 2>/dev/null || true)

    if [[ "${cached_base_url}" != "${BASE_URL}" || "${cached_game_code}" != "${GAME_CODE}" ]]; then
      printf "Cached token does not match BASE_URL/GAME_CODE, refreshing tokens...\n"
      SESSION_TOKEN=""
      ACCESS_TOKEN=""
      SESSION_ID=""
      return 0
    fi

    SESSION_TOKEN=$(jq -r '.sessionToken // empty' "${CACHE_FILE}" 2>/dev/null || true)
    ACCESS_TOKEN=$(jq -r '.accessToken // empty' "${CACHE_FILE}" 2>/dev/null || true)
    SESSION_ID=$(jq -r '.sessionId // empty' "${CACHE_FILE}" 2>/dev/null || true)
  fi
}

save_tokens() {
  jq -n \
    --arg baseUrl "${BASE_URL}" \
    --arg gameCode "${GAME_CODE}" \
    --arg sessionToken "${SESSION_TOKEN}" \
    --arg accessToken "${ACCESS_TOKEN}" \
    --arg sessionId "${SESSION_ID}" \
    '{baseUrl: $baseUrl, gameCode: $gameCode, sessionToken: $sessionToken, accessToken: $accessToken, sessionId: $sessionId, savedAt: now}' \
    > "${CACHE_FILE}"
}

http_post() {
  local url="$1"; shift
  curl --silent --show-error --location --request POST "$url" "$@" --write-out 'HTTPSTATUS:%{http_code}'
}

parse_body() {
  printf '%s' "$1" | sed 's/HTTPSTATUS:[0-9]\{3\}$//'
}

parse_status() {
  printf '%s' "$1" | sed -n 's/.*HTTPSTATUS:\([0-9]\{3\}\)$/\1/p'
}

decode_jwt_payload() {
  local token="$1"
  local payload
  local padding

  payload=$(printf '%s' "${token}" | cut -d'.' -f2 | tr '_-' '/+')
  padding=$(( (4 - ${#payload} % 4) % 4 ))
  payload="${payload}$(printf '%*s' "${padding}" '' | tr ' ' '=')"

  printf '%s' "${payload}" | base64 -D 2>/dev/null || printf '%s' "${payload}" | base64 -d 2>/dev/null || true
}

jwt_is_expired() {
  local token="$1"
  local exp
  local now

  if [[ -z "${token}" ]]; then
    return 0
  fi

  exp=$(decode_jwt_payload "${token}" | jq -r '.exp // empty' 2>/dev/null || true)
  if [[ -z "${exp}" || ! "${exp}" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  now=$(date +%s)
  [[ "${exp}" -le "${now}" ]]
}

cached_tokens_need_refresh() {
  if [[ -z "${ACCESS_TOKEN:-}" || -z "${SESSION_TOKEN:-}" || -z "${SESSION_ID:-}" ]]; then
    return 0
  fi

  if jwt_is_expired "${SESSION_TOKEN}" || jwt_is_expired "${ACCESS_TOKEN}"; then
    printf "Cached session/access token expired, refreshing tokens...\n"
    return 0
  fi

  return 1
}

is_session_invalid_response() {
  local status="$1"
  local body="$2"
  local message
  local code

  message=$(printf '%s' "${body}" | jq -r '.error.message // .message // empty' 2>/dev/null || true)
  code=$(printf '%s' "${body}" | jq -r '.error.code // .code // empty' 2>/dev/null || true)

  if [[ "${status}" == "401" ]]; then
    return 0
  fi

  printf '%s\n%s\n%s' "${body}" "${message}" "${code}" \
    | grep -Eiq 'invalid|expired|unauthorized|session[_ -]?(not[_ -]?found|expired|invalid|closed)|not[_ -]?found.*session'
}

detect_maintenance_block() {
  local step="$1"
  local status="$2"
  local body="$3"
  local message
  local code

  message=$(printf '%s' "${body}" | jq -r '.error.message // .message // empty' 2>/dev/null || true)
  code=$(printf '%s' "${body}" | jq -r '.error.code // .code // empty' 2>/dev/null || true)

  if printf '%s\n%s\n%s' "${body}" "${message}" "${code}" | grep -Ei 'maintenance|maintain' >/dev/null 2>&1; then
    MAINTENANCE_BLOCK_STEP="${step}"
    MAINTENANCE_BLOCK_STATUS="${status}"
    MAINTENANCE_BLOCK_MESSAGE="${message:-maintenance block detected}"
    MAINTENANCE_BLOCK_CODE="${code}"

    printf "\n"
    printf "============================================================\n"
    printf "MAINTENANCE BLOCKED at %s\n" "${MAINTENANCE_BLOCK_STEP}"
    printf "HTTP status: %s\n" "${MAINTENANCE_BLOCK_STATUS}"
    if [[ -n "${MAINTENANCE_BLOCK_CODE}" ]]; then
      printf "Error code: %s\n" "${MAINTENANCE_BLOCK_CODE}"
    fi
    printf "Message: %s\n" "${MAINTENANCE_BLOCK_MESSAGE}"
    printf "============================================================\n"
    printf "\n"
    return 0
  fi

  return 1
}

extract_token_from_launch_url() {
  local url="$1"
  printf '%s' "$url" | grep -o 'token=[^&]*' | cut -d'=' -f2 || true
}

refresh_tokens() {
  printf "[1/3] Starting session...\n"
  START_RESPONSE=$(http_post "${BASE_URL}/v2/service/session/start" \
    --header "x-signature: ${SIGNATURE}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${SESSION_START_PAYLOAD}")

  START_BODY=$(parse_body "${START_RESPONSE}")
  START_STATUS=$(parse_status "${START_RESPONSE}")

  printf "Start response:\n%s\n" "${START_BODY}"
  detect_maintenance_block "session.start" "${START_STATUS}" "${START_BODY}" || true

  if [[ "${START_STATUS}" != "200" ]]; then
    echo "ERROR: session start failed with HTTP status ${START_STATUS}."
    exit 1
  fi

  SESSION_TOKEN=$(printf '%s' "${START_BODY}" | jq -r '.token // .sessionToken // .data.token // empty')
  if [[ -z "${SESSION_TOKEN}" ]]; then
    LAUNCH_URL=$(printf '%s' "${START_BODY}" | jq -r '.data.launchUrl // empty')
    if [[ -n "${LAUNCH_URL}" ]]; then
      SESSION_TOKEN=$(extract_token_from_launch_url "${LAUNCH_URL}")
    fi
  fi

  SESSION_ID=$(printf '%s' "${START_BODY}" | jq -r '.session // .sessionId // .data.session // .data.sessionId // empty')

  if [[ -z "${SESSION_TOKEN}" ]]; then
    echo "ERROR: 無法從 session start 回傳中擷取 token。請檢查回傳格式。"
    exit 1
  fi

  printf "session token: %s\n" "${SESSION_TOKEN}"
  if [[ -n "${SESSION_ID}" ]]; then
    printf "session id: %s\n" "${SESSION_ID}"
  fi

  printf "[2/3] Activating session...\n"
  ACTIVATE_PAYLOAD=$(jq -n \
    --arg token "${SESSION_TOKEN}" \
    --arg timezone "us" \
    --arg language "us" \
    --arg device "mobile" \
    --arg orientation "landscape" \
    --arg connection "slow-2g" \
    '{token: $token, ts: 0, timezone: $timezone, analytics: {language: $language, device: $device, resolution: {w:0, h:0}, orientation: $orientation, connection: $connection}}')
  ACTIVATE_RESPONSE=$(http_post "${BASE_URL}/v2/exp/session/activate" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${ACTIVATE_PAYLOAD}")

  ACTIVATE_BODY=$(parse_body "${ACTIVATE_RESPONSE}")
  ACTIVATE_STATUS=$(parse_status "${ACTIVATE_RESPONSE}")

  printf "Activate response:\n%s\n" "${ACTIVATE_BODY}"
  detect_maintenance_block "session.activate" "${ACTIVATE_STATUS}" "${ACTIVATE_BODY}" || true

  if [[ "${ACTIVATE_STATUS}" != "200" ]]; then
    echo "ERROR: session activate failed with HTTP status ${ACTIVATE_STATUS}."
    exit 1
  fi

  ACCESS_TOKEN=$(printf '%s' "${ACTIVATE_BODY}" | jq -r '.token // .accessToken // .data.token // .data.accessToken // empty')
  if [[ -z "${ACCESS_TOKEN}" ]]; then
    echo "ERROR: 無法從 activate 回傳中擷取 access token。請檢查回傳格式。"
    exit 1
  fi

  printf "access token: %s\n" "${ACCESS_TOKEN}"
  save_tokens
}

build_bet_payload() {
  jq -n \
    --arg session "${SESSION_ID:-}" \
    --arg type "regular" \
    --arg value "2" \
    --arg stakeType "commonGame" \
    --arg name "regular bet" \
    --argjson multiplier 1 \
    --argjson rtp 96.56 \
    --argjson ts 177445520478 \
    '{session: $session, bet: {type: $type, value: $value}, stakeMode: {type: $stakeType, multiplier: $multiplier, name: $name, rtp: $rtp}, ts: $ts}'
}

bet_request() {
  local payload="$1"
  local response
  response=$(curl --silent --show-error --location \
    --request POST "${BASE_URL}/v2/exp/play/bet" \
    --header "cloudfront-viewer-country: JP" \
    --header "cloudfront-viewer-address: 1.2.3.4" \
    --header "x-access-token: ${ACCESS_TOKEN}" \
    --header "authorization: Bearer ${ACCESS_TOKEN}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}" \
    --write-out 'HTTPSTATUS:%{http_code}')

  local body
  local status
  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Bet response:\n%s\n" "${body}"
  detect_maintenance_block "play.bet" "${status}" "${body}" || true

  if is_session_invalid_response "${status}" "${body}"; then
    return 1
  fi

  BET_RESPONSE_BODY="${body}"
  return 0
}

extract_action_value() {
  local body="$1"
  printf '%s' "${body}" | jq -c '
    if .data.action != null then
      .data.action
    elif ((.data.actions // []) | type) == "array" and ((.data.actions // []) | length) > 0 then
      .data.actions[0] as $action
      | if ($action | type) == "object" and ($action.action != null) then
          $action.action
        else
          $action
        end
    else
      empty
    end
  ' 2>/dev/null || true
}

action_request() {
  local bet_body="$1"
  local action_value
  local round_id
  local payload
  local response
  local body
  local status

  action_value=$(extract_action_value "${bet_body}")
  if [[ -z "${action_value}" || "${action_value}" == "null" ]]; then
    return 0
  fi

  round_id=$(printf '%s' "${bet_body}" | jq -r '.data.roundId // empty' 2>/dev/null || true)
  if [[ -z "${round_id}" ]]; then
    echo "ERROR: Bet response has action, but data.roundId is missing."
    exit 1
  fi

  payload=$(jq -n \
    --arg session "${SESSION_ID:-}" \
    --arg roundId "${round_id}" \
    --argjson action "${action_value}" \
    --argjson ts "$(jq -n 'now * 1000 | floor')" \
    '{session: $session, roundId: $roundId, action: $action, ts: $ts}')

  printf "Action found in bet response, sending action request...\n"
  response=$(curl --silent --show-error --location \
    --request POST "${BASE_URL}/v2/exp/play/action" \
    --header "cloudfront-viewer-country: JP" \
    --header "cloudfront-viewer-address: 1.2.3.4" \
    --header "x-access-token: ${ACCESS_TOKEN}" \
    --header "authorization: Bearer ${ACCESS_TOKEN}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}" \
    --write-out 'HTTPSTATUS:%{http_code}')

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Action response:\n%s\n" "${body}"
  detect_maintenance_block "play.action" "${status}" "${body}" || true

  if is_session_invalid_response "${status}" "${body}"; then
    return 1
  fi

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: action request failed with HTTP status ${status}."
    exit 1
  fi

  ACTION_RESPONSE_BODY="${body}"
}

extract_summary_coins() {
  local body="$1"
  printf '%s' "${body}" | jq -r '
    .data.results.gameResponse.step.summary.coins
    | tonumber?
    | select(. > 0)
  ' 2>/dev/null || true
}

finish_request() {
  local play_body="$1"
  local coins
  local round_id
  local payload
  local response
  local body
  local status

  coins=$(extract_summary_coins "${play_body}")
  if [[ -z "${coins}" ]]; then
    return 0
  fi

  round_id=$(printf '%s' "${play_body}" | jq -r '.data.roundId // empty' 2>/dev/null || true)
  if [[ -z "${round_id}" ]]; then
    echo "ERROR: Play response has summary.coins > 0, but data.roundId is missing."
    exit 1
  fi

  payload=$(jq -n \
    --arg session "${SESSION_ID:-}" \
    --arg roundId "${round_id}" \
    --argjson ts "$(jq -n 'now * 1000 | floor')" \
    '{session: $session, roundId: $roundId, ts: $ts}')

  printf "Summary coins=%s, sending finish request...\n" "${coins}"
  response=$(curl --silent --show-error --location \
    --request POST "${BASE_URL}/v2/exp/play/finish" \
    --header "cloudfront-viewer-country: JP" \
    --header "cloudfront-viewer-address: 1.2.3.4" \
    --header "x-access-token: ${ACCESS_TOKEN}" \
    --header "authorization: Bearer ${ACCESS_TOKEN}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}" \
    --write-out 'HTTPSTATUS:%{http_code}')

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Finish response:\n%s\n" "${body}"
  detect_maintenance_block "play.finish" "${status}" "${body}" || true

  if is_session_invalid_response "${status}" "${body}"; then
    return 1
  fi

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: finish request failed with HTTP status ${status}."
    exit 1
  fi

  FINISH_RESPONSE_BODY="${body}"
}

run_play_flow() {
  BET_RESPONSE_BODY=""
  ACTION_RESPONSE_BODY=""
  FINISH_RESPONSE_BODY=""

  printf "[3/3] Sending bet request...\n"
  BET_PAYLOAD=$(build_bet_payload)

  if ! bet_request "${BET_PAYLOAD}"; then
    return 1
  fi

  if ! action_request "${BET_RESPONSE_BODY}"; then
    return 1
  fi

  if ! finish_request "${ACTION_RESPONSE_BODY:-${BET_RESPONSE_BODY}}"; then
    return 1
  fi

  return 0
}

load_cached_tokens
if cached_tokens_need_refresh; then
  refresh_tokens
fi

if ! run_play_flow; then
  printf "Session/token invalid or expired, refreshing cache and retrying...\n"
  refresh_tokens
  if ! run_play_flow; then
    echo "ERROR: Play flow failed even after refreshing session/access token."
    exit 1
  fi
fi

save_play_result "${BET_RESPONSE_BODY}" "${ACTION_RESPONSE_BODY:-}" "${FINISH_RESPONSE_BODY:-}"

printf "Done."

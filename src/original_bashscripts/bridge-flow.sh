#!/bin/bash

# ==============================================================================
# RGS Bridge Service - Multi-Instance Automation Test Script (v21)
# ==============================================================================

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' 

AUTO_DIR=".automation_test"
REDIS_PORT=6000
INIT_WAIT=15        # Fixed initialization wait
KAFKA_WAIT=15       # Default Kafka wait (changeable via -w)
STARTUP_DELAY=3
GAMES_INPUT="LGS-004"
STARTUP_ORDER="billing,game,bridge"
KILL_REDIS=false
TOPOLOGIES=()

usage() {
    echo -e "${BLUE}RGS Automation Test - Intuitive Topology Explorer${NC}"
    echo "Usage: $0 [options] {enable|disable|stop|logs}"
    echo ""
    echo "Options:"
    echo "  -T <topology> Define an environment topology (can be used multiple times)"
    echo "  -k            Enable Redis flush (Case 3: Billing Site fallback)"
    echo "  -f <games>    Comma-separated game codes (default: LGS-004)"
    echo "  -w <secs>     Wait time for KAFKA propagation (default: 15)"
    echo "  -s <order>    Startup order (default: billing,game,bridge)"
    exit 1
}

while getopts "T:kf:w:s:h" opt; do
    case $opt in
        T) TOPOLOGIES+=("$OPTARG") ;;
        k) KILL_REDIS=true ;;
        f) GAMES_INPUT=$OPTARG ;;
        w) KAFKA_WAIT=$OPTARG ;; # Updated to KAFKA_WAIT
        s) STARTUP_ORDER=$OPTARG ;;
        h|*) usage ;;
    esac
done
shift $((OPTIND-1))

# ... [Cleanup and Helper functions remain unchanged] ...

ACTION=$1
if [[ -z "$ACTION" || "$ACTION" == *"["* ]]; then
    ACTION="enable"
else
    shift
fi

stop_all() {
    echo -e "${BLUE}Stopping all instances...${NC}"
    if [ -d "$AUTO_DIR/pids" ]; then
        PIDS=$(cat "$AUTO_DIR/pids"/*.pid 2>/dev/null)
        if [ -n "$PIDS" ]; then
            echo -e "${BLUE}>>> Terminating PIDs from current session...${NC}"
            kill -9 $PIDS > /dev/null 2>&1 || true
        fi
    fi
    echo -e "${BLUE}>>> Killing background node processes for this project...${NC}"
    pkill -9 -f "build/index.js" > /dev/null 2>&1
    echo -e "${BLUE}>>> Clearing Ports 7000-11000 targeting 'node' only...${NC}"
    lsof -a -i :7000-11000 -t -c node 2>/dev/null | xargs kill -9 > /dev/null 2>&1 || true
    rm -rf "$AUTO_DIR"
    echo -e "${GREEN}Cleanup completed.${NC}"
    exit 0
}

show_logs() {
    if [ ! -d "$AUTO_DIR/logs" ] || [ -z "$(ls -A "$AUTO_DIR/logs" 2>/dev/null)" ]; then
        echo "No running instances found."
        exit 1
    fi
    echo "Streaming logs... (Ctrl+C to stop)"
    tail -f "$AUTO_DIR/logs"/*.log
    exit 0
}

[ "$ACTION" == "stop" ] && stop_all
[ "$ACTION" == "logs" ] && show_logs
[[ "$ACTION" != "enable" && "$ACTION" != "disable" ]] && usage

ENABLED_VAL="false"
[ "$ACTION" == "enable" ] && ENABLED_VAL="true"

if [ ${#TOPOLOGIES[@]} -eq 0 ]; then
    echo -e "$YELLOW[NOTICE] No -T flags provided. Using default complex topology spans DEV and EXTRA_ENV.$NC"
    TOPOLOGIES+=("DEV[B=ap-southeast-1:2;G=us-east-2:1,us-east-1:1,ap-northeast-1:1,sa-east-1:1;R=us-east-2:3,us-east-1:3,ap-northeast-1:3,sa-east-1:3]")
    TOPOLOGIES+=("EXTRA_ENV[B=ap-southeast-1:2;G=us-east-2:1,us-east-1:1,ap-northeast-1:1,sa-east-1:1;R=us-east-2:3,us-east-1:3,ap-northeast-1:3,sa-east-1:3]")
fi

rm -rf "$AUTO_DIR"
mkdir -p "$AUTO_DIR/logs" "$AUTO_DIR/pids" "$AUTO_DIR/envs"
touch "$AUTO_DIR/port_map.txt"

cat << 'EOF' > "$AUTO_DIR/flush_redis.js"
const Redis = require('ioredis');
const port = process.env.REDIS_PORT || 6000;
const options = { connectTimeout: 2000, lazyConnect: true, maxRetriesPerRequest: 0 };
async function tryFlush() {
    let redis;
    try {
        console.log(`Connecting to Redis on 127.0.0.1:${port}...`);
        redis = new Redis.Cluster([{ host: '127.0.0.1', port }], { clusterRetryStrategy: () => null, redisOptions: options });
        redis.on('error', () => {});
        await redis.connect().catch(() => {});
        if (redis.status !== 'ready') {
            redis.disconnect();
            redis = new Redis({ host: '127.0.0.1', port, ...options });
            redis.on('error', () => {});
            await redis.connect().catch(() => {});
        }
        if (redis.status === 'ready') {
            const nodes = redis.nodes ? redis.nodes('master') : [redis];
            let totalFlushed = 0;
            for (const node of nodes) {
                const nodeKeys = await node.keys('*');
                const filtered = nodeKeys.filter(k => k.includes('slot-rgs') || k.includes('remote-game-server') || k.includes('am-access'));
                if (filtered.length > 0) {
                    await Promise.all(filtered.map(k => node.del(k)));
                    totalFlushed += filtered.length;
                }
            }
            if (totalFlushed > 0) console.log(`Successfully flushed ${totalFlushed} keys.`);
            else console.log('No keys found for flush.');
        } else {
            console.error('Failed to connect to Redis. Skipping flush.');
        }
    } catch (e) {
        console.error('Redis error:', e.message);
    } finally {
        if (redis) redis.disconnect();
        process.exit(0);
    }
}
tryFlush();
EOF

echo -e "$BLUE>>> Building project...$NC"
npm run build > /dev/null 2>&1

if [ -f "$AUTO_DIR/flush_redis.js" ]; then
    echo -e "$BLUE>>> Clearing stale Redis data...$NC"
    if nc -z -w 1 127.0.0.1 $REDIS_PORT > /dev/null 2>&1; then
        REDIS_PORT=$REDIS_PORT node "$AUTO_DIR/flush_redis.js"
    else
        echo -e "$YELLOW[WARNING] Redis port $REDIS_PORT is closed. Skipping flush.$NC"
    fi
fi

provision_db() {
    local env_name=$1
    local db_name="slot_${env_name}"
    local container="remote-game-server-db-1"
    
    echo -e "$BLUE>>> Provisioning Database: $db_name$NC"
    if ! docker ps --filter "name=$container" --filter "status=running" -q > /dev/null; then
        echo -e "$RED[ERROR] Postgres container '$container' is not running.$NC"
        return 1
    fi

    docker exec "$container" psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -q 1 || \
    docker exec "$container" psql -U postgres -c "CREATE DATABASE \"$db_name\"" > /dev/null 2>&1

    ln -sfn slot "db-migrations/$db_name"
    [ -f .env ] && mv .env .env.bak
    cp .env.billing.example .env
    sed -i '' "s|^DB_NAME=.*|DB_NAME=$db_name|" .env
    
    echo "Running migrations for $db_name..."
    npx @ikigaians/migrate up "$db_name" > /dev/null 2>&1
    
    rm "db-migrations/$db_name"
    rm .env
    [ -f .env.bak ] && mv .env.bak .env
}

start_instance() {
    local port=$1
    local type=$2
    local env_name=$3
    local region=$4
    local billing_port=$5
    local core_region=${6:-$region}
    local env_file="$AUTO_DIR/envs/.env.$port"
    local log_file="$AUTO_DIR/logs/rgs-$port.log"
    local pid_file="$AUTO_DIR/pids/rgs-$port.pid"

    local template=".env.$type.example"
    [ ! -f "$template" ] && template=".env.example"
    [ ! -f "$template" ] && template=".env"
    
    cp "$template" "$env_file" 2>/dev/null
    [ -f "$env_file" ] && [ -n "$(tail -c1 "$env_file" 2>/dev/null)" ] && echo "" >> "$env_file"

    sed -i '' "s|^RGS_PORT=.*|RGS_PORT=$port|" "$env_file"
    sed -i '' "s|^RGS_EXTERNAL_HOST=.*|RGS_EXTERNAL_HOST=http://localhost:$port|" "$env_file"
    sed -i '' "s|^RGS_APP_DOMAIN=.*|RGS_APP_DOMAIN=http://localhost:$port|" "$env_file"
    sed -i '' "s|^REDIS_PORT=.*|REDIS_PORT=$REDIS_PORT|" "$env_file"
    sed -i '' "s|^CORE_SLOT_RGS_SERVICE_URL=.*|CORE_SLOT_RGS_SERVICE_URL=http://localhost:$billing_port|" "$env_file"
    
    # Replace MONEY_SERVICE_URL for CIT Environment validation
    sed -i '' "/^MONEY_SERVICE_URL=/d" "$env_file"; echo "MONEY_SERVICE_URL=https://money-service.iki-cit.cc" >> "$env_file"
    
    sed -i '' "/^APP_SERVICE_TYPE=/d" "$env_file"
    [ "$type" == "bridge" ] && echo "APP_SERVICE_TYPE=bridge" >> "$env_file" || echo "APP_SERVICE_TYPE=api" >> "$env_file"
    sed -i '' "/^APP_ENV=/d" "$env_file"; echo "APP_ENV=$env_name" >> "$env_file"
    sed -i '' "/^MONGO_NAME=/d" "$env_file"; echo "MONGO_NAME=rgs_${env_name}" >> "$env_file"
    sed -i '' "/^DB_NAME=/d" "$env_file"; echo "DB_NAME=slot_${env_name}" >> "$env_file"
    sed -i '' "/^REDIS_PREFIX=/d" "$env_file"; echo "REDIS_PREFIX=slot-rgs:$env_name" >> "$env_file"
    sed -i '' "/^APP_CLOUD_REGION_TYPE=/d" "$env_file"
    [ "$type" == "billing" ] && echo "APP_CLOUD_REGION_TYPE=billing" >> "$env_file" || echo "APP_CLOUD_REGION_TYPE=peripheral" >> "$env_file"
    sed -i '' "/^APP_CLOUD_REGION=/d" "$env_file"; echo "APP_CLOUD_REGION=$region" >> "$env_file"
    sed -i '' "/^APP_CLOUD_CORE_REGION=/d" "$env_file"; echo "APP_CLOUD_CORE_REGION=$core_region" >> "$env_file"
    sed -i '' "/^APP_NAME=/d" "$env_file"; echo "APP_NAME=remote-game-server" >> "$env_file"
    sed -i '' "/^VERSION=/d" "$env_file"; echo "VERSION=v1" >> "$env_file"

    local env_vars=$(grep -v '^#' "$env_file" | xargs)
    local node_path="$(pwd)/build"
    
    ( env NODE_PATH="$node_path" $env_vars node build/index.js > "$log_file" 2>&1 ) &
    echo $! > "$pid_file"
    echo "$port|$type|$env_name|$region" >> "$AUTO_DIR/port_map.txt"
}

IFS=',' read -ra ORDER_TYPES <<< "$STARTUP_ORDER"

ENV_INIT_SEEN=""
for TOPOLOGY in "${TOPOLOGIES[@]}"; do
    ENV_NAME=$(echo "$TOPOLOGY" | cut -d'[' -f1)
    if [[ ! "$ENV_INIT_SEEN" == *"$ENV_NAME"* ]]; then
        provision_db "$ENV_NAME"
        ENV_INIT_SEEN="$ENV_INIT_SEEN $ENV_NAME"
    fi
done

ENV_INDEX=0
for TOPOLOGY in "${TOPOLOGIES[@]}"; do
    ENV_NAME=$(echo "$TOPOLOGY" | cut -d'[' -f1)
    INNER=$(echo "$TOPOLOGY" | sed 's/.*\[\(.*\)\].*/\1/')
    PORT_OFFSET=$((ENV_INDEX * 1000))
    PRIMARY_BILLING_PORT=$((8080 + PORT_OFFSET))
    
    echo -e "$YELLOW>>> Launching Environment: $ENV_NAME (Offset: $PORT_OFFSET)$NC"
    
    ENV_CORE_REGION=""
    B_BLOCK=$(echo "$INNER" | grep -o "B=[^;]*" | head -n 1)
    if [ -n "$B_BLOCK" ]; then
        ENV_CORE_REGION=$(echo "$B_BLOCK" | cut -d'=' -f2 | cut -d',' -f1 | cut -d':' -f1)
    fi

    for ord_type in "${ORDER_TYPES[@]}"; do
        T_CODE=""
        [[ "$ord_type" == "billing" ]] && T_CODE="B"
        [[ "$ord_type" == "game" ]] && T_CODE="G"
        [[ "$ord_type" == "bridge" ]] && T_CODE="R"
        
        type_block=""
        IFS=';' read -ra BLOCKS <<< "$INNER"
        for b in "${BLOCKS[@]}"; do
            [[ "$b" == "$T_CODE="* ]] && type_block="$b"
        done

        if [ -n "$type_block" ]; then
            T_REGS=$(echo "$type_block" | cut -d'=' -f2)
            T_NAME="game"; BASE_P=9001
            [[ "$T_CODE" == "B" ]] && { T_NAME="billing"; BASE_P=8080; }
            [[ "$T_CODE" == "R" ]] && { T_NAME="bridge"; BASE_P=7001; }
            
            LOC_CNT=0
            IFS=',' read -ra REGS <<< "$T_REGS"
            for reg_block in "${REGS[@]}"; do
                REG_NAME=$(echo "$reg_block" | cut -d':' -f1)
                REG_COUNT=$(echo "$reg_block" | cut -d':' -f2)
                [[ "$REG_NAME" == "$REG_COUNT" ]] && REG_COUNT=1
                
                for ((i=0; i<REG_COUNT; i++)); do
                    start_instance $((BASE_P + PORT_OFFSET + LOC_CNT)) "$T_NAME" "$ENV_NAME" "$REG_NAME" "$PRIMARY_BILLING_PORT" "$ENV_CORE_REGION"
                    ((LOC_CNT++))
                done
            done
            echo "Started $ord_type instances."
            sleep "$STARTUP_DELAY"
        fi
    done
    ((ENV_INDEX++))
done

echo -ne "$YELLOW>>> Waiting for health checks...$NC"
INST_COUNT=$(wc -l < "$AUTO_DIR/port_map.txt")
READY=0
for i in {1..60}; do
    READY=0
    for pidf in "$AUTO_DIR/pids"/*.pid; do
        port=$(basename "$pidf" | sed 's/rgs-//;s/\.pid//')
        curl -s -o /dev/null "http://localhost:$port/v2/service/healthcheck" && ((READY++))
    done
    [ $READY -eq $INST_COUNT ] && break
    echo -n "."; sleep 1
done
if [ $READY -eq $INST_COUNT ]; then
    echo -e "\n$GREEN>>> $READY/$INST_COUNT instances up.$NC"
else
    echo -e "\n$RED>>> Only $READY/$INST_COUNT instances up. Verification likely to fail.$NC"
fi

# ==============================================================================
# Helper Functions
# ==============================================================================

# Custom API Caller that logs exact Source and Target (macOS compatible)
call_api() {
    local method=$1
    local target_type=$2
    local target_port=$3
    local path=$4
    local payload=$5
    local token=$6
    
    RESP=$(curl -s -w "\n%{http_code}" -X "$method" "http://localhost:$target_port$path" -H "x-access-token: $token" -H 'Content-Type: application/json' -d "$payload")
    HTTP_CODE=$(echo "$RESP" | tail -n 1 | tr -d ' ')
    BODY=$(echo "$RESP" | sed '$ d')
    
    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ] && [ "$HTTP_CODE" != "201" ]; then
        # Use tr for universal bash uppercase conversion
        UPPER_TYPE=$(echo "$target_type" | tr 'a-z' 'A-Z')
        echo -e "${RED}    [TestScript -> $UPPER_TYPE :$target_port] | $method $path | ERROR ($HTTP_CODE): $BODY${NC}"
    fi
}

# Ensure games exist in the DB before testing
seed_games_if_needed() {
    echo -e "$BLUE>>> Seeding games in databases to prevent 404 errors...$NC"
    local ENV_SEEN=""
    while IFS='|' read -r port type env region; do
        if [[ "$type" == "billing" && ! "$ENV_SEEN" == *"$env"* ]]; then
            TOKEN=$(curl -s -X 'POST' "http://localhost:$port/v1/service/am/token" -H 'x-signature: rgs-local-signature' -H 'Content-Type: application/json' -d '{"userId": 0, "account": "tester", "code": "SLT", "permission": [{"routeKey": "*", "methods": ["*"]}]}' | jq -r '.data.token')
            
            for game in $(echo $GAMES_INPUT | tr ',' ' '); do
                SEED_DATA="{\"name\": \"Test Game $game\", \"code\": \"$game\", \"enabled\": true, \"category\": \"slot\", \"versions\": [], \"supplier\": \"test\", \"languages\": [\"en\"], \"betLevels\": {\"default\": {\"EUR\": [{\"type\": \"regular\", \"value\": \"1\", \"default\": true}]}}, \"gameServerConfig\": {}}"
                call_api "POST" "$type" "$port" "/v1/internal/game" "$SEED_DATA" "$TOKEN"
            done
            
            ENV_SEEN="$ENV_SEEN $env"
        fi
    done < "$AUTO_DIR/port_map.txt"
}

# Run seed
seed_games_if_needed

# Determine Initial vs Target States
FIRST_ENV=$(head -n 1 "$AUTO_DIR/port_map.txt" | cut -d'|' -f3)
INITIAL_VAL="false"
INITIAL_BET_VAL="50"
[ "$ENABLED_VAL" == "false" ] && { INITIAL_VAL="true"; INITIAL_BET_VAL="100"; }

TARGET_BET_VAL="50"
[ "$ENABLED_VAL" == "true" ] && TARGET_BET_VAL="100"

echo -e "$BLUE>>> PROVING ISOLATION: Updating ONLY $FIRST_ENV to $ENABLED_VAL (Bet Level: $TARGET_BET_VAL)$NC"

# 1. Reset ALL envs to initial state
echo -e "$BLUE>>> INITIALIZING ISOLATION: Setting ALL environments to $INITIAL_VAL and standardizing bet levels...$NC"
ENV_SEEN=""
while IFS='|' read -r port type env region; do
    if [[ "$type" == "billing" && ! "$ENV_SEEN" == *"$env"* ]]; then
        TOKEN=$(curl -s -X 'POST' "http://localhost:$port/v1/service/am/token" -H 'x-signature: rgs-local-signature' -H 'Content-Type: application/json' -d '{"userId": 0, "account": "tester", "code": "SLT", "permission": [{"routeKey": "*", "methods": ["*"]}]}' | jq -r '.data.token')
        
        GAME_DATA="{\"data\": [$(echo $GAMES_INPUT | sed 's/,/ /g' | xargs -n1 printf '{\"code\": \"%s\", \"enabled\": '$INITIAL_VAL'},' | sed 's/,$//')]}"
        call_api "PATCH" "$type" "$port" "/v1/internal/games/status" "$GAME_DATA" "$TOKEN"
        
        for game in $(echo $GAMES_INPUT | tr ',' ' '); do
            BET_DATA="{\"currencyCode\": \"EUR\", \"betLevels\": [{\"type\": \"regular\", \"value\": \"$INITIAL_BET_VAL\", \"default\": true}]}"
            call_api "PATCH" "$type" "$port" "/v1/internal/game/$game/betLevels" "$BET_DATA" "$TOKEN"
        done
        
        ENV_SEEN="$ENV_SEEN $env"
    fi
done < "$AUTO_DIR/port_map.txt"

# USES FIXED INIT_WAIT
echo "Waiting for initialization sync (${INIT_WAIT}s)..."
sleep "$INIT_WAIT"

# 3. Snapshot log positions
while IFS='|' read -r port type env region; do
    if [[ "$type" == "bridge" ]]; then
        wc -l < "$AUTO_DIR/logs/rgs-$port.log" 2>/dev/null | tr -d ' ' > "$AUTO_DIR/log_pos_$port" || echo 0 > "$AUTO_DIR/log_pos_$port"
    fi
done < "$AUTO_DIR/port_map.txt"

# 4. Apply target state
echo -e "$BLUE>>> TEST: Updating ONLY $FIRST_ENV billing to $ENABLED_VAL (other ENVs stay at $INITIAL_VAL)$NC"
while IFS='|' read -r port type env region; do
    if [[ "$type" == "billing" && "$env" == "$FIRST_ENV" ]]; then
        TOKEN=$(curl -s -X 'POST' "http://localhost:$port/v1/service/am/token" -H 'x-signature: rgs-local-signature' -H 'Content-Type: application/json' -d '{"userId": 0, "account": "tester", "code": "SLT", "permission": [{"routeKey": "*", "methods": ["*"]}]}' | jq -r '.data.token')
        
        GAME_DATA="{\"data\": [$(echo $GAMES_INPUT | sed 's/,/ /g' | xargs -n1 printf '{\"code\": \"%s\", \"enabled\": '$ENABLED_VAL'},' | sed 's/,$//')]}"
        call_api "PATCH" "$type" "$port" "/v1/internal/games/status" "$GAME_DATA" "$TOKEN"
        
        for game in $(echo $GAMES_INPUT | tr ',' ' '); do
            BET_DATA="{\"currencyCode\": \"EUR\", \"betLevels\": [{\"type\": \"regular\", \"value\": \"$TARGET_BET_VAL\", \"default\": true}]}"
            call_api "PATCH" "$type" "$port" "/v1/internal/game/$game/betLevels" "$BET_DATA" "$TOKEN"
        done
        
        echo -e "  Hit billing :$port ($env | $region) with Game Data and Bet Levels update"
        break
    fi
done < "$AUTO_DIR/port_map.txt"

# USES DYNAMIC KAFKA_WAIT (from -w)
echo "Waiting for Kafka propagation (${KAFKA_WAIT}s)..."
sleep "$KAFKA_WAIT"

# ... [Verification logic remains unchanged] ...

FAILURES=0
FIRST_GAME=$(echo $GAMES_INPUT | cut -d',' -f1)
echo -e "\n$BLUE>>> Starting Verification$NC"

echo -e "\n$BLUE--- Bridge Subscriptions (info) ---$NC"
while IFS='|' read -r port type env region; do
    if [[ "$type" == "bridge" ]]; then
        LOG_FILE="$AUTO_DIR/logs/rgs-$port.log"
        GID=$(grep -o "groupId: [^\"]*" "$LOG_FILE" 2>/dev/null | tail -n 1 | sed 's/groupId: //')
        TOPIC=$(grep -o "topic: [^ ]*" "$LOG_FILE" 2>/dev/null | tail -n 1 | sed 's/topic: //')
        echo -e "  :$port ($env | $region)  Topic: ${TOPIC:-?}  |  GID: ${GID:-?}"
    fi
done < "$AUTO_DIR/port_map.txt"

echo -e "\n$BLUE--- Kafka Event Propagation (By Consumer Group Region) ---$NC"
UNIQUE_REGIONS=$(awk -F'|' '$3=="'$FIRST_ENV'" && $2=="bridge" {print $4}' "$AUTO_DIR/port_map.txt" | sort -u)
for region in $UNIQUE_REGIONS; do
    REG_GAME=0
    REG_BET=0
    
    while IFS='|' read -r port type env r; do
        if [[ "$type" == "bridge" && "$env" == "$FIRST_ENV" && "$r" == "$region" ]]; then
            LOG_FILE="$AUTO_DIR/logs/rgs-$port.log"
            PREV=$(cat "$AUTO_DIR/log_pos_$port" 2>/dev/null | tr -d ' ')
            PREV=${PREV:-0}
            
            # Use safe grep for both updates
            G_COUNT=$(tail -n "+$((PREV+1))" "$LOG_FILE" 2>/dev/null | grep -c '"updateType":"gameData"' || true)
            B_COUNT=$(tail -n "+$((PREV+1))" "$LOG_FILE" 2>/dev/null | grep -c '"updateType":"betLevels"' || true)
            
            REG_GAME=$((REG_GAME + G_COUNT))
            REG_BET=$((REG_BET + B_COUNT))
        fi
    done < "$AUTO_DIR/port_map.txt"
    
    if [ "$REG_GAME" -ge 1 ] && [ "$REG_BET" -ge 1 ]; then
        echo -e "$GREEN[PASS] Region $region Processed GAME_DATA ($REG_GAME) and BET_LEVELS ($REG_BET) events across its bridges$NC"
    else
        echo -e "$RED[FAIL] Region $region Missing events! GAME_DATA: $REG_GAME, BET_LEVELS: $REG_BET$NC"
        ((FAILURES++))
    fi
done

echo -e "\n$BLUE--- Game Status via API (ENV isolation + data propagation) ---$NC"
while IFS='|' read -r port type env region; do
    [[ "$type" == "bridge" ]] && continue

    EXPECTED="$INITIAL_VAL"
    [[ "$env" == "$FIRST_ENV" ]] && EXPECTED="$ENABLED_VAL"

    JSON=$(curl -s -f -X 'GET' "http://localhost:$port/v2/service/games" -H 'x-signature: rgs-local-signature' 2>&1)
    CURL_EXIT=$?

    if [ $CURL_EXIT -eq 0 ]; then
        VAL=$(echo "$JSON" | jq -r ".data.games[] | select(.code==\"$FIRST_GAME\") | .enabled" 2>/dev/null)
        if [ -z "$VAL" ] || [ "$VAL" == "null" ]; then
            VAL=$(echo "$JSON" | jq -r ".data[] | select(.code==\"$FIRST_GAME\") | .enabled" 2>/dev/null)
        fi
        
        if [ "$VAL" == "$EXPECTED" ]; then
            echo -e "$GREEN[PASS] :$port ($env | $type | $region) $FIRST_GAME: $VAL$NC"
        else
            echo -e "$RED[FAIL] :$port ($env | $type | $region) $FIRST_GAME: $VAL (Expected: $EXPECTED)$NC"
            if [ -z "$VAL" ] || [ "$VAL" == "null" ]; then
                echo -e "${YELLOW}  -> API Response Snippet: $(echo "$JSON" | cut -c 1-200)${NC}"
            fi
            ((FAILURES++))
        fi
    else
        echo -e "$RED[FAIL] :$port ($env | $type | $region) CURL ERROR ($CURL_EXIT)$NC"
        ((FAILURES++))
    fi
done < "$AUTO_DIR/port_map.txt"

[ $FAILURES -eq 0 ] && echo -e "\n$GREEN>>> ALL VERIFIED$NC" || { echo -e "\n$RED>>> $FAILURES FAILURE(S)$NC"; exit 1; }
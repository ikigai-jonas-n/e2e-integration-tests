#!/bin/bash
# reset — wipe everything for a completely fresh start.

set -euo pipefail

WORKTREE_BASE=".e2e-worktrees"

echo "🛑 Killing service processes..."
for port in 7001 8070 8080 8090 8091 9000 19080; do
  pids=$(lsof -P -n -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "   Killing port $port (PID $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "🐳 Stopping Docker Compose Projects..."
for dir in "$WORKTREE_BASE/queue-service" "$WORKTREE_BASE/remote-game-server"; do
  if [ -f "$dir/docker-compose.yml" ]; then
    docker compose -f "$dir/docker-compose.yml" down -v --remove-orphans --timeout 5 2>/dev/null || true
  fi
done
if [ -f "docker-compose.observability.yml" ]; then
  docker compose -f docker-compose.observability.yml down -v --timeout 5 2>/dev/null || true
fi

echo "🐳 Annihilating Orphaned Containers..."
# BROADER TARGETS: We now target 'mongo', 'game', 'rgs', 'slot', etc.
# This ensures we catch the database containers even if Docker names them weirdly.
TARGETS=$(docker ps -a -q -f "name=mongo" -f "name=game" -f "name=queue" -f "name=rgs" -f "name=slot" -f "name=seq" -f "name=dozzle")

if [ -n "$TARGETS" ]; then
  echo "   Force-removing test containers..."
  echo "$TARGETS" | xargs docker rm -f -v >/dev/null 2>&1 || true
fi

docker network rm e2e-net 2>/dev/null || true
docker network prune -f >/dev/null 2>&1 || true

echo "🌳 Removing worktrees..."
if [ -d "$WORKTREE_BASE" ]; then
  for repo in ../queue-service ../slot-game-server ../remote-game-server; do
    if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
      git -C "$repo" worktree prune 2>/dev/null || true
    fi
  done
  
  echo "   Deleting $WORKTREE_BASE (using Docker to bypass Root/WiredTiger locks)..."
  docker run --rm -v "$(pwd):/workspace" alpine sh -c "rm -rf /workspace/$WORKTREE_BASE"
fi

echo "🗑️  Clearing build caches..."
find . -name ".e2e-state.json" -delete 2>/dev/null || true
rm -f .e2e-endpoints.json E2E_Local.postman_environment.json

echo ""
echo "✅ Reset complete. Next 'bun test' starts from scratch."
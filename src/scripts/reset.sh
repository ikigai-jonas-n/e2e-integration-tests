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
# FIX: Dynamically loop through ANY folder inside the worktree base
for compose_file in "$WORKTREE_BASE"/*/docker-compose.yml; do
  if [ -f "$compose_file" ]; then
    docker compose -f "$compose_file" down -v --remove-orphans --timeout 5 2>/dev/null || true
  fi
done

if [ -f "src/docker-compose.observability.yml" ]; then
  docker compose -f src/docker-compose.observability.yml down -v --timeout 5 2>/dev/null || true
fi

echo "🐳 Annihilating Orphaned Containers..."
# FIX: Added redis and rustfs to the target list
TARGETS=$(docker ps -a -q -f "name=mongo" -f "name=game" -f "name=queue" -f "name=rgs" -f "name=slot" -f "name=seq" -f "name=dozzle" -f "name=redis" -f "name=rustfs")

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
  
  # --- ASYNCHRONOUS DELETION OPTIMIZATION ---
  echo "   Deleting $WORKTREE_BASE (natively in background)..."
  
  # Move the folder to a temp name instantly (takes 1 millisecond)
  TMP_TRASH=".e2e-trash-$(date +%s)"
  mv "$WORKTREE_BASE" "$TMP_TRASH" 2>/dev/null || true
  
  # Delete the temp folder quietly in the background, freeing up your terminal immediately
  (rm -rf "$TMP_TRASH" &)
fi

echo "🗑️  Clearing build caches..."
find . -name ".e2e-state.json" -delete 2>/dev/null || true
rm -f .e2e-endpoints.json E2E_Local.postman_environment.json

echo ""
echo "✅ Reset complete. Next 'bun test' starts from scratch."
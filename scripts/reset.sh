#!/bin/bash
# reset — wipe everything for a completely fresh start.
# Kills service processes, stops Docker infra, removes all worktrees and build caches.
# Run time: ~10-15 seconds.

set -euo pipefail

WORKTREE_BASE=".e2e-worktrees"

echo "🛑 Killing service processes..."
for port in 7001 8070 8080 8090 8091 9000 19080; do
  pids=$(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "   Killing port $port (PID $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "🐳 Stopping Docker infra..."
# Only the two repos that actually have Docker infra containers.
# Variants (remote-game-server-billing etc.) share the same compose — skip them.
for dir in "$WORKTREE_BASE/queue-service" "$WORKTREE_BASE/remote-game-server"; do
  if [ -f "$dir/docker-compose.yml" ]; then
    echo "   -> $dir"
    docker compose -f "$dir/docker-compose.yml" down --timeout 10 -v --remove-orphans 2>&1 || true
  fi
done

echo "📊 Stopping observability (Seq + Dozzle)..."
docker compose -f docker-compose.observability.yml down -v 2>&1 || true

echo "🌳 Removing worktrees..."
if [ -d "$WORKTREE_BASE" ]; then
  # Prune stale worktree refs from each source repo so 'git worktree list' stays clean.
  for repo in ../queue-service ../slot-game-server ../remote-game-server; do
    if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
      git -C "$repo" worktree prune 2>/dev/null || true
    fi
  done
  rm -rf "$WORKTREE_BASE"
  echo "   Removed $WORKTREE_BASE"
fi

echo "🗑️  Clearing build caches..."
find . -name ".e2e-state.json" -delete 2>/dev/null || true
rm -f .e2e-endpoints.json E2E_Local.postman_environment.json

echo ""
echo "✅ Reset complete. Next 'bun test' starts from scratch."

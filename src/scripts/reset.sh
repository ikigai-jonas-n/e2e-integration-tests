#!/bin/bash
# reset — wipe everything for a completely fresh start.

set -euo pipefail

WORKTREE_BASE=".e2e-worktrees"

echo "🛑 Dynamically detecting service ports..."
# Use Bun to dynamically parse the YAML and extract all exposed Node.js ports
PORTS=$(bun -e "
const yaml = require('yaml');
const fs = require('fs');
try {
  const doc = yaml.parse(fs.readFileSync('src/docker-compose.services.yml', 'utf8'));
  const ports = Object.values(doc.services).flatMap(s => s.ports || []).map(p => p.split(':')[0]);
  console.log(ports.join(' '));
} catch(e) {}
")

if [ -n "$PORTS" ]; then
  echo "   Killing processes on ports: $PORTS"
  for port in $PORTS; do
    pids=$(lsof -P -n -ti:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "   Killing port $port (PID $pids)"
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done
fi

echo "🐳 Stopping Docker Compose Projects..."
for compose_file in "$WORKTREE_BASE"/*/docker-compose.yml; do
  if [ -f "$compose_file" ]; then
    docker compose -f "$compose_file" down -v --remove-orphans --timeout 5 2>/dev/null || true
  fi
done
if [ -f "src/docker-compose.observability.yml" ]; then
  docker compose -f src/docker-compose.observability.yml down -v --timeout 5 2>/dev/null || true
fi

echo "🐳 Annihilating Orphaned Test Containers..."
# SAFER FALLBACK: Only target containers whose Docker Compose working directory label contains .e2e-worktrees
TARGETS=$(docker ps -a --filter "label=com.docker.compose.project.working_dir" --format "{{.ID}} {{.Label \"com.docker.compose.project.working_dir\"}}" | grep "\.e2e-worktrees" | awk '{print $1}')

if [ -n "$TARGETS" ]; then
  echo "   Force-removing orphaned E2E containers..."
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
  
  # Delete asynchronously so your terminal is freed instantly
  echo "   Deleting $WORKTREE_BASE (natively in background)..."
  TMP_TRASH=".e2e-trash-$(date +%s)"
  mv "$WORKTREE_BASE" "$TMP_TRASH" 2>/dev/null || true
  (rm -rf "$TMP_TRASH" &)
fi

echo "🗑️  Clearing build caches..."
find . -name ".e2e-state.json" -delete 2>/dev/null || true
rm -f .e2e-endpoints.json E2E_Local.postman_environment.json

echo ""
echo "✅ Reset complete. Next 'bun test' starts from scratch."
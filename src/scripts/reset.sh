#!/bin/bash
# reset — wipe environment. Defaults to soft reset (keeps build cache).
# Use --hard for a complete nuclear wipe of worktrees.

set -euo pipefail

HARD_RESET=false
if [[ "${1:-}" == "--hard" ]]; then
  HARD_RESET=true
fi

WORKTREE_BASE=".e2e-worktrees"

echo "🛑 Dynamically detecting service ports..."
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
    dir=$(dirname "$compose_file")
    docker compose -f "$compose_file" down -v --remove-orphans --timeout 5 2>/dev/null || true
    
    # ---> FIX: Nuke bind-mounted data volumes specifically <---
    for d in mongo/primary/data mongo/secondary/data postgreSql/data redis/data rustfs/data; do
      rm -rf "$dir/.docker-rgs/$d" 2>/dev/null || true
    done
  fi
done
if [ -f "src/docker-compose.observability.yml" ]; then
  docker compose -f src/docker-compose.observability.yml down -v --timeout 5 2>/dev/null || true
fi

echo "🐳 Annihilating Orphaned Test Containers..."
TARGETS=$(bun -e "
const yaml = require('yaml');
const fs = require('fs');
const path = require('path');
const targets = new Set(['seq', 'dozzle']);
try {
  const dirs = fs.readdirSync('.e2e-worktrees').map(d => path.join('.e2e-worktrees', d, 'docker-compose.yml')).filter(f => fs.existsSync(f));
  for (const file of dirs) {
    const doc = yaml.parse(fs.readFileSync(file, 'utf8'));
    if (doc && doc.services) {
      for (const [key, svc] of Object.entries(doc.services)) {
        if (svc.container_name) targets.add(svc.container_name);
        else targets.add(key);
      }
    }
  }
} catch(e) {}
console.log(Array.from(targets).join(' '));
")

if [ -n "$TARGETS" ]; then
  for target in $TARGETS; do
    cids=$(docker ps -a -q -f "name=^${target}$" 2>/dev/null || true)
    if [ -n "$cids" ]; then
      echo "   Force-removing test container: $target"
      echo "$cids" | xargs docker rm -f -v >/dev/null 2>&1 || true
    fi
  done
fi

docker network rm e2e-net 2>/dev/null || true
docker network prune -f >/dev/null 2>&1 || true

# ---> OPTIMIZATION: Hide worktree destruction behind the --hard flag <---
if [ "$HARD_RESET" = true ]; then
  echo "🌳 [HARD RESET] Removing worktrees and build caches..."
  if [ -d "$WORKTREE_BASE" ]; then
    for repo in ../queue-service ../slot-game-server ../remote-game-server; do
      if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
        git -C "$repo" worktree prune 2>/dev/null || true
      fi
    done
    
    echo "   Deleting $WORKTREE_BASE (natively in background)..."
    TMP_TRASH=".e2e-trash-$(date +%s)"
    mv "$WORKTREE_BASE" "$TMP_TRASH" 2>/dev/null || true
    (rm -rf "$TMP_TRASH" &)
  fi

  # Clear build caches
  find . -name ".e2e-state.json" -delete 2>/dev/null || true

  # Clear the Super Optimistic state tracker and rerun markers <---
  rm -f "$WORKTREE_BASE/.e2e-ready.json" 2>/dev/null || true
  rm -f "logs/.rerun-needed" 2>/dev/null || true

  # Clear endpoints
  rm -f .e2e-endpoints.json E2E_Local.postman_environment.json
else
  # Clear the Super Optimistic state tracker and rerun markers <---
  rm -f "$WORKTREE_BASE/.e2e-ready.json" 2>/dev/null || true
  rm -f "logs/.rerun-needed" 2>/dev/null || true
  
  echo "🌳 [SOFT RESET] Preserving Git worktrees and build caches."
fi

echo ""
if [ "$HARD_RESET" = true ]; then
  echo "✅ Hard Reset complete. Next 'bun test' will Cold Start from scratch."
else
  echo "✅ Soft Reset complete. Next 'bun test' will boot in seconds!"
fi
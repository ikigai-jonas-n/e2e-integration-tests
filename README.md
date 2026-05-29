# E2E Integration Tests

Automated integration test suite for the multi-service gaming architecture.
Spins up all dependent services, runs tests end-to-end, and tears down cleanly.

---

## TL;DR — How To Use This

```bash
bun install     # once, to install orchestrator deps
bun test        # always — auto-decides what to skip
```

**That's it.** No `.env` file. No flags. No manual setup.

The orchestrator detects whether services are already running and whether code has changed.
It skips everything it safely can and goes straight to tests.

| Situation | What runs | Time |
|---|---|---|
| First ever run | Full: git checkout + docker + migrations + build + start | ~2-3 min |
| Services up, code unchanged | Nothing — warm start | ~2s |
| Services up, code changed | Rebuild changed service, restart | ~30-40s |
| Services down, code unchanged | docker up + migrations + start (no rebuild) | ~45s |

**`E2E_SKIP_PULL=1`** — use only when you have **local uncommitted changes** and don't want
`git reset --hard` to wipe them. The dirty-file hash still detects your edits and rebuilds when needed.
```bash
E2E_SKIP_PULL=1 bun test
```
Do **not** use in CI. CI must always pull latest.

**`global.network`** — set in `e2e-config.json` → `"global"` → `"network"`.
`null` = host networking (default). `"e2e-net"` = Docker bridge mode (see Bridge Network section).
```json
{ "global": { "network": null } }
```

---

## Prerequisites

| Tool | Purpose |
|---|---|
| [Bun](https://bun.sh/) v1.0+ | Test runner and process spawner |
| Node.js + npm | Runs the microservices |
| Docker + Docker Compose | Databases, Kafka, Redis, RustFS |
| Git | Worktree checkout |

### Required directory layout

```
../
├── e2e-integration-tests/   ← you are here
├── queue-service/
├── slot-game-server/
└── remote-game-server/
```

All four repos must exist as siblings. The orchestrator uses `git worktree` — not clones — so no disk duplication.

---

## Quick Start

```bash
# Install orchestrator dependencies (one-time)
bun install

# Run the full E2E suite
bun test
```

No `.env` file needed. All configuration lives in `e2e-config.json`.

First run takes ~2-3 minutes (git checkout + npm install + build + docker up).
**Every subsequent run auto-detects warm state and completes in < 5 seconds** when services are already running and code hasn't changed.

---

## How It Works

```
bun test
  └─ E2EOrchestrator.setupWorktrees()
       → kill zombie processes on config-derived ports
       → git pull all service repos (skipped if E2E_SKIP_PULL=1)
       → auto-detect warm start
  └─ E2EOrchestrator.startInfrastructure()     ← skipped on warm start
       → docker-compose up (Kafka, Postgres, MongoDB, Redis, RustFS)
  └─ E2EOrchestrator.runGlobalMigrations()     ← skipped on warm start
       → @ikigaians/migrate up (Postgres schema, MongoDB indexes)
  └─ E2EOrchestrator.runServices()             ← skipped on warm start
       → npm install + npm run build (skipped if HEAD unchanged)
       → node ... start all services concurrently
       → parallel healthcheck polling
  └─ tests/e2e.spec.ts
       → poll game node until process cache loaded
       → seed EUR bet levels for LGS-001
       → run test flows
  └─ E2EOrchestrator.teardown()
       → SIGKILL all spawned node processes
       → docker-compose down
```

---

## Smart Warm Start

No flags required. After `git pull`, the orchestrator prints a startup analysis and auto-decides:

```
📊 Startup Analysis:
   Services:              ✅ all 4 health checks passed
   slot-game-server       ⚡ cached
   remote-game-server     🔄 uncommitted local changes detected

🚀 Mode: COLD START — reason: code changed. Running full setup.
```

The decision requires **both**:

1. **All health checks pass** — every configured `healthCheck` URL responds 200
2. **No code changed** — for every service repo:
   - `git HEAD` matches the hash in `.e2e-state.json` (committed changes)
   - `git diff HEAD` hash matches (uncommitted changes to local files)

If both pass → **WARM START**: skip docker, migrations, npm install, npm build, service restart.
If either fails → **COLD START**: full setup, only rebuilding repos that changed.

```
Warm run:       git pull + analysis (~2s) → tests
Cold run:       full setup (~2-3 min first time)
Code changed:   rebuild changed service (~30-40s) → restart
```

The cache stamp (`.e2e-state.json`) is written per repo after a successful build. It stores:
```json
{ "commit": "abc1234...", "dirty": "a3f2b1c0" }
```
`dirty` is a hash of `git diff HEAD` — detects saved-but-not-committed edits.

---

## Configuration (`e2e-config.json`)

### Top-level structure

```json
{
  "global": { ... },
  "services": { ... }
}
```

### `global`

| Field | Type | Default | Description |
|---|---|---|---|
| `worktreeBasePath` | `string` | `"./.e2e-worktrees"` | Where git worktrees are checked out |
| `cleanOnTeardown` | `boolean` | `false` | Delete worktrees after test run |
| `network` | `string \| null` | `null` | Docker network name for bridge mode. `null` = host networking (default) |

### `services[name]`

| Field | Type | Description |
|---|---|---|
| `repoPath` | `string` | Relative path to the source repo (sibling directory) |
| `target` | `string` | Branch or commit to check out |
| `composeServiceEnvOverrides` | `object` | Env var overrides per docker-compose service name, applied when `global.network` is set |
| `instances` | `array` | One or more process instances to run |

### `services[name].instances[i]`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Human-readable instance name (used in logs) |
| `count` | `number` | How many copies to start. Use `{INDEX}` in `envOverrides` values |
| `envBase` | `string` | Path to the `.env.*.example` file to use as base |
| `envOverrides` | `object` | Key/value overrides applied on top of `envBase` |
| `networkEnvOverrides` | `object` | Additional overrides applied only when `global.network` is set (bridge mode) |
| `commands` | `array` | Commands to run. `sync: true` = run before starting (install/build). `sync: false` = run as long-lived process |
| `healthCheck` | `string` | URL polled until 200 before tests begin |

### Changing the branch under test

```json
{
  "services": {
    "remote-game-server": {
      "target": "feature/my-awesome-feature"
    }
  }
}
```

The orchestrator pulls the specified branch into its git worktree. The build cache invalidates automatically because HEAD changes.

---

## Environment Variable Flag

| Variable | Value | Effect |
|---|---|---|
| `E2E_SKIP_PULL=1` | set | Skip `git pull` on all repos. Use when testing **local uncommitted changes** — prevents `git reset --hard` from discarding your edits. All other smart-start logic (health checks, build cache) still applies. |

```bash
E2E_SKIP_PULL=1 bun test
```

Do **not** use this in CI. CI should always pull latest.

---

## Bridge Network Mode

By default the orchestrator uses `network_mode: "host"` so all services share `localhost`. This is required because Kafka advertises `localhost:9093` as its external listener.

To run with Docker bridge network isolation (e.g. stricter CI environments):

**1. Set `global.network` in `e2e-config.json`:**
```json
{
  "global": {
    "network": "e2e-net"
  }
}
```

**2. Update `docker-compose.e2e.yml`** — comment out `network_mode: "host"`, uncomment the bridge network section (see comments in that file).

**3. Fix the Redis cluster** (required for bridge mode):

The Valkey cluster startup script inside `remote-game-server/docker-compose.yml` hardcodes `127.0.0.1` for cluster gossip. In bridge mode, clients receive `MOVED` redirects to `127.0.0.1:600X` which resolves to the wrong container. Fix by adding `--cluster-announce-hostname redis-cluster` to each `valkey-server` invocation in that script.

**What `global.network` does automatically:**
- Creates the Docker network if it doesn't exist
- Generates `docker-compose.override.yml` files that attach all containers to the network and override Kafka's `KAFKA_CFG_ADVERTISED_LISTENERS` to use container names
- Merges `networkEnvOverrides` from each instance into its environment, repointing all `localhost` connection strings to container names

The `networkEnvOverrides` in `e2e-config.json` already contain the full bridge-mode mapping for all services (Kafka, Redis, MongoDB, Postgres, RustFS).

---

## Ports

Ports are derived dynamically from `e2e-config.json` at startup. No hardcoded list.

The orchestrator scans:
- `envOverrides` keys containing `PORT` (e.g. `PORT=8080`, `RGS_PORT=8090`)
- `localhost` URLs in `envOverrides` values (e.g. `http://127.0.0.1:9000`)
- `healthCheck` URLs

macOS AirPlay conflicts on port 7000/7001 are patched automatically in the docker-compose files (remapped to 7002/7003).

---

## CI Usage (`docker-compose.e2e.yml`)

For CI, run the entire suite inside a container:

```bash
docker-compose -f docker-compose.e2e.yml up --abort-on-container-exit
```

The orchestrator container mounts `/var/run/docker.sock` (Docker-out-of-Docker) and runs with `network_mode: "host"` so it can reach Kafka on `localhost:9093`.

---

## Troubleshooting

### Port conflicts
Services automatically kill zombie node/bun processes on their ports before starting. If a Docker container holds a port, find it with `docker ps` and stop it manually.

### Git worktree stuck
If a previous crash left a dangling worktree lock:
```bash
git worktree prune   # run inside ../remote-game-server (or other affected repo)
```

### Build not refreshing after code change
Delete the build cache stamp to force a rebuild:
```bash
rm .e2e-worktrees/remote-game-server/.e2e-state.json
rm .e2e-worktrees/slot-game-server/.e2e-state.json
```

### Services not starting (warm start falsely triggered)
Force a cold start by stopping the Docker containers:
```bash
docker-compose -f .e2e-worktrees/remote-game-server/docker-compose.yml down -v
docker-compose -f .e2e-worktrees/queue-service/docker-compose.yml down -v
```
The health checks will fail → orchestrator does full restart on next run.

### Kafka consumers not subscribing in time
The test suite polls the game node's process cache instead of using a fixed sleep. If Kafka is unusually slow to start, increase the poll timeout in `tests/e2e.spec.ts` (default: 60 attempts × 1s).

---

## File Structure

```
e2e-integration-tests/
├── e2e-config.json          ← all service/instance/network configuration
├── tests/
│   └── e2e.spec.ts          ← test flows (smoke, Flow 1, Flow 2)
├── src/
│   └── E2EOrchestrator.ts   ← spins up all services, manages lifecycle
├── run-e2e.sh               ← wrapper: creates timestamped log in logs/
├── docker-compose.e2e.yml   ← CI: runs orchestrator in a container
├── Dockerfile.e2e           ← CI: builds the orchestrator container image
├── logs/                    ← e2e-run-TIMESTAMP.log (gitignored)
└── .e2e-worktrees/          ← git worktrees (gitignored)
```

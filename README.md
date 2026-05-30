# E2E Integration Tests

Automated integration test suite for the multi-service gaming architecture.
Spins up all dependent services, runs tests end-to-end, and tears down cleanly.

---

## TL;DR — How To Use This

```bash
bun install                    # once, to install orchestrator deps
bun test                       # run everything — auto-decides what to skip
bun test -t "Flow: Bet"        # run only the bet flow
bun test -t "Service APIs"     # run only smoke/health checks
```

**That's it.** No `.env` file. No manual setup.

### Services stay alive after every run

By default, Docker containers and Node.js services are **never stopped** when `bun test` finishes. The next run detects them as healthy, skips all infrastructure setup, and goes straight to tests — taking ~5s instead of 2-3 minutes.

```
First run:       2-3 min  (git checkout + build + docker + migrations)
Subsequent run:  ~5s      (git pull + warm start → straight to tests)
```

To **force a full stop** (one-off):
```bash
E2E_TEARDOWN=1 bun test
```

To make teardown permanent, edit `e2e-orchestrator.yml`:
```yaml
global:
  cleanOnTeardown: true
```

This is the only change needed — no code changes required.

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

**`global.network`** — set in `e2e-orchestrator.yml` → `global.network`.
`null` = host networking (default). `"e2e-net"` = Docker bridge mode (see Bridge Network section).
```yaml
global:
  network: null
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

No `.env` file needed. Configuration lives in `e2e-orchestrator.yml` and `docker-compose.services.yml`.

First run takes ~2-3 minutes (git checkout + npm install + build + docker up).
**Every subsequent run auto-detects warm state and completes in < 5 seconds** when services are already running and code hasn't changed.

---

## Running Specific Tests

Use `--test-name-pattern` (or `-t`) to run only the tests you care about.
The pattern matches against the full test name: `"<describe block> > <test name>"`.

```bash
# Run only smoke/health checks
bun test -t "Service APIs"

# Run only the bet + action flow
bun test -t "Flow: Bet"

# Run one specific step
bun test -t "Step 3: Bet"

# Run all lobby flow steps
bun test -t "Flow: Lobby"

# Run the bridge / Kafka propagation flow
bun test -t "Flow: Bridge"

# Run maintenance flow
bun test -t "Flow: Game Maintenance"

# Run everything that touches a session
bun test -t "Session"
```

**How it works**: `beforeAll` (infra boot) always runs, but only matching tests execute.
On a warm start the `beforeAll` takes ~5s, so targeting one flow is near-instant.

### All test suites and their names

| Suite | Pattern to use |
|---|---|
| Health checks + game registry | `"Service APIs"` |
| AM token, enable/disable game | `"Internal APIs"` |
| Individual exp endpoints | `"Experience APIs"` |
| Full bet → action → finish lifecycle | `"Flow: Bet"` |
| Session token activate + refresh | `"Flow: Lobby"` |
| Maintenance toggle | `"Flow: Game Maintenance"` |
| Kafka state propagation (bridge) | `"Flow: Bridge"` |

### Tip: combine with warm start

Services stay running after each `bun test` (by default). So the second time you run with a pattern, it hits warm start and the full run is:

```
git pull (~1s) → health check (~1s) → your 2-3 tests (~3s) = ~5s total
```

---

## How It Works

```
bun test
  └─ E2EOrchestrator.setupWorktrees()
       → kill zombie processes on config-derived ports
       → git pull all service repos (skipped if E2E_SKIP_PULL=1)
       → auto-detect warm start
  └─ E2EOrchestrator.startInfrastructure()     ← skipped on warm start
       → docker compose up (Kafka, Postgres, MongoDB, Redis, RustFS)
  └─ E2EOrchestrator.runGlobalMigrations()     ← skipped on warm start
       → @ikigaians/migrate up (Postgres schema, MongoDB indexes)
  └─ E2EOrchestrator.runServices()             ← skipped on warm start
       → npm install + npm run build (skipped if HEAD unchanged)
       → node ... start all services concurrently
       → parallel healthcheck polling
  └─ tests/e2e.spec.ts
       → poll game node until process cache loaded
       → seed EUR bet levels for LGS-004
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

## Configuration

There are two config files. Edit them to adjust how the test suite runs.

### `e2e-orchestrator.yml` — harness settings

Controls how the orchestrator provisions and manages infrastructure.

| Field | Default | Description |
|---|---|---|
| `global.worktreeBasePath` | `./.e2e-worktrees` | Where git repos are checked out |
| `global.cleanOnTeardown` | `false` | Keep services alive after run (enables warm start) |
| `global.network` | `null` | `null` = host networking. `"e2e-net"` = Docker bridge mode |
| `global.verbose` | `false` | `false` = logs to file only. `"errors"` = stderr to terminal too. `true` = everything to terminal |
| `repos.<name>.repoPath` | — | Sibling repo path |
| `repos.<name>.target` | `"main"` | Branch to check out |
| `composeServiceEnvOverrides` | — | Docker container env overrides for bridge network mode |

### `docker-compose.services.yml` — service definitions

Defines every Node.js service: command, ports, environment, health check, and startup dependencies.

Standard Docker Compose fields:

| Field | Description |
|---|---|
| `command` | The long-lived process to spawn |
| `environment` | Base environment variables |
| `ports` | `"hostPort:containerPort"` — orchestrator uses the host port |
| `healthcheck.test` | Orchestrator polls the `http://` URL until 200 |
| `depends_on` | Service must be healthy before this one starts |

Orchestrator-hint fields (Docker Compose ignores `x-*`):

| Field | Description |
|---|---|
| `x-repo` | Which worktree the source lives in |
| `x-env-file` | `.env.*.example` base file (relative to worktree) |
| `x-setup` | One-time build commands (cached by git hash) |
| `x-bridge-env` | Extra env applied when `global.network` is set |

### Changing the branch under test

Edit `e2e-orchestrator.yml`:
```yaml
repos:
  remote-game-server:
    target: "feature/my-awesome-feature"
```

The build cache invalidates automatically because HEAD changes.

---

## Environment Variable Flags

| Variable | Effect |
|---|---|
| `E2E_TEARDOWN=1` | Force stop all services and Docker after the run, even when `cleanOnTeardown` is false. Use when you're done for the day and want to free resources. |
| `E2E_SKIP_PULL=1` | Skip `git pull`. Use when testing local uncommitted changes — prevents `git reset --hard` from discarding your edits. Build cache + warm start still apply. |

```bash
# Done for the day — shut everything down
E2E_TEARDOWN=1 bun test

# Test local changes without git pulling
E2E_SKIP_PULL=1 bun test

# Both at once
E2E_TEARDOWN=1 E2E_SKIP_PULL=1 bun test
```

`E2E_SKIP_PULL=1` — do **not** use in CI. CI must always pull latest.

---

## Bridge Network Mode

By default the orchestrator uses `network_mode: "host"` so all services share `localhost`. This is required because Kafka advertises `localhost:9093` as its external listener.

To run with Docker bridge network isolation (e.g. stricter CI environments):

**1. Set `global.network` in `e2e-orchestrator.yml`:**
```yaml
global:
  network: "e2e-net"
```

**2. Update `docker-compose.e2e.yml`** — comment out `network_mode: "host"`, uncomment the bridge network section (see comments in that file).

**3. Fix the Redis cluster** (required for bridge mode):

The Valkey cluster startup script inside `remote-game-server/docker-compose.yml` hardcodes `127.0.0.1` for cluster gossip. In bridge mode, clients receive `MOVED` redirects to `127.0.0.1:600X` which resolves to the wrong container. Fix by adding `--cluster-announce-hostname redis-cluster` to each `valkey-server` invocation in that script.

**What `global.network` does automatically:**
- Creates the Docker network if it doesn't exist
- Generates `docker-compose.override.yml` files that attach all containers to the network and override Kafka's `KAFKA_CFG_ADVERTISED_LISTENERS` to use container names
- Merges `networkEnvOverrides` from each instance into its environment, repointing all `localhost` connection strings to container names

The `x-bridge-env` fields in `docker-compose.services.yml` already contain the full bridge-mode mapping for all services (Kafka, Redis, MongoDB, Postgres, RustFS).

---

## Ports

Ports come from `ports:` entries in `docker-compose.services.yml` (e.g. `"8080:8080"` → port 8080). No regex scanning needed.

After a successful start, the orchestrator prints a service endpoint table and writes two files:
- `.e2e-endpoints.json` — machine-readable `{ "billing": "http://127.0.0.1:8080", ... }`
- `E2E_Local.postman_environment.json` — drag-and-drop into Postman for manual API testing

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
├── e2e-orchestrator.yml         ← harness settings: repos, global flags, bridge-mode overrides
├── docker-compose.services.yml  ← service definitions: command, ports, env, healthcheck, depends_on
├── src/
│   └── E2EOrchestrator.ts       ← reads both YAMLs, spins up services, manages lifecycle
├── tests/
│   ├── e2e.spec.ts              ← root: beforeAll/afterAll + all describe suites
│   ├── specs/                   ← individual test suites (export runXxx functions)
│   └── utils/
│       ├── api.ts               ← fetch wrappers, log helpers, waitForCondition, propagateConfig
│       └── config.ts            ← BILLING/GAME URLs (parsed from docker-compose.services.yml)
├── run-e2e.sh                   ← wrapper: creates logs/<timestamp>/ folder, splits per-suite logs
├── docker-compose.e2e.yml       ← CI: runs orchestrator in a container
├── Dockerfile.e2e               ← CI: builds the orchestrator container image
└── logs/
    └── <timestamp>/
        ├── _master.log          ← all output (test + service logs)
        ├── _failures.log        ← failure summary with log file pointers (on failure)
        ├── billing-8080.log     ← per-service raw output
        ├── game-19080.log
        ├── ...
        ├── test_service-apis.log        ← per-suite test output
        ├── test_flow-bet-action.log
        └── ...
```

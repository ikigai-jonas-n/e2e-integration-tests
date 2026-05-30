# E2E Integration Tests — Session Handover

**Written:** 2026-05-30  
**Purpose:** Complete context dump for the next Claude session. Read this before touching anything.

---

## What This Repo Is

Integration test suite for a multi-service slot gaming platform. It:
1. Checks out sibling repos via git worktree
2. Spins up Docker infra (Kafka, Postgres, MongoDB, Redis, S3)
3. Builds and starts 6 Node.js services
4. Runs typed TypeScript tests using `bun:test`
5. Leaves services running (warm start for next run)

**Entry point:** `bun test` → discovered by `run-e2e.sh` → orchestrated by `src/E2EOrchestrator.ts`

---

## Directory Layout

```
e2e-integration-tests/           ← this repo
├── e2e-config.json              ← ALL configuration (services, ports, env, network)
├── run-e2e.sh                   ← wrapper: creates timestamped log + prints failure summary
├── src/
│   └── E2EOrchestrator.ts       ← spins up Docker, git worktrees, builds, Node.js services
├── tests/
│   ├── e2e.spec.ts              ← orchestrates all suites (beforeAll/afterAll)
│   ├── specs/
│   │   ├── service.spec.ts      ← unit-style: healthchecks, game registry
│   │   ├── internal.spec.ts     ← unit-style: AM token, enable/disable game
│   │   ├── exp.spec.ts          ← unit-style: individual exp/* endpoints
│   │   ├── bet-n-action-flow.spec.ts  ← flow: session→activate→bet→action?→finish?
│   │   ├── lobby-flow.spec.ts   ← flow: session-token activate + refresh
│   │   ├── maintenance-flow.spec.ts   ← flow: isMaintenance toggle
│   │   └── bridge-flow.spec.ts  ← flow: Kafka propagation billing→game node (slow: 65s poll)
│   └── utils/
│       ├── api.ts               ← fetch wrappers + log/logError/logWarn (truncated) + propagateConfig/resetGameState
│       └── config.ts            ← BILLING/GAME URLs derived from e2e-config.json
├── docker-compose.e2e.yml       ← CI only: runs orchestrator container (network_mode: host)
├── Dockerfile.e2e               ← CI container image
├── original_bashscripts/        ← original bash prototypes (reference only, not executed)
│   ├── bet-flow.sh
│   ├── bridge-flow.sh
│   ├── lobby-flow.sh
│   └── maintenance-flow.sh
└── logs/                        ← e2e-run-TIMESTAMP.log (gitignored)
```

---

## Services and Ports

| Service | Port | Type | Notes |
|---|---|---|---|
| `sgs-core` (slot-game-server) | 9000 | BILLING equivalent for SGS | Requires rebuild on code change |
| `billing` (remote-game-server) | 8080 | BILLING cloud region | Source of truth for game data |
| `game-activity` | 8070 | PERIPHERAL | Tracks player activity |
| `bridge` | 7001 | PERIPHERAL | Bridges Kafka → Redis |
| `job-stale-rounds` | 8090 | JOB | Closes stale rounds |
| `job-close-inactive` | 8091 | JOB | Closes inactive sessions |
| `game` (remote-game-server) | 19080 | PERIPHERAL | Handles player sessions/bets |

**Infra containers:**
- Kafka (region): `9092/9093`, Kafka (global): `9192/9193`
- MongoDB: `27017/27018`, Postgres: `5437`, Redis cluster: `6000-6005`, RustFS: `7002-7003`

---

## API Response Wrapper — CRITICAL

**Every** remote-game-server endpoint wraps in `{ error: null, data: {...} }`:

```json
GET /v2/service/games → { "error": null, "data": { "games": [...] } }
```

Access pattern in tests: `res.data?.data?.games` (double `.data`).

**Exceptions (no wrapper):**
- Fastify 404: `{ "message": "...", "error": "Not Found", "statusCode": 404 }` — NO `data` key

---

## Known API Quirks

### sync-games endpoint
- **Only on billing (8080)** — game node (19080) returns 404 for `GET /v2/service/sync-games`
- Billing returns `{ error, data: { games: [...] } }` with FULL game data including `betLevels`
- `GET /v2/service/games` (both nodes) returns SUMMARY — no `betLevels` in response

### betLevels structure
After PATCH, `betLevels` shape in sync-games response:
```json
{ "default": { "EUR": [{"type":"regular","value":"2","default":true}], "AED": [...] } }
```
Check with: `game.betLevels?.default && Object.keys(game.betLevels.default).length > 0`

### /v2/service/game (single game)
- `game` (no trailing s) — **only on billing**, not on game node
- Returns 404 on game node

### Session start response
```json
{ "error": null, "data": { "launchUrl": "http://...?token=XXX&...", "session": "uuid" } }
```
Extract session token: `launchUrl.match(/[?&]token=([^&]+)/)?.[1]`

### Session activate response
```json
{ "error": null, "data": { "token": "ACCESS_JWT" } }
```
Access token is at `res.data?.data?.token ?? res.data?.data?.accessToken`.

### Bet response
```json
{
  "error": null,
  "data": {
    "roundId": "uuid",
    "actions": [...],
    "results": { "gameResponse": { "step": { "summary": { "coins": 0.16 } } } }
  }
}
```
- `actions` present → call `/v2/exp/play/action` before finish
- `coins > 0` → explicit finish needed (else round auto-closed)
- `coins == 0` → no finish call needed

---

## Game Data Flow (BILLING → GAME NODE)

**Architecture:**
```
DB (Postgres) → billing process cache → Kafka GAME_DATA event → bridge → Redis → game node cron (60s)
```

**Critical timing:**
- Game node `games-collection-sync` cron: **every 60s**
- On startup: runs immediately, tries Redis → if empty falls back to billing HTTP
- Redis key: `{no_version}:gameCodes` (VERSION env var unset → defaults to `no_version`)

**`propagateConfig(amToken)` in api.ts does:**
1. GET games from billing process cache
2. PATCH all games status → fires Kafka GAME_DATA event → bridge updates Redis
3. Wait 2.5s for bridge processing
4. `docker exec redis-cluster valkey-cli -c -p 6000 DEL {no_version}:gameCodes`
   → game node's next cron: Redis empty → falls back to billing → GUARANTEED fresh data

**Result:** poll loops use 65s (= 60s max cron + 5s buffer). Cannot be eliminated without adding a force-sync HTTP endpoint to the game node.

---

## Player IDs — CRITICAL

**Only `kyle0c` is registered in the external money/player services.**

Session start requires a valid player in `https://money-service.iki-cit.cc`. If you invent a player ID like `bet-flow-player`, the session starts (200) but the subsequent BET fails (400/500) because the debit call to money-service finds no account.

**Always use:**
```ts
playerId: 'QARealGameOperator:QARealGameBrand:kyle0c'
externalPlayerId: 'kyle0c'
```

**External services in use:**
- `https://money-service.iki-cit.cc` — debit/credit for bets
- `https://player-service.iki-cit.cc` — player validation
- `https://api-hub.iki-cit.cc` — jurisdiction settings
- `https://api-hub-gs1.iki-cit.cc` — game node variant

---

## Warm Start Mechanism

After every successful `bun test`, services stay running (`cleanOnTeardown: false`). Next run:

1. `setupWorktrees()` → git pull (no docker-compose down)
2. `detectWarmStart()` → checks health + commit-hash cache
3. If all healthy + no code changes → **WARM START** (~5s total)

**Build cache:** `.e2e-state.json` per repo stores `{ commit: "HEAD_SHA", dirty: "hash(git diff HEAD)" }`.
- Invalidates on new commit OR local file edits
- Excludes `docker-compose.yml` and `.env*` from dirty hash (orchestrator mutates those)

**Force teardown:** `E2E_TEARDOWN=1 bun test`
**Skip git pull:** `E2E_SKIP_PULL=1 bun test`

---

## Service Log Verbosity

Controlled by `"verbose"` in `e2e-config.json`:

| Value | Service stdout | Service stderr |
|---|---|---|
| `false` (default) | Log file only | Log file only |
| `"errors"` | Log file only | Log file **+ terminal** |
| `true` | Log file + terminal | Log file + terminal |

Service logs **always** go to the log file via `E2E_LOG_FILE` env var passed from `run-e2e.sh`. The orchestrator opens a WriteStream and appends directly, separate from bun:test's tee'd output.

---

## Failure Summary in Terminal

`run-e2e.sh` runs a grep on the log after test completion. Patterns captured:
- `error:` — assertion failures, import errors, hook timeouts
- `Expected:` / `Received:` — expect comparison
- `at <anonymous>` — spec file:line:col (clickable in VS Code terminal)
- `(fail)` — test name + duration
- `^ ` — hook timeout explanation
- `# Unhandled` — unhandled error section header

Server stack frames (`at RoundService...`) are intentionally excluded — they're service code, not test code.

---

## Test Suite Structure

Tests are registered in `e2e.spec.ts` via `describe(name, runFn)`. The run order matters:

1. **Service APIs** — healthchecks, `GET /v2/service/games`, `GET /v2/service/sync-games`
2. **Internal APIs** — AM token, disable/re-enable LGS-004 (uses `propagateConfig`)
3. **Experience APIs** — individual exp/* endpoint tests
4. **Flow: Bet + Action** — full session→activate→bet→action?→finish? lifecycle
5. **Flow: Lobby Session Token** — session-token activate + refresh
6. **Flow: Game Maintenance** — isMaintenance toggle, verified via sync-games (no cron wait)
7. **Flow: Bridge & State Propagation** — LAST because it disables/re-enables LGS-004 (65s poll)

---

## Known Issues / Outstanding Work

### Round is not in status for finish
`exp.spec.ts` always calls `/v2/exp/play/finish`. If a previous session left an open round for `kyle0c`, the finish call returns 400. Test accepts `[200, 400, 409]`. Resolves after ~20 min (job-close-inactive cleans stale rounds).

### sync-games check game node (removed)
`propagateConfig` previously called `${GAME}/v2/service/sync-games` expecting it to force a sync. This endpoint returns **404** on game node (PERIPHERAL nodes don't register it — they have no Postgres access). The call was removed and replaced with `docker exec redis-cluster valkey-cli DEL {no_version}:gameCodes`.

### Game node sync still bounded by 60s cron
The ONLY way to eliminate the 65s poll in `bridge-flow.spec.ts` and `internal.spec.ts` is to add a `POST /v2/service/force-games-sync` endpoint to the game node (PERIPHERAL) that calls `gamesCollectionSyncJob.process()`. This would require a change to `remote-game-server`.

### service.spec.ts — currencies field
`Billing /v2/service/sync-games has LGS-004 with currencies` checks `Array.isArray(game.currencies)`. This field exists in the actual API response (confirmed by passing tests) but isn't in the TypeBox DTO definition that was inspected. Don't remove this test.

### Lobby flow — session left open
`lobby-flow.spec.ts` starts a session but does NOT close it (no `/v2/service/session/stop`). The `job-close-inactive` service handles cleanup. If the test runs frequently, it accumulates open sessions for `kyle0c`.

### Docker compose files are mutated
`startInfrastructure()` patches docker-compose.yml to remap AirPlay-conflicting ports (7000→7002, 7001→7003). This creates a `git diff HEAD` in the worktree. The build cache excludes `docker-compose*` and `.env*` from the dirty hash to prevent false cache invalidation.

---

## e2e-config.json — Full Reference

```
global.worktreeBasePath     "./.e2e-worktrees"   where git worktrees go
global.cleanOnTeardown      false                 keep services alive after run
global.network              null                  null=host, "e2e-net"=bridge
global.verbose              false                 false/true/"errors" service log control

services[name].repoPath                           relative path to sibling repo
services[name].target                             git branch to checkout
services[name].composeServiceEnvOverrides         per-docker-service env (bridge network only)
instances[i].name                                 human name, used in logs
instances[i].envBase                              .env.*.example file to base from
instances[i].envOverrides                         applied on top of envBase (always)
instances[i].networkEnvOverrides                  applied ONLY when global.network is set
instances[i].commands[].run                       command string
instances[i].commands[].sync                      true=run before start (install/build)
instances[i].healthCheck                          URL polled until 200
```

---

## Running Tests

```bash
bun test                         # full suite, auto warm-start if possible
bun test -t "Flow: Bet"          # only bet+action flow
bun test -t "Service APIs"       # only smoke/healthchecks
bun test -t "Flow: Bridge"       # Kafka propagation (slow: ~65s)
bun test -t "Step 3: Bet"        # any test named Step 3: Bet
E2E_TEARDOWN=1 bun test          # run then shut everything down
E2E_SKIP_PULL=1 bun test         # test local uncommitted changes
```

---

## Adding a New Flow Test

1. Create `tests/specs/my-flow.spec.ts`:
```ts
import { it, expect } from 'bun:test';
import { api, logError } from '../utils/api';
import { BILLING, GAME, SVC_SIG } from '../utils/config';

export function runMyFlowTests() {
  it('Step 1: ...', async () => {
    const res = await api.post(`${GAME}/v2/...`, { ... }, { headers: SVC_SIG });
    if (res.status !== 200) logError('[my-flow/step1]', res.data);
    expect(res.status).toBe(200);
    // access: res.data?.data?.someField (always double .data for wrapped responses)
  });
}
```

2. Import and register in `tests/e2e.spec.ts`:
```ts
import { runMyFlowTests } from './specs/my-flow.spec';
describe('Flow: My New Flow', runMyFlowTests);
```

3. If the flow changes game state, put it BEFORE `bridge-flow` and call `api.resetGameState(gameCode, amToken)` in the last step to restore.

---

## Bridge Network Mode (Incomplete)

`global.network: "e2e-net"` enables bridge mode. The orchestrator:
1. Creates the Docker network
2. Generates `docker-compose.override.yml` per service (attaches containers + overrides Kafka advertised listeners)
3. Merges `networkEnvOverrides` into Node.js service environments

**BLOCKER:** Redis cluster startup script hardcodes `127.0.0.1` for cluster gossip. Bridge-mode clients get `MOVED` redirects to `127.0.0.1:6000X` which resolves to orchestrator's loopback (wrong). Fix: add `--cluster-announce-hostname redis-cluster` to each `valkey-server` invocation in `remote-game-server/docker-compose.yml`.

---

## CI Usage

```bash
docker-compose -f docker-compose.e2e.yml up --abort-on-container-exit
```

`network_mode: "host"` is **required** — Kafka advertises `localhost:9093`, which only resolves correctly when orchestrator shares host network. Bridge networking breaks Kafka client connections.

---

## Troubleshooting Cheatsheet

| Symptom | Cause | Fix |
|---|---|---|
| `Timeout: game node process cache never populated` | billing process cache not ready when game node's startup cron ran | wait ~60s and retry; or check service logs |
| `Flow: Bet + Action > Step 3: Bet` fails | player not in external services OR betLevels not set to EUR/2 | check `resetGameState` ran; confirm `kyle0c` is the player |
| `EADDRINUSE port 7001` | previous run left bridge process alive, port not cleared | port 7001 is in `envOverrides.RGS_PORT` so cleanup picks it up; if still stuck: `E2E_TEARDOWN=1 bun test` |
| `(unnamed) hook timed out` | `afterAll` exceeded default 5s | ensure `afterAll(..., 60000)` has 60s timeout |
| Warm start falsely triggered | services crashed silently with ports still bound | `E2E_TEARDOWN=1 bun test` to force full restart |
| Service logs missing from log file | script run via `bun test` directly (not `bun test` via `run-e2e.sh`) | `E2E_LOG_FILE=logs/debug.log bun test` to force logging |
| Build cache stuck / won't rebuild | `.e2e-state.json` has wrong commit hash | `rm .e2e-worktrees/{repo}/.e2e-state.json` |

---

## Session History Summary

This session (2026-05-30) built the TypeScript/bun test infrastructure from scratch on top of the existing bash scripts. Key work done:

- Rewrote E2EOrchestrator with warm start, build cache, port detection, service log control
- Created 7 test spec files mirroring the original bash scripts
- Fixed response structure bugs (`data.data.games` double-wrapper)
- Fixed player ID issue (only `kyle0c` works in external services)
- Added `propagateConfig` + Redis eviction for game sync
- Created failure summary in `run-e2e.sh` with clickable file:line:col
- Added verbose/log control (`false`/`true`/`"errors"`)
- Documented bridge network support (incomplete — Redis cluster blocker)

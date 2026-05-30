import { afterAll, beforeAll, describe } from 'bun:test';
import { E2EOrchestrator } from '../src/E2EOrchestrator';
import { api, log } from './utils/api';
import { BILLING, GAME, SVC_SIG } from './utils/config';

// Unit-test style specs (individual endpoint coverage)
import { runExpTests } from './specs/exp.spec';
import { runInternalTests } from './specs/internal.spec';
import { runServiceTests } from './specs/service.spec';

// Flow specs (end-to-end lifecycle tests, each step depends on the previous)
import { runBetAndActionFlow } from './specs/bet-n-action-flow.spec';
import { runBridgeFlowTests } from './specs/bridge-flow.spec';
import { runLobbyFlowTests } from './specs/lobby-flow.spec';
import { runMaintenanceFlowTests } from './specs/maintenance-flow.spec';

const orchestrator = new E2EOrchestrator();

beforeAll(async () => {
  await orchestrator.setupWorktrees();
  await orchestrator.startInfrastructure();
  await orchestrator.runGlobalMigrations();
  await orchestrator.runServices();

  log('[setup] Waiting for caches to warm up (Billing + Game)...');
  let cacheReady = false;
  // Increase timeout to 120s for slow cold starts
  for (let i = 0; i < 120; i++) {
    try {
      const [bRes, gRes] = await Promise.all([
        api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG }),
        api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG }),
      ]);

      const bGames = bRes.data?.data?.games ?? bRes.data?.data ?? [];
      const gGames = gRes.data?.data?.games ?? gRes.data?.data ?? [];

      if (bGames.length > 0 && gGames.length > 0) {
        log(`[setup] Caches ready: Billing(${bGames.length}), Game(${gGames.length})`);
        cacheReady = true;
        break;
      }

      if (i % 10 === 0) {
        log(`[setup] Progress: Billing=${bGames.length} games, Game=${gGames.length} games...`);
      }
    } catch (e) {
      if (i % 20 === 0) log(`[setup] Connection pending...`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!cacheReady)
    throw new Error(
      'Timeout: Services online but process caches are empty. Check DB connectivity.',
    );
  log('✅ Setup complete.');
}, 600000);

afterAll(async () => {
  await orchestrator.teardown();
}, 60000);

// ── Suite + test control ───────────────────────────────────────────────────────
//
// Skip suites by slug:         E2E_SKIP_SUITES=flow-maintenance,flow-bridge bun test:raw
// Run only specific suites:    E2E_SUITES=service-apis,flow-bet-action bun test:raw
//
// Skip slow tests:             E2E_FAST=1 bun test:raw
//   Skips any test declared with itSlow() whose expected duration > E2E_SLOW_MS (default 5000).
//   Override threshold:        E2E_SLOW_MS=10000 E2E_FAST=1 bun test:raw
//
// Suite slugs: service-apis, internal-apis, experience-apis,
//              flow-bet-action, flow-lobby, flow-maintenance, flow-bridge

const _skip = new Set(
  (process.env.E2E_SKIP_SUITES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const _only = new Set(
  (process.env.E2E_SUITES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
// (slow-test gating: see tests/utils/test-helpers.ts → itSlow)

function suite(slug: string, label: string, fn: () => void) {
  const active = (_only.size === 0 || _only.has(slug)) && !_skip.has(slug);
  const runner = active ? describe : describe.skip;
  runner(label, () => {
    beforeAll(() => process.stdout.write(`__E2E_SUITE_START__:${slug}\n`));
    afterAll(() => process.stdout.write(`__E2E_SUITE_END__:${slug}\n`));
    fn();
  });
}

// ==========================================
// UNIT-TEST STYLE — individual endpoints
// ==========================================
suite('service-apis', 'Service APIs   (/v2/service/*)', runServiceTests);
suite('internal-apis', 'Internal APIs  (/v1/internal/*)', runInternalTests);
suite('experience-apis', 'Experience APIs (/v2/exp/*)', runExpTests);

// ==========================================
// FLOW SPECS — full lifecycle tests
// ==========================================
suite('flow-bet-action', 'Flow: Bet + Action', runBetAndActionFlow);
suite('flow-lobby', 'Flow: Lobby Session Token', runLobbyFlowTests);
suite('flow-maintenance', 'Flow: Game Maintenance', runMaintenanceFlowTests);

// Bridge flow last — it disables / re-enables LGS-004 (may affect cron state)
suite('flow-bridge', 'Flow: Bridge & State Propagation', runBridgeFlowTests);

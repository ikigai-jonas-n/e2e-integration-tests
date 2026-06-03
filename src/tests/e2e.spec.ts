import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { afterAll, beforeAll, describe } from 'bun:test';
import { E2EOrchestrator } from '../E2EOrchestrator';
import { api } from './utils/api';
import { BILLING_URL, GAME_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE } from './utils/config';

// Unit-test style specs (individual endpoint coverage)
import { runExpTests } from './specs/exp.spec';
import { runInternalTests } from './specs/internal.spec';
import { runServiceTests } from './specs/service.spec';

// Flow specs (end-to-end lifecycle tests, each step depends on the previous)
import { runBetAndActionFlow } from './specs/bet-n-action-flow.spec';
import { runBridgeSyncBugTests } from './specs/bridge-flow-must-sync-all-games.spec';
import { runBridgeFlowTests } from './specs/bridge-flow.spec';
import { runLobbyFlowTests } from './specs/lobby-flow.spec';
import { runMaintenanceFlowTests } from './specs/maintenance-flow.spec';

const orchestrator = new E2EOrchestrator();

beforeAll(async () => {
  await orchestrator.ensureReady(api, BILLING_URL, GAME_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE);
}, 600000);

afterAll(async () => {
  // Await background branch validation before tearing down.
  // If any branch moved on remote: deletes ready-state, exits 75 → wrapper reruns.
  await orchestrator.awaitBackgroundValidation();
  await orchestrator.teardown();
}, 60000);

// ── Suite + test control ───────────────────────────────────────────────────────

// 1. Read default skips from the Orchestrator YAML
const orchCfg = parseYaml(fs.readFileSync(path.resolve('./src/e2e-orchestrator.yml'), 'utf-8'));
const yamlSkips: string[] = orchCfg?.global?.skipSuites ?? [];

// 2. Read CLI environment variables (allows developers to override via CLI)
const envSkips = (process.env.E2E_SKIP_SUITES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const envOnly = (process.env.E2E_SUITES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 3. Merge them into sets
const _skip = new Set([...yamlSkips, ...envSkips]);
const _only = new Set(envOnly);

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
suite('flow-bridge-must-sync-all-games', 'Flow: Brand New Game Sync', runBridgeSyncBugTests);

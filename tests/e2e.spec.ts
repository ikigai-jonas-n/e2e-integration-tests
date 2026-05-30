import { beforeAll, afterAll, describe } from 'bun:test';
import { E2EOrchestrator } from '../src/E2EOrchestrator';
import { api, log } from './utils/api';
import { BILLING, GAME, SVC_SIG } from './utils/config';

// Unit-test style specs (individual endpoint coverage)
import { runServiceTests }  from './specs/service.spec';
import { runInternalTests } from './specs/internal.spec';
import { runExpTests }      from './specs/exp.spec';

// Flow specs (end-to-end lifecycle tests, each step depends on the previous)
import { runBetAndActionFlow }     from './specs/bet-n-action-flow.spec';
import { runLobbyFlowTests }       from './specs/lobby-flow.spec';
import { runMaintenanceFlowTests } from './specs/maintenance-flow.spec';
import { runBridgeFlowTests }      from './specs/bridge-flow.spec';

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
        api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG })
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
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!cacheReady) throw new Error('Timeout: Services online but process caches are empty. Check DB connectivity.');
  log('✅ Setup complete.');
}, 600000);

afterAll(async () => {
  await orchestrator.teardown();
}, 60000);

// ── Suite marker helpers ───────────────────────────────────────────────────────
// run-e2e.sh parses __E2E_SUITE_START__/<END__ markers to split per-suite log files.
function suiteMarkers(slug: string) {
  return {
    beforeAll: () => process.stdout.write(`__E2E_SUITE_START__:${slug}\n`),
    afterAll:  () => process.stdout.write(`__E2E_SUITE_END__:${slug}\n`),
  };
}

// ==========================================
// UNIT-TEST STYLE — individual endpoints
// ==========================================
describe('Service APIs   (/v2/service/*)', () => {
  const m = suiteMarkers('service-apis');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runServiceTests();
});

describe('Internal APIs  (/v1/internal/*)', () => {
  const m = suiteMarkers('internal-apis');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runInternalTests();
});

describe('Experience APIs (/v2/exp/*)', () => {
  const m = suiteMarkers('experience-apis');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runExpTests();
});

// ==========================================
// FLOW SPECS — full lifecycle tests
// ==========================================
describe('Flow: Bet + Action', () => {
  const m = suiteMarkers('flow-bet-action');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runBetAndActionFlow();
});

describe('Flow: Lobby Session Token', () => {
  const m = suiteMarkers('flow-lobby');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runLobbyFlowTests();
});

describe('Flow: Game Maintenance', () => {
  const m = suiteMarkers('flow-maintenance');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runMaintenanceFlowTests();
});

// Bridge flow last — it disables / re-enables LGS-004 (may affect cron state)
describe('Flow: Bridge & State Propagation', () => {
  const m = suiteMarkers('flow-bridge');
  beforeAll(m.beforeAll);
  afterAll(m.afterAll);
  runBridgeFlowTests();
});

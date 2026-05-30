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

  log('[setup] Waiting for caches to warm up...');
  let cacheReady = false;
  for (let i = 0; i < 90; i++) {
    try {
      const bRes = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
      const gRes = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });

      const bGames = bRes.data?.data?.games ?? bRes.data?.data;
      const gGames = gRes.data?.data?.games ?? gRes.data?.data;

      if (Array.isArray(bGames) && bGames.length > 0 && Array.isArray(gGames) && gGames.length > 0) {
        log(`[setup] Both caches ready after ~${i}s (billing: ${bGames.length}, game: ${gGames.length} games)`);
        cacheReady = true;
        break;
      }
      if (i > 0 && i % 15 === 0) {
        const bOk = Array.isArray(bGames) && bGames.length > 0;
        const gOk = Array.isArray(gGames) && gGames.length > 0;
        log(`[setup] Still waiting... billing=${bOk ? 'ready' : 'empty'}, game=${gOk ? 'ready' : 'empty'}`);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!cacheReady) throw new Error('Timeout waiting for process caches (billing + game node).');
  log('✅ Setup complete.');
}, 600000);

afterAll(async () => {
  await orchestrator.teardown();
}, 60000);

// ==========================================
// UNIT-TEST STYLE — individual endpoints
// ==========================================
describe('Service APIs   (/v2/service/*)',  runServiceTests);
describe('Internal APIs  (/v1/internal/*)', runInternalTests);
describe('Experience APIs (/v2/exp/*)',     runExpTests);

// ==========================================
// FLOW SPECS — full lifecycle tests
// ==========================================
describe('Flow: Bet + Action',            runBetAndActionFlow);
describe('Flow: Lobby Session Token',     runLobbyFlowTests);
describe('Flow: Game Maintenance',        runMaintenanceFlowTests);

// Bridge flow last — it disables / re-enables LGS-001 (may affect cron state)
describe('Flow: Bridge & State Propagation', runBridgeFlowTests);

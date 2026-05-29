import { beforeAll, afterAll, describe } from 'bun:test';
import { E2EOrchestrator } from '../src/E2EOrchestrator';
import { api } from './utils/api';
import { BILLING, GAME, SVC_SIG } from './utils/config';

// Import Domain & Flow Tests
import { runServiceTests } from './specs/service.spec';
import { runInternalTests } from './specs/internal.spec';
import { runBridgeFlowTests } from './specs/bridge.spec';
import { runExpTests } from './specs/exp.spec';

const orchestrator = new E2EOrchestrator();

beforeAll(async () => {
  await orchestrator.setupWorktrees();
  await orchestrator.startInfrastructure();
  await orchestrator.runGlobalMigrations();
  await orchestrator.runServices();

  console.log('[setup] Waiting for caches to warm up...');
  let cacheReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const bRes = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
      const gRes = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      
      const bGames = bRes.data?.data?.games ?? bRes.data?.data;
      const gGames = gRes.data?.data?.games ?? gRes.data?.data;
      
      if (Array.isArray(bGames) && Array.isArray(gGames) && gGames.length > 0) {
        cacheReady = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!cacheReady) throw new Error('Timeout waiting for process caches.');
  console.log('✅ Setup complete.');
}, 600000);

afterAll(async () => {
  await orchestrator.teardown();
});

// ==========================================
// REGISTER SUITES (Order Matters!)
// ==========================================

// 1. Check basic health and registry endpoints
describe('Service APIs (/v2/service/*)', runServiceTests);
describe('Internal APIs (/v2/internal/*)', runInternalTests);

// 2. Test Kafka propagation. This ends by setting LGS-001 to enabled and EUR bet level to 2.
// describe('Flow: Bridge & State Propagation', runBridgeFlowTests);

// 3. Test actual gameplay now that the environment is proven ready.
describe('Experience APIs (/v2/exp/*) - Bet Flow', runExpTests);
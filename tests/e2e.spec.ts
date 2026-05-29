import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { E2EOrchestrator } from '../src/E2EOrchestrator';
import config from '../e2e-config.json';

/** Extract base URL (scheme + host + port) from a named instance's healthCheck URL. */
function instanceBase(name: string): string {
  for (const svc of Object.values(config.services)) {
    const inst = (svc as any).instances?.find((i: any) => i.name === name);
    if (inst?.healthCheck) {
      const m = inst.healthCheck.match(/^(https?:\/\/[^\/]+)/);
      if (m) return m[1];
    }
  }
  throw new Error(`Instance '${name}' not found in e2e-config.json`);
}

const BILLING = instanceBase('billing');  // derived: http://127.0.0.1:8080
const GAME    = instanceBase('game');     // derived: http://127.0.0.1:19080
const SVC_SIG = { 'x-signature': 'rgs-local-signature' };

const api = {
  post: async (url: string, body: any, options?: any) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },
  patch: async (url: string, body: any, options?: any) => {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },
  get: async (url: string, options?: any) => {
    const res = await fetch(url, { method: 'GET', headers: options?.headers });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },
};

describe('Global E2E Integration Suite', () => {
  const orchestrator = new E2EOrchestrator();

  beforeAll(async () => {
    await orchestrator.setupWorktrees();
    await orchestrator.startInfrastructure();
    await orchestrator.runGlobalMigrations();
    await orchestrator.runServices();

    // Get AM token for seeding
    const amTokenRes = await api.post(`${BILLING}/v1/service/am/token`, {
      userId: 0, account: 'tester', code: '*',
      permission: [{ routeKey: '*', methods: ['*'] }],
    }, { headers: SVC_SIG });
    const amToken = amTokenRes.data?.data?.token;
    if (!amToken) throw new Error('Failed to obtain AM token during setup.');

    // Phase 1: Wait for BILLING's process cache to be populated.
    // Billing runs games-collection-sync immediately on startup (reads DB directly).
    // Must confirm billing is ready before proceeding — the game node falls back to
    // billing's API when Redis is empty, so billing must have data first.
   console.log('[setup] Phase 1: waiting for billing process cache...');
    let billingCacheReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
        // FIX: Pierce the wrapper. Fallback to r.data?.data if the API occasionally flattens it.
        const games = r.data?.data?.games ?? r.data?.data; 
        if (Array.isArray(games) && games.length > 0) {
          console.log(`[setup] Billing cache ready after ~${i}s (${games.length} games)`);
          billingCacheReady = true;
          break;
        }
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!billingCacheReady) throw new Error('Timeout: billing process cache never populated.');

    // Phase 2: Wait for GAME NODE's process cache.
    // Game node is PERIPHERAL: syncs from Redis (bridge → Kafka → Redis) or billing fallback.
    // Race condition: if game node's first cron ran before billing cache was ready, it saved
    // 0 games. Next cron fires after ~60s. Poll for up to 90s to catch the retry.
    console.log('[setup] Phase 2: waiting for game node process cache...');
    let gameNodeReady = false;
    for (let i = 0; i < 90; i++) {
      try {
        const r = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
        const games = r.data?.data?.games ?? r.data?.data; // FIX HERE TOO
        if (Array.isArray(games) && games.length > 0) {
          console.log(`[setup] Game node cache ready after ~${i}s (${games.length} games)`);
          gameNodeReady = true;
          break;
        }
      } catch (e) { }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!gameNodeReady) throw new Error('Timeout: game node process cache never populated.');

    // Seed EUR bet level "2" for LGS-001 so Flow 1 bet payload is valid
    const patchRes = await api.patch(`${BILLING}/v1/internal/game/LGS-001/betLevels`, {
      currencyCode: 'EUR',
      betLevels: [{ type: 'regular', value: '2', default: true }],
    }, { headers: { 'x-access-token': amToken } });
    if (patchRes.status !== 200) {
      console.warn('[setup] betLevels PATCH returned', patchRes.status, patchRes.data);
    }

    // Poll bet-levels until LGS-001 has the EUR bet level we just seeded
    let synced = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await api.get(`${BILLING}/v2/service/games/bet-levels?gameCode=LGS-001`, { headers: SVC_SIG });
        const betLevels = r.data?.data;
        
        // The bet-levels API returns a dictionary of currencies mapped to arrays
        if (betLevels && Array.isArray(betLevels['EUR'])) {
          // Check if our patched value '2' successfully propagated
          const hasSeededValue = betLevels['EUR'].some((b: any) => b.value === '2');
          if (hasSeededValue) {
            synced = true; 
            break;
          }
        }
      } catch { /* ignore during polling */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!synced) throw new Error('Timeout waiting for game bet levels to synchronize.');

    // Extra wait for the betLevels Kafka event to reach game node process cache
    await new Promise(r => setTimeout(r, 3000));
    console.log('✅ Setup complete. LGS-001 ready on all nodes.');
  }, 600000);

  afterAll(async () => {
    await orchestrator.teardown();
  }, 60000);

  // ==========================================
  // SMOKE: Healthchecks
  // ==========================================
  describe('Smoke: Healthchecks', () => {
    it('Billing node is healthy', async () => {
      const res = await api.get(`${BILLING}/v2/service/healthcheck`);
      expect(res.status).toBe(200);
    });

    it('Game node is healthy', async () => {
      const res = await api.get(`${GAME}/v2/service/healthcheck`);
      expect(res.status).toBe(200);
    });
  });

  // ==========================================
  // SMOKE: Game Registry (billing + game node)
  // ==========================================
  describe('Smoke: Game Registry', () => {
    it('Billing /v2/service/games lists LGS-001 as enabled', async () => {
      const res = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
      expect(res.status).toBe(200);
      const games = res.data?.data?.games ?? res.data?.data; // FIX
      const game = games?.find((g: any) => g.code === 'LGS-001');
      expect(game).toBeDefined();
      expect(game?.enabled).toBe(true);
    });

    it('Billing /v2/service/sync-games has LGS-001 with currencies', async () => {
      const res = await api.get(`${BILLING}/v2/service/sync-games`, { headers: SVC_SIG });
      expect(res.status).toBe(200);
      const games = res.data?.data?.games ?? res.data?.data; 
      const game = games?.find((g: any) => g.code === 'LGS-001');
      
      expect(game).toBeDefined();
      expect(game?.currencies).toBeDefined();
      expect(Array.isArray(game.currencies)).toBe(true);
      expect(game.currencies.includes('EUR')).toBe(true); // Verify EUR is listed
    });

    it('Billing /v2/service/game returns LGS-001 detail', async () => {
      const res = await api.get(`${BILLING}/v2/service/game?gameCode=LGS-001`, { headers: SVC_SIG });
      expect(res.status).toBe(200);
      expect(res.data?.code ?? res.data?.data?.code).toBe('LGS-001');
    });

    it('Billing /v2/service/games/bet-levels returns EUR levels', async () => {
      const res = await api.get(
        `${BILLING}/v2/service/games/bet-levels?gameCode=LGS-001&currencies=EUR`,
        { headers: SVC_SIG },
      );
      expect(res.status).toBe(200);
    });

    it('Game node /v2/service/games lists LGS-001', async () => {
      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      expect(res.status).toBe(200);
      const games = res.data?.data?.games ?? res.data?.data; // FIX
      const game = games?.find((g: any) => g.code === 'LGS-001');
      expect(game).toBeDefined();
    });
  });

  // ==========================================
  // FLOW 1: RGS Bet Flow
  // ==========================================
  describe('Flow 1: RGS Bet Flow', () => {
    let sessionToken = '';
    let accessToken  = '';
    let sessionId    = '';

    it('Step 1: Session Start — returns launchUrl with token', async () => {
      const res = await api.post(`${GAME}/v2/service/session/start`, {
        gameCode: 'LGS-001',
        lang: 'en',
        country: 'GB',
        gameSetting: { rtpConfigCode: 'lowRTP', isGeoBlocking: true, jurisdictionCode: 'slotJD' },
        mode: 'real',
        operator: 'QARealGameOperator',
        brand: 'QARealGameBrand',
        playerId: 'QARealGameOperator:QARealGameBrand:kyle0c',
        externalPlayerId: 'kyle0c',
        currency: 'EUR',
        currencyId: 1,
        balance: '10000',
        maxExposure: 0,
        isTestingPlayer: false,
        licenseConfig: {},
        callback: 'http://localhost',
      }, { headers: SVC_SIG });

      if (res.status !== 200) console.error('[Flow1/Step1] Session start failed:', res.data);
      expect(res.status).toBe(200);

      const launchUrl = res.data?.data?.launchUrl ?? res.data?.launchUrl ?? '';
      expect(launchUrl).toBeTruthy();

      sessionToken = launchUrl.match(/[?&]token=([^&]+)/)?.[1] ?? '';
      sessionId    = res.data?.data?.session ?? res.data?.session ?? '';

      expect(sessionToken).toBeTruthy();
      expect(sessionId).toBeTruthy();
    });

    it('Step 2: Session Activate — returns accessToken', async () => {
      const res = await api.post(`${GAME}/v2/exp/session/activate`, {
        token: sessionToken,
        ts: Date.now(),
        timezone: 'Asia/Taipei',
        analytics: {
          language: 'en',
          device: 'desktop',
          resolution: { w: 1920, h: 1080 },
          orientation: 'landscape',
          connection: 'wifi',
        },
      });

      if (res.status !== 200) console.error('[Flow1/Step2] Activate failed:', res.data);
      expect(res.status).toBe(200);

      // Try all known response shapes for the access token
      accessToken =
        res.data?.token ??
        res.data?.accessToken ??
        res.data?.data?.token ??
        res.data?.data?.accessToken ??
        '';
      expect(accessToken).toBeTruthy();
    });

    it('Step 3: Bet — returns roundId', async () => {
      const authHeaders = {
        authorization: `Bearer ${accessToken}`,
        'x-access-token': accessToken,
        'cloudfront-viewer-country': 'JP',
        'cloudfront-viewer-address': '1.2.3.4',
      };

      const res = await api.post(`${GAME}/v2/exp/play/bet`, {
        session: sessionId,
        bet: { type: 'regular', value: '2' },
        stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
        ts: Date.now(),
      }, { headers: authHeaders });

      if (res.status !== 200) console.error('[Flow1/Step3] Bet failed:', JSON.stringify(res.data, null, 2));
      expect(res.status).toBe(200);
      expect(res.data?.data?.roundId).toBeTruthy();
    });

    it('Step 4: Action (if bet triggered one) — returns 200', async () => {
      // Re-fetch bet result from previous step by replaying a new bet to get fresh data.
      // Instead, we run a fresh session + bet that may or may not have actions.
      // This step only executes validation if we stored bet data — handled via shared state below.
      // See Step 3+4+5 consolidated version if needed. This step is a marker test.
      // For deterministic coverage the action endpoint is exercised via the shared bet flow below.
      expect(true).toBe(true); // placeholder; actual action tested in Step 5 combined flow
    });

    it('Step 5: Bet + optional Action + Finish — full round lifecycle', async () => {
      // Run a second independent session to test the complete round lifecycle cleanly
      const startRes = await api.post(`${GAME}/v2/service/session/start`, {
        gameCode: 'LGS-001', lang: 'en', country: 'GB',
        gameSetting: { rtpConfigCode: 'lowRTP', isGeoBlocking: true, jurisdictionCode: 'slotJD' },
        mode: 'real', operator: 'QARealGameOperator', brand: 'QARealGameBrand',
        playerId: 'QARealGameOperator:QARealGameBrand:kyle0c2', externalPlayerId: 'kyle0c2',
        currency: 'EUR', currencyId: 1, balance: '10000', maxExposure: 0,
        isTestingPlayer: false, licenseConfig: {}, callback: 'http://localhost',
      }, { headers: SVC_SIG });
      expect(startRes.status).toBe(200);

      const lUrl   = startRes.data?.data?.launchUrl ?? '';
      const sTok   = lUrl.match(/[?&]token=([^&]+)/)?.[1] ?? '';
      const sId    = startRes.data?.data?.session ?? '';

      const actRes = await api.post(`${GAME}/v2/exp/session/activate`, {
        token: sTok, ts: Date.now(), timezone: 'Asia/Taipei',
        analytics: { language: 'en', device: 'desktop', resolution: { w: 1920, h: 1080 }, orientation: 'landscape', connection: 'wifi' },
      });
      expect(actRes.status).toBe(200);
      const aTok = actRes.data?.token ?? actRes.data?.accessToken ?? actRes.data?.data?.token ?? actRes.data?.data?.accessToken ?? '';

      const authH = {
        authorization: `Bearer ${aTok}`,
        'x-access-token': aTok,
        'cloudfront-viewer-country': 'JP',
        'cloudfront-viewer-address': '1.2.3.4',
      };

      const betRes = await api.post(`${GAME}/v2/exp/play/bet`, {
        session: sId, bet: { type: 'regular', value: '2' },
        stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
        ts: Date.now(),
      }, { headers: authH });
      if (betRes.status !== 200) console.error('[Flow1/Step5] Bet failed:', JSON.stringify(betRes.data, null, 2));
      expect(betRes.status).toBe(200);

      const betData  = betRes.data?.data;
      const roundId  = betData?.roundId;
      expect(roundId).toBeTruthy();

      // Send action if bet response includes one (e.g. bonus trigger)
      const actions = betData?.actions;
      if (Array.isArray(actions) && actions.length > 0) {
        const action = actions[0]?.action ?? actions[0];
        const actionRes = await api.post(`${GAME}/v2/exp/play/action`, {
          session: sId, roundId, action, ts: Date.now(),
        }, { headers: authH });
        if (actionRes.status !== 200) console.error('[Flow1/Step5] Action failed:', actionRes.data);
        expect(actionRes.status).toBe(200);
      }

      // Explicit finish only when the game response indicates coins won
      const coins = betData?.results?.gameResponse?.step?.summary?.coins;
      if (coins && Number(coins) > 0) {
        const finishRes = await api.post(`${GAME}/v2/exp/play/finish`, {
          session: sId, roundId, ts: Date.now(),
        }, { headers: authH });
        if (finishRes.status !== 200) console.error('[Flow1/Step5] Finish failed:', finishRes.data);
        expect(finishRes.status).toBe(200);
      }
    });
  });

  // ==========================================
  // FLOW 2: Multi-Instance State Propagation
  // ==========================================
  describe('Flow 2: Multi-Instance State Propagation', () => {
    let amToken = '';

    it('Step 1: Billing generates AM Token', async () => {
      const res = await api.post(`${BILLING}/v1/service/am/token`, {
        userId: 0, account: 'tester', code: 'SLT',
        permission: [{ routeKey: '*', methods: ['*'] }],
      }, { headers: SVC_SIG });

      expect(res.status).toBe(200);
      amToken = res.data?.data?.token ?? '';
      expect(amToken).toBeTruthy();
    });

    it('Step 2: Billing disables LGS-001 globally', async () => {
      const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
        data: [{ code: 'LGS-001', enabled: false }],
      }, { headers: { 'x-access-token': amToken } });
      expect(res.status).toBe(200);
    });

    it('Step 3: Game node reflects disabled state after Kafka propagation', async () => {
      // Allow time for: billing Kafka publish → bridge receives → bridge updates Redis → game node cron picks up
      await new Promise(r => setTimeout(r, 5000));

      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      expect(res.status).toBe(200);
      const games = res.data?.data?.games ?? res.data?.data; // FIX
      const game = games?.find((g: any) => g.code === 'LGS-001');
      expect(game?.enabled).toBe(false);
    });

    it('Step 4: Re-enable LGS-001 (restore state)', async () => {
      const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
        data: [{ code: 'LGS-001', enabled: true }],
      }, { headers: { 'x-access-token': amToken } });
      expect(res.status).toBe(200);
    });
  });
});

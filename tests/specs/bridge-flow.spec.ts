import { it, expect } from 'bun:test';
import { api } from '../utils/api';
import { BILLING, GAME, SVC_SIG } from '../utils/config';

export function runBridgeFlowTests() {
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

  it('Step 2: Billing disables LGS-001 and fires Kafka propagation', async () => {
    const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: 'LGS-001', enabled: false }],
    }, { headers: { 'x-access-token': amToken } });
    expect(res.status).toBe(200);

    // Evict Redis game codes key → game node forced to use billing-site fallback
    // on next cron, guaranteeing it reads the disabled state
    await api.propagateConfig(amToken);
  });

  it('Step 3: Game node reflects disabled state within 65s', async () => {
    let isGameDisabled = false;
    // 65s = 60s max cron interval + 5s buffer
    // Redis eviction in propagateConfig ensures billing-fallback on first cron hit
    for (let i = 0; i < 65; i++) {
      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      const games = res.data?.data?.games ?? res.data?.data;
      const game = games?.find((g: any) => g.code === 'LGS-001');
      if (game?.enabled === false) { isGameDisabled = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(isGameDisabled).toBe(true);
  }, 90000);

  it('Step 4: Restores LGS-001 (enabled + EUR bet level 2)', async () => {
    // resetGameState: PATCH enable + PATCH betLevels + propagateConfig
    await api.resetGameState('LGS-001', amToken);

    let isRestored = false;
    for (let i = 0; i < 65; i++) {
      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      const games = res.data?.data?.games ?? res.data?.data;
      const game = games?.find((g: any) => g.code === 'LGS-001');
      if (game?.enabled === true) { isRestored = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(isRestored).toBe(true);
  }, 90000);
}

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

  it('Step 2: Billing disables LGS-001 globally', async () => {
    const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: 'LGS-001', enabled: false }],
    }, { headers: { 'x-access-token': amToken } });
    expect(res.status).toBe(200);
  });

  it('Step 3: Game node reflects disabled state after Kafka propagation', async () => {
    let isGameDisabled = false;

    // ⏳ Game node syncs via cron every 60s. We must poll up to 75s.
    for (let i = 0; i < 75; i++) {
      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      const games = res.data?.data?.games ?? res.data?.data; 
      const game = games?.find((g: any) => g.code === 'LGS-001');

      if (game && game.enabled === false) {
        isGameDisabled = true;
        break; // State successfully pulled from Redis by the cron job!
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    expect(isGameDisabled).toBe(true);
  }, 90000); // 90s timeout override for this specific test

  it('Step 4: Re-enable LGS-001 (restore state for other tests)', async () => {
    // 1. Enable Game
    const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: 'LGS-001', enabled: true }],
    }, { headers: { 'x-access-token': amToken } });
    expect(res.status).toBe(200);

    // 2. Set Bet Level (Ensures Flow 1 has the EUR '2' bet level it expects)
    await api.patch(`${BILLING}/v1/internal/game/LGS-001/betLevels`, {
      currencyCode: 'EUR',
      betLevels: [{ type: 'regular', value: '2', default: true }],
    }, { headers: { 'x-access-token': amToken } });
    
    let isGameEnabled = false;

    // ⏳ Wait for the cron job to restore the state on the Game Node
    for (let i = 0; i < 75; i++) {
      const checkRes = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      const games = checkRes.data?.data?.games ?? checkRes.data?.data; 
      const game = games?.find((g: any) => g.code === 'LGS-001');

      if (game && game.enabled === true) {
        isGameEnabled = true;
        break; 
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    expect(isGameEnabled).toBe(true);
  }, 90000);
}
import { it, expect } from 'bun:test';
import { api } from '../utils/api';
import { BILLING, GAME, SVC_SIG } from '../utils/config';

export function runInternalTests() {
  let amToken = '';

  it('Generates AM Token', async () => {
    const res = await api.post(`${BILLING}/v1/service/am/token`, {
      userId: 0, account: 'tester', code: 'SLT',
      permission: [{ routeKey: '*', methods: ['*'] }],
    }, { headers: SVC_SIG });

    expect(res.status).toBe(200);
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  it('Disables LGS-001 globally', async () => {
    const res = await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: 'LGS-001', enabled: false }],
    }, { headers: { 'x-access-token': amToken } });
    expect(res.status).toBe(200);
  });

  it('Game node reflects disabled state (75s poll)', async () => {
    let isGameDisabled = false;
    for (let i = 0; i < 75; i++) {
      const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
      const games = res.data?.data?.games ?? res.data?.data; 
      const game = games?.find((g: any) => g.code === 'LGS-001');
      if (game && game.enabled === false) {
        isGameDisabled = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(isGameDisabled).toBe(true);
  }, 90000);

  it('Restores LGS-001 to enabled and sets EUR bet level to 2', async () => {
    // 1. Enable Game
    await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: 'LGS-001', enabled: true }],
    }, { headers: { 'x-access-token': amToken } });

    // 2. Set Bet Level
    await api.patch(`${BILLING}/v1/internal/game/LGS-001/betLevels`, {
      currencyCode: 'EUR',
      betLevels: [{ type: 'regular', value: '2', default: true }],
    }, { headers: { 'x-access-token': amToken } });

    // 3. Wait for GAME node to re-enable
    let isGameEnabled = false;
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
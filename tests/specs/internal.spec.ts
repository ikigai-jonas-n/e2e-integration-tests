import { it, expect, afterAll } from 'bun:test';
import { api, waitForCondition } from '../utils/api';
import { billingClient, gameClient } from '../utils/client';

export function runInternalTests() {
  let amToken = '';

  // Safety net: always restore LGS-001 even if an assertion fails mid-flow.
  afterAll(async () => {
    if (amToken) await api.resetGameState('LGS-001', amToken).catch(() => {});
  }, 30000);

  it('Generates AM Token', async () => {
    const res = await billingClient.getAmToken();
    expect(res.status).toBe(200);
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  it('Disables LGS-001 globally and propagates via Kafka', async () => {
    const res = await billingClient.setGamesStatus(amToken, [{ code: 'LGS-001', enabled: false }]);
    expect(res.status).toBe(200);
    // Redis eviction ensures billing-fallback on next cron — see api.propagateConfig
    await api.propagateConfig(amToken);
  });

  it('Game node reflects disabled state within 65s (cron-based)', async () => {
    // 65s = 60s max cron interval + 5s buffer.
    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-001')?.enabled === false;
    }, 65000);
  }, 90000);

  it('Restores LGS-001 to enabled with EUR bet level 2', async () => {
    await api.resetGameState('LGS-001', amToken);

    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-001')?.enabled === true;
    }, 65000);
  }, 90000);
}

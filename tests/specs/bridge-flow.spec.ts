import { it, expect, afterAll } from 'bun:test';
import { api, waitForCondition } from '../utils/api';
import { billingClient, gameClient } from '../utils/client';

export function runBridgeFlowTests() {
  let amToken = '';

  // Safety net: always restore LGS-001 even if a test assertion fails mid-flow.
  afterAll(async () => {
    if (amToken) await api.resetGameState('LGS-001', amToken).catch(() => {});
  }, 30000);

  it('Step 1: Billing generates AM Token', async () => {
    const res = await billingClient.getAmToken();
    expect(res.status).toBe(200);
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  it('Step 2: Billing disables LGS-001 and fires Kafka propagation', async () => {
    const res = await billingClient.setGamesStatus(amToken, [{ code: 'LGS-001', enabled: false }]);
    expect(res.status).toBe(200);
    // Evict Redis game codes key → game node forced to use billing-site fallback on next cron
    await api.propagateConfig(amToken);
  });

  it('Step 3: Game node reflects disabled state within 65s', async () => {
    // 65s = 60s max cron interval + 5s buffer.
    // Redis eviction in propagateConfig ensures billing-fallback on first cron hit.
    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-001')?.enabled === false;
    }, 65000);
  }, 90000);

  it('Step 4: Restores LGS-001 (enabled + EUR bet level 2)', async () => {
    await api.resetGameState('LGS-001', amToken);

    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-001')?.enabled === true;
    }, 65000);
  }, 90000);
}

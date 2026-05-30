import { it, expect, afterAll } from 'bun:test';
import { api, waitForCondition } from '../utils/api';
import { billingClient, gameClient } from '../utils/client';
import { atLeast } from '../utils/version-gate';

// Kafka propagation (billing → bridge → Redis → game node) requires bridge to
// correctly process billing's game-update messages.
// bridge >= 1.8.0 added strict schema validation that rejects billing 1.7.x messages.
const kafkaCompatible = atLeast('billing', '1.8.0') && atLeast('bridge', '1.8.0');

export function runBridgeFlowTests() {
  let amToken = '';

  // Safety net: always restore LGS-004 even if a test assertion fails mid-flow.
  afterAll(async () => {
    if (amToken) await api.resetGameState('LGS-004', amToken).catch(() => {});
  }, 30000);

  it('Step 1: Billing generates AM Token', async () => {
    const res = await billingClient.getAmToken();
    expect(res.status).toBe(200);
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  // @requires billing >= 1.8.0 && bridge >= 1.8.0  (Kafka propagation path)
  it.if(kafkaCompatible)('Step 2: Billing disables LGS-004 and fires Kafka propagation', async () => {
    const res = await billingClient.setGamesStatus(amToken, [{ code: 'LGS-004', enabled: false }]);
    expect(res.status).toBe(200);
    await api.propagateConfig(amToken);
  });

  // @requires billing >= 1.8.0 && bridge >= 1.8.0
  it.if(kafkaCompatible)('Step 3: Game node reflects disabled state within 90s', async () => {
    // 90s = 60s max cron interval + 30s buffer for Kafka consumer init on warm-start.
    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-004')?.enabled === false;
    }, 90000);
  }, 120000);

  // @requires billing >= 1.8.0 && bridge >= 1.8.0
  it.if(kafkaCompatible)('Step 4: Restores LGS-004 (enabled + EUR bet level 2)', async () => {
    await api.resetGameState('LGS-004', amToken);

    await waitForCondition(async () => {
      const res   = await gameClient.getGames();
      const games = res.data?.data?.games ?? res.data?.data;
      return games?.find((g: any) => g.code === 'LGS-004')?.enabled === true;
    }, 90000);
  }, 120000);
}

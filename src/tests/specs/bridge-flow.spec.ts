import { afterAll, expect, it } from 'bun:test';
import { api, waitForCondition } from '../utils/api';
import { billingClient, gameClient } from '../utils/client';
import { skipSlowKafka } from '../utils/test-helpers';

export function runBridgeFlowTests() {
  let amToken = '';

  // Safety net: always restore LGS-004 even if a test assertion fails mid-flow.
  afterAll(async () => {
    if (amToken) await api.resetGameState('LGS-004').catch(() => {});
  }, 30000);

  it('Step 1: Billing generates AM Token', async () => {
    const res = await billingClient.getAmToken();
    expect(res.status).toBe(200);
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  // @requires billing >= 1.8.0 && bridge >= 1.8.0  (Kafka propagation path)
  it.skipIf(skipSlowKafka)(
    'Step 2: Billing disables LGS-004 and fires Kafka propagation',
    async () => {
      const res = await billingClient.setGamesStatus(amToken, [
        { code: 'LGS-004', enabled: false },
      ]);
      expect(res.status).toBe(200);
      await api.propagateConfig(amToken);
    },
  );

  // @requires billing >= 1.8.0 && bridge >= 1.8.0  @slow ~90s
  it.skipIf(skipSlowKafka)(
    'Step 3: Game node reflects disabled state within 90s',
    async () => {
      await waitForCondition(async () => {
        const res = await gameClient.getGames();
        const games = res.data?.data?.games ?? res.data?.data;
        return games?.find((g: any) => g.code === 'LGS-004')?.enabled === false;
      }, 90000);
    },
    120000,
  );

  // @requires billing >= 1.8.0 && bridge >= 1.8.0  @slow ~90s
  it.skipIf(skipSlowKafka)(
    'Step 4: Restores LGS-004 (enabled + EUR bet level 2)',
    async () => {
      await api.resetGameState('LGS-004', amToken);

      await waitForCondition(async () => {
        const res = await gameClient.getGames();
        const games = res.data?.data?.games ?? res.data?.data;
        return games?.find((g: any) => g.code === 'LGS-004')?.enabled === true;
      }, 90000);
    },
    120000,
  );
}

/**
 * Maintenance toggle flow, mirroring maintenance-flow.sh exactly:
 *   1. AM token  POST /v1/service/am/token  (routeKey V1_INTERNAL_GAME_MAINTENANCE)
 *   2. Set maintenance = true   PATCH /v1/internal/game/:code/maintenance
 *   3. Verify maintenance = true  via billing /v2/service/sync-games
 *   4. Restore maintenance = false
 *   5. Verify maintenance = false
 *
 * Steps 2-5 require billing >= 1.8.0 (patchMaintenance added to registerCoreServiceEndpoints).
 * On older billing versions they are automatically skipped — no need to comment them out.
 */
import { expect, it } from 'bun:test';
import { api, logError } from '../utils/api';
import { BILLING_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE } from '../utils/config';
import { atLeast } from '../utils/version-gate';

export function runMaintenanceFlowTests() {
  let amToken = '';
  const GAME_CODE = TARGET_GAME_CODE;

  it('Step 1: Get AM Token with maintenance permission', async () => {
    const res = await api.post(
      `${BILLING_URL}/v1/service/am/token`,
      {
        userId: 0,
        account: 'tester',
        code: 'SLT',
        permission: [{ routeKey: 'V1_INTERNAL_GAME_MAINTENANCE', methods: ['*'] }],
      },
      { headers: SERVICE_SIGNATURE },
    );

    if (res.status !== 200) logError('[maint/step1] AM token failed:', res.data);
    expect(res.status).toBe(200);

    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  // @requires billing >= 1.8.0  (patchMaintenance endpoint)
  it.if(atLeast('billing', '1.8.0'))('Step 2: Set isMaintenance = true', async () => {
    const res = await api.patch(
      `${BILLING_URL}/v1/internal/game/${GAME_CODE}/maintenance`,
      { isMaintenance: true },
      { headers: { 'x-access-token': amToken } },
    );

    if (res.status !== 200) logError('[maint/step2] Patch failed:', res.data);
    expect(res.status).toBe(200);
  });

  // @requires billing >= 1.8.0
  it.if(atLeast('billing', '1.8.0'))('Step 3: Billing confirms isMaintenance = true', async () => {
    const res = await api.get(`${BILLING_URL}/v2/service/sync-games`, {
      headers: SERVICE_SIGNATURE,
    });
    expect(res.status).toBe(200);

    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === GAME_CODE);

    expect(game).toBeDefined();
    expect(game?.isMaintenance).toBe(true);
  });

  // @requires billing >= 1.8.0
  it.if(atLeast('billing', '1.8.0'))('Step 4: Restore isMaintenance = false', async () => {
    const res = await api.patch(
      `${BILLING_URL}/v1/internal/game/${GAME_CODE}/maintenance`,
      { isMaintenance: false },
      { headers: { 'x-access-token': amToken } },
    );

    if (res.status !== 200) logError('[maint/step4] Restore failed:', res.data);
    expect(res.status).toBe(200);
  });

  // @requires billing >= 1.8.0
  it.if(atLeast('billing', '1.8.0'))('Step 5: Billing confirms isMaintenance = false', async () => {
    const res = await api.get(`${BILLING_URL}/v2/service/sync-games`, {
      headers: SERVICE_SIGNATURE,
    });
    expect(res.status).toBe(200);

    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === GAME_CODE);

    expect(game).toBeDefined();
    expect(game?.isMaintenance).toBe(false);
  });
}

/**
 * Maintenance toggle flow, mirroring maintenance-flow.sh exactly:
 *   1. AM token  POST /v1/service/am/token  (routeKey V1_INTERNAL_GAME_MAINTENANCE)
 *   2. Set maintenance = true   PATCH /v1/internal/game/:code/maintenance
 *   3. Verify maintenance = true  via billing /v2/service/sync-games
 *   4. Restore maintenance = false
 *   5. Verify maintenance = false
 */
import { it, expect } from 'bun:test';
import { api, logError, logWarn } from '../utils/api';
import { BILLING, SVC_SIG } from '../utils/config';

export function runMaintenanceFlowTests() {
  let amToken = '';
  const GAME_CODE = 'LGS-004';

  it('Step 1: Get AM Token with maintenance permission', async () => {
    // maintenance-flow.sh: routeKey V1_INTERNAL_GAME_MAINTENANCE, account=tester, code=SLT
    const res = await api.post(`${BILLING}/v1/service/am/token`, {
      userId: 0,
      account: 'tester',
      code: 'SLT',
      permission: [{ routeKey: 'V1_INTERNAL_GAME_MAINTENANCE', methods: ['*'] }],
    }, { headers: SVC_SIG });

    if (res.status !== 200) logError('[maint/step1] AM token failed:', res.data);
    expect(res.status).toBe(200);

    // maintenance-flow.sh: .data.token
    amToken = res.data?.data?.token ?? '';
    expect(amToken).toBeTruthy();
  });

  it('Step 2: Set isMaintenance = true', async () => {
    // maintenance-flow.sh: PATCH /v1/internal/game/${GAME_CODE}/maintenance  { isMaintenance: true }
    const res = await api.patch(
      `${BILLING}/v1/internal/game/${GAME_CODE}/maintenance`,
      { isMaintenance: true },
      { headers: { 'x-access-token': amToken } },
    );

    if (res.status !== 200) logError('[maint/step2] Patch failed:', res.data);
    expect(res.status).toBe(200);
  });

  it('Step 3: Billing confirms isMaintenance = true', async () => {
    // Verify via sync-games (reads directly from DB — no cron dependency)
    const res = await api.get(`${BILLING}/v2/service/sync-games`, { headers: SVC_SIG });
    expect(res.status).toBe(200);

    const games = res.data?.data?.games ?? res.data?.data;
    const game  = games?.find((g: any) => g.code === GAME_CODE);

    expect(game).toBeDefined();
    expect(game?.isMaintenance).toBe(true);
  });

  it('Step 4: Restore isMaintenance = false', async () => {
    const res = await api.patch(
      `${BILLING}/v1/internal/game/${GAME_CODE}/maintenance`,
      { isMaintenance: false },
      { headers: { 'x-access-token': amToken } },
    );

    if (res.status !== 200) logError('[maint/step4] Restore failed:', res.data);
    expect(res.status).toBe(200);
  });

  it('Step 5: Billing confirms isMaintenance = false', async () => {
    const res = await api.get(`${BILLING}/v2/service/sync-games`, { headers: SVC_SIG });
    expect(res.status).toBe(200);

    const games = res.data?.data?.games ?? res.data?.data;
    const game  = games?.find((g: any) => g.code === GAME_CODE);

    expect(game).toBeDefined();
    expect(game?.isMaintenance).toBe(false);
  });
}

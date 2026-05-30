/**
 * Full bet-action-finish lifecycle, mirroring bet-flow.sh:
 *   1. Session start    → sessionToken, sessionId
 *   2. Session activate → accessToken
 *   3. Bet              → roundId, optional actions, optional coins
 *   4. Action           → only if bet response contains data.actions[0]
 *   5. Finish           → only if data.results.gameResponse.step.summary.coins > 0
 */
import { expect, it } from 'bun:test';
import { logError, logWarn } from '../utils/api';
import { gameClient } from '../utils/client';

export function runBetAndActionFlow() {
  let sessionToken = '';
  let accessToken = '';
  let sessionId = '';
  let roundId = '';
  let betData: any = null;

  it('Step 1: Session Start', async () => {
    const res = await gameClient.startSession();

    if (res.status !== 200) logError('[bet-flow/step1] Session start failed:', res.data);
    expect(res.status).toBe(200);

    // Token lives in launchUrl as ?token=... (same pattern as bet-flow.sh)
    const launchUrl = res.data?.data?.launchUrl ?? '';
    sessionToken = launchUrl.match(/[?&]token=([^&]+)/)?.[1] ?? res.data?.data?.token ?? '';
    sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    expect(sessionToken).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('Step 2: Session Activate', async () => {
    const res = await gameClient.activateSession(sessionToken);

    if (res.status !== 200) logError('[bet-flow/step2] Activate failed:', res.data);
    expect(res.status).toBe(200);

    accessToken = res.data?.data?.token ?? res.data?.data?.accessToken ?? '';
    if (!sessionId) sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    expect(accessToken).toBeTruthy();
  });

  it('Step 3: Bet', async () => {
    const res = await gameClient.bet(sessionId, accessToken);

    if (res.status !== 200) logError('[bet-flow/step3] Bet failed:', res.data);
    expect(res.status).toBe(200);

    betData = res.data?.data;
    roundId = betData?.roundId ?? '';
    expect(roundId).toBeTruthy();
  });

  it('Step 4: Action (skipped when bet has no actions)', async () => {
    const actions = betData?.actions;
    if (!Array.isArray(actions) || actions.length === 0) return;

    const action = actions[0]?.action ?? actions[0];
    const res = await gameClient.action(sessionId, accessToken, roundId, {
      action,
      ts: Date.now(),
    });

    if (res.status !== 200) logError('[bet-flow/step4] Action failed:', res.data);
    expect(res.status).toBe(200);

    betData = res.data?.data ?? betData;
  });

  it('Step 5: Finish (only when summary.coins > 0)', async () => {
    const coins = betData?.results?.gameResponse?.step?.summary?.coins;
    if (!coins || Number(coins) <= 0) return;

    const res = await gameClient.finish(sessionId, accessToken, roundId);

    // 200 = explicit finish. 400/409 = round auto-closed (stale from prior session)
    if (res.status !== 200) logWarn('[bet-flow/finish] Non-200:', `${res.status}`, res.data);
    expect([200, 400, 409]).toContain(res.status);
  });
}

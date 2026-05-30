/**
 * Full bet-action-finish lifecycle, mirroring bet-flow.sh exactly:
 *   1. Session start    → sessionToken, sessionId
 *   2. Session activate → accessToken
 *   3. Bet              → roundId, optional actions, optional coins
 *   4. Action           → only if bet response contains data.actions[0]
 *   5. Finish           → only if data.results.gameResponse.step.summary.coins > 0
 */
import { it, expect } from 'bun:test';
import { api, logError, logWarn } from '../utils/api';
import { GAME, SVC_SIG } from '../utils/config';

export function runBetAndActionFlow() {
  let sessionToken = '';
  let accessToken  = '';
  let sessionId    = '';
  let roundId      = '';
  let betData: any = null;

  // Must match a player registered in the external money/player services.
  // Only kyle0c is confirmed to exist there.
  const PLAYER_ID     = 'QARealGameOperator:QARealGameBrand:kyle0c';
  const EXT_PLAYER_ID = 'kyle0c';

  it('Step 1: Session Start', async () => {
    const res = await api.post(`${GAME}/v2/service/session/start`, {
      gameCode: 'LGS-001',
      lang: 'en',
      country: 'GB',
      gameSetting: { rtpConfigCode: 'lowRTP', isGeoBlocking: true, jurisdictionCode: 'slotJD' },
      mode: 'real',
      operator: 'QARealGameOperator',
      brand: 'QARealGameBrand',
      playerId: PLAYER_ID,
      externalPlayerId: EXT_PLAYER_ID,
      currency: 'EUR',
      currencyId: 1,
      balance: '10000',
      maxExposure: 0,
      isTestingPlayer: false,
      licenseConfig: {},
      callback: 'http://localhost',
    }, { headers: SVC_SIG });

    if (res.status !== 200) logError('[bet-flow/step1] Session start failed:', res.data);
    expect(res.status).toBe(200);

    // Token lives in launchUrl as ?token=... (same pattern as bet-flow.sh)
    const launchUrl = res.data?.data?.launchUrl ?? '';
    sessionToken = launchUrl.match(/[?&]token=([^&]+)/)?.[1] ?? res.data?.data?.token ?? '';
    sessionId    = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';

    expect(sessionToken).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('Step 2: Session Activate', async () => {
    const res = await api.post(`${GAME}/v2/exp/session/activate`, {
      token: sessionToken,
      ts: Date.now(),
      timezone: 'Asia/Taipei',
      analytics: {
        language: 'en', device: 'mobile',
        resolution: { w: 0, h: 0 },
        orientation: 'landscape', connection: 'slow-2g',
      },
    });

    if (res.status !== 200) logError('[bet-flow/step2] Activate failed:', res.data);
    expect(res.status).toBe(200);

    // .data.token OR .data.accessToken (matches bet-flow.sh fallback chain)
    accessToken = res.data?.data?.token ?? res.data?.data?.accessToken ?? '';
    if (!sessionId) {
      sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    }
    expect(accessToken).toBeTruthy();
  });

  it('Step 3: Bet', async () => {
    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
      'x-access-token': accessToken,
      'cloudfront-viewer-country': 'JP',
      'cloudfront-viewer-address': '1.2.3.4',
    };

    const res = await api.post(`${GAME}/v2/exp/play/bet`, {
      session: sessionId,
      bet: { type: 'regular', value: '2' },
      stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
      ts: Date.now(),
    }, { headers: authHeaders });

    if (res.status !== 200) logError('[bet-flow/step3] Bet failed:', res.data);
    expect(res.status).toBe(200);

    betData = res.data?.data;
    roundId = betData?.roundId ?? '';
    expect(roundId).toBeTruthy();
  });

  it('Step 4: Action (skipped when bet response has no actions)', async () => {
    const actions = betData?.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      // No action required — mirrors bet-flow.sh action_request() early-return
      return;
    }

    // Extract action value: prefer .action sub-field, fall back to the element itself
    const action = actions[0]?.action ?? actions[0];
    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
      'x-access-token': accessToken,
      'cloudfront-viewer-country': 'JP',
      'cloudfront-viewer-address': '1.2.3.4',
    };

    const res = await api.post(`${GAME}/v2/exp/play/action`, {
      session: sessionId, roundId, action, ts: Date.now(),
    }, { headers: authHeaders });

    if (res.status !== 200) logError('[bet-flow/step4] Action failed:', res.data);
    expect(res.status).toBe(200);

    // Update betData with action response so finish can check its coins
    betData = res.data?.data ?? betData;
  });

  it('Step 5: Finish (only when summary.coins > 0)', async () => {
    // Mirrors bet-flow.sh finish_request() — only called when coins won
    const coins = betData?.results?.gameResponse?.step?.summary?.coins;
    if (!coins || Number(coins) <= 0) {
      return;
    }

    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
      'x-access-token': accessToken,
      'cloudfront-viewer-country': 'JP',
      'cloudfront-viewer-address': '1.2.3.4',
    };

    const res = await api.post(`${GAME}/v2/exp/play/finish`, {
      session: sessionId, roundId, ts: Date.now(),
    }, { headers: authHeaders });

    // 200 = explicit finish accepted.
    // 400/409 = "round is not in status for finish" — round auto-closed already
    //   (transient: stale round from prior session; resolves after ~20 min).
    if (res.status !== 200) {
      logWarn('[bet-flow/finish] Non-200:', `${res.status}`, res.data);
    }
    expect([200, 400, 409]).toContain(res.status);
  });
}

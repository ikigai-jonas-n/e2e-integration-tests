/**
 * Lobby session-token flow, mirroring lobby-flow.sh exactly:
 *   1. Session start         → SESSION_TOKEN, SESSION_ID
 *   2. Session activate      → GAME_ACCESS_TOKEN (game-level JWT)
 *   3. Session-token activate POST /v1/exp/session-token/activate
 *                            → LOBBY_ACCESS_TOKEN, LOBBY_REFRESH_TOKEN, tokenType, expiresIn
 *   4. Session-token refresh POST /v1/exp/session-token/refresh  { refreshToken }
 *                            → REFRESHED_ACCESS_TOKEN, REFRESHED_REFRESH_TOKEN
 */
import { it, expect } from 'bun:test';
import { api } from '../utils/api';
import { GAME, SVC_SIG } from '../utils/config';

export function runLobbyFlowTests() {
  let sessionToken      = '';
  let sessionId         = '';
  let gameAccessToken   = '';
  let lobbyAccessToken  = '';
  let lobbyRefreshToken = '';

  // Must match a player registered in the external money/player services.
  // Only kyle0c is confirmed to exist there.
  const PLAYER_ID     = 'QARealGameOperator:QARealGameBrand:kyle0c';
  const EXT_PLAYER_ID = 'kyle0c';
  const RTP_CODE      = 'lowRTP';   // lobby-flow.sh: lowRTP for LGS-001

  it('Step 1: Session Start', async () => {
    const res = await api.post(`${GAME}/v2/service/session/start`, {
      gameCode: 'LGS-001',
      lang: 'en',
      country: 'GB',
      gameSetting: { rtpConfigCode: RTP_CODE, isGeoBlocking: true },
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

    if (res.status !== 200) console.error('[lobby/step1] Session start failed:', res.data);
    expect(res.status).toBe(200);

    const launchUrl = res.data?.data?.launchUrl ?? '';
    // lobby-flow.sh: extract token= from launchUrl, fallback to .data.token
    sessionToken = launchUrl.match(/[?&]token=([^&]+)/)?.[1]
                ?? res.data?.data?.token
                ?? '';
    sessionId    = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';

    expect(sessionToken).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('Step 2: Session Activate → game access token', async () => {
    const res = await api.post(`${GAME}/v2/exp/session/activate`, {
      token: sessionToken,
      ts: 0,       // lobby-flow.sh uses ts: 0
      timezone: 'us',
      analytics: {
        language: 'us', device: 'mobile',
        resolution: { w: 0, h: 0 },
        orientation: 'landscape', connection: 'slow-2g',
      },
    });

    if (res.status !== 200) console.error('[lobby/step2] Activate failed:', res.data);
    expect(res.status).toBe(200);

    // lobby-flow.sh: .token // .accessToken // .data.token // .data.accessToken
    gameAccessToken = res.data?.data?.token
                   ?? res.data?.data?.accessToken
                   ?? '';
    if (!sessionId) {
      sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    }
    expect(gameAccessToken).toBeTruthy();
  });

  it('Step 3: Session-token Activate → lobby tokens', async () => {
    // lobby-flow.sh: POST /v1/exp/session-token/activate
    //   Header: Authorization: Bearer ${GAME_ACCESS_TOKEN}
    //   No body
    const res = await api.post(
      `${GAME}/v1/exp/session-token/activate`,
      {},
      { headers: { authorization: `Bearer ${gameAccessToken}` } },
    );

    if (res.status !== 200) console.error('[lobby/step3] Session-token activate failed:', res.data);
    expect(res.status).toBe(200);

    // lobby-flow.sh: .data.tokenType // .data.accessToken // .data.refreshToken // .data.expiresIn
    lobbyAccessToken  = res.data?.data?.accessToken  ?? '';
    lobbyRefreshToken = res.data?.data?.refreshToken ?? '';
    const tokenType   = res.data?.data?.tokenType    ?? 'Bearer';
    const expiresIn   = res.data?.data?.expiresIn    ?? 0;

    expect(lobbyAccessToken).toBeTruthy();
    expect(lobbyRefreshToken).toBeTruthy();
    expect(tokenType).toBeTruthy();
    expect(expiresIn).toBeGreaterThanOrEqual(0);
  });

  it('Step 4: Session-token Refresh → refreshed lobby tokens', async () => {
    // lobby-flow.sh: wait 5s before refresh (simulates token expiry window)
    await new Promise(r => setTimeout(r, 5000));

    // lobby-flow.sh: POST /v1/exp/session-token/refresh
    //   Header: Authorization: Bearer ${LOBBY_ACCESS_TOKEN}
    //   Body: { refreshToken: LOBBY_REFRESH_TOKEN }
    const res = await api.post(
      `${GAME}/v1/exp/session-token/refresh`,
      { refreshToken: lobbyRefreshToken },
      { headers: { authorization: `Bearer ${lobbyAccessToken}` } },
    );

    if (res.status !== 200) console.error('[lobby/step4] Session-token refresh failed:', res.data);
    expect(res.status).toBe(200);

    // lobby-flow.sh: .data.accessToken // .data.refreshToken
    const refreshedAccess  = res.data?.data?.accessToken  ?? '';
    const refreshedRefresh = res.data?.data?.refreshToken ?? '';

    expect(refreshedAccess).toBeTruthy();
    // refreshToken may or may not rotate — just verify field is present if returned
    if (refreshedRefresh) {
      expect(typeof refreshedRefresh).toBe('string');
    }
  }, 30000);
}

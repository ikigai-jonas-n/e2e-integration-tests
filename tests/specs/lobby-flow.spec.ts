/**
 * Lobby session-token flow, mirroring lobby-flow.sh:
 *   1. Session start         → SESSION_TOKEN, SESSION_ID
 *   2. Session activate      → GAME_ACCESS_TOKEN (game-level JWT)
 *   3. Session-token activate POST /v1/exp/session-token/activate
 *                            → LOBBY_ACCESS_TOKEN, LOBBY_REFRESH_TOKEN, tokenType, expiresIn
 *   4. Session-token refresh POST /v1/exp/session-token/refresh  { refreshToken }
 *                            → REFRESHED_ACCESS_TOKEN, REFRESHED_REFRESH_TOKEN
 */
import { expect, it } from 'bun:test';
import { logError } from '../utils/api';
import { gameClient } from '../utils/client';

export function runLobbyFlowTests() {
  let sessionToken = '';
  let sessionId = '';
  let gameAccessToken = '';
  let lobbyAccessToken = '';
  let lobbyRefreshToken = '';

  it('Step 1: Session Start', async () => {
    const res = await gameClient.startSession({ rtpCode: 'RTP_97' });

    if (res.status !== 200) logError('[lobby/step1] Session start failed:', res.data);
    expect(res.status).toBe(200);

    const launchUrl = res.data?.data?.launchUrl ?? '';
    sessionToken = launchUrl.match(/[?&]token=([^&]+)/)?.[1] ?? res.data?.data?.token ?? '';
    sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    expect(sessionToken).toBeTruthy();
    expect(sessionId).toBeTruthy();
  });

  it('Step 2: Session Activate → game access token', async () => {
    const res = await gameClient.activateSession(sessionToken);

    if (res.status !== 200) logError('[lobby/step2] Activate failed:', res.data);
    expect(res.status).toBe(200);

    gameAccessToken = res.data?.data?.token ?? res.data?.data?.accessToken ?? '';
    if (!sessionId) sessionId = res.data?.data?.session ?? res.data?.data?.sessionId ?? '';
    expect(gameAccessToken).toBeTruthy();
  });

  it('Step 3: Session-token Activate → lobby tokens', async () => {
    const res = await gameClient.activateSessionToken(gameAccessToken);

    if (res.status !== 200) logError('[lobby/step3] Session-token activate failed:', res.data);
    expect(res.status).toBe(200);

    lobbyAccessToken = res.data?.data?.accessToken ?? '';
    lobbyRefreshToken = res.data?.data?.refreshToken ?? '';
    const tokenType = res.data?.data?.tokenType ?? 'Bearer';
    const expiresIn = res.data?.data?.expiresIn ?? 0;

    expect(lobbyAccessToken).toBeTruthy();
    expect(lobbyRefreshToken).toBeTruthy();
    expect(tokenType).toBeTruthy();
    expect(expiresIn).toBeGreaterThanOrEqual(0);
  });

  it('Step 4: Session-token Refresh → refreshed lobby tokens', async () => {
    // Simulate token expiry window (mirrors lobby-flow.sh)
    await new Promise((r) => setTimeout(r, 5000));

    const res = await gameClient.refreshSessionToken(lobbyRefreshToken);

    if (res.status !== 200) logError('[lobby/step4] Session-token refresh failed:', res.data);
    expect(res.status).toBe(200);

    const refreshedAccess = res.data?.data?.accessToken ?? '';
    const refreshedRefresh = res.data?.data?.refreshToken ?? '';

    expect(refreshedAccess).toBeTruthy();
    if (refreshedRefresh) expect(typeof refreshedRefresh).toBe('string');
  }, 30000);
}

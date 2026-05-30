/**
 * Strongly-typed test clients that abstract auth headers and shared request shapes.
 * Use these instead of inline api.post/get + manual headers to keep spec files
 * focused on the WHAT (assertions) not the HOW (header wiring).
 */
import { api } from './api';
import { BILLING_URL, GAME_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE, TARGET_RTP_CODE } from './config';

// ─── Shared player constants ──────────────────────────────────────────────────

/** Only this player is registered in the external money/player services. */
export const KYLE = {
  playerId: 'QARealGameOperator:QARealGameBrand:kyle0c',
  externalPlayerId: 'kyle0c',
  operator: 'QARealGameOperator',
  brand: 'QARealGameBrand',
} as const;

// ─── Billing client ───────────────────────────────────────────────────────────

export const billingClient = {
  /**
   * Request an AM (admin) token from billing.
   * All internal/admin endpoints require `x-access-token: <amToken>`.
   */
  async getAmToken(permissions: string[] = ['*']) {
    return api.post(
      `${BILLING_URL}/v1/service/am/token`,
      {
        userId: 0,
        account: 'tester',
        code: 'SLT',
        permission: permissions.map((routeKey) => ({ routeKey, methods: ['*'] })),
      },
      { headers: SERVICE_SIGNATURE },
    );
  },

  async getGames() {
    return api.get(`${BILLING_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
  },

  async getSyncGames() {
    return api.get(`${BILLING_URL}/v2/service/sync-games`, { headers: SERVICE_SIGNATURE });
  },

  async setGamesStatus(amToken: string, updates: { code: string; enabled: boolean }[]) {
    return api.patch(
      `${BILLING_URL}/v1/internal/games/status`,
      { data: updates },
      { headers: { 'x-access-token': amToken } },
    );
  },

  async setBetLevels(amToken: string, gameCode: string, currencyCode: string, betLevels: any[]) {
    return api.patch(
      `${BILLING_URL}/v1/internal/game/${gameCode}/betLevels`,
      { currencyCode, betLevels },
      { headers: { 'x-access-token': amToken } },
    );
  },

  async setMaintenance(amToken: string, gameCode: string, isMaintenance: boolean) {
    return api.patch(
      `${BILLING_URL}/v1/internal/game/${gameCode}/maintenance`,
      { isMaintenance },
      { headers: { 'x-access-token': amToken } },
    );
  },
};

// ─── Game client ──────────────────────────────────────────────────────────────

export const gameClient = {
  async getGames() {
    return api.get(`${GAME_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
  },

  async startSession(
    // 1. Keep the type definition clean (no equals signs here)
    opts: {
      gameCode?: string;
      playerId?: string;
      externalPlayerId?: string;
      operator?: string;
      brand?: string;
      rtpCode?: string;
      country?: string;
      currency?: string;
    } = {},
  ) {
    // 2. Assign the default values during object destructuring
    const {
      gameCode = TARGET_GAME_CODE,     // <-- DEFAULT ASSIGNED HERE
      playerId = KYLE.playerId,
      externalPlayerId = KYLE.externalPlayerId,
      operator = KYLE.operator,
      brand = KYLE.brand,
      rtpCode = TARGET_RTP_CODE,       // <-- DEFAULT ASSIGNED HERE
      country = 'GB',
      currency = 'EUR',
    } = opts;

    return api.post(
      `${GAME_URL}/v2/service/session/start`,
      {
        gameCode,                      // <-- Uses the destructured variable
        lang: 'en',
        country,
        gameSetting: { 
          rtpConfigCode: rtpCode,      // <-- Uses the destructured variable
          isGeoBlocking: true, 
          jurisdictionCode: 'slotJD' 
        },
        mode: 'real',
        operator,
        brand,
        playerId,
        externalPlayerId,
        currency,
        currencyId: 1,
        balance: '10000',
        maxExposure: 0,
        isTestingPlayer: false,
        licenseConfig: {},
        callback: 'http://localhost',
      },
      { headers: SERVICE_SIGNATURE },
    );
  },

  async activateSession(token: string) {
    return api.post(`${GAME_URL}/v2/exp/session/activate`, {
      token,
      ts: Date.now(),
      timezone: 'Asia/Taipei',
      analytics: {
        language: 'en',
        device: 'mobile',
        resolution: { w: 0, h: 0 },
        orientation: 'landscape',
        connection: 'wifi',
      },
    });
  },

  /** Places a bet. Returns the full response including roundId and actions. */
  async bet(sessionId: string, accessToken: string, betValue = '2') {
    return api.post(
      `${GAME_URL}/v2/exp/play/bet`,
      {
        session: sessionId,
        bet: { type: 'regular', value: betValue },
        stakeMode: { type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 96.56 },
        ts: Date.now(),
      },
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-access-token': accessToken,
          'cloudfront-viewer-country': 'JP',
          'cloudfront-viewer-address': '1.2.3.4',
        },
      },
    );
  },

  async action(sessionId: string, accessToken: string, roundId: string, actionData: any) {
    return api.post(
      `${GAME_URL}/v2/exp/play/action`,
      {
        session: sessionId,
        roundId,
        ...actionData,
      },
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-access-token': accessToken,
          'cloudfront-viewer-country': 'JP',
          'cloudfront-viewer-address': '1.2.3.4',
        },
      },
    );
  },

  async finish(sessionId: string, accessToken: string, roundId: string) {
    return api.post(
      `${GAME_URL}/v2/exp/play/finish`,
      {
        session: sessionId,
        roundId,
      },
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-access-token': accessToken,
          'cloudfront-viewer-country': 'JP',
          'cloudfront-viewer-address': '1.2.3.4',
        },
      },
    );
  },

  async activateSessionToken(gameAccessToken: string) {
    return api.post(
      `${GAME_URL}/v1/exp/session-token/activate`,
      {},
      { headers: { authorization: `Bearer ${gameAccessToken}` } },
    );
  },

  async refreshSessionToken(refreshToken: string) {
    return api.post(`${GAME_URL}/v1/exp/session-token/refresh`, { refreshToken });
  },
};

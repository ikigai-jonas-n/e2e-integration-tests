import { BILLING, GAME, SVC_SIG } from './config';

export const api = {
  post: async (url: string, body: any, options?: any) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },

  get: async (url: string, options?: any) => {
    const res = await fetch(url, { method: 'GET', headers: options?.headers });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },

  patch: async (url: string, body: any, options?: any) => {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },

  /**
   * LIGHTNING SPEED SYNC: 
   * Discovery-based propagation. Fetches current state from Billing 
   * and forces the Game node to refresh its memory cache instantly.
   */
  propagateConfig: async (amToken: string) => {
    // 1. Discover current game states from Billing
    const res = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
    const games = res.data?.data?.games ?? res.data?.data;
    
    if (Array.isArray(games)) {
      // 2. Re-patch current status to ensure Bridge/Redis is fresh via Kafka
      const statusPayload = {
        data: games.map((g: any) => ({ code: g.code, enabled: g.enabled }))
      };
      await api.patch(`${BILLING}/v1/internal/games/status`, statusPayload, {
        headers: { 'x-access-token': amToken }
      });
    }

    // 3. Force the Game Node to pull from Redis immediately (bypassing 60s cron)
    await api.get(`${GAME}/v2/service/sync-games`, { headers: SVC_SIG });
  },

  /**
   * Ensures a game is back to a "White Paper" clean state.
   */
  resetGameState: async (gameCode: string, amToken: string) => {
    // Force Enablement
    await api.patch(`${BILLING}/v1/internal/games/status`, {
      data: [{ code: gameCode, enabled: true }]
    }, { headers: { 'x-access-token': amToken } });

    // Force Standard Bet Levels (EUR 2)
    await api.patch(`${BILLING}/v1/internal/game/${gameCode}/betLevels`, {
      currencyCode: 'EUR',
      betLevels: [{ type: 'regular', value: '2', default: true }],
    }, { headers: { 'x-access-token': amToken } });

    // Synchronize nodes instantly
    await api.propagateConfig(amToken);
  }
};
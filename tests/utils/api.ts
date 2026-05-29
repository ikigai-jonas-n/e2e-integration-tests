import { BILLING, SVC_SIG } from './config';

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
   * Fires a consolidated Kafka event so Bridge updates Redis with the latest game states.
   * The Game node (PERIPHERAL) reads Redis on its 60s cron — call this before polling
   * to guarantee Redis is fresh, maximising the chance of an early-exit in the poll loop.
   *
   * Note: the Game node has no force-refresh HTTP endpoint (it's PERIPHERAL with no DB
   * access). The 60s cron cycle is unavoidable — this helper just ensures Redis is ready.
   */
  propagateConfig: async (amToken: string) => {
    // 1. Read current game states from Billing's process cache
    const res = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
    const games = res.data?.data?.games ?? res.data?.data;

    // 2. Re-PATCH all games → publishes GAME_DATA Kafka event
    //    → Bridge receives → updates Redis with fresh state
    if (Array.isArray(games)) {
      await api.patch(`${BILLING}/v1/internal/games/status`, {
        data: games.map((g: any) => ({ code: g.code, enabled: g.enabled }))
      }, { headers: { 'x-access-token': amToken } });
    }

    // 3. Wait for Bridge to process the Kafka event and write updated game states to Redis
    await new Promise(r => setTimeout(r, 2500));

    // 4. Evict the game codes registry key from Redis.
    //    Key: {no_version}:gameCodes  (VERSION env var is unset → defaults to 'no_version')
    //    Effect: next time the game node's 60s cron fires, syncGamesFromRedisToProcessCache()
    //    returns false (empty registry) → immediately falls back to syncGamesFromBillingSiteToProcessCache()
    //    which calls billing directly and gets guaranteed-fresh data.
    //    Without this, the cron might load stale Redis data from before the PATCH.
    try {
      Bun.spawnSync([
        'docker', 'exec', 'redis-cluster',
        'valkey-cli', '-c', '-p', '6000', 'DEL', '{no_version}:gameCodes',
      ]);
    } catch { /* non-fatal — falls back to cron-reads-Redis path if eviction fails */ }
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
import { BILLING_URL, GAME_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE } from './config';

/**
 * Polls conditionFn every intervalMs until it returns true or maxMs elapses.
 * Use instead of hardcoded `for (let i = 0; i < 65; i++) { sleep(1000) }` loops.
 */
export async function waitForCondition(
  conditionFn: () => Promise<boolean>,
  maxMs = 65000,
  intervalMs = 1000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${maxMs}ms`);
}

/** Max chars printed per log call — prevents huge API responses (e.g. betLevels) from flooding logs. */
const LOG_LIMIT = 300;

function trim(data: any): string {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return s.length > LOG_LIMIT ? s.slice(0, LOG_LIMIT) + '…' : s;
}

/** Truncated console.log. */
export function log(...args: any[]): void {
  console.log(args.map(trim).join(' '));
}

/** Truncated console.error. */
export function logError(...args: any[]): void {
  console.error(args.map(trim).join(' '));
}

/** Truncated console.warn. */
export function logWarn(...args: any[]): void {
  console.warn(args.map(trim).join(' '));
}

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

  // --- ADD THIS HELPER ---
  getAmToken: async (): Promise<string> => {
    const res = await api.post(
      `${BILLING_URL}/v1/service/am/token`,
      {
        userId: 0,
        account: 'tester',
        code: 'SLT',
        permission: [{ routeKey: '*', methods: ['*'] }],
      },
      { headers: SERVICE_SIGNATURE },
    );
    const token = res.data?.data?.token;
    if (!token) throw new Error('Failed to generate AM token');

    // Zero-side-effect validation: Get current game state, then patch it to the EXACT SAME state
    const syncRes = await api.get(`${BILLING_URL}/v2/service/sync-games`, {
      headers: SERVICE_SIGNATURE,
    });
    const games = syncRes.data?.data?.games ?? syncRes.data?.data;
    const targetGame = games?.find((g: any) => g.code === TARGET_GAME_CODE);
    const currentState = targetGame?.enabled ?? true;

    const patchRes = await api.patch(
      `${BILLING_URL}/v1/internal/games/status`,
      { data: [{ code: TARGET_GAME_CODE, enabled: currentState }] },
      { headers: { 'x-access-token': token } },
    );

    if (patchRes.status !== 200) {
      throw new Error(`Token validation failed! Status: ${patchRes.status}`);
    }

    return token;
  },

  // --- UPDATE THIS (Make amToken optional) ---
  propagateConfig: async (amToken?: string) => {
    const token = amToken ?? (await api.getAmToken()); // Fetch fresh if not provided

    const res = await api.get(`${BILLING_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
    const games = res.data?.data?.games ?? res.data?.data;

    if (Array.isArray(games)) {
      await api.patch(
        `${BILLING_URL}/v1/internal/games/status`,
        { data: games.map((g: any) => ({ code: g.code, enabled: g.enabled })) },
        { headers: { 'x-access-token': token } },
      );
    }
    await new Promise((r) => setTimeout(r, 2500));
  },

  // --- UPDATE THIS (Remove amToken argument entirely) ---
  resetGameState: async (gameCode: string) => {
    const token = await api.getAmToken(); // Always fetch a fresh token

    await api.patch(
      `${BILLING_URL}/v1/internal/games/status`,
      { data: [{ code: gameCode, enabled: true }] },
      { headers: { 'x-access-token': token } },
    );

    await api.patch(
      `${BILLING_URL}/v1/internal/game/${gameCode}/betLevels`,
      {
        currencyCode: 'EUR',
        betLevels: [{ type: 'regular', value: '2', default: true }],
      },
      { headers: { 'x-access-token': token } },
    );

    await api.propagateConfig(token);

    // --- ADD THIS BLOCK ---
    // Wait for the Game Node's 60-second cron to sync the state into memory
    await waitForCondition(async () => {
      const res = await api.get(`${GAME_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });

      // Ensure we handle both potential formats
      const games = Array.isArray(res.data?.data?.games)
        ? res.data.data.games
        : Array.isArray(res.data?.data)
          ? res.data.data
          : [];

      const targetGame = games.find((g: any) => g.code === gameCode);

      console.log(
        `[resetGameState] ${gameCode} found: ${!!targetGame}, enabled: ${targetGame?.enabled}`,
      );
      return targetGame?.enabled === true;
    }, 90000);
  },
};

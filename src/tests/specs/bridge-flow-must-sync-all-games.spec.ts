import { expect, it } from 'bun:test';
import { api, waitForCondition } from '../utils/api';
import { BILLING_URL, GAME_URL, SERVICE_SIGNATURE } from '../utils/config';

export function runBridgeSyncBugTests() {
  let amToken = '';
  // Generate a totally unique game code for this specific test run
  const UNIQUE_GAME_CODE = `SYNC-${Date.now()}`;

  it('Step 1: Get AM Token', async () => {
    amToken = await api.getAmToken();
    expect(amToken).toBeTruthy();
  });

  it('Step 2: Create a brand new game via Internal API', async () => {
    const newGamePayload = {
      name: 'Sync Bug Test Game',
      code: UNIQUE_GAME_CODE, // <--- FIXED: Now totally unique every time
      enabled: true,
      category: 'slot',
      supplier: 'ikigai',
      languages: ['en'],
      versions: [
        {
          versionEnabled: true,
          default: true,
          rtpCode: 'RTP_97',
          rtp: 97.0,
          availableCurrenciesIds: [1],
          stakeModes: [{ type: 'commonGame', multiplier: 1, name: 'regular bet', rtp: 97.0 }],
          volatility: 'High',
          defaultMaxWin: 'x10000',
          lines: 20,
          maxExposure: 0,
        },
      ],
      gameServerConfig: { assets: { thumbnailLink: 'test.png' } },
      betLevels: {
        default: {
          EUR: [{ type: 'regular', value: '1', default: true }],
        },
      },
    };

    const res = await api.post(`${BILLING_URL}/v1/internal/game`, newGamePayload, {
      headers: { 'x-access-token': amToken },
    });

    if (res.status !== 200) {
      console.error('Failed to create game:', res.data);
    }
    expect(res.status).toBe(200);
  });

  // The Game node sync cron runs every 1 minute. We wait up to 75 seconds.
  it('Step 3: New game MUST appear on Game Node (Requires Bet Levels in Redis)', async () => {
    await waitForCondition(async () => {
      const res = await api.get(`${GAME_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
      const games = res.data?.data?.games ?? res.data?.data ?? [];

      const found = games.some((g: any) => g.code === UNIQUE_GAME_CODE);
      if (found) console.log(`\n   ✅ Game Node successfully synced ${UNIQUE_GAME_CODE}!`);
      return found;
    }, 75000);
  }, 85000); // 85s test timeout
}

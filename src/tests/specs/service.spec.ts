import { expect, it } from 'bun:test';
import { api } from '../utils/api';
import { BILLING_URL, GAME_URL, SERVICE_SIGNATURE } from '../utils/config';

export function runServiceTests() {
  it('Billing node is healthy', async () => {
    const res = await api.get(`${BILLING_URL}/v2/service/healthcheck`);
    expect(res.status).toBe(200);
  });

  it('Game node is healthy', async () => {
    const res = await api.get(`${GAME_URL}/v2/service/healthcheck`);
    expect(res.status).toBe(200);
  });

  it('Billing /v2/service/games lists LGS-004', async () => {
    const res = await api.get(`${BILLING_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-004');
    expect(game).toBeDefined();
  });

  it('Billing /v2/service/sync-games has LGS-004 with currencies', async () => {
    const res = await api.get(`${BILLING_URL}/v2/service/sync-games`, { headers: SERVICE_SIGNATURE });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-004');
    expect(game).toBeDefined();
    expect(Array.isArray(game.currencies)).toBe(true);
  });

  it('Game node /v2/service/games lists LGS-004', async () => {
    const res = await api.get(`${GAME_URL}/v2/service/games`, { headers: SERVICE_SIGNATURE });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-004');
    expect(game).toBeDefined();
  });
}

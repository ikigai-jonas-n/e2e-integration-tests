import { it, expect } from 'bun:test';
import { api } from '../utils/api';
import { BILLING, GAME, SVC_SIG } from '../utils/config';

export function runServiceTests() {
  it('Billing node is healthy', async () => {
    const res = await api.get(`${BILLING}/v2/service/healthcheck`);
    expect(res.status).toBe(200);
  });

  it('Game node is healthy', async () => {
    const res = await api.get(`${GAME}/v2/service/healthcheck`);
    expect(res.status).toBe(200);
  });

  it('Billing /v2/service/games lists LGS-001', async () => {
    const res = await api.get(`${BILLING}/v2/service/games`, { headers: SVC_SIG });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-001');
    expect(game).toBeDefined();
  });

  it('Billing /v2/service/sync-games has LGS-001 with currencies', async () => {
    const res = await api.get(`${BILLING}/v2/service/sync-games`, { headers: SVC_SIG });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-001');
    expect(game).toBeDefined();
    expect(Array.isArray(game.currencies)).toBe(true);
  });

  it('Game node /v2/service/games lists LGS-001', async () => {
    const res = await api.get(`${GAME}/v2/service/games`, { headers: SVC_SIG });
    expect(res.status).toBe(200);
    const games = res.data?.data?.games ?? res.data?.data;
    const game = games?.find((g: any) => g.code === 'LGS-001');
    expect(game).toBeDefined();
  });
}
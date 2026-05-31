import { readFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

// Read compose config
const composed = parseYaml(
  readFileSync(path.resolve('./src/docker-compose.services.yml'), 'utf-8'),
) as { services: Record<string, { ports?: string[] }> };

// Read orchestrator config
const orchCfg = parseYaml(readFileSync(path.resolve('./src/e2e-orchestrator.yml'), 'utf-8')) as any;

export function instanceBase(name: string): string {
  const svc = composed.services?.[name];
  const port = svc?.ports?.[0]?.split(':')?.[0];
  if (!port) throw new Error(`Service '${name}' not found in docker-compose.services.yml`);
  return `http://127.0.0.1:${port}`;
}

export const BILLING_URL = instanceBase('billing');
export const GAME_URL = instanceBase('game');
export const SERVICE_SIGNATURE = { 'x-signature': 'rgs-local-signature' };

// --- ADD THESE NEW EXPORTS ---
export const TARGET_GAME_CODE = orchCfg?.global?.testConfig?.targetGameCode ?? 'LGS-004';
export const TARGET_RTP_CODE = orchCfg?.global?.testConfig?.targetRtpCode ?? 'RTP_97';

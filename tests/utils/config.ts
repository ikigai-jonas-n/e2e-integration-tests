import { readFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

// Derive service base URLs from docker-compose.services.yml ports.
// Synchronous at module-load time — works before the orchestrator runs.
const composed = parseYaml(
  readFileSync(path.resolve('./docker-compose.services.yml'), 'utf-8'),
) as { services: Record<string, { ports?: string[] }> };

export function instanceBase(name: string): string {
  const svc = composed.services?.[name];
  const port = svc?.ports?.[0]?.split(':')?.[0];
  if (!port) throw new Error(`Service '${name}' not found in docker-compose.services.yml`);
  return `http://127.0.0.1:${port}`;
}

export const BILLING = instanceBase('billing');
export const GAME = instanceBase('game');
export const SVC_SIG = { 'x-signature': 'rgs-local-signature' };

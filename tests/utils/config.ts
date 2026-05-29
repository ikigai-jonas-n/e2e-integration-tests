import config from '../../e2e-config.json';

export function instanceBase(name: string): string {
  for (const svc of Object.values(config.services)) {
    const inst = (svc as any).instances?.find((i: any) => i.name === name);
    if (inst?.healthCheck) {
      const m = inst.healthCheck.match(/^(https?:\/\/[^\/]+)/);
      if (m) return m[1];
    }
  }
  throw new Error(`Instance '${name}' not found in e2e-config.json`);
}

export const BILLING = instanceBase('billing');
export const GAME    = instanceBase('game');
export const SVC_SIG = { 'x-signature': 'rgs-local-signature' };
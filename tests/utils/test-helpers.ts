/**
 * Test control helpers — slow-test gating and other shared utilities.
 *
 * Slow-test skip:
 *   E2E_FAST=1 bun test:raw                     skip any test using itSlow()
 *   E2E_FAST=1 E2E_SLOW_MS=10000 bun test:raw   skip itSlow() tests > 10s
 *
 * Usage:
 *   import { itSlow } from '../utils/test-helpers';
 *   itSlow('cron propagation 90s', async () => { ... }, 120000);
 */
import { it } from 'bun:test';

export const fastMode = process.env.E2E_FAST === '1';

/**
 * Drop-in replacement for `it` that is automatically skipped when E2E_FAST=1.
 * Use for tests whose expected wall-clock time exceeds a few seconds.
 *
 *   itSlow('cron test 90s', async () => { ... }, 120000);
 *
 * Combined with a version gate:
 *   it.skipIf(fastMode || !kafkaCompatible)('cron test', async () => { ... }, 120000);
 */
export const itSlow: typeof it = fastMode ? it.skip : it;

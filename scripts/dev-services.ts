/**
 * Spin up the full E2E environment without running any tests.
 *
 * Usage:
 *   bun setup:env                   # start services and keep running
 *   E2E_TEARDOWN=1 bun setup:env    # teardown then exit
 *
 * What it does:
 *   1. Provisions git worktrees
 *   2. Starts Docker infra (Kafka, Postgres, MongoDB, Redis, Seq, Dozzle)
 *   3. Runs DB migrations
 *   4. Builds and starts all Node services
 *   5. Prints endpoint table and keeps the process alive
 *
 * Services stay running after this process exits (cleanOnTeardown: false).
 * Next `bun test` or `bun dev` will warm-start in ~5s.
 * Force full restart: bun reset
 */

import { E2EOrchestrator } from '../src/E2EOrchestrator';

const orchestrator = new E2EOrchestrator();

async function main() {
  if (process.env.E2E_TEARDOWN === '1') {
    console.log('\n🛑 Tearing down E2E environment...');
    await orchestrator.teardown();
    console.log('✅ Done.');
    process.exit(0);
  }

  try {
    await orchestrator.setupWorktrees();
    await orchestrator.startInfrastructure();
    await orchestrator.runGlobalMigrations();
    await orchestrator.runServices();

    console.log('\n✅ E2E environment is ready. Services are running.');
    console.log('   Press Ctrl+C to exit (services keep running in background).');
    console.log('   Run tests: bun test');
    console.log('   Tear down: bun reset\n');

    // Keep process alive so logs stream and Ctrl+C is clean
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        console.log('\nExiting (services still running)…');
        resolve();
      });
      process.on('SIGTERM', () => resolve());
    });
  } catch (err) {
    console.error('❌ Failed to start E2E environment:', err);
    process.exit(1);
  }
}

main();

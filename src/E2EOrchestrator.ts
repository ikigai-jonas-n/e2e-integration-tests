import fs from 'fs';
import path from 'path';
import { execSync } from 'node:child_process';
import axios from 'axios';
import config from '../e2e-config.json';

interface CommandDef { run: string; sync: boolean; }

export class E2EOrchestrator {
  private activeProcesses: any[] = [];
  private worktreeBase = path.resolve(config.global.worktreeBasePath);
  private npmCacheDir  = path.resolve('./.e2e-npm-cache');

  /**
   * Computed once at the end of setupWorktrees().
   * true  → services are healthy AND all repos have unchanged code → skip infra/migrations/restarts.
   * false → something changed or services are down → do full startup.
   */
  private _warmStart: boolean = false;

  /**
   * E2E_SKIP_PULL=1 — skip git pull only.
   * Use when testing local uncommitted changes you don't want to clobber with `git reset --hard`.
   * Everything else (warm-start, build cache, etc.) still applies.
   */
  private readonly skipPull = process.env.E2E_SKIP_PULL === '1';

  // ─── Network ────────────────────────────────────────────────────────────────

  private get network(): string | null {
    return (config.global as any).network ?? null;
  }

  // ─── Port resolution ────────────────────────────────────────────────────────

  private get portsToClear(): number[] {
    const ports = new Set<number>();
    for (const svc of Object.values(config.services)) {
      for (const inst of svc.instances) {
        for (const [key, value] of Object.entries(inst.envOverrides || {})) {
          const v = String(value);
          if (/PORT/i.test(key)) {
            const p = parseInt(v, 10);
            if (p > 1024 && p < 65536) ports.add(p);
          }
          for (const m of v.matchAll(/:\/\/(?:localhost|127\.0\.0\.1)[^:]*:(\d+)/g)) {
            const p = parseInt(m[1], 10);
            if (p > 1024) ports.add(p);
          }
        }
        if (inst.healthCheck) {
          const m = inst.healthCheck.match(/:\/\/[^:]+:(\d+)/);
          if (m) ports.add(parseInt(m[1], 10));
        }
      }
    }
    return [...ports].sort((a, b) => a - b);
  }

  // ─── Build cache (commit-hash keyed) ────────────────────────────────────────

  private readonly STATE_FILE = '.e2e-state.json';

  /**
   * Returns a two-part cache key: committed HEAD + a hash of any uncommitted diff.
   * Detects BOTH "new commit pulled" and "local files changed without committing".
   */
  private getBuildKey(worktreeDir: string): { commit: string; dirty: string } | null {
    try {
      const commit = execSync('git rev-parse HEAD', { cwd: worktreeDir }).toString().trim();
      // Hash the diff of the working tree vs HEAD (empty string on a clean tree)
      const diff = execSync('git diff HEAD', { cwd: worktreeDir }).toString();
      // Simple djb2-style hash over the diff text — no external tooling needed
      let h = 5381;
      for (let i = 0; i < diff.length; i++) h = ((h << 5) + h) ^ diff.charCodeAt(i);
      const dirty = (h >>> 0).toString(16);  // unsigned 32-bit hex
      return { commit, dirty };
    } catch { return null; }
  }

  private isBuildCached(worktreeDir: string): boolean {
    const stateFile   = path.join(worktreeDir, this.STATE_FILE);
    const nodeModules = path.join(worktreeDir, 'node_modules');
    const buildIndex  = path.join(worktreeDir, 'build', 'index.js');
    if (!fs.existsSync(stateFile) || !fs.existsSync(nodeModules) || !fs.existsSync(buildIndex)) {
      return false;
    }
    try {
      const saved  = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const current = this.getBuildKey(worktreeDir);
      if (!current) return false;
      return saved.commit === current.commit && saved.dirty === current.dirty;
    } catch { return false; }
  }

  private writeBuildCache(worktreeDir: string): void {
    try {
      const key = this.getBuildKey(worktreeDir);
      if (key) {
        fs.writeFileSync(path.join(worktreeDir, this.STATE_FILE), JSON.stringify(key));
      }
    } catch { /* non-fatal */ }
  }

  /** Human-readable description of why a repo needs a rebuild. */
  private buildCacheStatus(worktreeDir: string): string {
    const stateFile = path.join(worktreeDir, this.STATE_FILE);
    if (!fs.existsSync(path.join(worktreeDir, 'build', 'index.js'))) return 'no build output';
    if (!fs.existsSync(stateFile)) return 'no cache stamp';
    try {
      const saved   = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const current = this.getBuildKey(worktreeDir);
      if (!current) return 'git error';
      if (saved.commit !== current.commit) return `HEAD changed (${saved.commit.slice(0,7)} → ${current.commit.slice(0,7)})`;
      if (saved.dirty  !== current.dirty)  return 'uncommitted local changes detected';
      return 'up-to-date';
    } catch { return 'state file unreadable'; }
  }

  // ─── Warm-start detection ───────────────────────────────────────────────────

  private async detectWarmStart(): Promise<void> {
    console.log('\n📊 Startup Analysis:');

    // ── Step 1: health checks ──
    const urls = (Object.values(config.services) as any[])
      .flatMap((s: any) => s.instances)
      .map((i: any) => i.healthCheck)
      .filter(Boolean) as string[];

    let servicesHealthy = false;
    if (urls.length > 0) {
      try {
        await Promise.all(urls.map(url => axios.get(url, { timeout: 1500 })));
        servicesHealthy = true;
        console.log(`   Services:  ✅ all ${urls.length} health checks passed`);
      } catch {
        console.log(`   Services:  ❌ one or more health checks failed → full startup required`);
      }
    } else {
      console.log('   Services:  ⚠️  no health checks configured');
    }

    // ── Step 2: build cache ──
    let allCached = true;
    for (const [service, data] of Object.entries(config.services)) {
      if (!data.instances?.length) continue;
      const svcDir = path.join(this.worktreeBase, service);
      if (!fs.existsSync(path.join(svcDir, '.git'))) continue;

      const status = this.buildCacheStatus(svcDir);
      const cached = status === 'up-to-date';
      if (!cached) allCached = false;
      console.log(`   ${service.padEnd(24)} ${cached ? '⚡ cached' : `🔄 ${status}`}`);
    }

    this._warmStart = servicesHealthy && allCached;

    if (this._warmStart) {
      console.log('\n⚡ Mode: WARM START — skipping docker / migrations / build / restart. Going straight to tests.\n');
    } else {
      const reasons: string[] = [];
      if (!servicesHealthy) reasons.push('services not healthy');
      if (!allCached)       reasons.push('code changed');
      console.log(`\n🚀 Mode: COLD START — reason: ${reasons.join(', ')}. Running full setup.\n`);
    }
  }

  // ─── Compose override (bridge network support) ──────────────────────────────

  private writeComposeOverride(
    dir: string,
    networkName: string,
    serviceEnvOverrides: Record<string, Record<string, string>>,
  ): void {
    const composeContent = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');
    const serviceNames = [...composeContent.matchAll(/^  (\w[\w-]+):\s*$/gm)].map(m => m[1]);

    const serviceBlocks = serviceNames.map(name => {
      const envLines = Object.entries(serviceEnvOverrides[name] || {})
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => `      - ${k}=${v}`)
        .join('\n');
      const envBlock = envLines ? `    environment:\n${envLines}\n` : '';
      return `  ${name}:\n${envBlock}    networks:\n      - ${networkName}:\n`;
    }).join('\n');

    const override = [
      'services:',
      serviceBlocks,
      'networks:',
      `  ${networkName}:`,
      '    external: true',
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'docker-compose.override.yml'), override);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private runAsync(cmd: string, cwd: string, env: any = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = Bun.spawn(cmd.split(' '), { cwd, env, stdout: 'pipe', stderr: 'pipe' });
      proc.exited.then(async () => {
        if (proc.exitCode === 0) resolve();
        else {
          const err = await new Response(proc.stderr).text();
          reject(new Error(`Command failed: ${cmd}\n${err}`));
        }
      });
    });
  }

  private buildEnvironment(
    worktreeDir: string,
    envBaseFile: string,
    overrides: Record<string, string>,
    index: number,
  ) {
    const envPath = path.join(worktreeDir, envBaseFile);
    let baseEnv: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const rawEnv = fs.readFileSync(envPath, 'utf-8');
      rawEnv.split('\n').forEach((line: string) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...val] = trimmed.split('=');
          baseEnv[key] = val.join('=');
        }
      });
    }
    const finalEnv = { ...process.env, ...baseEnv, npm_config_cache: this.npmCacheDir };
    for (const [key, value] of Object.entries(overrides)) {
      finalEnv[key] = String(value).replace(/{INDEX}/g, index.toString());
    }
    return finalEnv;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async setupWorktrees() {
    console.log('🧹 Running Pre-flight Cleanup...');

    const ports = this.portsToClear;
    console.log(`   Clearing ports: [${ports.join(', ')}]`);
    for (const port of ports) {
      try {
        execSync(
          `lsof -i:${port} | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
        );
      } catch (e) {}
    }

    if (this.skipPull) {
      console.log('⚡ E2E_SKIP_PULL=1: skipping git pull (using local working tree as-is).');
    } else {
      if (!fs.existsSync(this.worktreeBase)) {
        fs.mkdirSync(this.worktreeBase, { recursive: true });
      }

      console.log('🌳 Provisioning Git Worktrees (Concurrently)...');
      const tasks = Object.entries(config.services).map(async ([service, data]) => {
        const targetDir = path.join(this.worktreeBase, service);
        const repoPath  = path.resolve(data.repoPath);

        if (fs.existsSync(path.join(targetDir, '.git'))) {
          console.log(`   -> Pulling latest for ${service} @ ${data.target}...`);
          if (fs.existsSync(path.join(targetDir, 'docker-compose.yml'))) {
            Bun.spawnSync(['docker-compose', 'down', '-v', '--remove-orphans'], { cwd: targetDir });
          }
          await this.runAsync('git reset --hard HEAD', targetDir);
          await this.runAsync(`git pull origin ${data.target}`, targetDir);
        } else {
          console.log(`   -> Cloning ${service} @ ${data.target}...`);
          if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
          await this.runAsync('git fetch --all', repoPath);
          try { await this.runAsync('git worktree prune', repoPath); } catch (e) {}
          await this.runAsync(`git worktree add -f ${targetDir} ${data.target}`, repoPath);
        }
      });
      await Promise.all(tasks);
    }

    // Auto-detect warm start AFTER git pull so HEAD reflects latest remote state.
    // Warm = all healthchecks pass AND no repo has changed since last successful build.
    await this.detectWarmStart();
    if (this._warmStart) {
      console.log('⚡ Auto warm start: services healthy, code unchanged — will skip infra/migrations/restart.');
    }
  }

  async startInfrastructure() {
    if (this._warmStart) {
      console.log('⚡ Warm start: skipping Docker infrastructure startup.');
      return;
    }

    console.log('🐳 Starting Infrastructure (Docker Compose)...');
    const infraServices = ['queue-service', 'remote-game-server'];

    if (this.network) {
      console.log(`   -> Creating Docker network '${this.network}'...`);
      execSync(`docker network create ${this.network} 2>/dev/null || true`);
    }

    await Promise.all(infraServices.map(async (service) => {
      const dir         = path.join(this.worktreeBase, service);
      const composeFile = path.join(dir, 'docker-compose.yml');
      if (!fs.existsSync(composeFile)) return;

      console.log(`   -> Bringing up ${service} infra...`);
      let content = fs.readFileSync(composeFile, 'utf-8');
      content = content
        .replace(/'7000:9000'/g, "'7002:9000'").replace(/"7000:9000"/g, '"7002:9000"')
        .replace(/'7001:9001'/g, "'7003:9001'").replace(/"7001:9001"/g, '"7003:9001"');
      fs.writeFileSync(composeFile, content);

      if (this.network) {
        const svcData = (config.services as any)[service];
        this.writeComposeOverride(dir, this.network, svcData?.composeServiceEnvOverrides ?? {});
      }

      await this.runAsync('docker-compose up -d', dir);
    }));

    console.log('⏳ Waiting 10 seconds for Databases to initialize...');
    await new Promise(r => setTimeout(r, 10000));
  }

  async runGlobalMigrations() {
    if (this._warmStart) {
      console.log('⚡ Warm start: skipping migrations.');
      return;
    }

    console.log('🗄️ Running DB Migrations...');
    for (const [service, data] of Object.entries(config.services)) {
      const worktreeDir   = path.join(this.worktreeBase, service);
      const migrationsDir = path.join(worktreeDir, 'db-migrations');
      if (!fs.existsSync(migrationsDir)) continue;

      let migrationEnv = process.env;
      const firstInstance = data.instances?.[0];
      if (firstInstance) {
        migrationEnv = this.buildEnvironment(
          worktreeDir,
          firstInstance.envBase,
          firstInstance.envOverrides as Record<string, string> || {},
          1,
        ) as any;
        const baseEnvPath = path.join(worktreeDir, firstInstance.envBase);
        const destEnvPath = path.join(worktreeDir, '.env');
        if (fs.existsSync(baseEnvPath)) {
          fs.copyFileSync(baseEnvPath, destEnvPath);
          if (firstInstance.envOverrides) {
            const overrides = Object.entries(firstInstance.envOverrides)
              .map(([k, v]) => `${k}=${String(v).replace(/{INDEX}/g, '1')}`);
            fs.appendFileSync(destEnvPath, '\n' + overrides.join('\n') + '\n');
          }
        }
      }

      const dbs = fs.readdirSync(migrationsDir)
        .filter((f: string) => fs.statSync(path.join(migrationsDir, f)).isDirectory());
      for (const db of dbs) {
        console.log(`   -> Migrating ${service} -> ${db}`);
        const proc = Bun.spawnSync(
          ['npx', '--yes', '@ikigaians/migrate@2.0.1-alpha.6', 'up', db],
          { cwd: worktreeDir, stdout: 'inherit', env: migrationEnv as any },
        );
        if (proc.exitCode !== 0) console.error(`❌ Migration failed for ${db}`);
      }
    }
  }

  async runServices() {
    if (this._warmStart) {
      console.log('⚡ Warm start: all services already running with current code.');
      return;
    }

    console.log('🚀 Preparing Dependencies & Builds (Concurrently)...');

    const buildTasks: Promise<void>[] = [];
    const executionTasks: any[]       = [];
    const healthChecksToAwait: string[] = [];
    const preparedWorktrees = new Set<string>();

    for (const [service, data] of Object.entries(config.services)) {
      const worktreeDir = path.join(this.worktreeBase, service);

      for (const instance of data.instances) {
        const count = instance.count || 1;
        for (let i = 1; i <= count; i++) {
          const instanceName = count > 1 ? `${instance.name}-${i}` : instance.name;

          // Merge networkEnvOverrides on top of envOverrides when bridge network is active
          const allOverrides = {
            ...(instance.envOverrides || {}),
            ...(this.network ? (instance as any).networkEnvOverrides || {} : {}),
          } as Record<string, string>;
          const mergedEnv = this.buildEnvironment(worktreeDir, instance.envBase, allOverrides, i);

          if (instance.healthCheck) {
            healthChecksToAwait.push(instance.healthCheck.replace(/{INDEX}/g, i.toString()));
          }

          const syncCmds  = (instance.commands as CommandDef[]).filter(c => c.sync);
          const asyncCmds = (instance.commands as CommandDef[]).filter(c => !c.sync);

          if (syncCmds.length > 0 && !preparedWorktrees.has(worktreeDir)) {
            preparedWorktrees.add(worktreeDir);
            buildTasks.push((async () => {
              if (this.isBuildCached(worktreeDir)) {
                console.log(`   [CACHE HIT] ${service}: skipping install & build (HEAD unchanged)`);
                return;
              }
              for (const cmd of syncCmds) {
                console.log(`   [BUILD] ${service}: ${cmd.run}`);
                const proc = Bun.spawn(['sh', '-c', cmd.run], { cwd: worktreeDir, env: mergedEnv as any });
                await proc.exited;
                if (proc.exitCode !== 0) {
                  const err = await new Response(proc.stderr).text();
                  throw new Error(`Build failed for ${service}: ${err}`);
                }
              }
              this.writeBuildCache(worktreeDir);
            })());
          }
          executionTasks.push({ instanceName, worktreeDir, mergedEnv, asyncCmds });
        }
      }
    }

    await Promise.all(buildTasks);

    console.log('\n🚀 Starting Node Servers...');
    for (const task of executionTasks) {
      for (const cmd of task.asyncCmds) {
        console.log(`   [START] ${task.instanceName}: ${cmd.run}`);
        const proc = Bun.spawn(['sh', '-c', cmd.run], {
          cwd: task.worktreeDir,
          env: task.mergedEnv as any,
        });
        proc.stdout?.pipeTo(new WritableStream({
          write: chunk => process.stdout.write(`[${task.instanceName}] ${new TextDecoder().decode(chunk)}`),
        }));
        proc.stderr?.pipeTo(new WritableStream({
          write: chunk => process.stderr.write(`[${task.instanceName} ERROR] ${new TextDecoder().decode(chunk)}`),
        }));
        this.activeProcesses.push(proc);
      }
    }

    await this.waitForHealthChecks(healthChecksToAwait);
  }

  private async waitForHealthChecks(urls: string[]) {
    if (urls.length === 0) return;
    console.log(`\n⏳ Waiting for ${urls.length} health checks (parallel)...`);
    await Promise.all(urls.map(async (url) => {
      for (let attempt = 1; attempt <= 60; attempt++) {
        try {
          await axios.get(url, { timeout: 2000 });
          console.log(`   ✅ Ready: ${url}`);
          return;
        } catch {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      throw new Error(`❌ Healthcheck failed after 60 attempts: ${url}`);
    }));
  }

  async teardown() {
    console.log('\n🛑 Tearing down E2E Environment...');
    this.activeProcesses.forEach(proc => {
      try { proc.kill('SIGKILL'); } catch (e) {}
    });

    if (fs.existsSync(this.worktreeBase)) {
      for (const [service, data] of Object.entries(config.services)) {
        const dir = path.join(this.worktreeBase, service);
        if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
          try {
            Bun.spawnSync(['docker-compose', 'down', '-v', '--remove-orphans'], { cwd: dir });
          } catch (e) {}
        }
        if (config.global.cleanOnTeardown) {
          try {
            Bun.spawnSync(['git', 'worktree', 'remove', '-f', dir], {
              cwd: path.resolve(data.repoPath),
            });
          } catch (e) {}
        }
      }
      if (config.global.cleanOnTeardown) {
        fs.rmSync(this.worktreeBase, { recursive: true, force: true });
      }
    }
  }
}

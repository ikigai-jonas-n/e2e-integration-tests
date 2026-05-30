import fs from 'fs';
import path from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import { parse as parseYaml } from 'yaml';

// ─── e2e-orchestrator.yml types ───────────────────────────────────────────────

interface OrchestratorGlobal {
  worktreeBasePath: string;
  cleanOnTeardown: boolean;
  verbose: boolean | 'errors';
  network: string | null;
}

interface RepoConfig {
  repoPath: string;
  target: string;
}

interface OrchestratorConfig {
  global: OrchestratorGlobal;
  repos: Record<string, RepoConfig>;
  composeServiceEnvOverrides?: Record<string, Record<string, Record<string, string>>>;
}

// ─── docker-compose.services.yml types ───────────────────────────────────────

interface ComposeService {
  // Orchestrator hints (x-* fields — Docker Compose ignores these)
  'x-repo': string;
  'x-env-file': string;
  'x-setup'?: string[];
  'x-bridge-env'?: Record<string, string>;
  // Standard Docker Compose fields
  command: string;
  environment?: Record<string, string> | string[];
  ports?: string[];
  healthcheck?: { test: string[] };
  depends_on?: string[] | Record<string, { condition?: string }>;
}

// ─── Load configs ─────────────────────────────────────────────────────────────

const orchestratorCfg = parseYaml(
  readFileSync(path.resolve('./e2e-orchestrator.yml'), 'utf-8'),
) as OrchestratorConfig;

const composeServices = (parseYaml(
  readFileSync(path.resolve('./docker-compose.services.yml'), 'utf-8'),
) as { services: Record<string, ComposeService> }).services;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise Docker Compose environment to a flat map. Handles both map and array forms. */
function parseEnv(env: Record<string, string> | string[] | null | undefined): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map(item => { const [k, ...v] = String(item).split('='); return [k, v.join('=')]; }),
    );
  }
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
}

/** Extract host port number from a ports entry like "8080:8080". */
function hostPort(ports: string[] | undefined): number | null {
  if (!ports?.length) return null;
  return parseInt(String(ports[0]).split(':')[0], 10) || null;
}

/** Extract the http:// healthcheck URL from healthcheck.test args. */
function healthCheckUrl(svc: ComposeService): string | null {
  const args = svc.healthcheck?.test;
  if (!args) return null;
  return args.find(a => a.startsWith('http://') || a.startsWith('https://')) ?? null;
}

/** Return list of service names this service depends on. */
function dependsOn(svc: ComposeService): string[] {
  const d = svc.depends_on;
  if (!d) return [];
  if (Array.isArray(d)) return d as string[];
  return Object.keys(d);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class E2EOrchestrator {
  private activeProcesses: any[] = [];
  private worktreeBase = path.resolve(orchestratorCfg.global.worktreeBasePath);
  private npmCacheDir  = path.resolve('./.e2e-npm-cache');
  private _warmStart   = false;
  private readonly skipPull = process.env.E2E_SKIP_PULL === '1';

  private _masterStream: ReturnType<typeof fs.createWriteStream> | null = null;

  // ─── Verbose ──────────────────────────────────────────────────────────────

  private get verbose(): boolean | 'errors' {
    const v = orchestratorCfg.global.verbose;
    if (v === 'errors') return 'errors';
    return v === true;
  }

  // ─── Log directory ────────────────────────────────────────────────────────

  /** Timestamped folder set by run-e2e.sh via E2E_LOG_DIR=logs/<timestamp> */
  private get logDir(): string | null {
    return process.env.E2E_LOG_DIR ?? null;
  }

  private ensureMasterStream(): ReturnType<typeof fs.createWriteStream> | null {
    if (!this.logDir) return null;
    if (!this._masterStream) {
      this._masterStream = fs.createWriteStream(path.join(this.logDir, '_master.log'), { flags: 'a' });
    }
    return this._masterStream;
  }

  /** Per-service log: logs/<timestamp>/<name>-<port>.log */
  private openServiceStream(name: string, port: number): ReturnType<typeof fs.createWriteStream> | null {
    if (!this.logDir) return null;
    return fs.createWriteStream(path.join(this.logDir, `${name}-${port}.log`), { flags: 'a' });
  }

  // ─── Network ──────────────────────────────────────────────────────────────

  private get network(): string | null {
    return orchestratorCfg.global.network ?? null;
  }

  // ─── Ports to clear on cold start ─────────────────────────────────────────

  private get portsToClear(): number[] {
    return Object.values(composeServices)
      .map(s => hostPort(s.ports))
      .filter((p): p is number => p !== null)
      .sort((a, b) => a - b);
  }

  // ─── Build cache ──────────────────────────────────────────────────────────

  private readonly STATE_FILE = '.e2e-state.json';

  private getBuildKey(dir: string): { commit: string; dirty: string } | null {
    try {
      const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      const diff   = execSync(
        'git diff HEAD -- ":(exclude)*docker-compose*" ":(exclude)*.env*"',
        { cwd: dir },
      ).toString();
      let h = 5381;
      for (let i = 0; i < diff.length; i++) h = ((h << 5) + h) ^ diff.charCodeAt(i);
      return { commit, dirty: (h >>> 0).toString(16) };
    } catch { return null; }
  }

  private isBuildCached(dir: string): boolean {
    if (
      !fs.existsSync(path.join(dir, this.STATE_FILE))     ||
      !fs.existsSync(path.join(dir, 'node_modules'))      ||
      !fs.existsSync(path.join(dir, 'build', 'index.js'))
    ) return false;
    try {
      const saved   = JSON.parse(fs.readFileSync(path.join(dir, this.STATE_FILE), 'utf-8'));
      const current = this.getBuildKey(dir);
      if (!current) return false;
      return saved.commit === current.commit && saved.dirty === current.dirty;
    } catch { return false; }
  }

  private writeBuildCache(dir: string): void {
    try {
      const key = this.getBuildKey(dir);
      if (key) fs.writeFileSync(path.join(dir, this.STATE_FILE), JSON.stringify(key));
    } catch { /* non-fatal */ }
  }

  private buildCacheStatus(dir: string): string {
    if (!fs.existsSync(path.join(dir, 'build', 'index.js'))) return 'no build output';
    if (!fs.existsSync(path.join(dir, this.STATE_FILE)))     return 'no cache stamp';
    try {
      const saved   = JSON.parse(fs.readFileSync(path.join(dir, this.STATE_FILE), 'utf-8'));
      const current = this.getBuildKey(dir);
      if (!current) return 'git error';
      if (saved.commit !== current.commit)
        return `HEAD changed (${saved.commit.slice(0, 7)} → ${current.commit.slice(0, 7)})`;
      if (saved.dirty !== current.dirty) return 'source files changed (uncommitted)';
      return 'up-to-date';
    } catch { return 'state file unreadable'; }
  }

  // ─── Warm-start detection ─────────────────────────────────────────────────

  private async detectWarmStart(): Promise<void> {
    console.log('\n📊 Startup Analysis:');

    const healthUrls = Object.values(composeServices)
      .map(s => healthCheckUrl(s))
      .filter(Boolean) as string[];

    let servicesHealthy = false;
    if (healthUrls.length > 0) {
      try {
        await Promise.all(healthUrls.map(url => axios.get(url, { timeout: 1500 })));
        servicesHealthy = true;
        console.log(`   Services:  ✅ all ${healthUrls.length} health checks passed`);
      } catch {
        console.log('   Services:  ❌ one or more health checks failed → full startup required');
      }
    } else {
      console.log('   Services:  ⚠️  no health checks configured');
    }

    // One build-cache check per repo (multiple services can share a repo)
    const checkedRepos = new Set<string>();
    let allCached = true;
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (checkedRepos.has(repo)) continue;
      checkedRepos.add(repo);
      const svcDir = path.join(this.worktreeBase, repo);
      if (!fs.existsSync(path.join(svcDir, '.git'))) continue;
      const status = this.buildCacheStatus(svcDir);
      const cached = status === 'up-to-date';
      if (!cached) allCached = false;
      console.log(`   ${repo.padEnd(24)} ${cached ? '⚡ cached' : `🔄 ${status}`}`);
    }

    this._warmStart = servicesHealthy && allCached;

    const v    = this.verbose;
    const note = v === true     ? '(verbose=true: service logs → terminal+log)'     :
                 v === 'errors' ? '(verbose="errors": stderr→terminal, stdout→log)' :
                                  '(verbose=false: service logs → log file only)';
    if (this._warmStart) {
      console.log(`\n⚡ Mode: WARM START — skipping docker / migrations / build / restart. ${note}\n`);
    } else {
      const reasons = [
        ...(!servicesHealthy ? ['services not healthy'] : []),
        ...(!allCached       ? ['code changed']         : []),
      ];
      console.log(`\n🚀 Mode: COLD START — reason: ${reasons.join(', ')}. ${note}\n`);
    }
  }

  // ─── Compose override (bridge network) ───────────────────────────────────

  private writeComposeOverride(
    dir: string,
    networkName: string,
    svcEnvOverrides: Record<string, Record<string, string>>,
  ): void {
    const content  = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');
    const svcNames = [...content.matchAll(/^  (\w[\w-]+):\s*$/gm)].map(m => m[1]);
    const blocks   = svcNames.map(name => {
      const envLines = Object.entries(svcEnvOverrides[name] || {})
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => `      - ${k}=${v}`)
        .join('\n');
      const envBlock = envLines ? `    environment:\n${envLines}\n` : '';
      return `  ${name}:\n${envBlock}    networks:\n      - ${networkName}:\n`;
    }).join('\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.override.yml'), [
      'services:', blocks, 'networks:', `  ${networkName}:`, '    external: true',
    ].join('\n'));
  }

  // ─── Internals ────────────────────────────────────────────────────────────

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

  /**
   * Builds the final process environment for a service.
   * Merge order (later wins): process.env → x-env-file → environment → x-bridge-env (if network)
   */
  private buildEnvironment(worktreeDir: string, svc: ComposeService): Record<string, string> {
    const envPath = path.join(worktreeDir, svc['x-env-file']);
    const fileEnv: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
          const [key, ...val] = t.split('=');
          if (key) fileEnv[key] = val.join('=');
        }
      });
    }
    const bridgeEnv = this.network ? (svc['x-bridge-env'] ?? {}) : {};
    return {
      ...(process.env as Record<string, string>),
      ...fileEnv,
      ...parseEnv(svc.environment),
      ...bridgeEnv,
      npm_config_cache: this.npmCacheDir,
    };
  }

  // ─── Endpoint export ──────────────────────────────────────────────────────

  private exportEndpoints(): void {
    const endpoints: Record<string, string> = {};
    const postmanValues: { key: string; value: string; type: string; enabled: boolean }[] = [];
    const rows: string[] = [];

    for (const [name, svc] of Object.entries(composeServices)) {
      const port = hostPort(svc.ports);
      if (!port) continue;
      const url = `http://127.0.0.1:${port}`;
      endpoints[name] = url;
      rows.push(`  ${name.padEnd(22)} →  ${url}`);
      postmanValues.push({
        key: name.toUpperCase().replace(/-/g, '_') + '_URL',
        value: url,
        type: 'default',
        enabled: true,
      });
    }

    const sep = '─'.repeat(52);
    console.log(`\n┌${sep}┐`);
    console.log(`│  Active Service Endpoints${' '.repeat(sep.length - 26)}│`);
    console.log(`├${sep}┤`);
    rows.forEach(r => console.log(`│${r.padEnd(sep.length + 1)}│`));
    console.log(`└${sep}┘\n`);

    // Consumed by tests/utils/config.ts as a fast lookup after first run
    fs.writeFileSync('./.e2e-endpoints.json', JSON.stringify(endpoints, null, 2));

    // Drag-and-drop into Postman for manual API testing
    fs.writeFileSync('./E2E_Local.postman_environment.json', JSON.stringify({
      id: 'e2e-local-dev',
      name: 'E2E Local Environment',
      values: postmanValues,
      _postman_variable_scope: 'environment',
    }, null, 2));
    console.log('📦 Postman env → E2E_Local.postman_environment.json');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async setupWorktrees() {
    if (this.skipPull) {
      console.log('⚡ E2E_SKIP_PULL=1: skipping git pull (using local working tree as-is).');
    } else {
      if (!fs.existsSync(this.worktreeBase)) {
        fs.mkdirSync(this.worktreeBase, { recursive: true });
      }
      console.log('🌳 Provisioning Git Worktrees (Concurrently)...');
      await Promise.all(Object.entries(orchestratorCfg.repos).map(async ([repoName, repo]) => {
        const targetDir = path.join(this.worktreeBase, repoName);
        const repoPath  = path.resolve(repo.repoPath);
        if (fs.existsSync(path.join(targetDir, '.git'))) {
          console.log(`   -> Pulling latest for ${repoName} @ ${repo.target}...`);
          await this.runAsync('git reset --hard HEAD', targetDir);
          await this.runAsync(`git pull origin ${repo.target}`, targetDir);
        } else {
          console.log(`   -> Cloning ${repoName} @ ${repo.target}...`);
          if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
          await this.runAsync('git fetch --all', repoPath);
          try { await this.runAsync('git worktree prune', repoPath); } catch {}
          await this.runAsync(`git worktree add -f ${targetDir} ${repo.target}`, repoPath);
        }
      }));
    }

    await this.detectWarmStart();

    if (!this._warmStart) {
      const ports = this.portsToClear;
      console.log(`🧹 Cold start: clearing stale processes on ports [${ports.join(', ')}]`);
      for (const port of ports) {
        try {
          execSync(`lsof -i:${port} | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`);
        } catch {}
      }
    }
  }

  async startInfrastructure() {
    this.ensureDockerRunning();
    if (this._warmStart) {
      console.log('⚡ Warm start: skipping Docker infrastructure startup.');
      return;
    }

    console.log('🐳 Starting Infrastructure (Docker Compose)...');
    const infraRepos = ['queue-service', 'remote-game-server'];

    if (this.network) {
      console.log(`   -> Creating Docker network '${this.network}'...`);
      execSync(`docker network create ${this.network} 2>/dev/null || true`);
    }

    await Promise.all(infraRepos.map(async repoName => {
      const dir         = path.join(this.worktreeBase, repoName);
      const composeFile = path.join(dir, 'docker-compose.yml');
      if (!fs.existsSync(composeFile)) return;

      console.log(`   -> Bringing up ${repoName} infra...`);
      // Remap RustFS ports 7000/7001 → 7002/7003 to avoid AirPlay conflict on macOS
      let content = fs.readFileSync(composeFile, 'utf-8');
      content = content
        .replace(/'7000:9000'/g, "'7002:9000'").replace(/"7000:9000"/g, '"7002:9000"')
        .replace(/'7001:9001'/g, "'7003:9001'").replace(/"7001:9001"/g, '"7003:9001"');
      fs.writeFileSync(composeFile, content);

      if (this.network) {
        const overrides = orchestratorCfg.composeServiceEnvOverrides?.[repoName] ?? {};
        this.writeComposeOverride(dir, this.network, overrides);
      }
      await this.runAsync('docker compose up -d', dir);
    }));

    console.log('⏳ Waiting 15 seconds for Databases and Kafka to initialize...');
    await new Promise(r => setTimeout(r, 15000));
  }

  async runGlobalMigrations() {
    if (this._warmStart) {
      console.log('⚡ Warm start: skipping migrations.');
      return;
    }
    console.log('🗄️  Running DB Migrations...');

    // Run migrations once per repo (multiple services may share a repo)
    const reposMigrated = new Set<string>();
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (reposMigrated.has(repo)) continue;
      const worktreeDir   = path.join(this.worktreeBase, repo);
      const migrationsDir = path.join(worktreeDir, 'db-migrations');
      if (!fs.existsSync(migrationsDir)) continue;
      reposMigrated.add(repo);

      const migrationEnv = this.buildEnvironment(worktreeDir, svc);
      const baseEnvPath  = path.join(worktreeDir, svc['x-env-file']);
      const destEnvPath  = path.join(worktreeDir, '.env');
      if (fs.existsSync(baseEnvPath)) {
        fs.copyFileSync(baseEnvPath, destEnvPath);
        const lines = Object.entries(parseEnv(svc.environment)).map(([k, v]) => `${k}=${v}`);
        if (lines.length) fs.appendFileSync(destEnvPath, '\n' + lines.join('\n') + '\n');
      }

      const dbs = fs.readdirSync(migrationsDir)
        .filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory());
      for (const db of dbs) {
        console.log(`   -> Migrating ${repo} -> ${db}`);
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
      this.exportEndpoints();
      return;
    }

    console.log('🚀 Preparing Dependencies & Builds (Concurrently)...');

    // ── Phase 1: build (once per repo, git-hash cached) ──────────────────────

    const buildTasks: Promise<void>[] = [];
    const builtRepos = new Set<string>();

    for (const svc of Object.values(composeServices)) {
      const repo        = svc['x-repo'];
      const setupCmds   = svc['x-setup'] ?? [];
      const worktreeDir = path.join(this.worktreeBase, repo);
      if (!setupCmds.length || builtRepos.has(repo)) continue;
      builtRepos.add(repo);

      buildTasks.push((async () => {
        if (this.isBuildCached(worktreeDir)) {
          console.log(`   [CACHE HIT] ${repo}: skipping install & build`);
          return;
        }
        const mergedEnv = this.buildEnvironment(worktreeDir, svc);
        for (const cmd of setupCmds) {
          console.log(`   [BUILD] ${repo}: ${cmd}`);
          const proc = Bun.spawn(['sh', '-c', cmd], { cwd: worktreeDir, env: mergedEnv as any });
          await proc.exited;
          if (proc.exitCode !== 0) {
            const err = await new Response(proc.stderr).text();
            throw new Error(`Build failed for ${repo}: ${err}`);
          }
        }
        this.writeBuildCache(worktreeDir);
      })());
    }

    await Promise.all(buildTasks);

    // ── Phase 2: start services, honouring depends_on ─────────────────────────
    //
    // Each service gets a "ready" promise that resolves once its healthcheck passes
    // (or immediately if no healthcheck). Dependents await their deps' ready promises
    // before spawning — replacing `while ! curl` bash hacks with native logic.

    console.log('\n🚀 Starting Node Servers...');
    const verboseMode  = this.verbose;
    const masterStream = this.ensureMasterStream();

    // Register all ready promises upfront so deps can reference them immediately
    const readyMap = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    for (const name of Object.keys(composeServices)) {
      let resolve!: () => void;
      readyMap.set(name, { resolve, promise: new Promise<void>(r => { resolve = r; }) });
    }

    // Track actual health-check failures separately from dep-coordination
    const healthCheckResults: Promise<void>[] = [];

    const launchTasks = Object.entries(composeServices).map(([name, svc]) => (async () => {
      // Await declared dependencies before starting
      const deps = dependsOn(svc);
      if (deps.length > 0) {
        const depPromises = deps.map(d => readyMap.get(d)?.promise).filter(Boolean) as Promise<void>[];
        if (depPromises.length) {
          console.log(`   [WAIT]  ${name}: waiting for [${deps.join(', ')}]...`);
          await Promise.all(depPromises);
          console.log(`   [READY] ${name}: dependencies healthy — starting`);
        }
      }

      const worktreeDir   = path.join(this.worktreeBase, svc['x-repo']);
      const port          = hostPort(svc.ports) ?? 0;
      const hcUrl         = healthCheckUrl(svc);
      const mergedEnv     = this.buildEnvironment(worktreeDir, svc);
      const serviceStream = this.openServiceStream(name, port);
      const dec           = new TextDecoder();

      console.log(`   [START] ${name}: ${svc.command}`);
      const proc = Bun.spawn(['sh', '-c', svc.command], {
        cwd: worktreeDir,
        env: mergedEnv as any,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // stdout → per-service log (raw) + master log (prefixed) + terminal if verbose=true
      proc.stdout?.pipeTo(new WritableStream({
        write: chunk => {
          const text = dec.decode(chunk);
          serviceStream?.write(text);
          masterStream?.write(`[${name}] ${text}`);
          if (verboseMode === true) process.stdout.write(`[${name}] ${text}`);
        },
      }));

      // stderr → per-service log (raw) + master log (prefixed) + terminal if verbose or "errors"
      proc.stderr?.pipeTo(new WritableStream({
        write: chunk => {
          const text = dec.decode(chunk);
          serviceStream?.write(text);
          masterStream?.write(`[${name} ERR] ${text}`);
          if (verboseMode === true || verboseMode === 'errors') process.stderr.write(`[${name} ERR] ${text}`);
        },
      }));

      this.activeProcesses.push(proc);

      if (hcUrl) {
        const hcPromise = this.pollHealthCheck(name, hcUrl);
        healthCheckResults.push(hcPromise);
        hcPromise
          .then(() => readyMap.get(name)!.resolve())
          .catch(() => readyMap.get(name)!.resolve()); // unblock dependents even on timeout
      } else {
        readyMap.get(name)!.resolve();
      }
    })());

    // Wait for all launch tasks (dep-wait + start + health-check)
    await Promise.all(launchTasks);
    // Surface any health-check failures
    await Promise.all(healthCheckResults);

    console.log('\n✅ All services started.\n');
    this.exportEndpoints();
  }

  private async pollHealthCheck(name: string, url: string): Promise<void> {
    for (let attempt = 1; attempt <= 60; attempt++) {
      try {
        await axios.get(url, { timeout: 2000 });
        console.log(`   ✅ Ready: ${name} (${url})`);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error(`❌ Healthcheck failed after 60 attempts: ${name} (${url})`);
  }

  async teardown() {
    const forceTeardown = process.env.E2E_TEARDOWN === '1';
    if (!orchestratorCfg.global.cleanOnTeardown && !forceTeardown) {
      console.log('\n⚡ Services left running. Next bun test will warm-start in ~5s.');
      console.log('   (Force stop: E2E_TEARDOWN=1 bun test  or  cleanOnTeardown: true in e2e-orchestrator.yml)');
      return;
    }

    console.log('\n🛑 Tearing down E2E Environment...');
    this.activeProcesses.forEach(proc => { try { proc.kill('SIGKILL'); } catch {} });
    for (const port of this.portsToClear) {
      try { execSync(`lsof -i:${port} | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`); } catch {}
    }

    if (fs.existsSync(this.worktreeBase)) {
      for (const [repoName, repo] of Object.entries(orchestratorCfg.repos)) {
        const dir = path.join(this.worktreeBase, repoName);
        if (fs.existsSync(path.join(dir, 'docker-compose.yml'))) {
          try { Bun.spawnSync(['docker', 'compose', 'down', '-v', '--remove-orphans'], { cwd: dir }); } catch {}
        }
        try { Bun.spawnSync(['git', 'worktree', 'remove', '-f', dir], { cwd: path.resolve(repo.repoPath) }); } catch {}
      }
      fs.rmSync(this.worktreeBase, { recursive: true, force: true });
    }
  }

  private ensureDockerRunning() {
    try {
      execSync('docker info', { stdio: 'ignore' });
    } catch {
      console.log('🐳 Docker daemon is down. Attempting to auto-start Docker Desktop...');
      if (process.platform === 'darwin') {
        execSync('open -a Docker');
        console.log('⏳ Waiting for Docker VM to boot (up to 40s)...');
        let ready = false;
        for (let i = 0; i < 40; i++) {
          try { execSync('docker info', { stdio: 'ignore' }); ready = true; console.log('✅ Docker daemon online!'); break; }
          catch { execSync('sleep 1'); }
        }
        if (!ready) throw new Error('Timeout: Docker daemon failed to start.');
      } else {
        throw new Error('Docker daemon is not running. Auto-start only supported on macOS.');
      }
    }
  }
}

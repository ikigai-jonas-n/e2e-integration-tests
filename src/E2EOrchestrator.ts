import axios from 'axios';
import fs, { readFileSync } from 'fs';
import { execSync } from 'node:child_process';
import path from 'path';
import { parse as parseYaml } from 'yaml';

// ─── e2e-orchestrator.yml types ───────────────────────────────────────────────

interface FlushDataConfig {
  redis?: boolean;
  mongo?: boolean;
  postgres?: boolean;
}

interface OrchestratorGlobal {
  worktreeBasePath: string;
  cleanOnTeardown: boolean;
  verbose: boolean | 'errors';
  network: string | null;
  flushData?: FlushDataConfig; // <-- ADDED
}

interface RepoConfig {
  repoPath: string;
  target: string;
  migrationEnvFile?: string;
  envOverrides?: Record<string, string>;
  skipMigration?: boolean;
  alwaysRedoMigration?: boolean;
  untilMigrationFile?: string;
  flushData?: FlushDataConfig; // <-- ADDED
}

interface ObservabilityConfig {
  seq?: boolean;
  dozzle?: boolean;
}

interface OrchestratorConfig {
  global: OrchestratorGlobal;
  repos: Record<string, RepoConfig>;
  observability?: ObservabilityConfig;
  composeServiceEnvOverrides?: Record<string, Record<string, Record<string, string>>>;
}

// ─── docker-compose.services.yml types ───────────────────────────────────────

interface ComposeService {
  'x-repo'?: string;
  'x-env-file'?: string;
  'x-setup'?: string[];
  'x-bridge-env'?: Record<string, string>;
  command?: string;
  environment?: Record<string, string> | string[];
  ports?: string[];
  healthcheck?: { test: string[] };
  depends_on?: string[] | Record<string, { condition?: string }>;
}

// ─── Load configs ─────────────────────────────────────────────────────────────

const orchestratorCfg = parseYaml(
  readFileSync(path.resolve('./src/e2e-orchestrator.yml'), 'utf-8'),
) as OrchestratorConfig;

const composeServices = (
  parseYaml(readFileSync(path.resolve('./src/docker-compose.services.yml'), 'utf-8')) as {
    services: Record<string, ComposeService>;
  }
).services;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseEnv(
  env: Record<string, string> | string[] | null | undefined,
): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map((item) => {
        const [k, ...v] = String(item).split('=');
        return [k, v.join('=')];
      }),
    );
  }
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
}

function hostPort(ports: string[] | undefined): number | null {
  if (!ports?.length) return null;
  return parseInt(String(ports[0]).split(':')[0], 10) || null;
}

function healthCheckUrl(svc: ComposeService): string | null {
  const args = svc.healthcheck?.test;
  if (!args) return null;
  return args.find((a) => a.startsWith('http://') || a.startsWith('https://')) ?? null;
}

function dependsOn(svc: ComposeService): string[] {
  const d = svc.depends_on;
  if (!d) return [];
  if (Array.isArray(d)) return d as string[];
  return Object.keys(d);
}

// ─── Seq CLEF log forwarder ───────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const PINO_LEVELS: Record<number, string> = {
  10: 'Verbose',
  20: 'Debug',
  30: 'Information',
  40: 'Warning',
  50: 'Error',
  60: 'Fatal',
};

const PINO_PRETTY_BOUNDARY =
  /(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL) )/g;
const PINO_PRETTY_HEADER = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL) /;

const PINO_PRETTY_LEVELS: Record<string, string> = {
  TRACE: 'Verbose',
  DEBUG: 'Debug',
  INFO: 'Information',
  WARN: 'Warning',
  ERROR: 'Error',
  FATAL: 'Fatal',
};

function splitLogEntries(line: string): string[] {
  const stripped = stripAnsi(line);
  const parts = stripped.split(PINO_PRETTY_BOUNDARY).filter(Boolean);
  return parts.length > 1 ? parts : [stripped];
}

function lineToClef(line: string, service: string, isError: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const { level, time, msg, pid, hostname, name, ...rest } = JSON.parse(trimmed);
      const seqLevel = PINO_LEVELS[level as number] ?? (isError ? 'Error' : 'Information');
      const ts = typeof time === 'number' ? new Date(time).toISOString() : new Date().toISOString();
      return JSON.stringify({
        '@t': ts,
        '@l': seqLevel,
        '@m': String(msg ?? trimmed),
        Service: service,
        ...rest,
      });
    } catch {
      /* not valid JSON — fall through */
    }
  }

  const clean = stripAnsi(trimmed);
  const header = clean.match(PINO_PRETTY_HEADER);
  if (header) {
    const [fullHeader, time, levelStr] = header;
    const todayDate = new Date().toISOString().slice(0, 11);
    return JSON.stringify({
      '@t': `${todayDate}${time}Z`,
      '@l': PINO_PRETTY_LEVELS[levelStr] ?? (isError ? 'Error' : 'Information'),
      '@m': clean.slice(fullHeader.length).trim(),
      Service: service,
    });
  }

  if (!clean) return null;
  return JSON.stringify({
    '@t': new Date().toISOString(),
    '@l': isError ? 'Error' : 'Information',
    '@m': clean,
    Service: service,
  });
}

class SeqForwarder {
  private clefBuffer: string[] = [];
  private lineAccum = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly url: string;

  constructor(baseUrl: string) {
    this.url = `${baseUrl}/api/events/raw?clef`;
    this.timer = setInterval(() => this.flush(), 500);
  }

  push(chunk: string, service: string, isError = false): void {
    const text = this.lineAccum + chunk;
    const lines = text.split('\n');
    this.lineAccum = lines.pop() ?? '';

    for (const line of lines) {
      for (const entry of splitLogEntries(line)) {
        const event = lineToClef(entry, service, isError);
        if (event) this.clefBuffer.push(event);
      }
    }
    if (this.clefBuffer.length >= 50) this.flush();
  }

  private flush(): void {
    if (!this.clefBuffer.length) return;
    const body = this.clefBuffer.join('\n');
    this.clefBuffer = [];
    fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.serilog.clef' },
      body,
    }).catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lineAccum.trim()) {
      const event = lineToClef(this.lineAccum, 'unknown', false);
      if (event) this.clefBuffer.push(event);
    }
    this.flush();
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

// ── Ready-state file ─────────────────────────────────────────────────────────
// Written after every successful setup. On the next run, if this file exists
// AND services are healthy AND worktree SHAs match → skip the entire setup
// block and run tests immediately (warm path, <300ms overhead).
// Deleted by background validation if a branch has moved on the remote.

interface E2EReadyState {
  worktrees: Record<string, { sha: string; target: string }>; // repoKey → { HEAD SHA, configured target }
  timestamp: number;
}

export class E2EOrchestrator {
  private activeProcesses: any[] = [];
  private streamControllers: AbortController[] = []; // <-- ADD THIS
  private _changedRepos = new Set<string>();
  private _partialWarmStart = false; // services healthy but some repos changed
  private worktreeBase = path.resolve(orchestratorCfg.global.worktreeBasePath);
  private npmCacheDir = path.resolve('./.e2e-npm-cache');
  private _warmStart = false;
  private readonly skipPull = process.env.E2E_SKIP_PULL === '1';
  // Stored so afterAll can await it and act on stale detection.
  private _bgValidation: Promise<void> | null = null;
  private readonly readyFile = path.join(this.worktreeBase, '.e2e-ready.json');

  private _masterStream: ReturnType<typeof fs.createWriteStream> | null = null;
  private _seq: SeqForwarder | null = null;
  private _logDir: string = (() => {
    if (process.env.E2E_LOG_DIR) return process.env.E2E_LOG_DIR;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.resolve(`logs/${ts}`);
    fs.mkdirSync(dir, { recursive: true });
    const latestLink = path.resolve('logs/latest');
    try {
      fs.unlinkSync(latestLink);
    } catch {}
    fs.symlinkSync(ts, latestLink);
    return dir;
  })();

  private get verbose(): boolean | 'errors' {
    const v = orchestratorCfg.global.verbose;
    return v === 'errors' ? 'errors' : v === true;
  }

  private get logDir(): string {
    return this._logDir;
  }

  private ensureMasterStream(): ReturnType<typeof fs.createWriteStream> {
    if (!this._masterStream) {
      this._masterStream = fs.createWriteStream(path.join(this.logDir, '_master.log'), {
        flags: 'a',
      });
    }
    return this._masterStream;
  }

  private openServiceStream(name: string, port: number): ReturnType<typeof fs.createWriteStream> {
    return fs.createWriteStream(path.join(this.logDir, `${name}-${port}.log`), { flags: 'a' });
  }

  private get network(): string | null {
    return orchestratorCfg.global.network ?? null;
  }

  private get portsToClear(): number[] {
    return Object.values(composeServices)
      .map((s) => hostPort(s.ports))
      .filter((p): p is number => p !== null)
      .sort((a, b) => a - b);
  }

  private killProcessesOnPorts(ports: string[] | undefined): void {
    for (const port of (ports ?? [])
      .map((p) => hostPort([p]))
      .filter((p): p is number => p !== null)) {
      try {
        execSync(
          `lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
        );
      } catch {}
    }
  }

  // ─── Build cache ──────────────────────────────────────────────────────────

  private readonly STATE_FILE = '.e2e-state.json';

  private getBuildKey(dir: string): { commit: string; dirty: string } | null {
    try {
      const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      const diff = execSync('git diff HEAD -- ":(exclude)*docker-compose*" ":(exclude)*.env*"', {
        cwd: dir,
      }).toString();
      let h = 5381;
      for (let i = 0; i < diff.length; i++) h = ((h << 5) + h) ^ diff.charCodeAt(i);
      return { commit, dirty: (h >>> 0).toString(16) };
    } catch {
      return null;
    }
  }

  private isBuildCached(dir: string): boolean {
    if (
      !fs.existsSync(path.join(dir, this.STATE_FILE)) ||
      !fs.existsSync(path.join(dir, 'node_modules')) ||
      !fs.existsSync(path.join(dir, 'build', 'index.js'))
    )
      return false;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, this.STATE_FILE), 'utf-8'));
      const current = this.getBuildKey(dir);
      if (!current) return false;
      return saved.commit === current.commit && saved.dirty === current.dirty;
    } catch {
      return false;
    }
  }

  private writeBuildCache(dir: string): void {
    try {
      const key = this.getBuildKey(dir);
      if (key) fs.writeFileSync(path.join(dir, this.STATE_FILE), JSON.stringify(key));
    } catch {
      /* non-fatal */
    }
  }

  private buildCacheStatus(dir: string): string {
    if (!fs.existsSync(path.join(dir, 'build', 'index.js'))) return 'no build output';
    if (!fs.existsSync(path.join(dir, this.STATE_FILE))) return 'no cache stamp';
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, this.STATE_FILE), 'utf-8'));
      const current = this.getBuildKey(dir);
      if (!current) return 'git error';
      if (saved.commit !== current.commit)
        return `HEAD changed (${saved.commit.slice(0, 7)} → ${current.commit.slice(0, 7)})`;
      if (saved.dirty !== current.dirty) return 'source files changed (uncommitted)';
      return 'up-to-date';
    } catch {
      return 'state file unreadable';
    }
  }

  private async detectWarmStart(): Promise<void> {
    console.log('\n📊 Startup Analysis:');

    const healthUrls = Object.values(composeServices)
      .map((s) => healthCheckUrl(s))
      .filter(Boolean) as string[];

    let servicesHealthy = false;
    if (healthUrls.length > 0) {
      try {
        await Promise.all(healthUrls.map((url) => axios.get(url, { timeout: 1500 })));
        servicesHealthy = true;
        console.log(`   Services:  ✅ all ${healthUrls.length} health checks passed`);
      } catch {
        console.log('   Services:  ❌ one or more health checks failed → full startup required');
      }
    } else {
      console.log('   Services:  ⚠️  no health checks configured');
    }

    // Build-cache checks use `git diff HEAD` (blocking I/O). Run them in parallel
    // across unique repos so N repos cost max(1_repo_time) instead of sum.
    const uniqueRepos = new Map<string, string>(); // repo → svcDir
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo || uniqueRepos.has(repo)) continue;
      const svcDir = path.join(this.worktreeBase, repo);
      if (fs.existsSync(path.join(svcDir, '.git'))) uniqueRepos.set(repo, svcDir);
    }
    const cacheResults = await Promise.all(
      [...uniqueRepos.entries()].map(async ([repo, svcDir]) => ({
        repo,
        svcDir,
        status: await new Promise<string>((res) => res(this.buildCacheStatus(svcDir))),
      })),
    );
    let allCached = true;
    for (const { repo, status } of cacheResults) {
      const cached = status === 'up-to-date';
      if (!cached) {
        allCached = false;
        this._changedRepos.add(repo); // <-- ADD THIS
      }
      console.log(`   ${repo.padEnd(24)} ${cached ? '⚡ cached' : `🔄 ${status}`}`);
    }

    this._warmStart = servicesHealthy && allCached;
    this._partialWarmStart = servicesHealthy && !allCached;

    const v = this.verbose;
    const note =
      v === true
        ? '(verbose=true: service logs → terminal+log)'
        : v === 'errors'
          ? '(verbose="errors": stderr→terminal, stdout→log)'
          : '(verbose=false: service logs → log file only)';
    if (this._warmStart) {
      console.log(
        `\n⚡ Mode: WARM START — skipping docker / migrations / build / restart. ${note}\n`,
      );
    } else if (this._partialWarmStart) {
      const changedList = [...this._changedRepos].join(', ');
      console.log(
        `\n⚡ Mode: PARTIAL WARM START — only [${changedList}] changed, selectively rebuilding. ${note}\n`,
      );
    } else {
      const reasons = [
        ...(!servicesHealthy ? ['services not healthy'] : []),
        ...(!allCached ? ['code changed'] : []),
      ];
      console.log(`\n🚀 Mode: COLD START — reason: ${reasons.join(', ')}. ${note}\n`);
    }
  }

  private writeComposeOverride(
    dir: string,
    networkName: string,
    svcEnvOverrides: Record<string, Record<string, string>>,
  ): void {
    const content = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');
    const svcNames = [...content.matchAll(/^  (\w[\w-]+):\s*$/gm)].map((m) => m[1]);
    const blocks = svcNames
      .map((name) => {
        const envLines = Object.entries(svcEnvOverrides[name] || {})
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `      - ${k}=${v}`)
          .join('\n');
        const envBlock = envLines ? `    environment:\n${envLines}\n` : '';
        return `  ${name}:\n${envBlock}    networks:\n      - ${networkName}:\n`;
      })
      .join('\n');
    fs.writeFileSync(
      path.join(dir, 'docker-compose.override.yml'),
      ['services:', blocks, 'networks:', `  ${networkName}:`, '    external: true'].join('\n'),
    );
  }

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

  private runAsyncOutput(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = Bun.spawn(cmd.split(' '), { cwd, stdout: 'pipe', stderr: 'pipe' });
      proc.exited.then(async () => {
        const out = await new Response(proc.stdout).text();
        if (proc.exitCode === 0) resolve(out.trim());
        else reject(new Error(`Command failed: ${cmd}`));
      });
    });
  }

  /**
   * Deduce the isolated DB names for a specific repo variant.
   * Suffix-based isolation ensures that 'bridge', 'game', etc., get their own logical DBs.
   */
  private deduceIsolatedNames(repoName: string, repoCfg?: RepoConfig, svc?: ComposeService) {
    const defaultDb = 'slot';
    const defaultMongo = 'rgs';
    const defaultRedis = 'slot-rgs';

    let dbName = repoCfg?.envOverrides?.DB_NAME;
    let mongoName = repoCfg?.envOverrides?.MONGO_NAME;
    let redisPrefix = repoCfg?.envOverrides?.REDIS_PREFIX;

    if (!dbName || !mongoName || !redisPrefix) {
      // Put your exact database suffix logic back
      const parts = repoName.split('-');
      const suffix = parts.length > 1 ? parts[parts.length - 1] : '';

      dbName = dbName || `${defaultDb}_${suffix}`;
      mongoName = mongoName || `${defaultMongo}_${suffix}`;

      // Smartly deduce Redis based on APP_CLOUD_REGION_TYPE
      if (!redisPrefix) {
        let regionType = 'peripheral'; // default to gamesite

        if (svc) {
          const svcEnv = parseEnv(svc.environment);
          if (svcEnv.APP_CLOUD_REGION_TYPE) {
            regionType = svcEnv.APP_CLOUD_REGION_TYPE;
          } else {
            // Peek into the .env file to grab the region type
            const envFile = svc['x-env-file'] || repoCfg?.migrationEnvFile;
            if (envFile) {
              const envPath = path.join(this.worktreeBase, repoName, envFile);
              if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf-8');
                const match = content.match(/^APP_CLOUD_REGION_TYPE\s*=\s*["']?([^"'\n\r]+)["']?/m);
                if (match) regionType = match[1];
              }
            }
          }
        }

        // Map region types directly to your shared prefixes
        redisPrefix = regionType === 'billing' ? `${defaultRedis}_billing` : `${defaultRedis}_game`;
      }
    }

    return { dbName, mongoName, redisPrefix };
  }

  /**
   * Builds the final process environment for a service.
   * @param forMigration - when true, migrationEnvFile overrides x-env-file (to supply DB creds)
   */
  private buildEnvironment(
    worktreeDir: string,
    svc: ComposeService,
    repoName: string,
    repoCfg?: RepoConfig,
    forMigration = false,
  ): Record<string, string> {
    const primaryEnvFile =
      forMigration && repoCfg?.migrationEnvFile ? repoCfg.migrationEnvFile : svc['x-env-file'];
    const envPath = primaryEnvFile ? path.join(worktreeDir, primaryEnvFile) : null;

    const fileEnv: Record<string, string> = {};

    // Default Fallbacks
    const d = {
      u: 'postgres',
      p: 'secret',
      h: '127.0.0.1',
      prt: '5432',
      mu: 'root',
      mp: 'root',
      mh: '127.0.0.1',
      mprt: '27017',
    };

    if (envPath && fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach((line) => {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
          const idx = t.indexOf('=');
          if (idx !== -1) {
            const k = t.slice(0, idx).trim();
            let v = t.slice(idx + 1).trim();

            // --- ADD THESE TWO LINES TO STRIP QUOTES ---
            if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
            else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);

            if (k) fileEnv[k] = v;
          }
        }
      });
    }

    const { dbName, mongoName, redisPrefix } = this.deduceIsolatedNames(repoName, repoCfg, svc);

    // --- ADD THIS LOGIC TO DEDUCE VERSION ---
    // If target is a semver tag (e.g., 1.15.1), use it.
    // If it's a branch or SHA, you might want a fallback or the raw string.
    const version = repoCfg?.target || 'v1';

    // Merge everything
    const merged: Record<string, string> = {
      ...process.env,
      ...fileEnv,
      ...parseEnv(svc.environment),
      ...(this.network ? (svc['x-bridge-env'] ?? {}) : {}),
      ...(repoCfg?.envOverrides ?? {}),
      DB_NAME: dbName,
      MONGO_NAME: mongoName,
      REDIS_PREFIX: redisPrefix,
      VERSION: version, // <-- AUTO-INJECT VERSION HERE
    };

    // Construct Postgres URL - Using deducing logic for missing pieces
    const dbUser = merged.DB_USER || d.u;
    const dbPass = merged.DB_PASSWORD || d.p;
    const dbHost = merged.DB_HOST || d.h;
    const dbPort = merged.DB_PORT || d.prt;
    merged.DATABASE_URL = `postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}?sslmode=disable`;

    // Construct Mongo URL
    const mUser = merged.MONGO_USER || d.mu;
    const mPass = merged.MONGO_PASSWORD || d.mp;
    const mHost = merged.MONGO_HOST || d.mh;
    const mPort = merged.MONGO_PORT || d.mprt;
    merged.MONGO_URL =
      mUser && mPass
        ? `mongodb://${mUser}:${mPass}@${mHost}:${mPort}/${mongoName}?authSource=admin`
        : `mongodb://${mHost}:${mPort}/${mongoName}`;

    return merged;
  }

  async setupWorktrees() {
    if (this.skipPull) {
      console.log('⚡ E2E_SKIP_PULL=1: skipping git pull (using local working tree as-is).');
    } else {
      if (!fs.existsSync(this.worktreeBase)) {
        fs.mkdirSync(this.worktreeBase, { recursive: true });
      }
      console.log('🌳 Provisioning Git Worktrees (Concurrently)...');

      // ── Optimistic provisioning ───────────────────────────────────────────────
      // Strategy:
      //   Tags (semver x.y.z): local comparison only — immutable, zero network.
      //   Branches (main / feature/x): ls-remote fires in background immediately.
      //
      // Phase 1 (this block): local comparisons for all + report results instantly.
      //   Tags resolve in ~10ms. Branches report ✓ optimistically if local matches.
      //   ls-remote runs concurrently in background, not awaited yet.
      //
      // Phase 2 (detectWarmStart, called right after): await pending branch checks.
      //   If remote SHA differs from local → fetch + checkout that repo.
      //   Fetched repos → build cache miss → warm start disabled → cold start.
      //   Nothing done twice: expensive work (infra, migrations) hasn't started yet.
      const isSemverTag = (t: string) => /^v?\d+\.\d+/.test(t);

      // Fire all branch ls-remote Promises immediately, deduplicated by (repo, branch).
      // They run concurrently while Phase 1 processes tags locally.
      const pendingBranchChecks = new Map<
        string,
        Promise<{
          repoName: string;
          repoPath: string;
          targetDir: string;
          target: string;
          needsFetch: boolean;
        }>
      >();

      // ── Phase 1: local comparisons (instant) ─────────────────────────────────
      await Promise.all(
        Object.entries(orchestratorCfg.repos).map(async ([repoName, repo]) => {
          const targetDir = path.join(this.worktreeBase, repoName);
          const repoPath = path.resolve(repo.repoPath);

          if (fs.existsSync(path.join(targetDir, '.git'))) {
            const headSha = await this.runAsyncOutput(
              'git log -1 --format=%H HEAD',
              targetDir,
            ).catch(() => '');

            if (isSemverTag(repo.target)) {
              // Tag: local comparison only.
              const localSha = await this.runAsyncOutput(
                `git log -1 --format=%H ${repo.target}`,
                repoPath,
              ).catch(() => null);
              if (localSha && headSha === localSha) {
                console.log(`   -> ${repoName} @ ${repo.target} ✓ (${headSha.slice(0, 8)})`);
                return;
              }
              // Local mismatch → fetch now.
              console.log(`   -> Updating ${repoName} @ ${repo.target}...`);
              await this.runAsync('git fetch --all --tags', targetDir);
              try {
                await this.runAsync(`git checkout --detach origin/${repo.target}`, targetDir);
              } catch {
                await this.runAsync(`git checkout --detach ${repo.target}`, targetDir);
              }
            } else {
              // Branch: report optimistically based on local, fire background check.
              const lsKey = `${repoPath}::${repo.target}`;
              if (!pendingBranchChecks.has(lsKey)) {
                // Start ls-remote immediately (background, not awaited here).
                pendingBranchChecks.set(
                  lsKey,
                  this.runAsyncOutput(`git ls-remote origin refs/heads/${repo.target}`, repoPath)
                    .then((out) => {
                      const remoteSha = out.split('\n')[0]?.split('\t')[0]?.trim() || null;
                      return {
                        repoName,
                        repoPath,
                        targetDir,
                        target: repo.target,
                        needsFetch: !!remoteSha && headSha !== remoteSha,
                      };
                    })
                    .catch(() => ({
                      repoName,
                      repoPath,
                      targetDir,
                      target: repo.target,
                      needsFetch: false,
                    })),
                );
              }
              console.log(
                `   -> ${repoName} @ ${repo.target} ✓ (${headSha.slice(0, 8)}, verifying remote...)`,
              );
            }
          } else {
            console.log(`   -> Checking out ${repoName} @ ${repo.target}...`);
            if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
            await this.runAsync('git fetch --all --tags', repoPath);
            try {
              await this.runAsync('git worktree prune', repoPath);
            } catch {}
            await this.runAsync(`git worktree add --detach ${targetDir} ${repo.target}`, repoPath);
          }
        }),
      );

      // ── Phase 2: await branch remote checks (background since Phase 1 started) ─
      // ls-remote has been running concurrently with Phase 1. It's likely already
      // resolved. Any branch that needs updating is fetched here, before detectWarmStart
      // evaluates cache freshness — so the build cache miss / warm-start invalidation
      // happens naturally without special restart logic.
      if (pendingBranchChecks.size > 0) {
        const results = await Promise.all([...pendingBranchChecks.values()]);
        const stale = results.filter((r) => r.needsFetch);
        if (stale.length > 0) {
          await Promise.all(
            stale.map(async ({ repoName, targetDir, target }) => {
              console.log(`   -> ${repoName} @ ${target}: remote has new commits — updating...`);
              await this.runAsync('git fetch --all --tags', targetDir);
              try {
                await this.runAsync(`git checkout --detach origin/${target}`, targetDir);
              } catch {
                await this.runAsync(`git checkout --detach ${target}`, targetDir);
              }
            }),
          );
        }
      }
    }

    await this.detectWarmStart();

    if (!this._warmStart) {
      const ports = this.portsToClear;
      console.log(`🧹 Cold start: clearing stale processes on ports [${ports.join(', ')}]`);
      // DARK MAGIC: Added -P -n to completely bypass DNS resolution timeouts in lsof
      for (const port of ports) {
        try {
          execSync(
            `lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
          );
        } catch {}
      }
    }
  }

  /**
   * Streams logs from all Docker Compose infra containers to per-project log files.
   * Respects the `verbose` setting from e2e-orchestrator.yml:
   *   false    → log file only, nothing on terminal
   *   "errors" → log file + error-like lines to terminal stderr
   *   true     → log file + everything to terminal stdout
   */
  private _startDockerLogCapture(): void {
    const seenPaths = new Set<string>();
    const dec = new TextDecoder();
    const verboseMode = this.verbose;

    for (const [repoKey, repo] of Object.entries(orchestratorCfg.repos)) {
      const worktreeDir = path.join(this.worktreeBase, repoKey);
      const composeFile = path.join(worktreeDir, 'docker-compose.yml');
      const repoPath = path.resolve(repo.repoPath);
      if (!fs.existsSync(composeFile) || seenPaths.has(repoPath)) continue;
      seenPaths.add(repoPath);

      const logStream = fs.createWriteStream(path.join(this._logDir, `docker-${repoKey}.log`), {
        flags: 'a',
      });

      const proc = Bun.spawn(['docker', 'compose', 'logs', '-f', '--no-color', '--timestamps'], {
        cwd: worktreeDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const isErrorLine = (line: string) =>
        /error|ERROR|Error|FATAL|fatal|WARN|warn|exception|Exception/i.test(line);

      const handleChunk = (chunk: Uint8Array, isErr: boolean) => {
        const text = dec.decode(chunk);
        logStream.write(text);
        if (verboseMode === true) {
          (isErr ? process.stderr : process.stdout).write(`[docker:${repoKey}] ${text}`);
        } else if (verboseMode === 'errors') {
          // Only pass error/warning lines to terminal stderr
          for (const line of text.split('\n')) {
            if (line && isErrorLine(line)) process.stderr.write(`[docker:${repoKey}] ${line}\n`);
          }
        }
      };

      const ac = new AbortController();
      this.streamControllers.push(ac);
      proc.stdout
        ?.pipeTo(new WritableStream({ write: (c) => handleChunk(c, false) }), { signal: ac.signal })
        .catch(() => {});
      proc.stderr
        ?.pipeTo(new WritableStream({ write: (c) => handleChunk(c, true) }), { signal: ac.signal })
        .catch(() => {});
      this.activeProcesses.push(proc);
    }
  }

  private startObservability(): void {
    const obs = orchestratorCfg.observability;
    if (!obs?.seq && !obs?.dozzle) return;

    const toStart: string[] = [...(obs.seq ? ['seq'] : []), ...(obs.dozzle ? ['dozzle'] : [])];

    console.log(
      `📊 Starting observability: ${toStart.join(', ')} (pulling images if needed — this may take a moment on first run)...`,
    );
    try {
      const result = Bun.spawnSync(
        [
          'docker',
          'compose',
          '-f',
          './src/src/docker-compose.observability.yml',
          'up',
          '-d',
          ...toStart,
        ],
        { stdout: 'inherit', stderr: 'inherit' },
      );
      if (result.exitCode !== 0) {
        console.warn(
          '   ⚠️  Observability startup failed (non-fatal) — run manually to see error:',
        );
        console.warn('       docker compose -f src/docker-compose.observability.yml up -d');
      }
    } catch (e: any) {
      console.warn(
        `   ⚠️  Observability startup failed (non-fatal): ${String(e.message).split('\n')[0]}`,
      );
    }

    if (obs.seq) {
      this._seq = new SeqForwarder('http://localhost:5341');
      console.log('   📈 Seq log browser → http://localhost:8081');
    }
    if (obs.dozzle) {
      console.log(
        '   🔍 Dozzle live container logs → http://localhost:9990  (Docker containers only)',
      );
    }
  }

  async startInfrastructure() {
    // On warm start, Docker must already be running (services are healthy).
    // Skip the `docker info` probe (~300ms) — it adds overhead for no benefit.
    if (!this._warmStart) {
      this.ensureDockerRunning();
    }
    this.startObservability();

    if (this._warmStart) {
      console.log('⚡ Warm start: skipping Docker infrastructure startup.');
      this._startDockerLogCapture(); // still capture container logs even on warm start
      return;
    }

    console.log('🐳 Starting Infrastructure (Docker Compose)...');

    // Derive infra worktrees dynamically: find the first worktree per unique source
    // repo that has a docker-compose.yml. Avoids hardcoded repo names that break
    // when worktree keys are renamed (e.g. remote-game-server → remote-game-server-billing).
    const seenRepoPaths = new Set<string>();
    const infraRepos: string[] = [];
    for (const [repoName, repo] of Object.entries(orchestratorCfg.repos)) {
      const repoPath = path.resolve(repo.repoPath);
      if (seenRepoPaths.has(repoPath)) continue;
      seenRepoPaths.add(repoPath);
      const worktreeDir = path.join(this.worktreeBase, repoName);
      if (fs.existsSync(path.join(worktreeDir, 'docker-compose.yml'))) {
        infraRepos.push(repoName);
      }
    }

    if (this.network) {
      console.log(`   -> Creating Docker network '${this.network}'...`);
      execSync(`docker network create ${this.network} 2>/dev/null || true`);
    }

    await Promise.all(
      infraRepos.map(async (repoName) => {
        const dir = path.join(this.worktreeBase, repoName);
        const composeFile = path.join(dir, 'docker-compose.yml');
        if (!fs.existsSync(composeFile)) return;

        console.log(`   -> Bringing up ${repoName} infra...`);

        // Patch macOS AirPlay port conflicts
        let content = fs.readFileSync(composeFile, 'utf-8');
        content = content
          .replace(/'7000:9000'/g, "'7002:9000'")
          .replace(/"7000:9000"/g, '"7002:9000"')
          .replace(/'7001:9001'/g, "'7003:9001'")
          .replace(/"7001:9001"/g, '"7003:9001"');
        fs.writeFileSync(composeFile, content);

        if (this.network) {
          const overrides = orchestratorCfg.composeServiceEnvOverrides?.[repoName] ?? {};
          this.writeComposeOverride(dir, this.network, overrides);
        }

        // ADDED: --force-recreate to clear out broken container states
        await this.runAsync('docker compose up -d --force-recreate', dir);
      }),
    );

    // Map the internal ports to your actual LOCAL ports defined in your .env/compose
    console.log('⏳ Waiting for Databases and Kafka to accept connections...');
    const portsToWait = [5437, 27017, 9093];

    for (const port of portsToWait) {
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`nc -z -w 1 127.0.0.1 ${port}`, { stdio: 'ignore' });

          // Deeper readiness probes — port open ≠ service ready.
          if (port === 5437) {
            execSync(`docker exec $(docker ps -q -f "name=db-1") pg_isready -U postgres`, {
              stdio: 'ignore',
            });
          }

          if (port === 9093) {
            // TCP open ≠ Kafka broker ready. Probe with kafka-topics.sh to confirm the
            // broker has elected a controller and is ready for real connections.
            // Kafka accepts TCP handshakes but resets them (ECONNRESET) until fully up.
            const kafkaContainer = execSync(
              "docker ps --format '{{.Names}}' | grep kafka-region | head -1",
              { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
            ).trim();
            if (kafkaContainer) {
              execSync(
                `docker exec ${kafkaContainer} kafka-topics.sh --bootstrap-server localhost:9092 --list`,
                { stdio: 'ignore' },
              );
            }
          }

          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (ready) console.log(`   ✅ Port ${port} is fully ready.`);
      else console.warn(`   ⚠️  Port ${port} still warming up, proceeding with caution...`);
    }

    // Give a final 2s for Kafka/Mongo internal sharding/init
    await new Promise((r) => setTimeout(r, 2000));
    this._startDockerLogCapture();
  }

  async runGlobalMigrations() {
    // Fast-path: check if there are any forced-redo repos WITHOUT doing expensive
    // flushDatabases (Docker exec) first. Only run flushDatabases when actually needed.
    const hasForcedRedoRepos = Object.values(orchestratorCfg.repos).some(
      (r) => r.alwaysRedoMigration,
    );

    if (this._warmStart && !hasForcedRedoRepos) {
      console.log('⚡ Warm start: skipping migrations.');
      return;
    }

    const targetsToRedo = this.flushDatabases();
    const hasForcedRedo = hasForcedRedoRepos || targetsToRedo.size > 0;

    if (this._warmStart && !hasForcedRedo) {
      console.log('⚡ Warm start: skipping migrations.');
      return;
    }

    console.log('🗄️  Running DB Migrations...');

    const migrateBin = path.resolve('./node_modules/.bin/migrate');
    const reposMigrated = new Set<string>();
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo || reposMigrated.has(repo)) continue;

      const repoCfg = orchestratorCfg.repos[repo];
      const worktreeDir = path.join(this.worktreeBase, repo);
      const migrationsDir = path.join(worktreeDir, 'db-migrations');

      if (repoCfg?.skipMigration === true || !fs.existsSync(migrationsDir)) continue;
      reposMigrated.add(repo);

      const { dbName, mongoName } = this.deduceIsolatedNames(repo, repoCfg, svc);
      const migrationEnv = this.buildEnvironment(worktreeDir, svc, repo, repoCfg, true);

      // --- REPLACE THE MINIMAL ENV HACK WITH THIS ---
      this.writePhysicalEnvFile(worktreeDir, migrationEnv);

      // Release locks if redo is needed
      if (this._warmStart && repoCfg?.alwaysRedoMigration) {
        this.killProcessesOnPorts(svc.ports);
      }

      const dbs = fs
        .readdirSync(migrationsDir)
        .filter((f) => fs.statSync(path.join(migrationsDir, f)).isDirectory());

      // We only want to migrate the specific targets for this variant
      const targets = [
        { name: dbName, isMongo: false, source: 'slot' },
        { name: mongoName, isMongo: true, source: 'rgs' },
      ];

      for (const target of targets) {
        const sourcePath = path.join(migrationsDir, target.source);
        const targetPath = path.join(migrationsDir, target.name);

        // Skip if the source folder (e.g. 'slot') doesn't actually exist in this repo
        if (!fs.existsSync(sourcePath)) continue;

        // Ensure target symlink exists
        if (target.name !== target.source) {
          if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
          fs.symlinkSync(target.source, targetPath, 'dir');
        }

        // Handle "Until" logic (shadowing to capped directory)
        if (repoCfg?.untilMigrationFile) {
          this.createCappedMigrationDir(sourcePath, targetPath, repoCfg.untilMigrationFile);
        }

        // REDO Logic - Triggered by YAML flushData, alwaysRedoMigration, or a cache-miss
        // Notice this now cleanly checks target.name (e.g., slot_main) so it never wipes the wrong DB!
        const targetNeedsRedo =
          repoCfg?.alwaysRedoMigration ||
          targetsToRedo.has(target.name) ||
          this._changedRepos.has(repo);

        if (targetNeedsRedo) {
          console.log(`   -> [REDO] Wiping ${target.name}...`);
          Bun.spawnSync([migrateBin, 'down', target.name, 'all'], {
            cwd: worktreeDir,
            env: migrationEnv as any,
            stdout: 'inherit',
            stderr: 'inherit',
          });
        }

        console.log(`   -> Migrating ${repo} -> ${target.name}`);
        const proc = Bun.spawnSync([migrateBin, 'up', target.name], {
          cwd: worktreeDir,
          stdout: 'inherit',
          stderr: 'inherit',
          env: migrationEnv as any,
        });

        if (proc.exitCode !== 0) throw new Error(`❌ Migration failed for ${target.name}`);
      }
    }
  }

  async runServices() {
    const seqEnabled = !!orchestratorCfg.observability?.seq;

    if (this._warmStart) {
      // Skip respawn when: Seq is off, OR developer sets E2E_NO_RESPAWN=1.
      // E2E_NO_RESPAWN is useful when Seq is enabled for debugging but you
      // still want near-instant warm starts.
      const noRespawn = !seqEnabled || process.env.E2E_NO_RESPAWN === '1';
      if (noRespawn) {
        console.log('⚡ Warm start: all services already running with current code.');
        return;
      }
      console.log('⚡ Warm start + Seq: respawning services for log capture (build skipped)...');
      for (const port of this.portsToClear) {
        try {
          execSync(
            `lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
          );
        } catch {}
      }
    }

    // ── Compute affected services for PARTIAL WARM START ─────────────────────
    // Affected = services whose repo changed + transitive dependents (they need
    // restart too, even if their own repo didn't change, because their dependency did).
    const affectedServices = (() => {
      if (!this._partialWarmStart) return null; // not used in full cold/warm start
      const direct = new Set(
        Object.entries(composeServices)
          .filter(([, svc]) => svc['x-repo'] && this._changedRepos.has(svc['x-repo']))
          .map(([name]) => name),
      );
      // Expand transitively: if A depends on B and B is affected, A must also restart.
      let changed = true;
      while (changed) {
        changed = false;
        for (const [name, svc] of Object.entries(composeServices)) {
          if (direct.has(name)) continue;
          if (dependsOn(svc).some((d) => direct.has(d))) {
            direct.add(name);
            changed = true;
          }
        }
      }
      return direct;
    })();

    if (this._partialWarmStart && affectedServices!.size > 0) {
      console.log(`⚡ Partial warm start: rebuilding [${[...affectedServices!].join(', ')}]...`);
      // Kill only affected service ports
      for (const [, svc] of Object.entries(composeServices)) {
        const repo = svc['x-repo'];
        if (!repo || !this._changedRepos.has(repo)) continue;
        this.killProcessesOnPorts(svc.ports);
      }
    }

    // Flush Redis only on cold/partial starts — not on full warm start.
    // On warm start, services have valid in-memory + Redis state; wiping Redis
    // forces a 60s re-sync cycle in the game service before tests can run.
    if (!this._warmStart) {
      this.flushRedis();
      if (!this._partialWarmStart)
        console.log('🚀 Preparing Dependencies & Builds (Concurrently)...');
    }

    const buildTasks: Promise<void>[] = [];
    const builtRepos = new Set<string>();

    if (!this._warmStart) {
      for (const svc of Object.values(composeServices)) {
        const repo = svc['x-repo'];
        const setupCmds = svc['x-setup'] ?? [];
        if (!repo || !setupCmds.length || builtRepos.has(repo)) continue;
        // Partial warm start: only build changed repos
        if (this._partialWarmStart && !this._changedRepos.has(repo)) continue;
        const worktreeDir = path.join(this.worktreeBase, repo);
        builtRepos.add(repo);

        buildTasks.push(
          (async () => {
            if (this.isBuildCached(worktreeDir)) {
              console.log(`   [CACHE HIT] ${repo}: skipping install & build`);
              return;
            }
            const repoCfg = orchestratorCfg.repos[repo];
            const mergedEnv = this.buildEnvironment(worktreeDir, svc, repo, repoCfg);

            // --- ADD THIS HERE ---
            this.writePhysicalEnvFile(worktreeDir, mergedEnv);

            for (const cmd of setupCmds) {
              console.log(`   [BUILD] ${repo}: ${cmd}`);
              const proc = Bun.spawn(['sh', '-c', cmd], {
                cwd: worktreeDir,
                env: mergedEnv as any,
              });
              await proc.exited;
              if (proc.exitCode !== 0) {
                const err = await new Response(proc.stderr).text();
                throw new Error(`Build failed for ${repo}: ${err}`);
              }
            }
            this.writeBuildCache(worktreeDir);
          })(),
        );
      }
      await Promise.all(buildTasks);
    }

    console.log('\n🚀 Starting Node Servers...');
    const verboseMode = this.verbose;
    const masterStream = this.ensureMasterStream();

    const nativeServices = Object.entries(composeServices).filter(([, svc]) =>
      Boolean(svc['x-repo']),
    ) as [string, ComposeService][];

    const readyMap = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    for (const [name] of nativeServices) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      readyMap.set(name, { resolve, promise });
    }

    // Partial warm start: pre-resolve readyMap for unchanged services (still running).
    if (this._partialWarmStart && affectedServices) {
      for (const [name] of nativeServices) {
        if (!affectedServices.has(name)) {
          readyMap.get(name)!.resolve();
        }
      }
    }

    const healthCheckResults: Promise<void>[] = [];

    const launchTasks = nativeServices.map(([name, svc]) =>
      (async () => {
        // Partial warm start: skip services that don't need restart
        if (this._partialWarmStart && affectedServices && !affectedServices.has(name)) {
          console.log(`   ⚡ ${name}: unchanged, staying warm`);
          return;
        }

        const deps = dependsOn(svc);
        if (deps.length > 0) {
          const depPromises = deps
            .map((d) => readyMap.get(d)?.promise)
            .filter(Boolean) as Promise<void>[];
          if (depPromises.length) {
            console.log(`   [WAIT]  ${name}: waiting for [${deps.join(', ')}]...`);
            await Promise.all(depPromises);
            console.log(`   [READY] ${name}: dependencies healthy — starting`);
          }
        }

        const repoName = svc['x-repo']!;
        const worktreeDir = path.join(this.worktreeBase, repoName);
        const port = hostPort(svc.ports) ?? 0;
        const hcUrl = healthCheckUrl(svc);
        const repoCfg = orchestratorCfg.repos[repoName];
        const mergedEnv = this.buildEnvironment(worktreeDir, svc, repoName, repoCfg);
        const serviceStream = this.openServiceStream(name, port);
        const dec = new TextDecoder();

        // --- ADD THIS HERE ---
        this.writePhysicalEnvFile(worktreeDir, mergedEnv);

        console.log(`   [START] ${name}: ${svc.command!}`);
        const proc = Bun.spawn(['sh', '-c', svc.command!], {
          cwd: worktreeDir,
          env: mergedEnv as any,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        // 1. Create an abort controller for this process's streams
        const ac = new AbortController();
        this.streamControllers.push(ac);

        proc.stdout
          ?.pipeTo(
            new WritableStream({
              write: (chunk) => {
                const text = dec.decode(chunk);
                serviceStream?.write(text);
                masterStream?.write(`[${name}] ${text}`);
                this._seq?.push(text, name, false);
                if (verboseMode === true) process.stdout.write(`[${name}] ${text}`);
              },
            }),
            { signal: ac.signal },
          )
          .catch(() => {});

        proc.stderr
          ?.pipeTo(
            new WritableStream({
              write: (chunk) => {
                const text = dec.decode(chunk);
                serviceStream?.write(text);
                masterStream?.write(`[${name} ERR] ${text}`);
                this._seq?.push(text, name, true);
                if (verboseMode === true || verboseMode === 'errors')
                  process.stderr.write(`[${name} ERR] ${text}`);
              },
            }),
            { signal: ac.signal },
          )
          .catch(() => {});

        this.activeProcesses.push(proc);
        proc.unref();

        if (hcUrl) {
          const hcPromise = this.pollHealthCheck(name, hcUrl);
          healthCheckResults.push(hcPromise);
          hcPromise
            .then(() => readyMap.get(name)!.resolve())
            .catch(() => readyMap.get(name)!.resolve());
        } else {
          readyMap.get(name)!.resolve();
        }
      })(),
    );

    await Promise.all(launchTasks);
    await Promise.all(healthCheckResults);

    console.log('\n✅ All services started.\n');
  }

  private async pollHealthCheck(name: string, url: string): Promise<void> {
    const maxAttempts = 60;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await axios.get(url, { timeout: 3000 });
        console.log(`   ✅ Ready: ${name} (${url})`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`❌ Healthcheck failed after ${maxAttempts} attempts: ${name} (${url})`);
  }

  // ── Public API: single entry point ──────────────────────────────────────────

  /**
   * Ensures the E2E environment is ready to run tests.
   *
   * Warm path  (<300ms): services healthy + worktree SHAs match ready-state file
   *   → skip ALL setup steps, start tests immediately.
   *   → fire background branch validation; invalidate ready-state if remote moved.
   *
   * Cold path (minutes): full setup (worktrees, infra, migrations, services, cache warmup)
   *   → write ready-state file for next run.
   *
   * Usage in e2e.spec.ts beforeAll:
   *   await orchestrator.ensureReady(api, BILLING_URL, GAME_URL, SERVICE_SIGNATURE, TARGET_GAME_CODE);
   */
  async ensureReady(
    api: {
      get: (url: string, opts?: any) => Promise<{ status: number; data: any }>;
      propagateConfig: () => Promise<void>;
      resetGameState: (code: string) => Promise<void>;
    },
    billingUrl: string,
    gameUrl: string,
    serviceSignature: Record<string, string>,
    targetGameCode: string,
  ): Promise<void> {
    if (await this._tryWarmPath()) {
      // ── Warm path: services healthy + code matches → skip everything ──────
      this._startDockerLogCapture();
      this._startBackgroundValidation();
    } else if (await this._tryRestartPath()) {
      // ── Restart path: code matches but services dead → restart only ────────
      // Skip setupWorktrees (worktrees already correct) and runGlobalMigrations
      // (nothing changed in DB schema). Just bring infra up if needed and
      // restart Node services. Avoids ~60s of migration overhead on service crash.
      await this.startInfrastructure();
      await this.runServices();
      await this._waitForCaches(api, billingUrl, gameUrl, serviceSignature, targetGameCode);
      this._writeReadyState();
      this._startDockerLogCapture();
      this._startBackgroundValidation();
    } else {
      // ── Cold path: full setup ─────────────────────────────────────────────
      await this.setupWorktrees();
      await this.startInfrastructure();
      await this.runGlobalMigrations();
      await this.runServices();
      await this._waitForCaches(api, billingUrl, gameUrl, serviceSignature, targetGameCode);
      this._writeReadyState();
    }

    // Always print exactly once — after warm or cold path completes.
    // Swagger probing runs concurrently (800ms timeout per service, all parallel).
    await this.printEnvironmentSummary();
  }

  /** Reads ready-state and verifies health + SHA match. Fast (<300ms). */
  private async _tryWarmPath(): Promise<boolean> {
    const state = this._loadReadyState();
    if (!state) return false;

    // Parallel: health check + SHA comparison (both fast, local)
    const [healthy, shaMatch] = await Promise.all([
      this._checkServicesHealthy(),
      this._checkWorktreeSHAs(state.worktrees),
    ]);

    if (healthy && shaMatch) {
      console.log('\n⚡ Ready-state hit — skipping setup entirely.\n');
      this._warmStart = true;
      return true;
    }
    if (!shaMatch) {
      // Code or target changed — invalidate ready-state, cold path needed.
      this._deleteReadyState();
    }
    return false;
  }

  /**
   * Restart path: ready-state SHA/target matches (code unchanged) but services
   * are dead. Skip setupWorktrees (correct code already checked out) and
   * runGlobalMigrations (DB schema unchanged). Just restart services.
   * ~5x faster than cold path when services crash after a test failure.
   */
  private async _tryRestartPath(): Promise<boolean> {
    const state = this._loadReadyState();
    if (!state) return false; // no ready-state → can't skip migrations safely

    const shaMatch = await this._checkWorktreeSHAs(state.worktrees);
    if (!shaMatch) {
      this._deleteReadyState();
      return false; // code changed → must run migrations
    }

    // Only check repos that are actually used as service worktrees (have x-setup builds).
    // Infra-only repos (queue-service docker compose) have no build artifacts to check.
    const serviceRepos = new Set(
      Object.values(composeServices)
        .map((s) => s['x-repo'])
        .filter(Boolean) as string[],
    );
    const allBuildsIntact = [...serviceRepos].every((repoKey) => {
      const dir = path.join(this.worktreeBase, repoKey);
      return this.isBuildCached(dir);
    });
    if (!allBuildsIntact) return false;

    console.log(
      '\n⚡ Restart path — code unchanged, services dead. Restarting without migrations.\n',
    );
    return true;
  }

  /** Fires ls-remote checks in the background during test execution.
   *  If any branch is stale, invalidates ready-state so the next run re-setups. */
  /**
   * Fires ls-remote checks for branch targets concurrently with test execution.
   * Stores the Promise so awaitBackgroundValidation() can be called in afterAll.
   */
  private _startBackgroundValidation(): void {
    const branches = Object.entries(orchestratorCfg.repos)
      .filter(([, repo]) => !/^v?\d+\.\d+/.test(repo.target))
      .map(([repoKey, repo]) => ({
        repoKey,
        repoPath: path.resolve(repo.repoPath),
        target: repo.target,
        targetDir: path.join(this.worktreeBase, repoKey),
      }));

    if (branches.length === 0) {
      this._bgValidation = Promise.resolve();
      return;
    }

    // Ensure logs go to the master log file even on warm path (stream may not exist yet).
    const stream = this.ensureMasterStream();
    const logBg = (msg: string) => {
      console.log(msg);
      stream?.write(`${msg}\n`);
    };

    // Deduplicate ls-remote calls by (repoPath, branch)
    const seen = new Map<string, Promise<string | null>>();
    for (const { repoPath, target } of branches) {
      const key = `${repoPath}::${target}`;
      if (!seen.has(key)) {
        seen.set(
          key,
          this.runAsyncOutput(`git ls-remote origin refs/heads/${target}`, repoPath)
            .then((out) => out.split('\n')[0]?.split('\t')[0]?.trim() || null)
            .catch(() => {
              logBg(`[bg-validation] ⚠️  ls-remote failed for ${target}`);
              return null;
            }),
        );
      }
    }

    this._bgValidation = Promise.all(
      branches.map(async ({ repoKey, targetDir, target, repoPath }) => {
        const remoteSha = await seen.get(`${repoPath}::${target}`)!;
        if (!remoteSha) return;
        const headSha = await this.runAsyncOutput('git log -1 --format=%H HEAD', targetDir).catch(
          () => '',
        );
        if (headSha !== remoteSha) {
          logBg(
            `⚠️  [bg-validation] ${repoKey} @ ${target}: remote moved (local ${headSha.slice(0, 8)} → remote ${remoteSha.slice(0, 8)})`,
          );
          this._deleteReadyState();
        } else {
          logBg(`✓  [bg-validation] ${repoKey} @ ${target}: up-to-date (${headSha.slice(0, 8)})`);
        }
      }),
    ).then(() => {}) as Promise<void>;
  }

  /**
   * Called from afterAll. Awaits background branch validation.
   * If any branch was stale: deletes ready-state AND writes a marker file that
   * the run-tests.sh wrapper detects → auto-reruns with fresh setup.
   * Throws so the test run shows as failed (correct: it ran on stale code).
   */
  async awaitBackgroundValidation(): Promise<void> {
    if (!this._bgValidation) return;
    await this._bgValidation;

    if (!fs.existsSync(this.readyFile)) {
      // Write marker file. run-tests.sh detects it and reruns automatically.
      fs.writeFileSync(path.resolve('logs/.rerun-needed'), '');
      throw new Error('🔄 Remote branches updated during run. Wrapper will rerun automatically.');
    }
  }

  private async _checkServicesHealthy(): Promise<boolean> {
    const healthUrls = Object.values(composeServices)
      .map((s) => healthCheckUrl(s))
      .filter(Boolean) as string[];
    if (!healthUrls.length) return false;
    try {
      await Promise.all(healthUrls.map((url) => axios.get(url, { timeout: 1000 })));
      return true;
    } catch {
      return false;
    }
  }

  private async _checkWorktreeSHAs(
    stored: Record<string, { sha: string; target: string }>,
  ): Promise<boolean> {
    const checks = Object.entries(stored).map(async ([repoKey, entry]) => {
      // If the configured target changed since we wrote the ready-state,
      // the worktree must be switched — invalidate immediately.
      const configuredTarget = orchestratorCfg.repos[repoKey]?.target;
      if (configuredTarget !== entry.target) return false;

      const dir = path.join(this.worktreeBase, repoKey);
      const head = await this.runAsyncOutput('git log -1 --format=%H HEAD', dir).catch(() => '');
      return head === entry.sha;
    });
    const results = await Promise.all(checks);
    return results.every(Boolean);
  }

  private async _waitForCaches(
    api: {
      get: (url: string, opts?: any) => Promise<{ status: number; data: any }>;
      propagateConfig: () => Promise<void>;
      resetGameState: (code: string) => Promise<void>;
    },
    billingUrl: string,
    gameUrl: string,
    serviceSignature: Record<string, string>,
    targetGameCode: string,
  ): Promise<void> {
    console.log('[setup] Waiting for caches to warm up (Billing + Game)...');
    for (let i = 0; i < 120; i++) {
      try {
        const [bRes, gRes] = await Promise.all([
          api.get(`${billingUrl}/v2/service/games`, { headers: serviceSignature }),
          api.get(`${gameUrl}/v2/service/games`, { headers: serviceSignature }),
          api.propagateConfig(),
        ]);
        const bGames: any[] = bRes.data?.data?.games ?? bRes.data?.data ?? [];
        const gGames: any[] = gRes.data?.data?.games ?? gRes.data?.data ?? [];
        if (bGames.length > 0 && gGames.length > 0) {
          console.log(`[setup] Caches ready: Billing(${bGames.length}), Game(${gGames.length})`);
          console.log(`[setup] Ensuring ${targetGameCode} is in a clean, enabled state...`);
          await api.resetGameState(targetGameCode);
          console.log('✅ Setup complete.');
          return;
        }
        if (i % 10 === 0)
          console.log(`[setup] Progress: Billing=${bGames.length}, Game=${gGames.length}...`);
      } catch {
        if (i % 20 === 0) console.log('[setup] Connection pending...');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Timeout: Services online but caches are empty. Check DB connectivity.');
  }

  private _loadReadyState(): E2EReadyState | null {
    try {
      return JSON.parse(fs.readFileSync(this.readyFile, 'utf-8')) as E2EReadyState;
    } catch {
      return null;
    }
  }

  private _writeReadyState(): void {
    const worktrees: Record<string, { sha: string; target: string }> = {};
    for (const [repoKey, repoCfg] of Object.entries(orchestratorCfg.repos)) {
      const dir = path.join(this.worktreeBase, repoKey);
      try {
        const sha = execSync('git log -1 --format=%H HEAD', { cwd: dir }).toString().trim();
        worktrees[repoKey] = { sha, target: repoCfg.target };
      } catch {}
    }
    fs.mkdirSync(path.dirname(this.readyFile), { recursive: true });
    fs.writeFileSync(this.readyFile, JSON.stringify({ worktrees, timestamp: Date.now() }, null, 2));
  }

  private _deleteReadyState(): void {
    try {
      fs.unlinkSync(this.readyFile);
    } catch {}
  }

  async teardown() {
    this._seq?.stop();

    // Sever all active log streams so the Bun event loop can close
    this.streamControllers.forEach((ac) => ac.abort());

    const forceTeardown = process.env.E2E_TEARDOWN === '1';
    if (!orchestratorCfg.global.cleanOnTeardown && !forceTeardown) {
      console.log('\n⚡ Services left running. Next bun test will warm-start in ~5s.');
      console.log(
        '   (Force stop: E2E_TEARDOWN=1 bun test  or  cleanOnTeardown: true in e2e-orchestrator.yml)',
      );
      return;
    }

    console.log('\n🛑 Tearing down E2E Environment...');
    this._seq?.stop();
    this.activeProcesses.forEach((proc) => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    });
    for (const port of this.portsToClear) {
      try {
        execSync(
          `lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
        );
      } catch {}
    }

    if (fs.existsSync(this.worktreeBase)) {
      const composedDown = new Set<string>();

      // DARK MAGIC: Run all Docker composes down in parallel instead of sequentially
      const teardownPromises = Object.entries(orchestratorCfg.repos).map(([repoName, repo]) => {
        const dir = path.join(this.worktreeBase, repoName);
        const repoPath = path.resolve(repo.repoPath);
        const composeFile = path.join(dir, 'docker-compose.yml');

        if (fs.existsSync(composeFile) && !composedDown.has(repoPath)) {
          composedDown.add(repoPath);
          console.log(`   -> Stopping ${repoName} infra...`);
          try {
            return Bun.spawn(
              ['docker', 'compose', 'down', '--timeout', '10', '-v', '--remove-orphans'],
              { cwd: dir, stdout: 'ignore', stderr: 'ignore' },
            ).exited;
          } catch {}
        }
        return Promise.resolve();
      });

      await Promise.all(teardownPromises);

      // Now that containers are dead, cleanup the worktrees quickly
      for (const [repoName, repo] of Object.entries(orchestratorCfg.repos)) {
        try {
          Bun.spawnSync(
            ['git', 'worktree', 'remove', '-f', path.join(this.worktreeBase, repoName)],
            { cwd: path.resolve(repo.repoPath) },
          );
        } catch {}
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
          try {
            execSync('docker info', { stdio: 'ignore' });
            ready = true;
            console.log('✅ Docker daemon online!');
            break;
          } catch {
            execSync('sleep 1');
          }
        }
        if (!ready) throw new Error('Timeout: Docker daemon failed to start.');
      } else {
        throw new Error('Docker daemon is not running. Auto-start only supported on macOS.');
      }
    }
  }

  private flushDatabases(): Set<string> {
    const targetsToRedo = new Set<string>();
    const mongoDbsToDrop = new Set<string>();

    for (const [name, svc] of Object.entries(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo) continue;
      const repoCfg = orchestratorCfg.repos[repo];
      const { dbName, mongoName } = this.deduceIsolatedNames(repo, repoCfg, svc);

      const flushCfg = {
        mongo: repoCfg?.flushData?.mongo ?? orchestratorCfg.global.flushData?.mongo ?? false,
        postgres:
          repoCfg?.flushData?.postgres ?? orchestratorCfg.global.flushData?.postgres ?? false,
      };

      if (flushCfg.mongo && mongoName) mongoDbsToDrop.add(mongoName);
      if (flushCfg.postgres && dbName) targetsToRedo.add(dbName);
    }

    if (mongoDbsToDrop.size > 0 || targetsToRedo.size > 0) {
      console.log('\n🧹 Checking for requested database wipes...');
    }

    if (mongoDbsToDrop.size > 0) {
      try {
        const mongoContainers = execSync(`docker ps -q -f "name=mongo"`)
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean);
        if (mongoContainers.length > 0) {
          for (const mongoName of mongoDbsToDrop) {
            console.log(`   -> Dropping Mongo DB: ${mongoName}`);
            let success = false;
            let lastErr = '';

            // Loop through containers until we find the Replica Set Primary
            for (const cid of mongoContainers) {
              try {
                const cmd = `CMD="mongosh"; which mongosh >/dev/null 2>&1 || CMD="mongo"; $CMD -u root -p root --authenticationDatabase admin ${mongoName} --quiet --eval "db.dropDatabase()" || $CMD ${mongoName} --quiet --eval "db.dropDatabase()"`;

                // Use input pipe to execute safely
                execSync(`docker exec -i ${cid} sh`, {
                  input: cmd,
                  stdio: ['pipe', 'pipe', 'pipe'],
                });

                success = true;
                targetsToRedo.add(mongoName);
                break; // Primary found and dropped, move to next database!
              } catch (e: any) {
                const errText = e.stderr ? e.stderr.toString() : '';

                // --- UPDATE THIS LINE ---
                if (errText.includes('not primary') || errText.includes('ECONNREFUSED')) {
                  continue; // This is a secondary node or an arbiter, try the next container
                }

                lastErr = errText;
              }
            }

            if (!success) {
              console.warn(`   ⚠️  Failed to drop Mongo DB: ${mongoName}`);
              if (lastErr) console.warn(`      Error: ${lastErr.trim()}`);
              else console.warn(`      Error: Could not find a primary node.`);
            }
          }
        } else {
          console.warn('   ⚠️  Could not find any Mongo containers.');
        }
      } catch (e: any) {
        console.warn('   ⚠️  Failed to query Mongo containers.');
      }
    }

    return targetsToRedo;
  }

  private flushRedis() {
    const toFlushRedis = new Set<string>();
    for (const [name, svc] of Object.entries(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo) continue;
      const repoCfg = orchestratorCfg.repos[repo];
      const { redisPrefix } = this.deduceIsolatedNames(repo, repoCfg, svc);

      const flush = repoCfg?.flushData?.redis ?? orchestratorCfg.global.flushData?.redis ?? false;
      if (flush && redisPrefix) toFlushRedis.add(redisPrefix);
    }

    if (toFlushRedis.size > 0) {
      console.log('\n🧹 Flushing Redis namespaces...');
      try {
        const containerId = execSync(`docker ps -q -f "name=redis" | head -n 1`).toString().trim();
        if (containerId) {
          for (const prefix of toFlushRedis) {
            console.log(`   -> Scanning Redis cluster for prefix: ${prefix}:*`);

            // Clean multi-line bash script that tallies and prints every key found
            const script = `
              cli=$(which valkey-cli >/dev/null 2>&1 && echo valkey-cli || echo redis-cli)
              total=0
              for master in $($cli -p 6000 cluster nodes 2>/dev/null | grep master | awk '{print $2}' | cut -d@ -f1); do
                host=$(echo $master | cut -d: -f1)
                port=$(echo $master | cut -d: -f2)
                keys=$($cli -h $host -p $port --scan --pattern "${prefix}:*" 2>/dev/null)
                
                if [ -n "$keys" ]; then
                  for key in $keys; do
                    echo "      🗑️  Found: $key"
                    total=$((total + 1))
                  done
                  # Delete the keys
                  echo "$keys" | xargs $cli -h $host -p $port DEL >/dev/null 2>&1
                fi
              done
              
              if [ "$total" -gt 0 ]; then
                echo "   ✅ Successfully deleted $total keys for prefix ${prefix}:*"
              else
                echo "   ℹ️  No existing keys found for prefix ${prefix}:*"
              fi
            `;

            try {
              // Capture the stdout buffer and print it so you see the exact keys and the total!
              const output = execSync(`docker exec -i ${containerId} sh`, {
                input: script,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              console.log(output.toString().replace(/\n$/, ''));
            } catch (e: any) {
              console.warn(`   ⚠️  Failed to clear Redis prefix ${prefix}:*`);
              if (e.stderr) console.warn(`      Error: ${e.stderr.toString().trim()}`);
            }
          }
        }
      } catch (e: any) {
        console.warn('   ⚠️  Failed to execute Redis flush.');
        if (e.stderr) console.warn(`      Error: ${e.stderr.toString().trim()}`);
      }
    }
  }

  /**
   * Probe candidate swagger URLs concurrently. Returns a map of baseUrl → swagger URL
   * for every service that responds to a known swagger path.
   * Paths tried (Fastify swagger-ui default, then common alternatives):
   *   /documentation  /api-docs  /swagger  /swagger-ui
   */
  private async _probeSwaggerUrls(baseUrls: string[]): Promise<Map<string, string>> {
    const SWAGGER_PATHS = [
      '/docs',
      '/documentation',
      '/api-docs',
      '/swagger',
      '/swagger-ui',
      '/openapi.json',
    ];
    const result = new Map<string, string>();

    await Promise.all(
      baseUrls.flatMap((base) =>
        SWAGGER_PATHS.map(async (swPath) => {
          if (result.has(base)) return; // first hit wins
          try {
            const res = await axios.get(`${base}${swPath}`, { timeout: 800, maxRedirects: 0 });
            if (res.status < 400 && !result.has(base)) result.set(base, `${base}${swPath}`);
          } catch {}
        }),
      ),
    );
    return result;
  }

  /**
   * Unified environment summary — always printed, regardless of warm/cold path.
   * Shows service topology, active endpoints, and swagger links where available.
   * Also writes Postman env + endpoints JSON files.
   *
   * Swagger detection: probes common swagger UI paths concurrently. Fast (800ms timeout,
   * all services in parallel). Shows link only when the endpoint actually responds.
   */
  private async printEnvironmentSummary() {
    const portedServices = Object.entries(composeServices).filter(
      ([, s]) => s['x-repo'] && hostPort(s.ports),
    );
    const baseUrls = portedServices.map(([, s]) => `http://127.0.0.1:${hostPort(s.ports)}`);

    // Probe swagger concurrently while we build the table — fire immediately
    const swaggerPromise = this._probeSwaggerUrls([...new Set(baseUrls)]);

    const endpoints: Record<string, string> = {};
    const postmanValues: { key: string; value: string; type: string; enabled: boolean }[] = [];

    // Collect rows
    const rows: Array<{
      service: string;
      repo: string;
      target: string;
      port: string;
      db: string;
      url: string;
      swagger: string;
    }> = [];

    for (const [name, svc] of Object.entries(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo) continue;
      const repoCfg = orchestratorCfg.repos[repo];
      const { dbName } = this.deduceIsolatedNames(repo, repoCfg, svc);
      const port = hostPort(svc.ports);
      const url = port ? `http://127.0.0.1:${port}` : '-';

      if (port) {
        endpoints[name] = url;
        postmanValues.push({
          key: name.toUpperCase().replace(/-/g, '_') + '_URL',
          value: url,
          type: 'default',
          enabled: true,
        });
      }

      // Placeholder — filled in after swagger probing resolves
      rows.push({
        service: name,
        repo: repo.replace(/^remote-game-server-/, 'rgs-'),
        target: repoCfg?.target ?? '-',
        port: String(port ?? '-'),
        db: dbName ?? '-',
        url,
        swagger: '…', // resolved below
      });
    }

    // Await swagger probe results and fill in the swagger column
    const swaggerMap = await swaggerPromise;
    for (const r of rows) {
      r.swagger = swaggerMap.get(r.url) ?? '-';
    }

    // Column widths
    const w = {
      service: Math.max(7, ...rows.map((r) => r.service.length)),
      repo: Math.max(12, ...rows.map((r) => r.repo.length)),
      target: Math.max(6, ...rows.map((r) => r.target.length)),
      port: 5,
      db: Math.max(8, ...rows.map((r) => r.db.length)),
      url: Math.max(3, ...rows.map((r) => r.url.length)),
      swagger: Math.max(7, ...rows.map((r) => r.swagger.length)),
    };
    const totalW = Object.values(w).reduce((a, b) => a + b, 0) + Object.keys(w).length * 3 - 1;
    const bar = '─';
    const col = (s: string, n: number) => s.padEnd(n);
    const row = (r: (typeof rows)[0]) =>
      `│ ${col(r.service, w.service)} │ ${col(r.repo, w.repo)} │ ${col(r.target, w.target)} │ ${col(r.port, w.port)} │ ${col(r.db, w.db)} │ ${col(r.url, w.url)} │ ${col(r.swagger, w.swagger)} │`;
    const hdr = `│ ${col('Service', w.service)} │ ${col('Repo Variant', w.repo)} │ ${col('Target', w.target)} │ ${col('Port', w.port)} │ ${col('DB', w.db)} │ ${col('URL', w.url)} │ ${col('Swagger', w.swagger)} │`;
    const sep = (l: string, m: string, r2: string) =>
      l +
      [w.service, w.repo, w.target, w.port, w.db, w.url, w.swagger]
        .map((n) => bar.repeat(n + 2))
        .join(m) +
      r2;

    console.log('\n🌍 Service Environment');
    console.log(sep('┌', '┬', '┐'));
    console.log(hdr);
    console.log(sep('├', '┼', '┤'));
    rows.forEach((r) => console.log(row(r)));
    console.log(sep('└', '┴', '┘'));

    const obs = orchestratorCfg.observability;
    if (obs?.seq) console.log('   📈 Seq logs  →  http://localhost:8081');
    if (obs?.dozzle) console.log('   🔍 Dozzle    →  http://localhost:9990');
    console.log('');

    // Write artifacts
    fs.writeFileSync('./.e2e-endpoints.json', JSON.stringify(endpoints, null, 2));
    fs.writeFileSync(
      './E2E_Local.postman_environment.json',
      JSON.stringify(
        {
          id: 'e2e-local-dev',
          name: 'E2E Local Environment',
          values: postmanValues,
          _postman_variable_scope: 'environment',
        },
        null,
        2,
      ),
    );
    console.log('📦 Postman env → E2E_Local.postman_environment.json');
  }

  /**
   * Writes the compiled environment object to a physical .env file in the worktree.
   * This guarantees tools like dotenv find the exact same variables we injected natively.
   */
  private writePhysicalEnvFile(worktreeDir: string, envObj: Record<string, string>) {
    const content = Object.entries(envObj)
      // Filter out huge raw OS variables we don't need to write to disk
      .filter(([k]) => !k.startsWith('npm_') && k !== 'PATH' && k !== 'LS_COLORS')
      .map(([k, v]) => {
        const strVal = String(v);
        // Only wrap in quotes if the value contains a space or a newline
        if (strVal.includes(' ') || strVal.includes('\n')) {
          return `${k}="${strVal.replace(/"/g, '\\"')}"`;
        }
        return `${k}=${strVal}`; // Write naked strings (Bash friendly!)
      })
      .join('\n');

    fs.writeFileSync(path.join(worktreeDir, '.env'), content);
  }
}

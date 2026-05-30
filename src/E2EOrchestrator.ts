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
  migrationEnvFile?: string;
  envOverrides?: Record<string, string>;
  skipMigration?: boolean;        // New
  alwaysRedoMigration?: boolean; // New
  untilMigrationFile?: string;    // New
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
  readFileSync(path.resolve('./e2e-orchestrator.yml'), 'utf-8'),
) as OrchestratorConfig;

const composeServices = (parseYaml(
  readFileSync(path.resolve('./docker-compose.services.yml'), 'utf-8'),
) as { services: Record<string, ComposeService> }).services;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseEnv(env: Record<string, string> | string[] | null | undefined): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map(item => { const [k, ...v] = String(item).split('='); return [k, v.join('=')]; }),
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
  return args.find(a => a.startsWith('http://') || a.startsWith('https://')) ?? null;
}

function dependsOn(svc: ComposeService): string[] {
  const d = svc.depends_on;
  if (!d) return [];
  if (Array.isArray(d)) return d as string[];
  return Object.keys(d);
}

// ─── Seq CLEF log forwarder ───────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

const PINO_LEVELS: Record<number, string> = {
  10: 'Verbose', 20: 'Debug', 30: 'Information',
  40: 'Warning', 50: 'Error', 60: 'Fatal',
};

const PINO_PRETTY_BOUNDARY = /(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL) )/g;
const PINO_PRETTY_HEADER   = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL) /;

const PINO_PRETTY_LEVELS: Record<string, string> = {
  TRACE: 'Verbose', DEBUG: 'Debug', INFO: 'Information',
  WARN: 'Warning', ERROR: 'Error', FATAL: 'Fatal',
};

function splitLogEntries(line: string): string[] {
  const stripped = stripAnsi(line);
  const parts    = stripped.split(PINO_PRETTY_BOUNDARY).filter(Boolean);
  return parts.length > 1 ? parts : [stripped];
}

function lineToClef(line: string, service: string, isError: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const { level, time, msg, pid, hostname, name, ...rest } = JSON.parse(trimmed);
      const seqLevel = PINO_LEVELS[level as number] ?? (isError ? 'Error' : 'Information');
      const ts       = typeof time === 'number' ? new Date(time).toISOString() : new Date().toISOString();
      return JSON.stringify({
        '@t': ts, '@l': seqLevel, '@m': String(msg ?? trimmed),
        'Service': service, ...rest,
      });
    } catch { /* not valid JSON — fall through */ }
  }

  const clean  = stripAnsi(trimmed);
  const header = clean.match(PINO_PRETTY_HEADER);
  if (header) {
    const [fullHeader, time, levelStr] = header;
    const todayDate = new Date().toISOString().slice(0, 11);
    return JSON.stringify({
      '@t': `${todayDate}${time}Z`,
      '@l': PINO_PRETTY_LEVELS[levelStr] ?? (isError ? 'Error' : 'Information'),
      '@m': clean.slice(fullHeader.length).trim(),
      'Service': service,
    });
  }

  if (!clean) return null;
  return JSON.stringify({
    '@t': new Date().toISOString(),
    '@l': isError ? 'Error' : 'Information',
    '@m': clean,
    'Service': service,
  });
}

class SeqForwarder {
  private clefBuffer: string[] = [];
  private lineAccum   = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly url: string;

  constructor(baseUrl: string) {
    this.url = `${baseUrl}/api/events/raw?clef`;
    this.timer = setInterval(() => this.flush(), 500);
  }

  push(chunk: string, service: string, isError = false): void {
    const text  = this.lineAccum + chunk;
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
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.lineAccum.trim()) {
      const event = lineToClef(this.lineAccum, 'unknown', false);
      if (event) this.clefBuffer.push(event);
    }
    this.flush();
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class E2EOrchestrator {
  private activeProcesses: any[] = [];
  private worktreeBase = path.resolve(orchestratorCfg.global.worktreeBasePath);
  private npmCacheDir  = path.resolve('./.e2e-npm-cache');
  private _warmStart   = false;
  private readonly skipPull = process.env.E2E_SKIP_PULL === '1';

  private _masterStream: ReturnType<typeof fs.createWriteStream> | null = null;
  private _seq: SeqForwarder | null = null;
  private _logDir: string = (() => {
    if (process.env.E2E_LOG_DIR) return process.env.E2E_LOG_DIR;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.resolve(`logs/${ts}`);
    fs.mkdirSync(dir, { recursive: true });
    const latestLink = path.resolve('logs/latest');
    try { fs.unlinkSync(latestLink); } catch {}
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
      this._masterStream = fs.createWriteStream(path.join(this.logDir, '_master.log'), { flags: 'a' });
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

    const checkedRepos = new Set<string>();
    let allCached = true;
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo || checkedRepos.has(repo)) continue;
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
 * Deduce the isolated DB names for a specific repo variant.
 * Suffix-based isolation ensures that 'bridge', 'game', etc., get their own logical DBs.
 */
private deduceIsolatedNames(repoName: string, repoCfg?: RepoConfig) {
  const defaultDb = 'slot';
  const defaultMongo = 'rgs';
  
  let dbName = repoCfg?.envOverrides?.DB_NAME;
  let mongoName = repoCfg?.envOverrides?.MONGO_NAME;

  if (!dbName || !mongoName) {
    const parts = repoName.split('-');
    const suffix = parts.length > 1 ? parts[parts.length - 1] : '';
    
    // Billing is the architectural root; other suffixes get isolated namespaces.
    if (suffix && !['billing', 'server', 'service'].includes(suffix)) {
      dbName = dbName || `${defaultDb}_${suffix}`;
      mongoName = mongoName || `${defaultMongo}_${suffix}`;
    } else {
      dbName = dbName || defaultDb;
      mongoName = mongoName || defaultMongo;
    }
  }
  return { dbName, mongoName };
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
    const primaryEnvFile = (forMigration && repoCfg?.migrationEnvFile) ? repoCfg.migrationEnvFile : svc['x-env-file'];
    const envPath = primaryEnvFile ? path.join(worktreeDir, primaryEnvFile) : null;
    
    const fileEnv: Record<string, string> = {};
    
    // Default Fallbacks
    const d = { 
      u: 'postgres', p: 'secret', h: '127.0.0.1', prt: '5432',
      mu: 'root', mp: 'root', mh: '127.0.0.1', mprt: '27017'
    };

    if (envPath && fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
          const idx = t.indexOf('=');
          if (idx !== -1) {
            const k = t.slice(0, idx).trim();
            const v = t.slice(idx + 1).trim();
            if (k) fileEnv[k] = v;
          }
        }
      });
    }

    const { dbName, mongoName } = this.deduceIsolatedNames(repoName, repoCfg);

    // Merge everything
    const merged: Record<string, string> = {
      ...process.env,
      ...fileEnv,
      ...parseEnv(svc.environment),
      ...(this.network ? (svc['x-bridge-env'] ?? {}) : {}),
      ...(repoCfg?.envOverrides ?? {}),
      DB_NAME: dbName,
      MONGO_NAME: mongoName,
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
    merged.MONGO_URL = (mUser && mPass) 
      ? `mongodb://${mUser}:${mPass}@${mHost}:${mPort}/${mongoName}?authSource=admin`
      : `mongodb://${mHost}:${mPort}/${mongoName}`;

    // Log the build for debugging
    console.log(`🛠️  Env Built: ${repoName} | DB: ${dbName} | Port: ${dbPort}`);

    return merged;
  }

  private exportEndpoints(): void {
    const endpoints: Record<string, string> = {};
    const postmanValues: { key: string; value: string; type: string; enabled: boolean }[] = [];
    const rows: string[] = [];

    for (const [name, svc] of Object.entries(composeServices)) {
      if (!svc['x-repo']) continue;
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
    console.log(`└${sep}┘`);

    const obs = orchestratorCfg.observability;
    if (obs?.seq || obs?.dozzle) {
      console.log('');
      if (obs.seq)    console.log('   📈 Seq log browser  →  http://localhost:8081');
      if (obs.dozzle) console.log('   🔍 Dozzle (infra)   →  http://localhost:9990');
    }
    console.log('');

    fs.writeFileSync('./.e2e-endpoints.json', JSON.stringify(endpoints, null, 2));
    fs.writeFileSync('./E2E_Local.postman_environment.json', JSON.stringify({
      id: 'e2e-local-dev',
      name: 'E2E Local Environment',
      values: postmanValues,
      _postman_variable_scope: 'environment',
    }, null, 2));
    console.log('📦 Postman env → E2E_Local.postman_environment.json');
  }

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
          console.log(`   -> Updating ${repoName} @ ${repo.target}...`);
          await this.runAsync('git fetch --all --tags', targetDir);
          try {
            await this.runAsync(`git reset --hard origin/${repo.target}`, targetDir);
          } catch {
            await this.runAsync(`git checkout ${repo.target}`, targetDir);
          }
        } else {
          console.log(`   -> Checking out ${repoName} @ ${repo.target}...`);
          if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
          await this.runAsync('git fetch --all --tags', repoPath);
          try { await this.runAsync('git worktree prune', repoPath); } catch {}
          await this.runAsync(`git worktree add -f ${targetDir} ${repo.target}`, repoPath);
        }
      }));
    }

    await this.detectWarmStart();

    if (!this._warmStart) {
      const ports = this.portsToClear;
      console.log(`🧹 Cold start: clearing stale processes on ports [${ports.join(', ')}]`);
      // DARK MAGIC: Added -P -n to completely bypass DNS resolution timeouts in lsof
      for (const port of ports) {
        try {
          execSync(`lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`);
        } catch {}
      }
    }
  }

  private startObservability(): void {
    const obs = orchestratorCfg.observability;
    if (!obs?.seq && !obs?.dozzle) return;

    const toStart: string[] = [
      ...(obs.seq    ? ['seq']    : []),
      ...(obs.dozzle ? ['dozzle'] : []),
    ];

    console.log(`📊 Starting observability: ${toStart.join(', ')} (pulling images if needed — this may take a moment on first run)...`);
    try {
      const result = Bun.spawnSync(
        ['docker', 'compose', '-f', './docker-compose.observability.yml', 'up', '-d', ...toStart],
        { stdout: 'inherit', stderr: 'inherit' },
      );
      if (result.exitCode !== 0) {
        console.warn('   ⚠️  Observability startup failed (non-fatal) — run manually to see error:');
        console.warn('       docker compose -f docker-compose.observability.yml up -d');
      }
    } catch (e: any) {
      console.warn(`   ⚠️  Observability startup failed (non-fatal): ${String(e.message).split('\n')[0]}`);
    }

    if (obs.seq) {
      this._seq = new SeqForwarder('http://localhost:5341');
      console.log('   📈 Seq log browser → http://localhost:8081');
    }
    if (obs.dozzle) {
      console.log('   🔍 Dozzle live container logs → http://localhost:9990  (Docker containers only)');
    }
  }

  async startInfrastructure() {
    this.ensureDockerRunning();
    this.startObservability();

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
      
      // Patch macOS AirPlay port conflicts
      let content = fs.readFileSync(composeFile, 'utf-8');
      content = content
        .replace(/'7000:9000'/g, "'7002:9000'").replace(/"7000:9000"/g, '"7002:9000"')
        .replace(/'7001:9001'/g, "'7003:9001'").replace(/"7001:9001"/g, '"7003:9001"');
      fs.writeFileSync(composeFile, content);

      if (this.network) {
        const overrides = orchestratorCfg.composeServiceEnvOverrides?.[repoName] ?? {};
        this.writeComposeOverride(dir, this.network, overrides);
      }
      
      // ADDED: --force-recreate to clear out broken container states
      await this.runAsync('docker compose up -d --force-recreate', dir);
    }));

// Map the internal ports to your actual LOCAL ports defined in your .env/compose
console.log('⏳ Waiting for Databases and Kafka to accept connections...');
  const portsToWait = [5437, 27017, 9093]; 

  for (const port of portsToWait) {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        execSync(`nc -z -w 1 127.0.0.1 ${port}`, { stdio: 'ignore' });
        
        // DARK MAGIC: If it's the Postgres port, verify the internal engine is actually READY
        if (port === 5437) {
          // Attempt to connect and run a dummy query. If it's still "starting up", this fails.
          execSync(`docker exec $(docker ps -q -f "name=db-1") pg_isready -U postgres`, { stdio: 'ignore' });
        }
        
        ready = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (ready) console.log(`   ✅ Port ${port} is fully ready.`);
    else console.warn(`   ⚠️  Port ${port} still warming up, proceeding with caution...`);
  }
  
  // Give a final 2s for Kafka/Mongo internal sharding/init
  await new Promise(r => setTimeout(r, 2000));
}

  async runGlobalMigrations() {
  const hasForcedRedo = Object.values(orchestratorCfg.repos).some(r => r.alwaysRedoMigration);
  
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

    const { dbName, mongoName } = this.deduceIsolatedNames(repo, repoCfg);
    const migrationEnv = this.buildEnvironment(worktreeDir, svc, repo, repoCfg, true);
    
    // Write the clean .env for migrate.sh
    const minimalEnvKeys = [
      'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_PORT', 'DB_NAME',
      'MONGO_USER', 'MONGO_PASSWORD', 'MONGO_HOST', 'MONGO_PORT', 'MONGO_NAME',
      'MONGO_URL', 'DATABASE_URL'
    ];
    const minimalEnvContent = minimalEnvKeys
      .filter(k => migrationEnv[k])
      .map(k => `${k}=${migrationEnv[k]}`)
      .join('\n');
    fs.writeFileSync(path.join(worktreeDir, '.env'), minimalEnvContent);

    // Release locks if redo is needed
    if (this._warmStart && repoCfg?.alwaysRedoMigration) {
      this.killProcessesOnPorts(svc.ports);
    }

    const dbs = fs.readdirSync(migrationsDir).filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory());

    // We only want to migrate the specific targets for this variant
    const targets = [
      { name: dbName, isMongo: false, source: 'slot' },
      { name: mongoName, isMongo: true, source: 'rgs' }
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

      // REDO Logic
      if (repoCfg?.alwaysRedoMigration) {
        console.log(`   -> [REDO] Wiping ${target.name}...`);
        Bun.spawnSync([migrateBin, 'down', target.name, 'all'], {
          cwd: worktreeDir, env: migrationEnv as any, stdout: 'inherit', stderr: 'inherit'
        });
      }

      console.log(`   -> Migrating ${repo} -> ${target.name}`);
      const proc = Bun.spawnSync([migrateBin, 'up', target.name], {
        cwd: worktreeDir, stdout: 'inherit', stderr: 'inherit', env: migrationEnv as any
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
        this.exportEndpoints();
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

    if (!this._warmStart) {
      console.log('🚀 Preparing Dependencies & Builds (Concurrently)...');
    }

    const buildTasks: Promise<void>[] = [];
    const builtRepos = new Set<string>();

    if (!this._warmStart) {
      for (const svc of Object.values(composeServices)) {
        const repo        = svc['x-repo'];
        const setupCmds   = svc['x-setup'] ?? [];
        if (!repo || !setupCmds.length || builtRepos.has(repo)) continue;
        const worktreeDir = path.join(this.worktreeBase, repo);
        builtRepos.add(repo);

        buildTasks.push((async () => {
          if (this.isBuildCached(worktreeDir)) {
            console.log(`   [CACHE HIT] ${repo}: skipping install & build`);
            return;
          }
          const repoCfg = orchestratorCfg.repos[repo];
          const mergedEnv = this.buildEnvironment(worktreeDir, svc, repo, repoCfg);
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
    }

    console.log('\n🚀 Starting Node Servers...');
    const verboseMode  = this.verbose;
    const masterStream = this.ensureMasterStream();

    const nativeServices = Object.entries(composeServices)
      .filter(([, svc]) => Boolean(svc['x-repo'])) as [string, ComposeService][];

    const readyMap = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    for (const [name] of nativeServices) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; }); 
      readyMap.set(name, { resolve, promise });
    }

    const healthCheckResults: Promise<void>[] = [];

    const launchTasks = nativeServices.map(([name, svc]) => (async () => {
      const deps = dependsOn(svc);
      if (deps.length > 0) {
        const depPromises = deps.map(d => readyMap.get(d)?.promise).filter(Boolean) as Promise<void>[];
        if (depPromises.length) {
          console.log(`   [WAIT]  ${name}: waiting for [${deps.join(', ')}]...`);
          await Promise.all(depPromises);
          console.log(`   [READY] ${name}: dependencies healthy — starting`);
        }
      }

      const repoName      = svc['x-repo']!;
      const worktreeDir   = path.join(this.worktreeBase, repoName);
      const port          = hostPort(svc.ports) ?? 0;
      const hcUrl         = healthCheckUrl(svc);
      const repoCfg       = orchestratorCfg.repos[repoName];
      const mergedEnv     = this.buildEnvironment(worktreeDir, svc, repoName, repoCfg);
      const serviceStream = this.openServiceStream(name, port);
      const dec           = new TextDecoder();

      console.log(`   [START] ${name}: ${svc.command!}`);
      const proc = Bun.spawn(['sh', '-c', svc.command!], {
        cwd: worktreeDir,
        env: mergedEnv as any,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      proc.stdout?.pipeTo(new WritableStream({
        write: chunk => {
          const text = dec.decode(chunk);
          serviceStream?.write(text);
          masterStream?.write(`[${name}] ${text}`);
          this._seq?.push(text, name, false);
          if (verboseMode === true) process.stdout.write(`[${name}] ${text}`);
        },
      }));

      proc.stderr?.pipeTo(new WritableStream({
        write: chunk => {
          const text = dec.decode(chunk);
          serviceStream?.write(text);
          masterStream?.write(`[${name} ERR] ${text}`);
          this._seq?.push(text, name, true);
          if (verboseMode === true || verboseMode === 'errors') process.stderr.write(`[${name} ERR] ${text}`);
        },
      }));

      this.activeProcesses.push(proc);

      if (hcUrl) {
        const hcPromise = this.pollHealthCheck(name, hcUrl);
        healthCheckResults.push(hcPromise);
        hcPromise
          .then(() => readyMap.get(name)!.resolve())
          .catch(() => readyMap.get(name)!.resolve()); 
      } else {
        readyMap.get(name)!.resolve();
      }
    })());

    await Promise.all(launchTasks);
    await Promise.all(healthCheckResults);

    console.log('\n✅ All services started.\n');
    this.exportEndpoints();
  }

  private async pollHealthCheck(name: string, url: string): Promise<void> {
    const maxAttempts = 60;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await axios.get(url, { timeout: 3000 });
        console.log(`   ✅ Ready: ${name} (${url})`);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw new Error(`❌ Healthcheck failed after ${maxAttempts} attempts: ${name} (${url})`);
  }

  async teardown() {
    const forceTeardown = process.env.E2E_TEARDOWN === '1';
    if (!orchestratorCfg.global.cleanOnTeardown && !forceTeardown) {
      console.log('\n⚡ Services left running. Next bun test will warm-start in ~5s.');
      console.log('   (Force stop: E2E_TEARDOWN=1 bun test  or  cleanOnTeardown: true in e2e-orchestrator.yml)');
      return;
    }

    console.log('\n🛑 Tearing down E2E Environment...');
    this._seq?.stop();
    this.activeProcesses.forEach(proc => { try { proc.kill('SIGKILL'); } catch {} });
    for (const port of this.portsToClear) {
      try { execSync(`lsof -P -n -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`); } catch {}
    }

    if (fs.existsSync(this.worktreeBase)) {
      const composedDown = new Set<string>();

      // DARK MAGIC: Run all Docker composes down in parallel instead of sequentially
      const teardownPromises = Object.entries(orchestratorCfg.repos).map(([repoName, repo]) => {
        const dir        = path.join(this.worktreeBase, repoName);
        const repoPath   = path.resolve(repo.repoPath);
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
         try { Bun.spawnSync(['git', 'worktree', 'remove', '-f', path.join(this.worktreeBase, repoName)], { cwd: path.resolve(repo.repoPath) }); } catch {}
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
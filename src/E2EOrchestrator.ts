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
  /** Override the env file used when running db-migrations.
   *  Required for repos whose first compose service lacks DB credentials
   *  (e.g. bridge, game-activity). Use the service that owns the DB schema. */
  migrationEnvFile?: string;
  /** Env overrides applied on top of everything else — for BOTH migrations and
   *  service runtime. Primary use: isolate each repo variant's DB by overriding
   *  DB_NAME and MONGO_NAME so variants never share state. */
  envOverrides?: Record<string, string>;
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
  // Orchestrator hints (x-* fields — Docker Compose ignores these).
  // Optional because observability services (seq, dozzle) are Docker-managed and lack these fields.
  'x-repo'?: string;
  'x-env-file'?: string;
  'x-setup'?: string[];
  'x-bridge-env'?: Record<string, string>;
  // Standard Docker Compose fields
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

// ─── Seq CLEF log forwarder ───────────────────────────────────────────────────
//
// Strips ANSI terminal escape sequences (fallback for non-JSON log lines).
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

// Maps pino numeric level → CLEF level string for Seq.
const PINO_LEVELS: Record<number, string> = {
  10: 'Verbose', 20: 'Debug', 30: 'Information',
  40: 'Warning', 50: 'Error', 60: 'Fatal',
};

// pino-pretty line format: [HH:MM:SS.mmm] LEVEL (pid): message
// Used to detect and split concatenated pretty entries AND extract the timestamp.
const PINO_PRETTY_BOUNDARY = /(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL) )/g;
const PINO_PRETTY_HEADER   = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL) /;

const PINO_PRETTY_LEVELS: Record<string, string> = {
  TRACE: 'Verbose', DEBUG: 'Debug', INFO: 'Information',
  WARN: 'Warning', ERROR: 'Error', FATAL: 'Fatal',
};

/**
 * Split a raw line into individual log entries.
 * Handles the case where pino-pretty emits multiple entries without newlines between them.
 */
function splitLogEntries(line: string): string[] {
  const stripped = stripAnsi(line);
  const parts    = stripped.split(PINO_PRETTY_BOUNDARY).filter(Boolean);
  return parts.length > 1 ? parts : [stripped];
}

/**
 * Convert a single log line to a CLEF event string.
 *
 * Priority:
 *  1. pino NDJSON (LOG_PRETTY=''): all structured fields become Seq properties
 *  2. pino-pretty text: extracts timestamp + level for accurate Seq metadata
 *  3. Plain text fallback
 */
function lineToClef(line: string, service: string, isError: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1. pino NDJSON (best — all properties searchable in Seq)
  if (trimmed.startsWith('{')) {
    try {
      const { level, time, msg, pid, hostname, name, ...rest } = JSON.parse(trimmed);
      const seqLevel = PINO_LEVELS[level as number] ?? (isError ? 'Error' : 'Information');
      const ts       = typeof time === 'number' ? new Date(time).toISOString() : new Date().toISOString();
      return JSON.stringify({
        '@t': ts,
        '@l': seqLevel,
        '@m': String(msg ?? trimmed),
        'Service': service,
        ...rest,   // url, method, query, roundId, gameCode, etc. — all searchable in Seq
      });
    } catch { /* not valid JSON — fall through */ }
  }

  // 2. pino-pretty: extract timestamp and level for accurate Seq metadata
  const clean  = stripAnsi(trimmed);
  const header = clean.match(PINO_PRETTY_HEADER);
  if (header) {
    const [fullHeader, time, levelStr] = header;
    const todayDate = new Date().toISOString().slice(0, 11); // "2026-05-30T"
    return JSON.stringify({
      '@t': `${todayDate}${time}Z`,
      '@l': PINO_PRETTY_LEVELS[levelStr] ?? (isError ? 'Error' : 'Information'),
      '@m': clean.slice(fullHeader.length).trim(),
      'Service': service,
    });
  }

  // 3. Plain text fallback (startup messages, non-pino output)
  if (!clean) return null;
  return JSON.stringify({
    '@t': new Date().toISOString(),
    '@l': isError ? 'Error' : 'Information',
    '@m': clean,
    'Service': service,
  });
}

// Buffers CLEF log events and batch-flushes to Seq every 500ms.
// Maintains a partial-line buffer so chunks that split a JSON line are reassembled.
// Fire-and-forget: Seq failures are silently ignored (Seq is optional).

class SeqForwarder {
  private clefBuffer: string[] = [];
  private lineAccum   = '';     // accumulates a partial line across chunks
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly url: string;

  constructor(baseUrl: string) {
    this.url = `${baseUrl}/api/events/raw?clef`;
    this.timer = setInterval(() => this.flush(), 500);
  }

  push(chunk: string, service: string, isError = false): void {
    // Reassemble chunk with any leftover partial line from previous chunk
    const text  = this.lineAccum + chunk;
    const lines = text.split('\n');
    // Last element is either empty (chunk ended with \n) or a partial line
    this.lineAccum = lines.pop() ?? '';

    for (const line of lines) {
      // pino-pretty sometimes concatenates multiple entries without newlines.
      // splitLogEntries detects pino-pretty boundaries and separates them.
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
    }).catch(() => {}); // Seq being down must never crash tests
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Flush any partial line left in the accumulator
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

    // One build-cache check per repo (multiple services can share a repo).
    // Skip observability services (seq, dozzle) that have no x-repo.
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
  private buildEnvironment(
    worktreeDir: string,
    svc: ComposeService,
    repoOverrides?: Record<string, string>,
  ): Record<string, string> {
    const envFilePath = svc['x-env-file'];
    const envPath = envFilePath ? path.join(worktreeDir, envFilePath) : null;
    const fileEnv: Record<string, string> = {};
    if (envPath && fs.existsSync(envPath)) {
      fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
          const [key, ...val] = t.split('=');
          if (key) fileEnv[key] = val.join('=');
        }
      });
    }
    const bridgeEnv = this.network ? (svc['x-bridge-env'] ?? {}) : {};
    // When Seq is enabled, disable pino-pretty so services emit raw NDJSON.
    // The orchestrator then parses each line into rich CLEF events with all
    // structured fields (url, method, roundId, etc.) searchable in Seq.
    // Empty string is falsy in JS — disables pino-pretty regardless of whether the
    // service checks `if (LOG_PRETTY)`, `LOG_PRETTY === 'true'`, or `!== 'false'`.
    const seqEnv: Record<string, string> = orchestratorCfg.observability?.seq ? { LOG_PRETTY: '' } : {};
    return {
      ...(process.env as Record<string, string>),
      ...fileEnv,
      ...parseEnv(svc.environment),
      ...bridgeEnv,
      ...seqEnv,
      ...(repoOverrides ?? {}),  // highest priority: repo-level DB isolation overrides
      npm_config_cache: this.npmCacheDir,
    };
  }

  // ─── Endpoint export ──────────────────────────────────────────────────────

  private exportEndpoints(): void {
    const endpoints: Record<string, string> = {};
    const postmanValues: { key: string; value: string; type: string; enabled: boolean }[] = [];
    const rows: string[] = [];

    // Only export native Node.js services (those with x-repo) — skip seq/dozzle
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

    // Print observability URLs separately (not included in Postman env)
    const obs = orchestratorCfg.observability;
    if (obs?.seq || obs?.dozzle) {
      console.log('');
      if (obs.seq)    console.log('   📈 Seq log browser  →  http://localhost:8081');
      if (obs.dozzle) console.log('   🔍 Dozzle (infra)   →  http://localhost:9990');
    }
    console.log('');

    // Consumed by tests/utils/config.ts as a fast lookup
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
          console.log(`   -> Updating ${repoName} @ ${repo.target}...`);
          // --tags ensures version tags (1.7.10, 1.15.1, etc.) are fetched
          await this.runAsync('git fetch --all --tags', targetDir);
          // Try branch-style reset first; fall back to tag checkout on failure
          try {
            await this.runAsync(`git reset --hard origin/${repo.target}`, targetDir);
          } catch {
            // target is a tag (immutable) — just checkout, no remote tracking branch
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
      for (const port of ports) {
        try {
          execSync(`lsof -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`);
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
      // stdout/stderr inherit → Docker pull progress goes straight to terminal.
      // spawnSync blocks until images are pulled and containers are started.
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

    // Initialize Seq forwarder so Node.js service logs are forwarded
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

    // Always start observability (even on warm start — containers may need to be running)
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

    // Run migrations once per repo — every repo with a db-migrations directory runs.
    // Each variant is isolated via envOverrides (different DB_NAME / MONGO_NAME).
    const reposMigrated = new Set<string>();
    for (const svc of Object.values(composeServices)) {
      const repo = svc['x-repo'];
      if (!repo || reposMigrated.has(repo)) continue;
      const repoCfg = orchestratorCfg.repos[repo];
      const worktreeDir   = path.join(this.worktreeBase, repo);
      const migrationsDir = path.join(worktreeDir, 'db-migrations');
      if (!fs.existsSync(migrationsDir)) continue;
      reposMigrated.add(repo);

      // migrationEnvFile: use a different .env.*.example for migrations
      //   (e.g. bridge/game-activity don't have DB credentials — borrow billing's)
      // envOverrides: applied last — isolates this variant's DB from others
      //   (DB_NAME=slot_bridge, MONGO_NAME=rgs_bridge, etc.)
      const envFileToUse = repoCfg?.migrationEnvFile ?? svc['x-env-file'];
      const svcForMigration: ComposeService = envFileToUse !== svc['x-env-file']
        ? { ...svc, 'x-env-file': envFileToUse }
        : svc;

      const migrationEnv = this.buildEnvironment(worktreeDir, svcForMigration, repoCfg?.envOverrides);
      const baseEnvPath  = envFileToUse ? path.join(worktreeDir, envFileToUse) : null;
      const destEnvPath  = path.join(worktreeDir, '.env');
      if (baseEnvPath && fs.existsSync(baseEnvPath)) {
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
    const seqEnabled = !!orchestratorCfg.observability?.seq;

    if (this._warmStart) {
      if (!seqEnabled) {
        // Pure warm start: services already running, nothing to do
        console.log('⚡ Warm start: all services already running with current code.');
        this.exportEndpoints();
        return;
      }
      // Seq is enabled: cannot attach to already-running processes.
      // Kill them and respawn with stdout/stderr piped so Seq receives all logs.
      // Build is still skipped — only the spawn step runs (~10-30s for health checks).
      console.log('⚡ Warm start + Seq: respawning services for log capture (build skipped)...');
      for (const port of this.portsToClear) {
        try {
          execSync(
            `lsof -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`,
          );
        } catch {}
      }
      // Fall through directly to the spawn phase — skip builds below
    }

    if (!this._warmStart) {
      console.log('🚀 Preparing Dependencies & Builds (Concurrently)...');
    }

    // ── Phase 1: build (once per repo, git-hash cached) — skipped on warm start ──

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
    }

    // ── Phase 2: start services, honouring depends_on ─────────────────────────
    //
    // Each service gets a "ready" promise that resolves once its healthcheck passes
    // (or immediately if no healthcheck). Dependents await their deps' ready promises
    // before spawning — replacing `while ! curl` bash hacks with native logic.
    //
    // Services without x-repo (Seq, Dozzle) are Docker containers managed by
    // startObservability() — skip them here.

    console.log('\n🚀 Starting Node Servers...');
    const verboseMode  = this.verbose;
    const masterStream = this.ensureMasterStream();

    // Only native services (those with x-repo) are spawned by the orchestrator
    const nativeServices = Object.entries(composeServices)
      .filter(([, svc]) => Boolean(svc['x-repo'])) as [string, ComposeService][];

    // Register all ready promises upfront so deps can reference them immediately.
    // IMPORTANT: must separate Promise creation from the object literal so that
    // the Promise constructor (which assigns `resolve`) runs BEFORE the shorthand
    // `{ resolve }` captures its value — otherwise `resolve` is captured as undefined.
    const readyMap = new Map<string, { resolve: () => void; promise: Promise<void> }>();
    for (const [name] of nativeServices) {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; }); // executor runs sync → resolve is now a function
      readyMap.set(name, { resolve, promise });
    }

    // Track actual health-check failures separately from dep-coordination
    const healthCheckResults: Promise<void>[] = [];

    const launchTasks = nativeServices.map(([name, svc]) => (async () => {
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

      // nativeServices filter guarantees x-repo and command are present
      const worktreeDir   = path.join(this.worktreeBase, svc['x-repo']!);
      const port          = hostPort(svc.ports) ?? 0;
      const hcUrl         = healthCheckUrl(svc);
      const repoEnvOverrides = orchestratorCfg.repos[svc['x-repo']!]?.envOverrides;
      const mergedEnv     = this.buildEnvironment(worktreeDir, svc, repoEnvOverrides);
      const serviceStream = this.openServiceStream(name, port);
      const dec           = new TextDecoder();

      console.log(`   [START] ${name}: ${svc.command!}`);
      const proc = Bun.spawn(['sh', '-c', svc.command!], {
        cwd: worktreeDir,
        env: mergedEnv as any,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // stdout → service log (raw) + master log (prefixed) + Seq + terminal if verbose=true
      proc.stdout?.pipeTo(new WritableStream({
        write: chunk => {
          const text = dec.decode(chunk);
          serviceStream?.write(text);
          masterStream?.write(`[${name}] ${text}`);
          this._seq?.push(text, name, false);
          if (verboseMode === true) process.stdout.write(`[${name}] ${text}`);
        },
      }));

      // stderr → service log (raw) + master log (prefixed) + Seq + terminal if verbose or "errors"
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
    this._seq?.stop();
    this.activeProcesses.forEach(proc => { try { proc.kill('SIGKILL'); } catch {} });
    for (const port of this.portsToClear) {
      try { execSync(`lsof -i:${port} -sTCP:LISTEN | grep -E 'node|bun' | awk '{print $2}' | sort -u | xargs kill -9 2>/dev/null || true`); } catch {}
    }

    if (fs.existsSync(this.worktreeBase)) {
      // Multiple repos may share the same repoPath (e.g. remote-game-server-billing,
      // remote-game-server-bridge all point to ../remote-game-server).
      // Run docker compose down ONCE per unique source repo to avoid hanging on
      // already-stopped containers.
      const composedDown = new Set<string>();

      for (const [repoName, repo] of Object.entries(orchestratorCfg.repos)) {
        const dir        = path.join(this.worktreeBase, repoName);
        const repoPath   = path.resolve(repo.repoPath);
        const composeFile = path.join(dir, 'docker-compose.yml');

        if (fs.existsSync(composeFile) && !composedDown.has(repoPath)) {
          composedDown.add(repoPath);
          console.log(`   -> Stopping ${repoName} infra...`);
          try {
            Bun.spawnSync(
              ['docker', 'compose', 'down', '--timeout', '10', '-v', '--remove-orphans'],
              { cwd: dir, stdout: 'inherit', stderr: 'inherit' },
            );
          } catch {}
        }
        try { Bun.spawnSync(['git', 'worktree', 'remove', '-f', dir], { cwd: repoPath }); } catch {}
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

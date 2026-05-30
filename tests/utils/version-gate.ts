/**
 * Version-gated test runner.
 *
 * Determines whether a service's running target (branch or tag) satisfies a
 * version constraint by comparing **git commit timestamps** — so a branch like
 * `feature/x` or `main` is correctly compared against any semver tag without
 * assuming "branch = newest".
 *
 * Resolution order:
 *  1. git log timestamps  — universal, works for branch ↔ tag and tag ↔ tag
 *  2. Bun.semver.satisfies — fallback when the required tag isn't in the repo
 *  3. Permissive pass     — if we genuinely cannot determine ordering, don't skip
 *
 * Aliases are derived at load time from docker-compose.services.yml (x-repo
 * field) and e2e-orchestrator.yml (repos keys) — nothing is hardcoded.
 *
 * Usage:
 *   import { atLeast } from '../utils/version-gate';
 *
 *   // Run only when billing target is at or after 1.8.0
 *   it.if(atLeast('billing', '1.8.0'))('Step 2: …', async () => { … });
 *
 *   // Require multiple services
 *   const ok = atLeast('billing', '1.8.0') && atLeast('bridge', '1.8.0');
 *   it.if(ok)('cron propagation', async () => { … });
 *
 *   // Explicit semver range syntax also accepted
 *   it.if(atLeast('billing', '>=1.8.0 <2.0.0'))('…', async () => { … });
 */

import fs       from 'fs';
import path     from 'path';
import { execFileSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

// ── Load configs at module init (synchronous, happens once) ──────────────────

type RepoEntry = { repoPath: string; target: string };
type OrchestratorConfig = {
  global: { worktreeBasePath: string };
  repos:  Record<string, RepoEntry>;
};
type ComposeFile = { services?: Record<string, { 'x-repo'?: string }> };

const orch    = parseYaml(fs.readFileSync('./e2e-orchestrator.yml', 'utf-8')) as OrchestratorConfig;
const composed = parseYaml(fs.readFileSync('./docker-compose.services.yml', 'utf-8')) as ComposeFile;

const worktreeBase = path.resolve(orch.global.worktreeBasePath);

// ── Build alias map dynamically ───────────────────────────────────────────────
// Priority: compose service names (e.g. "billing") → repo key (e.g. "remote-game-server-billing")
// Fallback: repo keys resolve to themselves (always accepted verbatim).

const _serviceToRepo: Record<string, string> = {};

// From docker-compose.services.yml x-repo fields
for (const [svcName, svc] of Object.entries(composed.services ?? {})) {
  const repo = svc['x-repo'];
  if (repo) _serviceToRepo[svcName] = repo;
}

// All orchestrator repo keys are always accepted verbatim
for (const key of Object.keys(orch.repos ?? {})) {
  _serviceToRepo[key] = key;
}

function resolveRepoKey(serviceKey: string): string {
  return _serviceToRepo[serviceKey] ?? serviceKey;
}

// ── Git timestamp helpers ────────────────────────────────────────────────────

/**
 * Returns Unix seconds for a git ref (HEAD, tag, branch) in `dir`.
 * Returns null if the ref doesn't exist or git fails.
 */
function gitTimestamp(dir: string, ref: string): number | null {
  try {
    const raw = execFileSync('git', ['log', '-1', '--format=%ct', ref], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

// ── Core comparison ──────────────────────────────────────────────────────────

/**
 * Returns true when the service's running target satisfies `constraint`.
 *
 * `constraint` is a semver range or bare version:
 *   "1.8.0"          → equivalent to ">=1.8.0"
 *   ">=1.8.0"        → explicit >=
 *   ">=1.8.0 <2.0.0" → range (both bounds evaluated independently)
 *   "<1.9.0"         → older-than check
 */
const _isSemver = (v: string) => /^v?\d+\.\d+\.\d+/.test(v);
const _isBranch = (v: string) => !_isSemver(v);

function _applyOp(diff: number, operator: string): boolean {
  if (operator === '>=' || operator === '') return diff >= 0;
  if (operator === '>')                     return diff >  0;
  if (operator === '<=')                    return diff <= 0;
  if (operator === '<')                     return diff <  0;
  if (operator === '==' || operator === '=') return diff === 0;
  if (operator === '!=' || operator === '!') return diff !== 0;
  return diff >= 0;
}

function _satisfies(repoKey: string, target: string, constraint: string): boolean {
  const worktreeDir = path.join(worktreeBase, repoKey);

  // Split compound ranges (e.g. ">=1.8.0 <2.0.0") and AND them
  const parts = constraint.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return parts.every(p => _satisfies(repoKey, target, p));
  }

  const raw = constraint.trim();
  const match = raw.match(/^([><=!]*)([0-9].*)$/);
  if (!match) return true;

  const [, op, requiredVersion] = match;
  const operator = op || '>=';

  // ── Strategy: pick the comparison method based on what `target` is ────────
  //
  // SEMVER target (e.g. "1.7.10"):
  //   Use Bun.semver — timestamp order is unreliable when hotfix tags exist
  //   (a 1.7.x tag committed AFTER a 1.8.x tag would fool timestamp comparison).
  //
  // BRANCH target (e.g. "main", "feature/x"):
  //   Use git timestamps — Bun.semver can't parse branch names.
  //   A branch HEAD is compared against the required version tag's commit time.

  if (_isSemver(target)) {
    // ── Path 1: both sides are semver → use Bun.semver ────────────────────
    const clean    = target.replace(/^v/, '');
    const semRange = /^[><=!]/.test(raw) ? raw : `>=${raw}`;
    try { return Bun.semver.satisfies(clean, semRange); }
    catch { /* fall through to timestamp */ }
  }

  // ── Path 2: branch target → use git commit timestamps ─────────────────────
  if (_isBranch(target)) {
    const headTs     = gitTimestamp(worktreeDir, 'HEAD');
    const requiredTs = gitTimestamp(worktreeDir, requiredVersion)
                    ?? gitTimestamp(worktreeDir, `v${requiredVersion}`);

    if (headTs !== null && requiredTs !== null) {
      return _applyOp(headTs - requiredTs, operator);
    }
  }

  // ── Fallback: can't determine, don't skip ─────────────────────────────────
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true when the running target for `serviceKey` satisfies `constraint`.
 * Use with `it.if()` to skip tests on incompatible versions:
 *
 *   it.if(atLeast('billing', '1.8.0'))('my test', async () => { … });
 *
 * @param serviceKey   Compose service name ("billing") or full repo key.
 * @param constraint   Semver range or bare version ("1.8.0", ">=1.8.0", "<2.0.0").
 */
export function atLeast(serviceKey: string, constraint: string): boolean {
  const repoKey = resolveRepoKey(serviceKey);
  const cfg     = orch.repos?.[repoKey];
  if (!cfg) return true; // unknown service — don't skip

  const normalised = /^[0-9v]/.test(constraint) ? `>=${constraint}` : constraint;
  return _satisfies(repoKey, cfg.target, normalised);
}

/**
 * Returns true when the running target does NOT satisfy `constraint`.
 * Useful for tests covering behaviour removed in newer releases.
 *
 *   it.if(olderThan('billing', '2.0.0'))('legacy path', async () => { … });
 */
export function olderThan(serviceKey: string, constraint: string): boolean {
  return !atLeast(serviceKey, constraint);
}

/**
 * Returns the configured target string (tag or branch) for a service.
 *   running('billing')  → "1.7.10"
 *   running('game')     → "1.15.1"
 */
export function running(serviceKey: string): string {
  const cfg = orch.repos?.[resolveRepoKey(serviceKey)];
  return cfg?.target ?? 'unknown';
}

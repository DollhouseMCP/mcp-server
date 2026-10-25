/**
 * Ownership lookup and cache for the GitHub ownership policy (Issue #3153)
 *
 * Resolves who authored the PR, issue or PR-head branch a tool call is about
 * to modify, using the operator's own `gh` CLI authentication. Results for
 * explicit targets (a PR number, an issue number, a named branch) are cached
 * per session. Lookups that depend on "the current branch" of a working
 * directory are never cached: a `git checkout` between two calls would
 * otherwise map a teammate's branch onto a stale, owner-authored result.
 *
 * Errors are never cached either, so a transient failure fails closed once
 * and is retried on the next call.
 *
 * All `gh` invocations use `execFile` with an argument array (no shell) and a
 * resolved absolute binary path. Selectors supplied by the agent are validated
 * before they reach `gh`, so a value such as `--repo evil/evil` cannot be
 * smuggled in as a flag.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { logger } from '../../../utils/logger.js';
import {
  isValidGitHubLogin,
  type GitHubMutationIntent,
  type GitHubRepoRef,
  type OwnershipLookupResult,
} from './OwnershipPolicy.js';

// ── gh runner ──────────────────────────────────────────────────────

export interface GhCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GhRunOptions {
  cwd?: string;
  timeoutMs: number;
}

/** Runs `gh` with the given arguments. Injected so tests never spawn a process. */
export type GhRunner = (args: readonly string[], options: GhRunOptions) => Promise<GhCommandResult>;

/** Well-known install locations tried before falling back to a PATH search. */
const GH_CANDIDATE_PATHS = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
  '/home/linuxbrew/.linuxbrew/bin/gh',
];

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * `gh` shells out to `git` inside `cwd`, and git honours per-repository config
 * that can execute commands (`core.fsmonitor`, `core.hooksPath`). The hook
 * supplies `cwd`, so neutralise those keys for every child git process.
 * GIT_CONFIG_PARAMETERS entries are space-separated, single-quoted key=value.
 */
const GIT_CONFIG_HARDENING = ["'core.fsmonitor=false'", "'core.hooksPath=/dev/null'"].join(' ');

function hardenedGitConfigParameters(existing: string | undefined): string {
  return existing && existing.trim() !== '' ? `${existing} ${GIT_CONFIG_HARDENING}` : GIT_CONFIG_HARDENING;
}

/** Accept `cwd` only when it is an existing absolute directory; anything else is dropped (gh then runs without a repo). */
export function sanitizeWorkingDirectory(cwd: string | undefined): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  try {
    return statSync(cwd).isDirectory() ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to the `gh` binary.
 * Order: `DOLLHOUSE_GH_PATH` override → well-known locations → PATH entries.
 */
export function resolveGhBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.DOLLHOUSE_GH_PATH?.trim();
  if (override && isAbsolute(override) && isExecutable(override)) return override;

  for (const candidate of GH_CANDIDATE_PATHS) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'gh');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Process-wide memo of the `gh` binary resolution. `undefined` = not resolved
 * yet; `{ path: undefined }` = resolved and not found (a missing binary is not
 * re-probed on every call; `_resetGhBinaryCacheForTests()` clears it).
 */
let ghBinaryResolution: { path: string | undefined } | undefined;

function resolvedGhBinary(): string | undefined {
  if (!ghBinaryResolution) {
    const path = resolveGhBinary();
    ghBinaryResolution = { path };
    logger.debug('[OwnershipLookup] gh binary resolved', { path: path ?? null, fromOverride: Boolean(process.env.DOLLHOUSE_GH_PATH) });
  }
  return ghBinaryResolution.path;
}

/** Default runner: spawns the resolved `gh` binary without a shell. */
export const defaultGhRunner: GhRunner = (args, options) => {
  const binary = resolvedGhBinary();
  if (!binary) {
    return Promise.resolve({ stdout: '', stderr: 'gh CLI not found', exitCode: 127 });
  }
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
          GIT_CONFIG_PARAMETERS: hardenedGitConfigParameters(process.env.GIT_CONFIG_PARAMETERS),
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const withCode = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          const exitCode = typeof withCode.code === 'number' ? withCode.code : 1;
          const detail = withCode.killed ? `timed out after ${options.timeoutMs}ms` : (stderr || error.message);
          resolve({ stdout: String(stdout ?? ''), stderr: String(detail), exitCode });
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
      },
    );
  });
};

/** Test hook: forget the resolved binary path. */
export function _resetGhBinaryCacheForTests(): void {
  ghBinaryResolution = undefined;
}

// ── Selector validation ────────────────────────────────────────────

const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/;
const NUMBER_PATTERN = /^#?(\d{1,9})$/;
/** Git branch names: no leading dash (would be parsed as a flag), no control/space chars. */
const BRANCH_PATTERN = /^\w[\w./+-]{0,254}$/;

function repoArg(repo: GitHubRepoRef | undefined): string[] {
  return repo ? ['--repo', `${repo.owner}/${repo.name}`] : [];
}

function parseNumber(selector: string): number | undefined {
  const match = NUMBER_PATTERN.exec(selector);
  return match ? Number(match[1]) : undefined;
}

// ── Response parsing ───────────────────────────────────────────────

interface GhAuthorPayload {
  number?: unknown;
  author?: { login?: unknown };
  user?: { login?: unknown };
}

function extractAuthor(payload: GhAuthorPayload): { login: string; number?: number } | undefined {
  const login = payload.author?.login ?? payload.user?.login;
  if (!isValidGitHubLogin(login)) return undefined;
  const number = typeof payload.number === 'number' ? payload.number : undefined;
  return { login, number };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * gh messages that mean "no such PR", as opposed to auth, network or binary
 * failures. Scoped to the `gh pr view` / `gh pr list` commands we issue, whose
 * only 404 is the PR or repository itself.
 */
const PR_NOT_FOUND_PATTERN = /no pull requests found|Could not resolve to a|HTTP 404/i;
/** `gh api repos/{o}/{r}/issues/N`: the only resource on that path is the issue, so a 404 means it does not exist. */
const ISSUE_NOT_FOUND_PATTERN = /HTTP 404|Could not resolve to a/i;

function classifyFailure(result: GhCommandResult, context: string, notFound: RegExp): OwnershipLookupResult {
  const detail = result.stderr.trim().split('\n')[0] || `gh exited with code ${result.exitCode}`;
  if (notFound.test(result.stderr)) {
    return { status: 'not_found' };
  }
  return { status: 'error', message: `${context}: ${detail.slice(0, 200)}` };
}

// ── Resolver ───────────────────────────────────────────────────────

export interface OwnershipLookupContext {
  /** Working directory of the agent, used by `gh` to infer the repository and current branch. */
  cwd?: string;
}

export interface OwnershipResolver {
  /** Login of the authenticated `gh` user, used when no owner login is configured. */
  resolveOwnerLogin(context?: OwnershipLookupContext): Promise<string | undefined>;
  /** Who authored the PR/issue a mutation targets. */
  lookup(intent: GitHubMutationIntent, context?: OwnershipLookupContext): Promise<OwnershipLookupResult>;
}

export const DEFAULT_GH_TIMEOUT_MS = 8000;

export class GhOwnershipResolver implements OwnershipResolver {
  constructor(
    private readonly run: GhRunner = defaultGhRunner,
    private readonly timeoutMs: number = DEFAULT_GH_TIMEOUT_MS,
  ) {}

  private runOptions(context: OwnershipLookupContext): GhRunOptions {
    return { cwd: sanitizeWorkingDirectory(context.cwd), timeoutMs: this.timeoutMs };
  }

  async resolveOwnerLogin(context: OwnershipLookupContext = {}): Promise<string | undefined> {
    const result = await this.run(['api', 'user', '--jq', '.login'], this.runOptions(context));
    if (result.exitCode !== 0) {
      logger.warn('[OwnershipLookup] Could not resolve the authenticated gh user', { stderr: result.stderr.slice(0, 200) });
      return undefined;
    }
    const login = result.stdout.trim();
    return isValidGitHubLogin(login) ? login : undefined;
  }

  async lookup(intent: GitHubMutationIntent, context: OwnershipLookupContext = {}): Promise<OwnershipLookupResult> {
    switch (intent.kind) {
      case 'pull_request':
        return this.lookupPullRequest(intent, context);
      case 'issue':
        return this.lookupIssue(intent, context);
      case 'branch':
        return this.lookupBranch(intent, context);
      default:
        return { status: 'error', message: 'target cannot be identified' };
    }
  }

  private async lookupPullRequest(intent: GitHubMutationIntent, context: OwnershipLookupContext): Promise<OwnershipLookupResult> {
    const selectorArgs: string[] = [];
    let repo = intent.repo;
    if (intent.selector !== undefined) {
      const url = PR_URL_PATTERN.exec(intent.selector);
      const number = parseNumber(intent.selector);
      if (url) {
        repo = repo ?? { owner: url[1], name: url[2] };
        selectorArgs.push(url[3]);
      } else if (number !== undefined) {
        selectorArgs.push(String(number));
      } else if (BRANCH_PATTERN.test(intent.selector)) {
        selectorArgs.push(intent.selector);
      } else {
        return { status: 'error', message: `unsupported pull request selector '${intent.selector.slice(0, 80)}'` };
      }
    }
    const result = await this.run(
      ['pr', 'view', ...selectorArgs, '--json', 'author,number', ...repoArg(repo)],
      this.runOptions(context),
    );
    if (result.exitCode !== 0) return classifyFailure(result, 'gh pr view', PR_NOT_FOUND_PATTERN);
    const author = extractAuthor((parseJson(result.stdout) ?? {}) as GhAuthorPayload);
    return author
      ? { status: 'resolved', authorLogin: author.login, number: author.number }
      : { status: 'error', message: 'gh pr view returned no author' };
  }

  private async lookupIssue(intent: GitHubMutationIntent, context: OwnershipLookupContext): Promise<OwnershipLookupResult> {
    if (intent.selector === undefined) {
      return { status: 'error', message: 'issue selector missing' };
    }
    const url = ISSUE_URL_PATTERN.exec(intent.selector);
    const number = url ? Number(url[3]) : parseNumber(intent.selector);
    const repo = intent.repo ?? (url ? { owner: url[1], name: url[2] } : undefined);
    if (number === undefined) {
      return { status: 'error', message: `unsupported issue selector '${intent.selector.slice(0, 80)}'` };
    }
    const repoPath = repo ? `${repo.owner}/${repo.name}` : '{owner}/{repo}';
    const result = await this.run(
      ['api', `repos/${repoPath}/issues/${number}`, '--jq', '{number: .number, user: {login: .user.login}}'],
      this.runOptions(context),
    );
    if (result.exitCode !== 0) return classifyFailure(result, 'gh api issues', ISSUE_NOT_FOUND_PATTERN);
    const author = extractAuthor((parseJson(result.stdout) ?? {}) as GhAuthorPayload);
    return author
      ? { status: 'resolved', authorLogin: author.login, number: author.number ?? number }
      : { status: 'error', message: 'gh api returned no author' };
  }

  private async lookupBranch(intent: GitHubMutationIntent, context: OwnershipLookupContext): Promise<OwnershipLookupResult> {
    if (intent.branch === undefined) {
      // Current branch: let gh resolve the PR for HEAD in cwd.
      return this.lookupPullRequest({ ...intent, kind: 'pull_request', selector: undefined }, context);
    }
    if (!BRANCH_PATTERN.test(intent.branch)) {
      return { status: 'error', message: `unsupported branch name '${intent.branch.slice(0, 80)}'` };
    }
    const result = await this.run(
      ['pr', 'list', '--head', intent.branch, '--state', 'open', '--json', 'author,number', '--limit', '5', ...repoArg(intent.repo)],
      this.runOptions(context),
    );
    if (result.exitCode !== 0) return classifyFailure(result, 'gh pr list', PR_NOT_FOUND_PATTERN);
    const payload = parseJson(result.stdout);
    if (!Array.isArray(payload)) return { status: 'error', message: 'gh pr list returned unexpected output' };
    if (payload.length === 0) return { status: 'not_found' };
    const authors = payload
      .map(entry => extractAuthor(entry as GhAuthorPayload))
      .filter((author): author is { login: string; number?: number } => author !== undefined);
    if (authors.length !== payload.length) {
      return { status: 'error', message: 'gh pr list returned no author' };
    }
    const distinct = new Set(authors.map(author => author.login.toLowerCase()));
    if (distinct.size > 1) {
      // Several open PRs (e.g. from forks) share this head branch with different
      // authors; one author cannot represent them all, so fail closed.
      return { status: 'error', message: `branch '${intent.branch}' heads ${authors.length} open pull requests by different authors` };
    }
    return { status: 'resolved', authorLogin: authors[0].login, number: authors[0].number };
  }
}

// ── Cache ──────────────────────────────────────────────────────────

export interface OwnershipCacheOptions {
  /** TTL for resolved authors (default 30 minutes). */
  resolvedTtlMs?: number;
  /** TTL for "nothing to protect" results, kept short so a newly opened PR is noticed (default 60 s). */
  notFoundTtlMs?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
  now?: () => number;
}

interface CacheEntry {
  result: OwnershipLookupResult;
  expiresAt: number;
}

/**
 * Build the cache key for an intent, or `undefined` when the intent must not
 * be cached (anything that depends on the working directory's current branch).
 */
export function ownershipCacheKey(intent: GitHubMutationIntent): string | undefined {
  const repo = intent.repo ? `${intent.repo.owner}/${intent.repo.name}`.toLowerCase() : '';
  switch (intent.kind) {
    case 'pull_request':
      return intent.selector === undefined ? undefined : `pr|${repo}|${intent.selector}`;
    case 'issue':
      return intent.selector === undefined ? undefined : `issue|${repo}|${intent.selector}`;
    case 'branch':
      return intent.branch === undefined ? undefined : `branch|${repo}|${intent.branch}`;
    default:
      return undefined;
  }
}

/** Session-scoped, bounded, TTL-based cache of ownership lookups. */
export class OwnershipCache {
  private readonly sessions = new Map<string, Map<string, CacheEntry>>();
  private readonly resolvedTtlMs: number;
  private readonly notFoundTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;
  private readonly now: () => number;

  constructor(options: OwnershipCacheOptions = {}) {
    this.resolvedTtlMs = options.resolvedTtlMs ?? 30 * 60 * 1000;
    this.notFoundTtlMs = options.notFoundTtlMs ?? 60 * 1000;
    this.maxSessions = options.maxSessions ?? 64;
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? 256;
    this.now = options.now ?? Date.now;
  }

  get(sessionId: string, intent: GitHubMutationIntent): OwnershipLookupResult | undefined {
    const key = ownershipCacheKey(intent);
    if (!key) return undefined;
    const entries = this.sessions.get(sessionId);
    const entry = entries?.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      entries?.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /** Store a result. Errors and uncacheable intents are ignored. */
  set(sessionId: string, intent: GitHubMutationIntent, result: OwnershipLookupResult): void {
    if (result.status === 'error') return;
    const key = ownershipCacheKey(intent);
    if (!key) return;

    let entries = this.sessions.get(sessionId);
    if (!entries) {
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    if (entries.size >= this.maxEntriesPerSession && !entries.has(key)) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    const ttl = result.status === 'resolved' ? this.resolvedTtlMs : this.notFoundTtlMs;
    entries.set(key, { result, expiresAt: this.now() + ttl });
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    let total = 0;
    for (const entries of this.sessions.values()) total += entries.size;
    return total;
  }
}

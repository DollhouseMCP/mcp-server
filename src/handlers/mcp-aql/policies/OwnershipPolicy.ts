/**
 * Ownership Policy for GitHub pull requests and issues (Issue #3153)
 *
 * A pattern-only rule cannot express "agents may comment on, but not modify,
 * PRs and issues that belong to someone else". This module supplies the three
 * pure pieces that make such a rule enforceable:
 *
 * 1. Config — the owner identity, a teammate allow-list and the enforcement
 *    mode (`off`, `confirm`, `deny`).
 * 2. Detection — `detectGitHubMutations()` inspects a CLI tool call (raw Bash
 *    `gh`/`git`, or a GitHub MCP tool) and reports which PR, issue or branch
 *    it would modify. Comment and review actions are deliberately not reported.
 * 3. Decision — `decideOwnership()` turns an intent, a pre-decision ownership
 *    lookup result and the config into allow / confirm / deny.
 *
 * The lookup itself (gh api + per-session cache) and the hook wiring live in
 * separate modules so each piece can be tested in isolation. Everything here
 * is synchronous and side-effect free.
 *
 * Fail-closed rule: when the lookup errored, or the owner identity could not
 * be established, the decision is `confirm` (ask the human), never `allow`.
 *
 * @module
 */

import {
  integrationRequestParams,
  isIntegrationRequestEnvelope,
  normalizeMcpToolName,
} from '../../../security/IntegrationRequestEnvelope.js';

// ── Types ──────────────────────────────────────────────────────────

/**
 * How the policy reacts to a mutation of a PR/issue the agent does not own.
 * - `off`: policy inactive, every mutation falls through to the other layers
 * - `confirm`: ask the human before proceeding
 * - `deny`: block outright
 */
export type OwnershipPolicyMode = 'off' | 'confirm' | 'deny';

export const OWNERSHIP_POLICY_MODES: readonly OwnershipPolicyMode[] = ['off', 'confirm', 'deny'];

export interface OwnershipPolicyConfig {
  mode: OwnershipPolicyMode;
  /** GitHub login of the human who owns this session. Undefined = not yet known. */
  ownerLogin?: string;
  /** GitHub logins whose PRs and issues the agent may also modify. */
  teammates: readonly string[];
}

/** Raw, unvalidated config inputs (environment variables or a config file). */
export interface RawOwnershipPolicyConfig {
  mode?: string;
  ownerLogin?: string;
  /** Comma, semicolon or whitespace separated list of GitHub logins. */
  teammates?: string;
}

export type GitHubTargetKind =
  /** A specific pull request (by number, URL, branch, or the current branch when `selector` is absent). */
  | 'pull_request'
  /** A specific issue (by number or URL). */
  | 'issue'
  /** A remote branch (push target); protected only if an open PR uses it as head. */
  | 'branch'
  /** A mutation whose target cannot be identified statically (e.g. GraphQL mutations). */
  | 'unresolvable';

export interface GitHubRepoRef {
  owner: string;
  name: string;
}

/** What a tool call intends to modify on GitHub. */
export interface GitHubMutationIntent {
  kind: GitHubTargetKind;
  /** Short action label, e.g. `gh pr merge`, `git push`, `mcp:merge_pull_request`. */
  action: string;
  /** Explicit `--repo owner/name` / MCP `owner`+`repo`, when given. */
  repo?: GitHubRepoRef;
  /**
   * PR/issue selector exactly as the user typed it (number, URL or branch name).
   * Absent for `pull_request` means "the PR of the current branch".
   */
  selector?: string;
  /** Destination branch for `branch` intents. Absent means "the current branch". */
  branch?: string;
  /** The command segment or tool name the intent was extracted from. */
  source: string;
}

/** Outcome of the pre-decision ownership lookup. */
export type OwnershipLookupResult =
  | { status: 'resolved'; authorLogin: string; number?: number }
  /** No PR for that branch / no such issue — nothing to protect. */
  | { status: 'not_found' }
  /** The lookup could not be completed. The policy must fail closed. */
  | { status: 'error'; message: string };

export interface OwnershipDecision {
  behavior: 'allow' | 'confirm' | 'deny';
  reason: string;
  policySource: 'ownership_policy';
}

// ── Config ─────────────────────────────────────────────────────────

/** GitHub login: 1–39 alphanumerics or hyphens, optional `[bot]` suffix. */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const MAX_TEAMMATES = 100;

export const DEFAULT_OWNERSHIP_POLICY_MODE: OwnershipPolicyMode = 'confirm';

export function isValidGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN_PATTERN.test(value);
}

function normalizeLogin(login: string): string {
  return login.trim().replace(/^@/, '');
}

function parseMode(raw: string | undefined): OwnershipPolicyMode {
  const candidate = raw?.trim().toLowerCase();
  return OWNERSHIP_POLICY_MODES.find(mode => mode === candidate) ?? DEFAULT_OWNERSHIP_POLICY_MODE;
}

/**
 * Parse teammates from a delimited list. Invalid logins are dropped and
 * returned separately so the caller can log them without failing startup.
 */
export function parseTeammateList(raw: string | undefined): { teammates: string[]; rejected: string[] } {
  const teammates: string[] = [];
  const rejected: string[] = [];
  if (!raw) return { teammates, rejected };

  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,;]+/)) {
    const login = normalizeLogin(entry);
    if (!login) continue;
    if (!isValidGitHubLogin(login)) {
      rejected.push(login);
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key) || teammates.length >= MAX_TEAMMATES) continue;
    seen.add(key);
    teammates.push(login);
  }
  return { teammates, rejected };
}

/**
 * Build a validated config from raw inputs. Never throws: an unparseable mode
 * falls back to the default, an invalid owner login is treated as unset
 * (which makes the policy fail closed until an identity is resolved).
 */
export function parseOwnershipPolicyConfig(
  raw: RawOwnershipPolicyConfig,
): { config: OwnershipPolicyConfig; warnings: string[] } {
  const warnings: string[] = [];
  const mode = parseMode(raw.mode);
  if (raw.mode && raw.mode.trim() !== '' && !OWNERSHIP_POLICY_MODES.includes(raw.mode.trim().toLowerCase() as OwnershipPolicyMode)) {
    warnings.push(`Unknown ownership policy mode '${raw.mode}', using '${mode}'`);
  }

  let ownerLogin: string | undefined;
  const rawOwner = raw.ownerLogin === undefined ? '' : normalizeLogin(raw.ownerLogin);
  if (rawOwner !== '') {
    if (isValidGitHubLogin(rawOwner)) {
      ownerLogin = rawOwner;
    } else {
      warnings.push(`Ignoring invalid owner login '${rawOwner}'`);
    }
  }

  const { teammates, rejected } = parseTeammateList(raw.teammates);
  for (const login of rejected) {
    warnings.push(`Ignoring invalid teammate login '${login}'`);
  }

  return { config: { mode, ownerLogin, teammates }, warnings };
}

/** Whether `login` is the owner or a listed teammate (case-insensitive). */
export function isTrustedAuthor(login: string, config: OwnershipPolicyConfig): boolean {
  const needle = login.trim().toLowerCase();
  if (!needle) return false;
  if (config.ownerLogin && config.ownerLogin.toLowerCase() === needle) return true;
  return config.teammates.some(teammate => teammate.toLowerCase() === needle);
}

// ── Decision ───────────────────────────────────────────────────────

function describeTarget(intent: GitHubMutationIntent): string {
  const repo = intent.repo ? ` in ${intent.repo.owner}/${intent.repo.name}` : '';
  switch (intent.kind) {
    case 'pull_request':
      return intent.selector ? `pull request ${intent.selector}${repo}` : `the current branch's pull request${repo}`;
    case 'issue':
      return `issue ${intent.selector ?? '?'}${repo}`;
    case 'branch':
      return intent.branch ? `branch '${intent.branch}'${repo}` : `the current branch${repo}`;
    default:
      return 'a GitHub resource that could not be identified';
  }
}

function restrictedDecision(intent: GitHubMutationIntent, authorLogin: string, config: OwnershipPolicyConfig): OwnershipDecision {
  const behavior = config.mode === 'deny' ? 'deny' : 'confirm';
  const verb = behavior === 'deny' ? 'blocked' : 'requires confirmation';
  return {
    behavior,
    reason: `${intent.action} on ${describeTarget(intent)} ${verb}: authored by '${authorLogin}', not by the session owner` +
      (config.ownerLogin ? ` '${config.ownerLogin}'` : '') +
      '. Agents may comment or review on others\' work but must not modify it (ownership policy).',
    policySource: 'ownership_policy',
  };
}

/**
 * Decide whether a GitHub mutation may proceed.
 *
 * Precedence:
 * 1. mode `off` → allow
 * 2. lookup error, unknown owner identity, or unresolvable target → confirm (fail closed)
 * 3. nothing found to protect → allow
 * 4. author trusted → allow; otherwise mode (`confirm` | `deny`)
 */
export function decideOwnership(
  intent: GitHubMutationIntent,
  lookup: OwnershipLookupResult,
  config: OwnershipPolicyConfig,
): OwnershipDecision {
  const policySource = 'ownership_policy' as const;
  if (config.mode === 'off') {
    return { behavior: 'allow', reason: 'Ownership policy is off', policySource };
  }
  if (intent.kind === 'unresolvable') {
    return {
      behavior: 'confirm',
      reason: `${intent.action} targets ${describeTarget(intent)}; confirm before modifying GitHub state (ownership policy fail-closed)`,
      policySource,
    };
  }
  if (!config.ownerLogin) {
    return {
      behavior: 'confirm',
      reason: `${intent.action} on ${describeTarget(intent)} requires confirmation: the session owner's GitHub login is not configured or could not be resolved (ownership policy fail-closed)`,
      policySource,
    };
  }
  if (lookup.status === 'error') {
    return {
      behavior: 'confirm',
      reason: `${intent.action} on ${describeTarget(intent)} requires confirmation: ownership lookup failed (${lookup.message}) (ownership policy fail-closed)`,
      policySource,
    };
  }
  if (lookup.status === 'not_found') {
    return {
      behavior: 'allow',
      reason: `${intent.action} on ${describeTarget(intent)}: no pull request or issue found to protect`,
      policySource,
    };
  }
  if (isTrustedAuthor(lookup.authorLogin, config)) {
    return {
      behavior: 'allow',
      reason: `${intent.action} on ${describeTarget(intent)} allowed: authored by trusted login '${lookup.authorLogin}'`,
      policySource,
    };
  }
  return restrictedDecision(intent, lookup.authorLogin, config);
}

// ── Detection: shell tokenizing ────────────────────────────────────

const MAX_COMMAND_LENGTH = 4000;

/**
 * Split a shell command line into simple-command segments, honouring quotes.
 * Separators: `;`, newline, `&&`, `||`, `|`, `&`, parentheses, backticks and
 * `$(`. Splitting on sub-shell openers means `echo $(gh pr merge 1)` yields a
 * `gh pr merge 1` segment — over-splitting can only add intents, never hide one.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  const text = command.slice(0, MAX_COMMAND_LENGTH);

  const flush = (): void => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        current += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      flush();
      i++;
      continue;
    }
    if (';\n|&()`'.includes(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return segments;
}

/** Tokenize one simple command, removing quotes and honouring backslash escapes. */
export function tokenizeShellWords(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | '\'' | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < segment.length) {
      current += segment[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

const COMMAND_WRAPPERS = new Set(['command', 'env', 'nohup', 'time', 'builtin', 'exec']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop leading `VAR=value` assignments and transparent wrappers such as `env` or `nohup`. */
function stripLeadingWrappers(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (ENV_ASSIGNMENT.test(token) || COMMAND_WRAPPERS.has(token)) {
      index++;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// ── Detection: gh ──────────────────────────────────────────────────

/** `gh pr` subcommands that modify the PR itself. `comment` and `review` are intentionally absent. */
const GH_PR_MUTATIONS = new Set(['merge', 'update-branch', 'edit', 'close', 'ready', 'reopen', 'lock', 'unlock']);
/** `gh issue` subcommands that modify the issue itself. `comment` is intentionally absent. */
const GH_ISSUE_MUTATIONS = new Set(['edit', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin']);

/** Flags that consume the following token (so it is not mistaken for a selector). */
const GH_VALUE_FLAGS = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-m', '--match-head-commit',
  '-A', '--author', '-s', '--subject', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee',
  '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project', '--milestone', '--base',
  '--head', '-r', '--reason', '-c', '--comment', '--undo', '-H', '--hostname', '-q', '--jq', '--template',
]);

function parseRepoRef(value: string | undefined): GitHubRepoRef | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, name] = parts.slice(-2);
  if (!isValidGitHubLogin(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return undefined;
  return { owner, name };
}

/** `gh api` flags that consume the following token. */
const GH_API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq',
  '-t', '--template', '-p', '--preview', '--hostname', '--cache',
]);

interface GhArgs {
  repo?: GitHubRepoRef;
  positionals: string[];
  /** Flag → every value it was given (empty array for boolean flags). */
  flags: Map<string, string[]>;
}

/** Separate flags from positionals for a `gh <group> <sub> ...` argument list. */
function parseGhArgs(args: string[], valueFlags: ReadonlySet<string> = GH_VALUE_FLAGS): GhArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let repo: GitHubRepoRef | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined && valueFlags.has(flag) && i + 1 < args.length) {
      value = args[++i];
    }
    const values = flags.get(flag) ?? [];
    if (value !== undefined) values.push(value);
    flags.set(flag, values);
    if (flag === '-R' || flag === '--repo') {
      repo = parseRepoRef(value);
    }
  }
  return { repo, positionals, flags };
}

function flagValues(flags: GhArgs['flags'], ...names: string[]): string[] {
  return names.flatMap(name => flags.get(name) ?? []);
}

function detectGhPrOrIssue(group: 'pr' | 'issue', rest: string[], source: string): GitHubMutationIntent | undefined {
  const sub = rest[0];
  if (!sub) return undefined;
  const mutations = group === 'pr' ? GH_PR_MUTATIONS : GH_ISSUE_MUTATIONS;
  if (!mutations.has(sub)) return undefined;

  const { repo, positionals } = parseGhArgs(rest.slice(1));
  const kind: GitHubTargetKind = group === 'pr' ? 'pull_request' : 'issue';
  // `gh issue edit 1 2 3` can take several selectors; report each one.
  const selector = positionals[0];
  if (group === 'issue' && !selector) {
    // gh issue mutations always need a selector; nothing to protect without one.
    return undefined;
  }
  return { kind, action: `gh ${group} ${sub}`, repo, selector, source };
}

const GH_API_MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** REST sub-resources that are comment/review surfaces and therefore allowed. */
const GH_API_ALLOWED_SUBRESOURCES = new Set(['comments', 'reviews']);
const GH_API_TARGET_PATH = /^(?:https?:\/\/api\.github\.com\/)?\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/([^/?]+))?/;

function detectGhApi(rest: string[], source: string): GitHubMutationIntent | undefined {
  const { positionals, flags } = parseGhArgs(rest, GH_API_VALUE_FLAGS);
  const endpoint = positionals[0];
  if (!endpoint) return undefined;

  const explicitMethod = flagValues(flags, '-X', '--method').at(-1)?.toUpperCase();
  const impliesPost = ['-f', '-F', '--field', '--raw-field', '--input'].some(flag => flags.has(flag));
  const method = explicitMethod ?? (impliesPost ? 'POST' : 'GET');
  if (!GH_API_MUTATING_METHODS.has(method)) return undefined;

  if (endpoint === 'graphql') {
    const query = flagValues(flags, '-f', '--raw-field', '-F', '--field').join(' ');
    if (/\bmutation\b/i.test(query) || flags.has('--input')) {
      return { kind: 'unresolvable', action: 'gh api graphql mutation', source };
    }
    return undefined;
  }

  const match = GH_API_TARGET_PATH.exec(endpoint);
  if (!match) return undefined;
  const [, owner, name, resource, number, subresource] = match;
  if (subresource && GH_API_ALLOWED_SUBRESOURCES.has(subresource)) return undefined;
  const repo = parseRepoRef(`${owner}/${name}`);
  const kind: GitHubTargetKind = resource === 'pulls' ? 'pull_request' : 'issue';
  return { kind, action: `gh api ${method} ${resource}/${number}${subresource ? `/${subresource}` : ''}`, repo, selector: number, source };
}

function detectGh(tokens: string[], source: string): GitHubMutationIntent | undefined {
  const group = tokens[1];
  const rest = tokens.slice(2);
  if (group === 'pr' || group === 'issue') return detectGhPrOrIssue(group, rest, source);
  if (group === 'api') return detectGhApi(rest, source);
  return undefined;
}

// ── Detection: git push ────────────────────────────────────────────

/** `git push` options that take a value as the next token. */
const GIT_PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo', '--recurse-submodules', '--signed', '--force-with-lease', '--force-if-includes']);
/** Global git options (before the subcommand) that take a value. */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function findGitSubcommandIndex(tokens: string[]): number {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) return i;
    if (GIT_GLOBAL_VALUE_FLAGS.has(token) && !token.includes('=')) i++;
  }
  return -1;
}

function refspecDestination(refspec: string): string | undefined {
  const spec = refspec.replace(/^\+/, '');
  const colon = spec.indexOf(':');
  const destination = colon === -1 ? spec : spec.slice(colon + 1);
  if (destination === '' || destination.startsWith('refs/tags/')) return undefined;
  if (destination === 'HEAD') return undefined; // current branch — resolved at lookup time
  return destination.replace(/^refs\/heads\//, '');
}

function detectGitPush(tokens: string[], source: string): GitHubMutationIntent[] {
  const pushIndex = findGitSubcommandIndex(tokens);
  if (pushIndex === -1 || tokens[pushIndex] !== 'push') return [];

  const positionals: string[] = [];
  let deleting = false;
  let tagsOnly = false;
  for (let i = pushIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (token === '-d' || token === '--delete') deleting = true;
    if (token === '--tags') tagsOnly = true;
    if (GIT_PUSH_VALUE_FLAGS.has(token) && i + 1 < tokens.length) i++;
  }

  const refspecs = positionals.slice(1);
  if (tagsOnly && refspecs.length === 0) return [];
  const action = deleting ? 'git push --delete' : 'git push';
  if (refspecs.length === 0) {
    // Bare `git push` / `git push origin`: pushes the current branch.
    return [{ kind: 'branch', action, branch: undefined, source }];
  }

  const intents: GitHubMutationIntent[] = [];
  const seen = new Set<string>();
  for (const refspec of refspecs) {
    const branch = deleting ? refspec.replace(/^refs\/heads\//, '') : refspecDestination(refspec);
    if (!deleting && refspec === 'HEAD') {
      intents.push({ kind: 'branch', action, branch: undefined, source });
      continue;
    }
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    intents.push({ kind: 'branch', action, branch, source });
  }
  return intents;
}

// ── Detection: Bash entry point ────────────────────────────────────

function detectBashSegment(segment: string): GitHubMutationIntent[] {
  const tokens = stripLeadingWrappers(tokenizeShellWords(segment));
  if (tokens.length === 0) return [];
  const executable = basename(tokens[0]);
  if (executable === 'gh') {
    const intent = detectGh(tokens, segment);
    return intent ? [intent] : [];
  }
  if (executable === 'git') {
    return detectGitPush(tokens, segment);
  }
  return [];
}

function detectBashMutations(command: string): GitHubMutationIntent[] {
  const intents: GitHubMutationIntent[] = [];
  for (const segment of splitShellSegments(command)) {
    intents.push(...detectBashSegment(segment));
  }
  return intents;
}

// ── Detection: GitHub MCP tools ────────────────────────────────────

/**
 * GitHub MCP server tools that modify a PR, issue or branch, keyed by the
 * tool name without its `mcp__<server>__` prefix. Comment and review tools
 * (`add_issue_comment`, `create_pull_request_review`, ...) are not listed.
 */
const MCP_PR_MUTATIONS = new Set(['merge_pull_request', 'update_pull_request', 'update_pull_request_branch']);
const MCP_ISSUE_MUTATIONS = new Set(['update_issue']);
const MCP_BRANCH_MUTATIONS = new Set(['push_files', 'create_or_update_file', 'delete_file']);

function readString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  }
  return undefined;
}

function detectMcpMutation(toolName: string, input: Record<string, unknown>): GitHubMutationIntent | undefined {
  const parts = toolName.split('__');
  const tool = parts.at(-1) ?? '';
  const owner = readString(input, 'owner');
  const name = readString(input, 'repo');
  // Every GitHub MCP write tool requires owner+repo; without them this is not a GitHub call.
  if (!owner || !name) return undefined;
  const repo = parseRepoRef(`${owner}/${name}`);
  if (!repo) return undefined;
  const source = toolName;
  const action = `mcp:${tool}`;

  if (MCP_PR_MUTATIONS.has(tool)) {
    const selector = readString(input, 'pullNumber', 'pull_number', 'number');
    return selector ? { kind: 'pull_request', action, repo, selector, source } : { kind: 'unresolvable', action, repo, source };
  }
  if (MCP_ISSUE_MUTATIONS.has(tool) || (tool === 'issue_write' && readString(input, 'method') !== 'create')) {
    const selector = readString(input, 'issue_number', 'issueNumber', 'number');
    return selector ? { kind: 'issue', action, repo, selector, source } : { kind: 'unresolvable', action, repo, source };
  }
  if (MCP_BRANCH_MUTATIONS.has(tool)) {
    const branch = readString(input, 'branch');
    return branch ? { kind: 'branch', action, repo, branch, source } : { kind: 'unresolvable', action, repo, source };
  }
  return undefined;
}

// ── Detection: Dollhouse integration_request (MCP-AQL adapter) ─────

/**
 * Detect mutations issued through Dollhouse's own GitHub integration adapter
 * (`integration_request` with `{ provider, method, path }`), whether called
 * directly or wrapped in an `mcp_aql_execute` envelope.
 */
function detectIntegrationRequest(toolName: string, toolInput: Record<string, unknown>): GitHubMutationIntent | undefined {
  const normalizedName = normalizeMcpToolName(toolName);
  let params: Record<string, unknown> | null = null;
  if (normalizedName === 'integration_request') {
    params = toolInput;
  } else if (['mcp_aql_execute', 'mcp_aql'].includes(normalizedName) && isIntegrationRequestEnvelope(toolInput)) {
    params = integrationRequestParams(toolInput);
  }
  if (!params) return undefined;

  const provider = typeof params.provider === 'string' ? params.provider.toLowerCase() : '';
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
  const path = typeof params.path === 'string' ? params.path : '';
  if (!provider.includes('github') || !GH_API_MUTATING_METHODS.has(method) || !path) return undefined;

  const match = GH_API_TARGET_PATH.exec(path);
  if (!match) return undefined;
  const [, owner, name, resource, number, subresource] = match;
  if (subresource && GH_API_ALLOWED_SUBRESOURCES.has(subresource)) return undefined;
  const repo = parseRepoRef(`${owner}/${name}`);
  const kind: GitHubTargetKind = resource === 'pulls' ? 'pull_request' : 'issue';
  return { kind, action: `integration_request ${method} ${resource}/${number}`, repo, selector: number, source: toolName };
}

// ── Public detection entry point ───────────────────────────────────

/**
 * Report every PR/issue/branch mutation a CLI tool call would perform.
 * Returns an empty array for reads, comments, reviews and non-GitHub tools.
 */
export function detectGitHubMutations(toolName: string, toolInput: Record<string, unknown>): GitHubMutationIntent[] {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return command ? detectBashMutations(command) : [];
  }
  const integration = detectIntegrationRequest(toolName, toolInput);
  if (integration) return [integration];
  if (toolName.startsWith('mcp__')) {
    const intent = detectMcpMutation(toolName, toolInput);
    return intent ? [intent] : [];
  }
  return [];
}

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
 * Detection prefers over-reporting to under-reporting: an unclosed quote, a
 * sub-shell or a `--input` read idiom may produce an extra intent, which at
 * worst costs one confirmation prompt — never a silent allow.
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
export const MAX_TEAMMATES = 100;

export const DEFAULT_OWNERSHIP_POLICY_MODE: OwnershipPolicyMode = 'confirm';

export function isValidGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN_PATTERN.test(value);
}

function normalizeLogin(login: string): string {
  return login.trim().replace(/^@/, '');
}

function isOwnershipPolicyMode(value: string): value is OwnershipPolicyMode {
  return (OWNERSHIP_POLICY_MODES as readonly string[]).includes(value);
}

export interface ParsedTeammateList {
  teammates: string[];
  /** Entries dropped because they are not valid GitHub logins. */
  rejected: string[];
  /** Valid entries dropped because the list exceeded MAX_TEAMMATES. */
  truncated: number;
}

/**
 * Parse teammates from a delimited list. Invalid logins are dropped and
 * returned separately so the caller can log them without failing startup.
 */
export function parseTeammateList(raw: string | undefined): ParsedTeammateList {
  const teammates: string[] = [];
  const rejected: string[] = [];
  let truncated = 0;
  if (!raw) return { teammates, rejected, truncated };

  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,;]+/)) {
    const login = normalizeLogin(entry);
    if (!login) continue;
    if (!isValidGitHubLogin(login)) {
      rejected.push(login);
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (teammates.length >= MAX_TEAMMATES) {
      truncated++;
      continue;
    }
    teammates.push(login);
  }
  return { teammates, rejected, truncated };
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

  const rawMode = raw.mode?.trim().toLowerCase() ?? '';
  let mode: OwnershipPolicyMode = DEFAULT_OWNERSHIP_POLICY_MODE;
  if (isOwnershipPolicyMode(rawMode)) {
    mode = rawMode;
  } else if (rawMode !== '') {
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

  const { teammates, rejected, truncated } = parseTeammateList(raw.teammates);
  for (const login of rejected) {
    warnings.push(`Ignoring invalid teammate login '${login}'`);
  }
  if (truncated > 0) {
    warnings.push(`Teammate list exceeds ${MAX_TEAMMATES} entries; ignoring the last ${truncated}`);
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
 * 1. mode `off` → allow (short-circuits everything below, including unresolvable targets)
 * 2. unresolvable target, unknown owner identity, or lookup error → confirm (fail closed)
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
type QuoteChar = '"' | '\'';

/** Characters that end a simple command outside quotes (sub-shell openers included). */
const SEGMENT_SEPARATORS = new Set([';', '\n', '|', '&', '(', ')', '`']);

/**
 * Character-by-character scanner shared by the segmenter and the word
 * tokenizer: tracks quote state and backslash escapes so each consumer only
 * has to say what to do with a plain, unquoted character.
 */
interface ShellScanHandlers {
  /** Keep quote marks and escaping backslashes in the output (segmenter) or drop them (tokenizer). */
  keepQuotes: boolean;
  /** Receives literal characters: quoted content, escaped characters and (when kept) the quote marks. */
  onLiteral: (ch: string) => void;
  /** Receives an unquoted, unescaped character; returns extra characters consumed (1 for `$(`). */
  onPlain: (ch: string, index: number) => number;
  /** Called when a quote opens or an escape is seen, so the tokenizer can start an (possibly empty) token. */
  onQuoteBoundary?: () => void;
}

class ShellScanner {
  private quote: QuoteChar | null = null;
  constructor(private readonly text: string) {}

  /**
   * Visit every character, routing it to the handlers. An unclosed quote
   * simply ends at EOF: whatever was accumulated is kept (over-detection is
   * preferred to dropping a possible mutation).
   */
  scan(handlers: ShellScanHandlers): void {
    for (let i = 0; i < this.text.length; i++) {
      const ch = this.text[i];
      if (this.quote) {
        i += this.consumeQuoted(ch, i, handlers);
        continue;
      }
      const special = this.consumeSpecial(ch, i, handlers);
      i += special ?? handlers.onPlain(ch, i);
    }
  }

  /** Quote openers and escapes outside quotes. Returns extra characters consumed, or null when `ch` is plain. */
  private consumeSpecial(ch: string, index: number, handlers: ShellScanHandlers): number | null {
    if (ch === '"' || ch === '\'') {
      this.quote = ch;
      handlers.onQuoteBoundary?.();
      if (handlers.keepQuotes) handlers.onLiteral(ch);
      return 0;
    }
    if (ch === '\\' && index + 1 < this.text.length) {
      if (handlers.keepQuotes) handlers.onLiteral(ch);
      handlers.onLiteral(this.text[index + 1]);
      handlers.onQuoteBoundary?.();
      return 1;
    }
    return null;
  }

  /** Handle one character inside quotes. Returns extra characters consumed. */
  private consumeQuoted(ch: string, index: number, handlers: ShellScanHandlers): number {
    if (ch === this.quote) {
      this.quote = null;
      if (handlers.keepQuotes) handlers.onLiteral(ch);
      return 0;
    }
    if (ch === '\\' && this.quote === '"' && index + 1 < this.text.length) {
      if (handlers.keepQuotes) handlers.onLiteral(ch);
      handlers.onLiteral(this.text[index + 1]);
      return 1;
    }
    handlers.onLiteral(ch);
    return 0;
  }
}

/**
 * Split a shell command line into simple-command segments, honouring quotes.
 * Separators: `;`, newline, `&&`, `||`, `|`, `&`, parentheses, backticks and
 * `$(`. Splitting on sub-shell openers means `echo $(gh pr merge 1)` yields a
 * `gh pr merge 1` segment — over-splitting can only add intents, never hide one.
 */
export function splitShellSegments(command: string): string[] {
  const text = command.slice(0, MAX_COMMAND_LENGTH);
  const segments: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };
  const append = (ch: string): void => {
    current += ch;
  };

  new ShellScanner(text).scan({
    keepQuotes: true,
    onLiteral: append,
    onPlain: (ch, i) => {
      if (ch === '$' && text[i + 1] === '(') {
        flush();
        return 1;
      }
      if (SEGMENT_SEPARATORS.has(ch)) {
        flush();
        return 0;
      }
      current += ch;
      return 0;
    },
  });
  flush();
  return segments;
}

/** Tokenize one simple command, removing quotes and honouring backslash escapes. */
export function tokenizeShellWords(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  const append = (ch: string): void => {
    current += ch;
    inToken = true;
  };
  const markToken = (): void => {
    inToken = true;
  };

  new ShellScanner(segment).scan({
    keepQuotes: false,
    onLiteral: append,
    onQuoteBoundary: markToken,
    onPlain: (ch) => {
      if (/\s/.test(ch)) {
        if (inToken) tokens.push(current);
        current = '';
        inToken = false;
      } else {
        append(ch);
      }
      return 0;
    },
  });
  if (inToken) tokens.push(current);
  return tokens;
}

const COMMAND_WRAPPERS = new Set(['command', 'env', 'nohup', 'time', 'builtin', 'exec']);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** Drop leading `VAR=value` assignments and transparent wrappers such as `env` or `nohup`. */
function stripLeadingWrappers(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && (ENV_ASSIGNMENT.test(tokens[index]) || COMMAND_WRAPPERS.has(tokens[index]))) {
    index++;
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

/** `gh api` flags that consume the following token. */
const GH_API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq',
  '-t', '--template', '-p', '--preview', '--hostname', '--cache',
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

interface GhArgs {
  repo?: GitHubRepoRef;
  positionals: string[];
  /** Flag → every value it was given (empty array for boolean flags). */
  flags: Map<string, string[]>;
}

/** Split `--flag=value` / `--flag value` into its parts, consuming the next token when needed. */
function readFlag(args: string[], index: number, valueFlags: ReadonlySet<string>): { flag: string; value?: string; consumed: number } {
  const arg = args[index];
  const eq = arg.indexOf('=');
  if (eq !== -1) return { flag: arg.slice(0, eq), value: arg.slice(eq + 1), consumed: 0 };
  if (valueFlags.has(arg) && index + 1 < args.length) return { flag: arg, value: args[index + 1], consumed: 1 };
  return { flag: arg, consumed: 0 };
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
    const { flag, value, consumed } = readFlag(args, i, valueFlags);
    i += consumed;
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
  // A PR mutation without a selector targets the current branch's PR; an issue
  // mutation always needs a selector, so nothing can be protected without one.
  const selector = positionals[0];
  if (group === 'issue' && !selector) {
    return undefined;
  }
  return { kind, action: `gh ${group} ${sub}`, repo, selector, source };
}

const GH_API_MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** REST sub-resources that are comment/review surfaces and therefore allowed. */
const GH_API_ALLOWED_SUBRESOURCES = new Set(['comments', 'reviews']);
const GH_API_TARGET_PATH = /^(?:https?:\/\/api\.github\.com\/)?\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)(?:\/([^/?]+))?/;
/** Flags that make `gh api` default to POST when no `-X` is given. `--input` can also carry a read body; over-detection is accepted. */
const GH_API_BODY_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];

/** Build a pull_request / issue intent from a REST path such as `repos/o/r/pulls/5/merge`. */
function intentFromRestPath(path: string, action: string, source: string): GitHubMutationIntent | undefined {
  const match = GH_API_TARGET_PATH.exec(path);
  if (!match) return undefined;
  const [, owner, name, resource, number, subresource] = match;
  if (subresource && GH_API_ALLOWED_SUBRESOURCES.has(subresource)) return undefined;
  const repo = parseRepoRef(`${owner}/${name}`);
  const kind: GitHubTargetKind = resource === 'pulls' ? 'pull_request' : 'issue';
  const suffix = subresource ? `/${subresource}` : '';
  return { kind, action: `${action} ${resource}/${number}${suffix}`, repo, selector: number, source };
}

function detectGhApi(rest: string[], source: string): GitHubMutationIntent | undefined {
  const { positionals, flags } = parseGhArgs(rest, GH_API_VALUE_FLAGS);
  const endpoint = positionals[0];
  if (!endpoint) return undefined;

  const explicitMethod = flagValues(flags, '-X', '--method').at(-1)?.toUpperCase();
  const impliesPost = GH_API_BODY_FLAGS.some(flag => flags.has(flag));
  const method = explicitMethod ?? (impliesPost ? 'POST' : 'GET');
  if (!GH_API_MUTATING_METHODS.has(method)) return undefined;

  if (endpoint === 'graphql') {
    const query = flagValues(flags, '-f', '--raw-field', '-F', '--field').join(' ');
    if (/\bmutation\b/i.test(query) || flags.has('--input')) {
      return { kind: 'unresolvable', action: 'gh api graphql mutation', source };
    }
    return undefined;
  }
  return intentFromRestPath(endpoint, `gh api ${method}`, source);
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

interface PushArgs {
  /** Remote and refspecs, in order. */
  positionals: string[];
  deleting: boolean;
  tagsOnly: boolean;
}

function parsePushArgs(tokens: string[], pushIndex: number): PushArgs {
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
  return { positionals, deleting, tagsOnly };
}

interface RefspecTarget {
  /** Destination branch, or undefined for the current branch (`HEAD`). */
  branch?: string;
  deleting: boolean;
}

/**
 * Resolve what a refspec pushes to. Returns null when the refspec is not a
 * branch (tags) and therefore cannot be a PR head.
 */
function refspecTarget(refspec: string, deleting: boolean): RefspecTarget | null {
  const stripBranchPrefix = (ref: string): string => ref.replace(/^refs\/heads\//, '');
  if (deleting) return { branch: stripBranchPrefix(refspec), deleting: true };

  const spec = refspec.replace(/^\+/, '');
  const colon = spec.indexOf(':');
  const source = colon === -1 ? spec : spec.slice(0, colon);
  const destination = colon === -1 ? spec : spec.slice(colon + 1);
  if (destination === '' || destination.startsWith('refs/tags/')) return null;
  // `:branch` (empty source) is the legacy spelling of `--delete branch`.
  if (colon !== -1 && source === '') return { branch: stripBranchPrefix(destination), deleting: true };
  if (destination === 'HEAD') return { branch: undefined, deleting: false };
  return { branch: stripBranchPrefix(destination), deleting: false };
}

function detectGitPush(tokens: string[], source: string): GitHubMutationIntent[] {
  const pushIndex = findGitSubcommandIndex(tokens);
  if (pushIndex === -1 || tokens[pushIndex] !== 'push') return [];

  const { positionals, deleting, tagsOnly } = parsePushArgs(tokens, pushIndex);
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    // Bare `git push` / `git push origin`: pushes the current branch.
    return tagsOnly ? [] : [{ kind: 'branch', action: 'git push', branch: undefined, source }];
  }

  const intents: GitHubMutationIntent[] = [];
  const seen = new Set<string>();
  for (const refspec of refspecs) {
    const target = refspecTarget(refspec, deleting);
    if (!target) continue;
    const key = target.branch ?? '@current';
    if (seen.has(key)) continue;
    seen.add(key);
    intents.push({ kind: 'branch', action: target.deleting ? 'git push --delete' : 'git push', branch: target.branch, source });
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

/** Unwrap `integration_request` params from a direct call or an `mcp_aql_execute` envelope. */
function integrationRequestOf(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> | null {
  const normalizedName = normalizeMcpToolName(toolName);
  if (normalizedName === 'integration_request') return toolInput;
  if (['mcp_aql_execute', 'mcp_aql'].includes(normalizedName) && isIntegrationRequestEnvelope(toolInput)) {
    return integrationRequestParams(toolInput);
  }
  return null;
}

/**
 * Detect mutations issued through Dollhouse's own GitHub integration adapter
 * (`integration_request` with `{ provider, method, path }`).
 */
function detectIntegrationRequest(toolName: string, toolInput: Record<string, unknown>): GitHubMutationIntent | undefined {
  const params = integrationRequestOf(toolName, toolInput);
  if (!params) return undefined;

  const provider = typeof params.provider === 'string' ? params.provider.toLowerCase() : '';
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
  const path = typeof params.path === 'string' ? params.path : '';
  if (!provider.includes('github') || !GH_API_MUTATING_METHODS.has(method) || !path) return undefined;
  return intentFromRestPath(path, `integration_request ${method}`, toolName);
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

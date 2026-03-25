/**
 * Tool Classification for CLI-Level Permission Prompts
 *
 * Provides static classification of Claude Code CLI tool calls and
 * evaluation against active element gatekeeper policies.
 *
 * Used by the permission_prompt operation (Issue #625) to evaluate
 * --permission-prompt-tool requests without requiring LLM evaluation.
 *
 * @module
 */

import { matchesPattern } from '../../../utils/patternMatcher.js';
import type { ActiveElement } from './ElementPolicies.js';
import type { RiskAssessment } from '../GatekeeperTypes.js';

// ── Types ──────────────────────────────────────────────────────────

export type ToolRiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked';

export interface ToolClassificationResult {
  riskLevel: ToolRiskLevel;
  /** 'allow' = auto-approve, 'deny' = auto-reject, 'evaluate' = check element policies */
  behavior: 'allow' | 'deny' | 'evaluate';
  reason: string;
}

export interface PolicyEvaluationContext {
  evaluatedElements: Array<{
    type: string;
    name: string;
    matched?: 'allowPatterns' | 'confirmPatterns' | 'denyPatterns';
    matchedPattern?: string;
    matchedTarget?: string;
  }>;
  decisionChain: string[];
}

export interface CliToolPolicyResult {
  behavior: 'allow' | 'deny' | 'evaluate' | 'confirm';
  message?: string;
  confirmSource?: string;
  policyContext?: PolicyEvaluationContext;
}

// ── Gatekeeper-Essential Operations ──────────────────────────────────

/**
 * MCP-AQL operations that must NEVER be blocked by permission_prompt,
 * even if element denyPatterns would match the MCP tool name.
 *
 * These are essential for the Gatekeeper flow itself. Blocking them
 * would prevent the human-in-the-loop approval path from functioning
 * (e.g., a denyPattern of 'mcp__DollhouseMCP*' would block confirm_operation).
 */
const GATEKEEPER_ESSENTIAL_OPERATIONS = new Set([
  'confirm_operation',
  'verify_challenge',
  'permission_prompt',
  'introspect',
  'get_active_elements',
  'get_execution_state',
  'get_gathered_data',
  'approve_cli_permission',       // Issue #625 Phase 3
  'get_pending_cli_approvals',    // Issue #625 Phase 3
]);

/**
 * MCP-AQL operations that are inherently read-only.
 *
 * These auto-allow in permission_prompt (no element policy evaluation).
 * The Gatekeeper (Layer 2) still applies its own per-operation policies,
 * so this doesn't bypass server-side access control — it just avoids
 * unnecessary 'evaluate' round-trips for operations that can't modify state.
 */
const SAFE_MCP_OPERATIONS = new Set([
  'list_elements',
  'get_element',
  'get_element_details',
  'search_elements',
  'query_elements',
  'get_active_elements',
  'validate_element',
  'render',
  'export_element',
  'introspect',
  'get_execution_state',
  'get_gathered_data',
  'browse_collection',
  'search_collection',
  'search_collection_enhanced',
  'get_collection_content',
  'get_collection_cache_health',
  'portfolio_status',
  'portfolio_config',
  'search_portfolio',
  'search_all',
  'check_github_auth',
  'oauth_helper_status',
  'dollhouse_config',
  'get_build_info',
  'get_cache_budget_report',
  'query_logs',
  'find_similar_elements',
  'get_element_relationships',
  'search_by_verb',
  'get_relationship_stats',
  'get_effective_cli_policies',
  'get_pending_cli_approvals',
]);

// ── Static Classification Lists ────────────────────────────────────

/**
 * Tools that are always safe (read-only, no side effects).
 *
 * NOTE: "Safe" here means no destructive side effects — it does NOT mean
 * unrestricted. Read-only tools can still pose information-leakage or
 * scope-creep risks when used to access files outside the project working
 * directory (e.g., ~/.ssh/*, /etc/passwd, credentials in home directories).
 * Most LLM clients (Claude Code, Cursor, etc.) already enforce directory
 * scoping at the client level. The `assessRisk()` function applies a small
 * score bump for read operations targeting out-of-scope paths as an
 * additional signal for approval policies.
 */
const SAFE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TodoRead',
  'TodoWrite',
]);

/** Bash command prefixes/patterns that are safe */
const SAFE_BASH_PATTERNS = [
  'git status*',
  'git log*',
  'git diff*',
  'git branch*',
  'git show*',
  'git remote*',
  'git stash list*',
  'ls*',
  'pwd',
  'cat *',
  'head *',
  'tail *',
  'wc *',
  'echo *',
  'npm test*',
  'npm run lint*',
  'npm run build*',
  'npm run test*',
  'npm run check*',
  'npm run typecheck*',
  'npm run format*',
  'npm ls*',
  'npm info*',
  'npm outdated*',
  'npx jest*',
  'npx tsc --noEmit*',
  'node --version*',
  'which *',
  'type *',
  'gh issue list*',
  'gh issue view*',
  'gh pr list*',
  'gh pr view*',
  'gh pr checks*',
];

/** Bash command patterns that are dangerous */
const DANGEROUS_BASH_PATTERNS = [
  'rm -rf *',
  'rm -fr *',
  'git push --force*',
  'git push -f *',
  'git reset --hard*',
  'git clean -f*',
  'git checkout -- *',
  'git branch -D *',
  'chmod 777*',
  'chmod -R 777*',
  'chmod +s *',
  'chown root *',
  'sudo *',
  'doas *',
  'su -*',
  'eval *',
  // Pipe-to-shell patterns (with and without spaces, multiple shells)
  '*| sh',
  '*| sh *',
  '*|sh',
  '*|sh *',
  '*| bash',
  '*| bash *',
  '*|bash',
  '*|bash *',
  '*| zsh',
  '*|zsh',
  'curl * | *',
  'wget * | *',
  // Package manager installs (can execute arbitrary post-install scripts)
  'npm install *',
  'npm install',
  'npm i *',
  'npm i',
  'yarn add *',
  'yarn install*',
  'pip install *',
  'gem install *',
  // Environment manipulation (path poisoning, library injection, variable destruction)
  'export PATH=*',
  'export LD_PRELOAD=*',
  'export LD_LIBRARY_PATH=*',
  'env -i *',
  'unset *',
  // Process control (can terminate agents or system processes)
  'kill *',
  'kill -*',
  'pkill *',
  'killall *',
  // Network tools (exfiltration, reverse shells)
  'nc *',
  'nc -*',
  'netcat *',
  'ncat *',
  'socat *',
  // Archive operations (archive bombs, root directory exfiltration/ransomware)
  'tar -xf *',
  'tar xf *',
  'zip -r * /',
  // Command chaining with dangerous subcommands
  '*; rm -rf *',
  '*&& rm -rf *',
  '*|| rm -rf *',
  '*; sudo *',
  '*&& sudo *',
  '*|| sudo *',
  '*; eval *',
  '*&& eval *',
  // Subprocess execution wrappers (bypass outer command classification)
  'bash -c *',
  'sh -c *',
  'zsh -c *',
  '/bin/bash -c *',
  '/bin/sh -c *',
  // Process substitution (can inject arbitrary command output)
  '*<(*',
  // Encoded payload execution (base64-decode piped to shell)
  '*base64 -d*|*',
  '*base64 --decode*|*',
  '*base64 -D*|*',
];

/** Bash command patterns that are always blocked */
const BLOCKED_BASH_PATTERNS = [
  'mkfs*',
  'dd if=*',
  ':(){:|:&};:',
  'format *',
  '*(){ *',
];

// ── Static Classification ──────────────────────────────────────────

/**
 * Classify a CLI tool call by risk level using static rules.
 *
 * Returns 'allow' for known-safe tools, 'deny' for known-dangerous patterns,
 * and 'evaluate' for anything that needs further policy checking.
 */
export function classifyTool(
  toolName: string,
  toolInput: Record<string, unknown>
): ToolClassificationResult {
  // Known-safe tools: auto-allow
  if (SAFE_TOOLS.has(toolName)) {
    return { riskLevel: 'safe', behavior: 'allow', reason: `${toolName} is a read-only tool` };
  }

  // Bash: sub-classify by command content
  if (toolName === 'Bash') {
    return classifyBashCommand(toolInput);
  }

  // MCP tool calls: auto-allow gatekeeper-essential and safe read-only operations, evaluate others
  if (toolName.startsWith('mcp__')) {
    const operation = typeof toolInput.operation === 'string' ? toolInput.operation : '';
    if (operation && GATEKEEPER_ESSENTIAL_OPERATIONS.has(operation)) {
      return {
        riskLevel: 'safe',
        behavior: 'allow',
        reason: `Gatekeeper-essential operation '${operation}' — cannot be blocked by permission_prompt`,
      };
    }
    if (operation && SAFE_MCP_OPERATIONS.has(operation)) {
      return {
        riskLevel: 'safe',
        behavior: 'allow',
        reason: `Read-only MCP operation '${operation}'`,
      };
    }
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'MCP tool call requires policy evaluation' };
  }

  // Edit, Write, Agent, NotebookEdit, etc.: moderate risk
  if (['Edit', 'Write', 'Agent', 'NotebookEdit'].includes(toolName)) {
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: `${toolName} modifies state, requires policy evaluation` };
  }

  // Unknown tool: evaluate (permissive default for Phase 1)
  return { riskLevel: 'moderate', behavior: 'evaluate', reason: `Unknown tool '${toolName}', requires policy evaluation` };
}

/**
 * Sub-classify Bash commands by matching against known patterns.
 */
function classifyBashCommand(
  toolInput: Record<string, unknown>
): ToolClassificationResult {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';

  if (!command) {
    return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'Empty Bash command' };
  }

  // Check blocked patterns first (highest priority)
  for (const pattern of BLOCKED_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'blocked', behavior: 'deny', reason: `Blocked command pattern: ${pattern}` };
    }
  }

  // Check dangerous patterns
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'dangerous', behavior: 'deny', reason: `Dangerous command pattern: ${pattern}` };
    }
  }

  // Check safe patterns
  for (const pattern of SAFE_BASH_PATTERNS) {
    if (matchesPattern(command, pattern)) {
      return { riskLevel: 'safe', behavior: 'allow', reason: `Safe command pattern: ${pattern}` };
    }
  }

  // Unclassified: evaluate against element policies
  return { riskLevel: 'moderate', behavior: 'evaluate', reason: 'Bash command not statically classified' };
}

// ── Risk Assessment ───────────────────────────────────────────────

/**
 * Base risk scores by classification level (0-100 scale).
 *
 * Score ranges:
 * -  0:     safe — read-only tools, no side effects
 * -  1-39:  low — minor side effects, easily reversible
 * - 40-59:  moderate — file writes, package installs, unclassified commands
 * - 60-79:  elevated — moderate + aggravating factors (network, file creation)
 * - 80-99:  dangerous — destructive commands, privilege escalation
 * - 100:    blocked — always denied (e.g., reverse shells, disk wipe)
 *
 * Adjustments applied on top of base: irreversible pattern (+10),
 * network operation (+10), out-of-scope read (+10), file creation (+5).
 * Score is capped at 100.
 */
const RISK_SCORES: Record<string, number> = {
  safe: 0,
  moderate: 40,
  dangerous: 80,
  blocked: 100,
};

/** Read-only tools that may reference file paths */
const SAFE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Sensitive path prefixes that indicate out-of-scope reads */
const SENSITIVE_PATH_PREFIXES = [
  '~/.ssh/', '~/.gnupg/', '~/.aws/', '~/.config/',
  '~/.env', '~/.netrc', '~/.npmrc',
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc/', '/sys/',
];

/**
 * Heuristic: does a path look like it targets files outside the project scope?
 * Checks for home-directory sensitive paths, system paths, and parent traversals.
 */
function isOutOfScopePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/');

  // Explicit sensitive paths
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return true;
    }
  }

  // Home directory references (~/...) that aren't relative to the project
  if (normalized.startsWith('~/') || normalized.startsWith('/Users/') || normalized.startsWith('/home/')) {
    // Heuristic: reading sensitive dotfiles/dirs outside a project.
    // Targets known credential/config stores — avoids false positives for
    // common project dotfiles like .github/, .vscode/, .eslintrc, etc.
    if (/\/\.(ssh|gnupg|aws|azure|gcloud|kube|docker|npmrc|netrc|env|bash_history|zsh_history|credentials|password|secret)/i.test(normalized)) return true;
  }

  return false;
}

/** Bash command patterns that are irreversible */
const IRREVERSIBLE_PATTERNS = [
  'rm -rf *',
  'rm -fr *',
  'git push --force*',
  'git push -f *',
  'git reset --hard*',
  'git clean -f*',
  'mkfs*',
  'dd if=*',
  'drop *',
  'truncate *',
];

/**
 * Assess the risk of a CLI tool call.
 *
 * Returns a numeric score (0-100) and irreversibility indicator based on
 * the static classification and tool-specific heuristics.
 *
 * @param toolName - The tool being called
 * @param toolInput - The tool input parameters
 * @param classification - The result from classifyTool()
 * @returns Risk assessment with score, irreversibility, and contributing factors
 */
export function assessRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
  classification: ToolClassificationResult
): RiskAssessment {
  let score = RISK_SCORES[classification.riskLevel] ?? 40;
  const factors: string[] = [`Base: ${classification.riskLevel} (${RISK_SCORES[classification.riskLevel] ?? 40})`];
  let irreversible = false;

  // Check for irreversible patterns in Bash commands
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    const command = toolInput.command.trim();
    for (const pattern of IRREVERSIBLE_PATTERNS) {
      if (matchesPattern(command, pattern)) {
        irreversible = true;
        score = Math.min(100, score + 10);
        factors.push(`Irreversible pattern: ${pattern} (+10)`);
        break;
      }
    }

    // Network operations increase risk
    if (/\b(curl|wget|fetch|nc|netcat|ncat|socat)\b/.test(command)) {
      score = Math.min(100, score + 10);
      factors.push('Network operation (+10)');
    }
  }

  // Write/Edit operations: file creation increases risk slightly
  if (toolName === 'Write') {
    score = Math.min(100, score + 5);
    factors.push('File creation (+5)');
  }

  // Read-only tools targeting paths outside the working directory.
  // Most clients already enforce directory scoping, but this provides an
  // additional signal for approval policies to act on.
  if (SAFE_READ_TOOLS.has(toolName)) {
    const targetPath = (toolInput.file_path ?? toolInput.path ?? '') as string;
    if (targetPath && isOutOfScopePath(targetPath)) {
      score = Math.min(100, score + 10);
      factors.push('Out-of-scope read path (+10)');
    }
  }

  return { score, irreversible, factors };
}

// ── Static Policy Data Export ─────────────────────────────────────

/**
 * Return all static classification data for bridge policy export.
 *
 * Used by PolicyExportService to write the bridge-compatible policy file.
 * All data is returned as plain arrays/objects (no Sets).
 */
export function getStaticPolicyData() {
  return {
    safe_tools: [...SAFE_TOOLS],
    safe_bash_patterns: [...SAFE_BASH_PATTERNS],
    dangerous_bash_patterns: [...DANGEROUS_BASH_PATTERNS],
    blocked_bash_patterns: [...BLOCKED_BASH_PATTERNS],
    irreversible_patterns: [...IRREVERSIBLE_PATTERNS],
    sensitive_path_prefixes: [...SENSITIVE_PATH_PREFIXES],
    gatekeeper_essential_operations: [...GATEKEEPER_ESSENTIAL_OPERATIONS],
    safe_mcp_operations: [...SAFE_MCP_OPERATIONS],
    risk_scores: { ...RISK_SCORES },
  };
}

// ── Element Policy Evaluation ──────────────────────────────────────

/**
 * Evaluate a CLI tool call against active element gatekeeper policies.
 *
 * Four-step evaluation per element (Issue #625 Phase 2, Issue #1660):
 * 1. denyPatterns (highest priority) — first match = immediate deny
 * 1.5. confirmPatterns — first match = immediate confirm (requires approval)
 * 2. allowPatterns — if element defines them, record whether tool matched
 * 3. After all elements: if any had allowPatterns but tool wasn't allowed by any = deny
 *
 * Union semantics: tool must match at least ONE element's allowPatterns (not all).
 * Elements without allowPatterns don't restrict.
 *
 * @example
 * // Tool matches allowPatterns in element A but not B → ALLOWED (union semantics)
 * // Tool matches denyPatterns in any element → DENIED (deny always wins)
 * // Tool matches no allowPatterns but some exist → DENIED ("not in any allowlist")
 * // No allowPatterns defined anywhere → Phase 1 behavior (fall through to default)
 *
 * @returns 'deny' if blocked, 'evaluate' if permitted to fall through to default
 */
export function evaluateCliToolPolicy(
  toolName: string,
  toolInput: Record<string, unknown>,
  activeElements: ActiveElement[]
): CliToolPolicyResult {
  const evaluatedElements: PolicyEvaluationContext['evaluatedElements'] = [];
  const decisionChain: string[] = [];

  if (!activeElements.length) {
    decisionChain.push('No active elements — fall through to default');
    return {
      behavior: 'evaluate',
      policyContext: { evaluatedElements, decisionChain },
    };
  }

  // Build the strings to match against patterns
  const matchTargets = buildMatchTargets(toolName, toolInput);

  let anyElementHasAllowPatterns = false;
  let toolAllowedByAnyElement = false;
  const elementsWithAllowPatterns: string[] = [];

  for (const element of activeElements) {
    const restrictions = element.metadata?.gatekeeper?.externalRestrictions;
    const denyPatterns = restrictions?.denyPatterns;
    const confirmPatterns = restrictions?.confirmPatterns;
    const allowPatterns = restrictions?.allowPatterns;

    const hasRestrictions = (Array.isArray(denyPatterns) && denyPatterns.length > 0)
      || (Array.isArray(confirmPatterns) && confirmPatterns.length > 0)
      || (Array.isArray(allowPatterns) && allowPatterns.length > 0);

    if (!hasRestrictions) {
      evaluatedElements.push({ type: element.type, name: element.name });
      decisionChain.push(`${element.type} '${element.name}': no externalRestrictions`);
      continue;
    }

    // Step 1: Check denyPatterns (highest priority)
    if (Array.isArray(denyPatterns)) {
      for (const pattern of denyPatterns) {
        if (typeof pattern !== 'string') continue;
        for (const target of matchTargets) {
          if (matchesPattern(target, pattern)) {
            evaluatedElements.push({
              type: element.type,
              name: element.name,
              matched: 'denyPatterns',
              matchedPattern: pattern,
              matchedTarget: target,
            });
            decisionChain.push(`DENY: ${element.type} '${element.name}' denyPattern '${pattern}' matches '${target}'`);
            return {
              behavior: 'deny',
              message: `Denied by ${element.type} '${element.name}' policy: pattern '${pattern}' matches '${target}'`,
              policyContext: { evaluatedElements, decisionChain },
            };
          }
        }
      }
    }

    // Step 1.5: Check confirmPatterns (requires approval — Issue #1660)
    if (Array.isArray(confirmPatterns) && confirmPatterns.length > 0) {
      for (const pattern of confirmPatterns) {
        if (typeof pattern !== 'string') continue;
        for (const target of matchTargets) {
          if (matchesPattern(target, pattern)) {
            evaluatedElements.push({
              type: element.type,
              name: element.name,
              matched: 'confirmPatterns',
              matchedPattern: pattern,
              matchedTarget: target,
            });
            decisionChain.push(`CONFIRM: ${element.type} '${element.name}' confirmPattern '${pattern}' matches '${target}'`);
            return {
              behavior: 'confirm' as const,
              message: `Requires approval: ${element.type} '${element.name}' policy requires confirmation for pattern '${pattern}'`,
              confirmSource: `${element.type}:${element.name}`,
              policyContext: { evaluatedElements, decisionChain },
            };
          }
        }
      }
    }

    // Step 2: Check allowPatterns
    if (Array.isArray(allowPatterns) && allowPatterns.length > 0) {
      anyElementHasAllowPatterns = true;
      elementsWithAllowPatterns.push(`${element.type} '${element.name}'`);
      let matchedAllow = false;

      for (const pattern of allowPatterns) {
        if (typeof pattern !== 'string') continue;
        for (const target of matchTargets) {
          if (matchesPattern(target, pattern)) {
            evaluatedElements.push({
              type: element.type,
              name: element.name,
              matched: 'allowPatterns',
              matchedPattern: pattern,
              matchedTarget: target,
            });
            decisionChain.push(`${element.type} '${element.name}': allowPattern '${pattern}' matches '${target}'`);
            toolAllowedByAnyElement = true;
            matchedAllow = true;
            break;
          }
        }
        if (matchedAllow) break;
      }

      if (!matchedAllow) {
        evaluatedElements.push({ type: element.type, name: element.name });
        decisionChain.push(`${element.type} '${element.name}': allowPatterns defined but no match`);
      }
    } else {
      evaluatedElements.push({ type: element.type, name: element.name });
      decisionChain.push(`${element.type} '${element.name}': denyPatterns checked, no match`);
    }
  }

  // Step 3: If any element had allowPatterns, tool must have matched at least one
  if (anyElementHasAllowPatterns && !toolAllowedByAnyElement) {
    const restrictors = elementsWithAllowPatterns.join(', ');
    decisionChain.push(`DENY: tool not in any element allowlist (restricted by: ${restrictors})`);
    return {
      behavior: 'deny',
      message: `Tool '${toolName}' not permitted by allowlists defined in: ${restrictors}. Either deactivate these elements or add allowPatterns to match this tool.`,
      policyContext: { evaluatedElements, decisionChain },
    };
  }

  if (anyElementHasAllowPatterns) {
    decisionChain.push('Tool matched allowlist — fall through to default');
  } else {
    decisionChain.push('No allowPatterns defined — fall through to default (Phase 1 behavior)');
  }

  return {
    behavior: 'evaluate',
    policyContext: { evaluatedElements, decisionChain },
  };
}

/**
 * Maximum input length for pattern matching targets.
 * Truncates long commands/paths to prevent DoS via pathological glob matching.
 */
const MAX_MATCH_INPUT_LENGTH = 1000;

/**
 * Strip null bytes, control characters, and normalize Unicode for match input.
 * Preserves tab (\x09), newline (\x0A), carriage return (\x0D).
 * Prevents pattern bypass via injected control characters or Unicode
 * normalization attacks (e.g., combining characters that look like ASCII).
 */
function sanitizeMatchInput(input: string): string {
  // Normalize Unicode to NFC (canonical decomposition then composition).
  // This prevents bypass via combining characters or alternative representations.
  const normalized = input.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  return normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

/**
 * Build match target strings for a tool call.
 *
 * For Bash: matches against the tool name and "Bash:<command>"
 * For Edit/Write: matches against the tool name and "Edit:<file_path>"
 * For MCP tools: matches against the full tool name
 *
 * Inputs are truncated to MAX_MATCH_INPUT_LENGTH and sanitized to prevent
 * DoS via pathological glob matching and pattern bypass via control chars.
 */
function buildMatchTargets(
  toolName: string,
  toolInput: Record<string, unknown>
): string[] {
  const targets = [toolName];

  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    const sanitized = sanitizeMatchInput(toolInput.command.slice(0, MAX_MATCH_INPUT_LENGTH));
    targets.push(`Bash:${sanitized}`);
  } else if ((toolName === 'Edit' || toolName === 'Write') && typeof toolInput.file_path === 'string') {
    const sanitized = sanitizeMatchInput(toolInput.file_path.slice(0, MAX_MATCH_INPUT_LENGTH));
    targets.push(`${toolName}:${sanitized}`);
  }

  return targets;
}

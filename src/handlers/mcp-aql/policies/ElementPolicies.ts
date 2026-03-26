/**
 * Element Policies
 *
 * Handles element-based access control for the Gatekeeper.
 * Allows ANY DollhouseMCP element to define policies in its metadata
 * that override or restrict the default operation policies.
 *
 * Policy Resolution Order:
 * 1. Active element deny list (highest priority - blocks operation)
 * 2. Active element confirm list (requires confirmation)
 * 3. Active element allow list (auto-approves)
 * 4. Operation default permission (fallback)
 */

import {
  PermissionLevel,
  type ElementGatekeeperPolicy,
  type CliApprovalPolicy,
  type GatekeeperDecision,
  GatekeeperErrorCode,
} from '../GatekeeperTypes.js';
import { getDefaultPermissionLevel, canOperationBeElevated, getOperationPolicy } from './OperationPolicies.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { logger } from '../../../utils/logger.js';
import { MAX_GLOB_PATTERN_LENGTH } from '../../../utils/patternMatcher.js';

/**
 * Metadata structure for elements with Gatekeeper policies.
 * The 'gatekeeper' field is optional and contains policy definitions.
 */
export interface ElementMetadataWithPolicy {
  name: string;
  description?: string;
  gatekeeper?: ElementGatekeeperPolicy;
  [key: string]: unknown;
}

/**
 * Active element for policy evaluation.
 * Represents an element currently active in the session.
 */
export interface ActiveElement {
  type: string;
  name: string;
  metadata: ElementMetadataWithPolicy;
}

/**
 * Result of element policy resolution.
 * Contains the effective permission level and policy source.
 */
export interface ElementPolicyResult {
  /** Effective permission level after element policy application */
  permissionLevel: PermissionLevel;
  /** Which element's policy determined this result */
  sourceElement?: string;
  /** The specific policy field that matched (allow/confirm/deny) */
  matchedPolicy?: 'allow' | 'confirm' | 'deny' | 'scope_restriction';
  /** Whether the operation was blocked by scope restrictions */
  scopeBlocked?: boolean;
  /**
   * Elements that wanted to auto-approve this operation but were overridden
   * by a higher-priority confirm or deny policy from another element.
   * Issue #674: allow cannot override confirm.
   */
  conflictingElements?: Array<{ name: string; wantedLevel: PermissionLevel }>;
}

/**
 * Resolve the effective permission level for an operation
 * considering all active elements and their policies.
 *
 * @param operation - The operation to check
 * @param activeElements - Currently active elements with their metadata
 * @param targetElementType - Optional element type being operated on
 * @returns The resolved policy result
 */
export function resolveElementPolicy(
  operation: string,
  activeElements: ActiveElement[],
  targetElementType?: string
): ElementPolicyResult {
  // Start with the default operation permission level
  let effectiveLevel = getDefaultPermissionLevel(operation);
  let sourceElement: string | undefined;
  let matchedPolicy: ElementPolicyResult['matchedPolicy'];
  let scopeBlocked = false;
  // Issue #674: Track whether CONFIRM was set by an element policy (not just the route default)
  // allow can override the route default but NOT another element's confirm policy
  let confirmedByElement = false;
  // Track elements that wanted allow but were overridden by an element-set confirm/deny
  const conflictingElements: Array<{ name: string; wantedLevel: PermissionLevel }> = [];

  // Check each active element's policy in order
  for (const element of activeElements) {
    const policy = element.metadata.gatekeeper;
    if (!policy) {
      continue;
    }

    // 1. Check deny list first (highest priority)
    if (policy.deny?.includes(operation)) {
      return {
        permissionLevel: PermissionLevel.DENY,
        sourceElement: element.name,
        matchedPolicy: 'deny',
        conflictingElements: conflictingElements.length > 0 ? conflictingElements : undefined,
      };
    }

    // 2. Check scope restrictions
    if (targetElementType && policy.scopeRestrictions) {
      const { allowedTypes, blockedTypes } = policy.scopeRestrictions;

      // If allowedTypes is specified, target must be in the list
      if (allowedTypes && !allowedTypes.includes(targetElementType)) {
        scopeBlocked = true;
        sourceElement = element.name;
        matchedPolicy = 'scope_restriction';
        continue; // Check other elements, might have different policy
      }

      // If blockedTypes is specified, target must NOT be in the list
      if (blockedTypes?.includes(targetElementType)) {
        scopeBlocked = true;
        sourceElement = element.name;
        matchedPolicy = 'scope_restriction';
        continue;
      }
    }

    // 3. Check confirm list (requires confirmation)
    if (policy.confirm?.includes(operation)) {
      // Don't downgrade from DENY or CONFIRM_SINGLE_USE
      if (effectiveLevel !== PermissionLevel.DENY) {
        effectiveLevel = PermissionLevel.CONFIRM_SESSION;
        confirmedByElement = true;
        sourceElement = element.name;
        matchedPolicy = 'confirm';
      }
    }

    // 4. Check allow list (auto-approves)
    // Issue #674: allow CAN override the route default, but NOT another element's confirm policy.
    // Priority hierarchy: element deny > element confirm > element allow > route default
    if (policy.allow?.includes(operation)) {
      // Only elevate if the operation allows elevation
      if (canOperationBeElevated(operation)) {
        if (!confirmedByElement) {
          // No element has confirmed this — safe to elevate (overrides route default)
          effectiveLevel = PermissionLevel.AUTO_APPROVE;
          sourceElement = element.name;
          matchedPolicy = 'allow';
        } else {
          // Another element's confirm policy takes priority over this allow
          conflictingElements.push({ name: element.name, wantedLevel: PermissionLevel.AUTO_APPROVE });
        }
      }
    }
  }

  // If scope was blocked by all elements with restrictions
  if (scopeBlocked) {
    return {
      permissionLevel: PermissionLevel.DENY,
      sourceElement,
      matchedPolicy: 'scope_restriction',
      scopeBlocked: true,
    };
  }

  return {
    permissionLevel: effectiveLevel,
    sourceElement,
    matchedPolicy,
    conflictingElements: conflictingElements.length > 0 ? conflictingElements : undefined,
  };
}

/**
 * Create a Gatekeeper decision from element policy resolution.
 *
 * @param operation - The operation that was checked
 * @param result - The element policy resolution result
 * @param targetElementType - Optional element type being operated on
 * @returns A GatekeeperDecision object
 */
export function createDecisionFromPolicy(
  operation: string,
  result: ElementPolicyResult,
  targetElementType?: string
): GatekeeperDecision {
  const { permissionLevel, sourceElement, scopeBlocked, conflictingElements } = result;

  // Handle DENY
  if (permissionLevel === PermissionLevel.DENY) {
    if (scopeBlocked) {
      return {
        allowed: false,
        permissionLevel,
        errorCode: GatekeeperErrorCode.SCOPE_RESTRICTION,
        reason: `Operation "${operation}" is not allowed on element type "${targetElementType}" due to scope restrictions in active element "${sourceElement}"`,
        suggestion: `Deactivate the element "${sourceElement}" or use a different element type`,
        policySource: 'element_policy',
      };
    }

    return {
      allowed: false,
      permissionLevel,
      errorCode: GatekeeperErrorCode.ELEMENT_POLICY_VIOLATION,
      reason: `Operation "${operation}" is blocked by active element "${sourceElement}"'s deny policy`,
      suggestion: `Deactivate the element "${sourceElement}" to proceed with this operation`,
      policySource: 'element_policy',
    };
  }

  // Handle confirmation required
  if (
    permissionLevel === PermissionLevel.CONFIRM_SESSION ||
    permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE
  ) {
    // Build human-readable rationale explaining WHY confirmation is needed
    const policy = getOperationPolicy(operation);
    const levelLabel = permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE
      ? 'requires confirmation each time'
      : 'requires confirmation once per session';

    let rationale: string;
    if (sourceElement && result.matchedPolicy === 'confirm') {
      // Element policy elevated this operation's confirmation requirement
      const policyDetail = policy?.rationale ? ` ${policy.rationale}` : '';
      rationale = `Active element "${sourceElement}" policy requires confirmation for this operation.${policyDetail}`;
    } else if (policy?.rationale) {
      // Route-level default with documented rationale
      rationale = policy.rationale;
    } else {
      // Endpoint-level default, no specific rationale
      rationale = 'This operation modifies data and requires human approval before proceeding';
    }

    // Issue #674: Surface elements that wanted to auto-approve but were overridden
    const conflictNote = conflictingElements && conflictingElements.length > 0
      ? ` (Note: ${conflictingElements.map(e => `"${e.name}"`).join(', ')} would auto-approve this but ${conflictingElements.length === 1 ? 'is' : 'are'} overridden by the confirm policy.)`
      : '';

    return {
      allowed: false,
      permissionLevel,
      errorCode: GatekeeperErrorCode.CONFIRMATION_REQUIRED,
      reason: `Operation "${operation}" ${levelLabel}. ${rationale}${conflictNote}`,
      suggestion: 'Use the confirmation dialog to approve this operation',
      confirmationPending: true,
      policySource: sourceElement ? 'element_policy' : 'operation_default',
    };
  }

  // Handle AUTO_APPROVE
  return {
    allowed: true,
    permissionLevel,
    reason: sourceElement
      ? `Operation "${operation}" auto-approved by element "${sourceElement}"`
      : `Operation "${operation}" auto-approved by default policy`,
    policySource: sourceElement ? 'element_policy' : 'operation_default',
  };
}

/**
 * Parse and validate a Gatekeeper policy from element metadata.
 *
 * @param metadata - The element metadata to parse
 * @returns The parsed policy, or undefined if no policy is defined
 * @throws Error if the policy is malformed
 */
export function parseElementPolicy(
  metadata: unknown
): ElementGatekeeperPolicy | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }

  const meta = metadata as Record<string, unknown>;
  const gatekeeper = meta.gatekeeper;

  if (!gatekeeper) {
    return undefined;
  }

  if (typeof gatekeeper !== 'object' || gatekeeper === null) {
    throw new Error('Invalid gatekeeper policy: must be an object');
  }

  const policy = gatekeeper as Record<string, unknown>;

  // Validate and extract allow list
  const allow = validateStringArray(policy.allow, 'allow');
  const confirm = validateStringArray(policy.confirm, 'confirm');
  const deny = validateStringArray(policy.deny, 'deny');

  // Validate scope restrictions
  let scopeRestrictions: ElementGatekeeperPolicy['scopeRestrictions'];
  if (policy.scopeRestrictions) {
    if (typeof policy.scopeRestrictions !== 'object' || policy.scopeRestrictions === null) {
      throw new Error('Invalid gatekeeper policy: scopeRestrictions must be an object');
    }
    const sr = policy.scopeRestrictions as Record<string, unknown>;
    scopeRestrictions = {
      allowedTypes: validateStringArray(sr.allowedTypes, 'scopeRestrictions.allowedTypes'),
      blockedTypes: validateStringArray(sr.blockedTypes, 'scopeRestrictions.blockedTypes'),
    };
  }

  // Validate external restrictions (Issue #625 Phase 2)
  let externalRestrictions: ElementGatekeeperPolicy['externalRestrictions'];
  if (policy.externalRestrictions) {
    if (typeof policy.externalRestrictions !== 'object' || policy.externalRestrictions === null) {
      throw new Error('Invalid gatekeeper policy: externalRestrictions must be an object');
    }
    const er = policy.externalRestrictions as Record<string, unknown>;
    if (!er.description || typeof er.description !== 'string') {
      throw new Error('Invalid gatekeeper policy: externalRestrictions.description is required and must be a non-empty string');
    }
    const denyPatterns = validateStringArray(er.denyPatterns, 'externalRestrictions.denyPatterns');
    const confirmPatterns = validateStringArray(er.confirmPatterns, 'externalRestrictions.confirmPatterns');
    const allowPatterns = validateStringArray(er.allowPatterns, 'externalRestrictions.allowPatterns');
    if (denyPatterns) validatePatternStrings(denyPatterns, 'externalRestrictions.denyPatterns');
    if (confirmPatterns) validatePatternStrings(confirmPatterns, 'externalRestrictions.confirmPatterns');
    if (allowPatterns) validatePatternStrings(allowPatterns, 'externalRestrictions.allowPatterns');
    // Validate approvalPolicy (Issue #625 Phase 3)
    let approvalPolicy: CliApprovalPolicy | undefined = undefined;
    if (er.approvalPolicy !== undefined) {
      if (typeof er.approvalPolicy !== 'object' || er.approvalPolicy === null) {
        throw new Error('Invalid gatekeeper policy: externalRestrictions.approvalPolicy must be an object');
      }
      const ap = er.approvalPolicy as Record<string, unknown>;

      // Validate requireApproval
      let requireApproval: ('moderate' | 'dangerous')[] | undefined;
      if (ap.requireApproval !== undefined) {
        if (!Array.isArray(ap.requireApproval)) {
          throw new Error('Invalid gatekeeper policy: externalRestrictions.approvalPolicy.requireApproval must be an array');
        }
        const validLevels = new Set(['moderate', 'dangerous']);
        for (const level of ap.requireApproval) {
          if (typeof level !== 'string' || !validLevels.has(level)) {
            throw new Error(`Invalid gatekeeper policy: externalRestrictions.approvalPolicy.requireApproval contains invalid value "${level}". Must be "moderate" or "dangerous".`);
          }
        }
        requireApproval = ap.requireApproval as ('moderate' | 'dangerous')[];
      }

      // Validate defaultScope
      let defaultScope: 'single' | 'tool_session' | undefined;
      if (ap.defaultScope !== undefined) {
        if (ap.defaultScope !== 'single' && ap.defaultScope !== 'tool_session') {
          throw new Error(`Invalid gatekeeper policy: externalRestrictions.approvalPolicy.defaultScope must be "single" or "tool_session", got "${ap.defaultScope}"`);
        }
        defaultScope = ap.defaultScope;
      }

      // Validate ttlSeconds
      let ttlSeconds: number | undefined;
      if (ap.ttlSeconds !== undefined) {
        if (typeof ap.ttlSeconds !== 'number' || !Number.isFinite(ap.ttlSeconds)) {
          throw new Error('Invalid gatekeeper policy: externalRestrictions.approvalPolicy.ttlSeconds must be a number');
        }
        if (ap.ttlSeconds < 30 || ap.ttlSeconds > 3600) {
          throw new Error(`Invalid gatekeeper policy: externalRestrictions.approvalPolicy.ttlSeconds must be between 30 and 3600, got ${ap.ttlSeconds}`);
        }
        ttlSeconds = ap.ttlSeconds;
      }

      approvalPolicy = { requireApproval, defaultScope, ttlSeconds };
    }

    externalRestrictions = {
      description: er.description as string,
      denyPatterns,
      confirmPatterns,
      allowPatterns,
      approvalPolicy,
    };
  }

  return {
    allow,
    confirm,
    deny,
    scopeRestrictions,
    externalRestrictions,
  };
}

/**
 * Validate that a value is an array of strings.
 *
 * @param value - The value to validate
 * @param fieldName - The field name for error messages
 * @returns The validated array, or undefined
 */
function validateStringArray(
  value: unknown,
  fieldName: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid gatekeeper policy: ${fieldName} must be an array`);
  }

  if (!value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`Invalid gatekeeper policy: ${fieldName} must contain only strings`);
  }

  return value;
}

/**
 * Validate pattern strings for length and non-emptiness.
 *
 * @param patterns - Array of pattern strings to validate
 * @param fieldName - Field name for error messages
 * @throws Error if any pattern is empty or exceeds MAX_GLOB_PATTERN_LENGTH
 */
function validatePatternStrings(
  patterns: string[],
  fieldName: string
): void {
  for (const pattern of patterns) {
    if (!pattern) {
      throw new Error(`Invalid gatekeeper policy: ${fieldName} contains an empty pattern string`);
    }
    if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
      throw new Error(`Invalid gatekeeper policy: ${fieldName} pattern exceeds maximum length of ${MAX_GLOB_PATTERN_LENGTH} characters`);
    }
  }
}

/**
 * Known CLI tool names used in externalRestrictions patterns.
 * Patterns should start with one of these followed by ':' to be effective.
 */
const KNOWN_TOOL_PREFIXES = new Set([
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit',
]);

/**
 * Regex characters that have no meaning in glob syntax.
 * Users who include these likely intend regex but the matcher only supports * and ?.
 */
const REGEX_SYNTAX_PATTERN = /[|(){}[\]\\+^$]/;

/**
 * Analyze externalRestrictions patterns for common mistakes and suspicious syntax.
 *
 * Returns non-fatal warnings to help LLMs and users write effective patterns.
 * Does NOT throw — validation errors are handled by {@link validatePatternStrings}.
 *
 * Checks performed (Issue #1664):
 * - Missing tool prefix (pattern doesn't start with ToolName:)
 * - Overly broad patterns (bare `*` or `ToolName:*`)
 * - Regex syntax that won't work in glob matching
 * - Leading/trailing whitespace
 *
 * @param patterns - Array of pattern strings to analyze
 * @param fieldName - Field name for warning messages
 * @returns Array of warning messages (empty if no issues found)
 */
export function analyzePatternSyntax(
  patterns: string[],
  fieldName: string
): string[] {
  const warnings: string[] = [];
  for (const pattern of patterns) {
    analyzeOnePattern(pattern, fieldName, warnings);
  }
  return warnings;
}

/**
 * Analyze a single pattern string and append any warnings found.
 * Extracted from {@link analyzePatternSyntax} to reduce cognitive complexity.
 */
function analyzeOnePattern(
  pattern: string,
  fieldName: string,
  warnings: string[]
): void {
  // Check leading/trailing whitespace
  if (pattern !== pattern.trim()) {
    warnings.push(
      `${fieldName} pattern '${pattern}' has leading/trailing whitespace — this may prevent expected matches`
    );
  }

  // Check for bare wildcard (matches everything)
  if (pattern === '*') {
    warnings.push(
      `${fieldName} pattern '*' matches everything — this is likely unintentional`
    );
    return;
  }

  // Check for tool prefix and related issues
  const colonIndex = pattern.indexOf(':');
  if (colonIndex === -1) {
    warnings.push(
      `${fieldName} pattern '${pattern}' has no tool prefix (e.g., 'Bash:', 'Edit:'). ` +
      `Patterns are matched against 'ToolName:input' strings and will not match without a prefix.`
    );
  } else {
    checkToolPrefix(pattern, colonIndex, fieldName, warnings);
  }

  // Check for regex syntax that won't work in glob
  const regexMatch = REGEX_SYNTAX_PATTERN.exec(pattern);
  if (regexMatch) {
    warnings.push(
      `${fieldName} pattern '${pattern}' contains regex syntax '${regexMatch[0]}' — ` +
      `only glob wildcards (* and ?) are supported`
    );
  }
}

/**
 * Check tool prefix validity and broadness for a pattern that contains ':'.
 */
function checkToolPrefix(
  pattern: string,
  colonIndex: number,
  fieldName: string,
  warnings: string[]
): void {
  const prefix = pattern.slice(0, colonIndex);
  const afterColon = pattern.slice(colonIndex + 1);

  // Check for unknown tool prefix
  if (!KNOWN_TOOL_PREFIXES.has(prefix) && !prefix.startsWith('mcp_')) {
    warnings.push(
      `${fieldName} pattern '${pattern}' uses unknown tool prefix '${prefix}'. ` +
      `Known prefixes: ${[...KNOWN_TOOL_PREFIXES].join(', ')}. MCP tools use 'mcp_' prefix.`
    );
  }

  // Check for overly broad ToolName:* pattern
  if (afterColon === '*') {
    warnings.push(
      `${fieldName} pattern '${pattern}' matches ALL ${prefix} operations — verify this is intentional`
    );
  }
}

/**
 * Validate and sanitize a gatekeeper policy during element deserialization.
 *
 * Returns a validated {@link ElementGatekeeperPolicy} if the raw data is
 * structurally valid, or `undefined` if the data is absent, falsy, or
 * malformed. Malformed policies are logged as security events and stripped
 * so they never reach the enforcement pipeline.
 *
 * Use this at every deserialization boundary (manager `parseMetadata` /
 * `sanitizeMetadata` / `parseMemoryFile`) to guarantee that only well-formed
 * policies survive loading.
 *
 * @param rawPolicy - The raw gatekeeper value from parsed YAML/JSON
 * @param elementName - Element name for diagnostic logging
 * @param elementType - Element type for diagnostic logging
 * @returns Validated policy or undefined
 *
 * @since Issue #524 — Runtime validation for all element types
 */
/**
 * Gatekeeper infrastructure operations — two related sets with distinct purposes.
 *
 * UNGATABLE_OPERATIONS: Operations that must NEVER appear in element policy lists.
 * These are pure internal plumbing — gating them serves no security purpose and
 * breaks critical flows (verification, CLI approval, permission evaluation).
 * Stripped from ALL policy lists (allow, confirm, deny) during sanitization.
 *
 * GATEKEEPER_INFRA_OPERATIONS: Operations that skip Layer 2 (element policy
 * resolution) during primary enforcement. This is a SUPERSET of UNGATABLE_OPERATIONS
 * — it adds confirm_operation, which IS a valid policy target (deny = nuclear sandbox)
 * but must not be gated through the normal enforce() path (that creates the
 * cascading confirmation loop from Issue #758). confirm_operation's element policies
 * are enforced through a separate check in the confirm handler instead.
 *
 * Relationship: GATEKEEPER_INFRA_OPERATIONS = UNGATABLE_OPERATIONS + confirm_operation
 * This derivation is explicit in code to prevent the sets from drifting apart.
 */
const UNGATABLE_OPERATIONS = new Set([
  'verify_challenge',
  'approve_cli_permission',
  'permission_prompt',
]);

/** Derived from UNGATABLE_OPERATIONS + confirm_operation. See block comment above. */
const GATEKEEPER_INFRA_OPERATIONS = new Set([
  ...UNGATABLE_OPERATIONS,
  'confirm_operation',
]);

/**
 * Check if an operation is a gatekeeper infrastructure operation that should
 * skip element policy evaluation in the primary enforcement path.
 * Exported for use by MCPAQLHandler. Issue #758.
 */
export function isGatekeeperInfraOperation(operation: string): boolean {
  return GATEKEEPER_INFRA_OPERATIONS.has(operation);
}

/**
 * Check if any active elements deny confirm_operation (nuclear sandbox).
 * Returns the denying element name if found, undefined otherwise.
 */
export function findConfirmDenyingElement(
  activeElements: Array<{ name: string; type: string; metadata: Record<string, unknown> }>
): { name: string; type: string } | undefined {
  for (const element of activeElements) {
    const gatekeeper = element.metadata?.gatekeeper as Record<string, unknown> | undefined;
    const denyList = gatekeeper?.deny;
    if (Array.isArray(denyList) && denyList.includes('confirm_operation')) {
      return { name: element.name, type: element.type };
    }
  }
  return undefined;
}

/**
 * Check if any active elements have confirm_operation in their confirm list (advisory).
 * Returns the element names that request additional scrutiny.
 */
export function findConfirmAdvisoryElements(
  activeElements: Array<{ name: string; type: string; metadata: Record<string, unknown> }>
): Array<{ name: string; type: string }> {
  const advisories: Array<{ name: string; type: string }> = [];
  for (const element of activeElements) {
    const gatekeeper = element.metadata?.gatekeeper as Record<string, unknown> | undefined;
    const confirmList = gatekeeper?.confirm;
    if (Array.isArray(confirmList) && confirmList.includes('confirm_operation')) {
      advisories.push({ name: element.name, type: element.type });
    }
  }
  return advisories;
}

/**
 * Strip ungatable operations from a policy list and log warnings.
 * Returns the filtered list (may be empty).
 *
 * Note: confirm_operation is NOT stripped from deny lists — it's a legitimate
 * sandbox mechanism. It IS stripped from allow/confirm lists since those are
 * handled through advisory messaging, not through enforce().
 */
function stripUngatable(
  operations: string[] | undefined,
  listName: string,
  elementName: string,
  elementType: string,
): string[] | undefined {
  if (!operations?.length) return operations;

  // confirm_operation in deny lists = nuclear sandbox (preserve)
  // confirm_operation in confirm lists = advisory marker (preserve — inert in enforce path,
  //   read at runtime by findConfirmAdvisoryElements(). Safe because skipElementPolicies
  //   prevents resolveElementPolicy() from ever evaluating confirm_operation as an operation.)
  // confirm_operation in allow lists = redundant with route default AUTO_APPROVE (strip)
  const opsToStrip = listName === 'allow'
    ? new Set([...UNGATABLE_OPERATIONS, 'confirm_operation'])
    : UNGATABLE_OPERATIONS;

  const stripped = operations.filter(op => {
    if (opsToStrip.has(op)) {
      logger.warn(
        `[Gatekeeper] Stripped "${op}" from ${listName} list in ${elementType} "${elementName}" — ` +
        `gatekeeper infrastructure operations cannot be gated by element policies (Issue #758)`
      );
      return false;
    }
    return true;
  });
  return stripped.length > 0 ? stripped : undefined;
}

export function sanitizeGatekeeperPolicy(
  rawPolicy: unknown,
  elementName: string,
  elementType: string,
): ElementGatekeeperPolicy | undefined {
  if (!rawPolicy || typeof rawPolicy !== 'object') {
    return undefined;
  }

  try {
    // Wrap in a metadata envelope so parseElementPolicy can extract it
    const validated = parseElementPolicy({ gatekeeper: rawPolicy });
    if (validated) {
      // Issue #758: Strip gatekeeper infrastructure operations from element policies
      // to prevent cascading confirmation loops
      validated.allow = stripUngatable(validated.allow, 'allow', elementName, elementType);
      validated.confirm = stripUngatable(validated.confirm, 'confirm', elementName, elementType);
      validated.deny = stripUngatable(validated.deny, 'deny', elementName, elementType);

      logger.debug(`Loaded gatekeeper policy for ${elementType} "${elementName}"`, {
        allow: validated.allow?.length ?? 0,
        confirm: validated.confirm?.length ?? 0,
        deny: validated.deny?.length ?? 0,
        hasScopeRestrictions: !!validated.scopeRestrictions,
      });
    }
    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    SecurityMonitor.logSecurityEvent({
      type: 'YAML_PARSING_WARNING',
      severity: 'MEDIUM',
      source: `${elementType}.deserialize`,
      details: `Malformed gatekeeper policy in "${elementName}" stripped during load: ${message}`,
    });
    logger.warn(`Stripped malformed gatekeeper policy from ${elementType} "${elementName}": ${message}`);
    return undefined;
  }
}

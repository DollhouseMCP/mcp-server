/**
 * TypeScript type definitions for MCP-AQL (MCP Agent Query Language)
 * These types match the GraphQL schema defined in schema.graphql
 */

import { ELEMENT_TYPE_MAP } from '../../utils/elementTypeNormalization.js';

/**
 * Element types supported by DollhouseMCP.
 * These correspond to the 6 core element types in the system.
 */
export enum ElementType {
  Persona = 'persona',
  Skill = 'skill',
  Template = 'template',
  Agent = 'agent',
  Memory = 'memory',
  Ensemble = 'ensemble',
}

/**
 * Normalize any element type string (singular or plural) to an MCP-AQL ElementType value.
 * Returns undefined for unrecognised input.
 * Issue #433: Accept both "memory" and "memories" at the input parsing layer.
 */
const MCPAQL_TYPE_MAP: Record<string, ElementType> = {
  persona: ElementType.Persona, personas: ElementType.Persona,
  skill: ElementType.Skill, skills: ElementType.Skill,
  template: ElementType.Template, templates: ElementType.Template,
  agent: ElementType.Agent, agents: ElementType.Agent,
  memory: ElementType.Memory, memories: ElementType.Memory,
  ensemble: ElementType.Ensemble, ensembles: ElementType.Ensemble,
};

// Runtime validation: every MCP-AQL ElementType must appear in MCPAQL_TYPE_MAP
for (const enumValue of Object.values(ElementType)) {
  if (!Object.values(MCPAQL_TYPE_MAP).includes(enumValue)) {
    throw new Error(
      `MCP-AQL types: ElementType '${enumValue}' is missing from MCPAQL_TYPE_MAP. ` +
      `Update MCPAQL_TYPE_MAP to include both singular and plural entries for this type.`
    );
  }
}

export function normalizeMCPAQLElementType(value: string): ElementType | undefined {
  return MCPAQL_TYPE_MAP[value.trim().toLowerCase()];
}

/**
 * Input for all MCP-AQL operations.
 * The operation field determines which handler function is invoked.
 */
export interface OperationInput {
  /**
   * The operation to perform (e.g., 'create_element', 'list_elements')
   */
  operation: string;

  /**
   * Element type for element operations (snake_case, Issue #290)
   */
  element_type?: ElementType;

  /**
   * Element type for element operations (camelCase, legacy)
   * @deprecated Use element_type instead
   */
  elementType?: ElementType;

  /**
   * Operation-specific parameters as a JSON object
   */
  params?: Record<string, unknown>;
}

/**
 * Batch request containing multiple operations to execute in sequence.
 * Operations are executed in order, and failures do not stop execution.
 */
export interface BatchRequest {
  /**
   * Array of operations to execute in sequence
   */
  operations: Array<{
    operation: string;
    element_type?: ElementType;
    elementType?: ElementType;
    params?: Record<string, unknown>;
  }>;
}

/**
 * Individual result in a batch operation response
 */
export interface BatchOperationResult {
  /**
   * Index of the operation in the batch (0-based)
   */
  index: number;

  /**
   * Operation that was executed
   */
  operation: string;

  /**
   * Result of the operation
   */
  result: OperationResult;
}

/**
 * Result of a batch operation request.
 * success=false when the batch itself is rejected (e.g. exceeds size limit).
 */
export interface BatchResult {
  success: boolean;

  /**
   * Array of individual operation results
   */
  results: BatchOperationResult[];

  /**
   * Summary statistics
   */
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };

  /** Batch-level error message (present when success=false) */
  error?: string;

  /** Request correlation and timing metadata for the overall batch (Issue #301) */
  _meta: ResponseMeta;
}

/**
 * Successful operation result.
 * Data contains the operation-specific result payload.
 */
export interface OperationSuccess {
  success: true;
  /** Operation-specific result payload */
  data: unknown;
  /** Request correlation and timing metadata (Issue #301) */
  _meta: ResponseMeta;
  error?: never;
}

/**
 * Failed operation result.
 * Error contains a human-readable error message.
 */
export interface OperationFailure {
  success: false;
  /** Human-readable error message */
  error: string;
  /** Request correlation and timing metadata (Issue #301) */
  _meta: ResponseMeta;
  data?: never;
}

/**
 * Standard result type for all MCP-AQL operations.
 * Discriminated union ensures type safety:
 * - success: true → data is present, error is absent
 * - success: false → error is present, data is absent
 */
export type OperationResult = OperationSuccess | OperationFailure;

/**
 * Response metadata for request correlation and timing.
 * Included in every operation response to enable log correlation and performance monitoring.
 * Issue #301: Request IDs and distributed tracing support.
 */
export interface ResponseMeta {
  /** Correlation ID from ContextTracker (matches correlationId in log entries) */
  requestId: string;
  /** Wall-clock milliseconds for the operation */
  durationMs: number;
  /** ISO 8601 response timestamp */
  timestamp: string;
}

/**
 * Operation categories mapped to their safety annotations
 */
export interface OperationSafety {
  readOnly: boolean;
  destructive: boolean;
}

/**
 * Map of endpoint names to their safety annotations
 */
export const ENDPOINT_SAFETY: Record<string, OperationSafety> = {
  mcp_aql_create: {
    readOnly: false,
    destructive: false,
  },
  mcp_aql_read: {
    readOnly: true,
    destructive: false,
  },
  mcp_aql_update: {
    readOnly: false,
    destructive: true,
  },
  mcp_aql_delete: {
    readOnly: false,
    destructive: true,
  },
};

/**
 * Operation names grouped by endpoint
 */
export const ENDPOINT_OPERATIONS = {
  create: ['create_element', 'import_element', 'addEntry', 'activate_element'],
  read: [
    'list_elements',
    'get_element',
    'search_elements',
    'query_elements',
    'get_active_elements',
    'validate_element',
    'render',
    'export_element',
    'deactivate_element',
    'introspect',
  ],
  update: ['edit_element'],
  delete: ['delete_element', 'execute_agent', 'clear'],
} as const;

/**
 * Type guard to check if a string is a valid ElementType.
 * Accepts both singular ("memory") and plural ("memories") forms.
 * Issue #433: Users and LLMs naturally use either form.
 */
export function isElementType(value: unknown): value is ElementType {
  if (typeof value !== 'string') return false;
  // Accept canonical MCP-AQL singular values
  if (Object.values(ElementType).includes(value as ElementType)) return true;
  // Also accept plural portfolio-layer values (Issue #433)
  return value.toLowerCase() in ELEMENT_TYPE_MAP;
}

/**
 * Type guard to check if an object is a valid OperationInput
 * Issue #290: Accepts both element_type (snake_case) and elementType (camelCase)
 */
export function isOperationInput(value: unknown): value is OperationInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const input = value as Record<string, unknown>;

  // operation is required and must be a string
  if (typeof input.operation !== 'string') {
    return false;
  }

  // Issue #290: Accept both element_type and elementType
  // elementType/element_type is optional but must be a valid ElementType if present
  const elementTypeValue = input.element_type ?? input.elementType;
  if (elementTypeValue !== undefined && !isElementType(elementTypeValue)) {
    return false;
  }

  // params is optional but must be a plain object (not array, not null) if present
  if (
    input.params !== undefined &&
    (typeof input.params !== 'object' ||
      input.params === null ||
      Array.isArray(input.params))
  ) {
    return false;
  }

  return true;
}

/**
 * Type guard to check if an object is a valid OperationResult
 */
export function isOperationResult(value: unknown): value is OperationResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const result = value as Record<string, unknown>;

  // success is required and must be a boolean
  if (typeof result.success !== 'boolean') {
    return false;
  }

  // error must be a string if present
  if (result.error !== undefined && typeof result.error !== 'string') {
    return false;
  }

  // _meta is required (Issue #301: request correlation metadata)
  if (typeof result._meta !== 'object' || result._meta === null) {
    return false;
  }

  return true;
}

/**
 * Type guard to check if an object is a valid BatchRequest
 */
export function isBatchRequest(value: unknown): value is BatchRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const input = value as Record<string, unknown>;

  // operations is required and must be an array
  if (!Array.isArray(input.operations)) {
    return false;
  }

  // Each operation must be a valid OperationInput structure
  return input.operations.every((op) => {
    if (typeof op !== 'object' || op === null) {
      return false;
    }
    const operation = op as Record<string, unknown>;

    // operation field is required and must be a string
    if (typeof operation.operation !== 'string') {
      return false;
    }

    // elementType is optional but must be a valid ElementType if present
    if (operation.elementType !== undefined && !isElementType(operation.elementType)) {
      return false;
    }

    // params is optional but must be a plain object if present
    if (
      operation.params !== undefined &&
      (typeof operation.params !== 'object' ||
        operation.params === null ||
        Array.isArray(operation.params))
    ) {
      return false;
    }

    return true;
  });
}

// ============================================================================
// Silent JSON Fallback Support (Issue #205)
// ============================================================================

/**
 * Legacy tool format that some LLMs might generate.
 * This is NOT documented but silently supported for resilience.
 *
 * NOTE: Only one of args/params should be used; if both are present,
 * args takes precedence.
 */
interface LegacyToolFormat {
  tool: string;
  /** Operation arguments (takes precedence over params) */
  args?: Record<string, unknown>;
  /** Operation parameters (used only if args not present) */
  params?: Record<string, unknown>;
}

/**
 * Type guard to check if input is in legacy tool format.
 * Supports: { tool: 'operation_name', args: {...} }
 *       or: { tool: 'operation_name', params: {...} }
 *
 * INTERNAL USE ONLY - Not documented to users.
 * Issue #205: Silent JSON fallback for edge cases.
 */
export function isLegacyToolFormat(value: unknown): value is LegacyToolFormat {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const input = value as Record<string, unknown>;

  // Must have 'tool' as a string
  if (typeof input.tool !== 'string') {
    return false;
  }

  // args/params are optional but must be objects if present
  if (input.args !== undefined) {
    if (typeof input.args !== 'object' || input.args === null || Array.isArray(input.args)) {
      return false;
    }
  }

  if (input.params !== undefined) {
    if (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params)) {
      return false;
    }
  }

  return true;
}

/**
 * Convert legacy tool format to proper OperationInput.
 *
 * PRECEDENCE RULES:
 * 1. If `args` is present (even if empty {}), use `args`
 * 2. Otherwise, if `params` is present, use `params`
 * 3. If neither present, use empty object {}
 *
 * EDGE CASE: { tool: 'x', args: { a: 1 }, params: { b: 2 } }
 * Result: { operation: 'x', params: { a: 1 } } (args wins, params ignored)
 *
 * INTERNAL USE ONLY - Not documented to users.
 * Issue #205: Silent JSON fallback for edge cases.
 */
export function convertLegacyToMCPAQL(legacy: LegacyToolFormat): OperationInput {
  return {
    operation: legacy.tool,
    // Prefer 'args' over 'params' for legacy compatibility
    params: legacy.args || legacy.params || {},
  };
}

/**
 * Input format types for internal metrics tracking.
 * Issue #205: Silent JSON fallback for edge cases.
 */
export type InputFormat = 'proper' | 'legacy_converted' | 'permission_prompt_protocol' | 'invalid';

/**
 * Internal metrics for input format tracking.
 * Not exposed to users; for monitoring purposes only.
 *
 * High legacy_converted ratio might indicate:
 * - Documentation issues
 * - Model confusion
 * - Need for better prompt engineering
 */
export class InputFormatMetrics {
  private static counts: Record<InputFormat, number> = {
    proper: 0,
    legacy_converted: 0,
    permission_prompt_protocol: 0,
    invalid: 0,
  };

  /**
   * Record an input format event
   */
  static record(format: InputFormat): void {
    this.counts[format]++;
  }

  /**
   * Get current metrics snapshot
   */
  static getMetrics(): Readonly<Record<InputFormat, number>> {
    return { ...this.counts };
  }

  /**
   * Reset metrics (mainly for testing)
   */
  static reset(): void {
    this.counts = {
      proper: 0,
      legacy_converted: 0,
      permission_prompt_protocol: 0,
      invalid: 0,
    };
  }
}

/**
 * Parse and normalize operation input, handling multiple formats.
 *
 * Supports:
 * 1. Proper MCP-AQL format: { operation: 'x', params: {...} }
 * 2. Legacy tool format: { tool: 'x', args: {...} } (silent fallback)
 *
 * Issue #205: Silent JSON fallback for edge cases.
 *
 * @param input - Raw input to parse
 * @returns Normalized OperationInput or null if invalid
 */
export function parseOperationInput(input: unknown): OperationInput | null {
  // Primary path: proper MCP-AQL format
  if (isOperationInput(input)) {
    InputFormatMetrics.record('proper');
    // Issue #290: Normalize element_type to elementType for internal consistency
    // Issue #433: Also normalize plural forms ("memories") to MCP-AQL singular ("memory")
    const raw = input as unknown as Record<string, unknown>;
    const rawTypeValue = (raw.element_type ?? raw.elementType) as string | undefined;

    if (rawTypeValue) {
      const normalizedType = normalizeMCPAQLElementType(rawTypeValue);
      return {
        ...input,
        elementType: normalizedType,
        element_type: normalizedType,
      } as OperationInput;
    }

    return input;
  }

  // Fallback: legacy tool format (silent conversion)
  if (isLegacyToolFormat(input)) {
    InputFormatMetrics.record('legacy_converted');
    // Note: No user-visible logging here - this is a silent fallback
    return convertLegacyToMCPAQL(input);
  }

  // Permission prompt protocol adaptation (Issue #647)
  // Claude Code --permission-prompt-tool sends {tool_name, input, agent_identity?}
  // without an operation field. Unambiguous: no other CRUDE operation uses
  // tool_name as a top-level parameter.
  if (input && typeof input === 'object' && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).tool_name === 'string'
      && !(input as Record<string, unknown>).operation) {
    const raw = input as Record<string, unknown>;
    InputFormatMetrics.record('permission_prompt_protocol');
    return {
      operation: 'permission_prompt',
      params: raw,
    };
  }

  // Invalid format — input matched none of: {operation, ...}, {tool, ...}, {tool_name, ...}
  // Callers handle null by returning an "invalid input" error to the client.
  InputFormatMetrics.record('invalid');
  return null;
}

/**
 * Generate a diagnostic summary of invalid input for error messages.
 * Helps agents and developers understand what was actually received when
 * parsing fails — especially useful for debugging parallel-call issues (#1656).
 *
 * @param input - The raw input that failed to parse
 * @returns Human-readable diagnostic string describing what was received
 *
 * @example
 * describeInvalidInput(null)
 * // => 'Received: null'
 *
 * describeInvalidInput({ params: { element_name: 'x' } })
 * // => 'Received: { params } (missing "operation" field)'
 *
 * describeInvalidInput([{ operation: 'addEntry' }, { operation: 'addEntry' }])
 * // => 'Received: array with 2 items (use { operations: [...] } for batch calls)'
 *
 * describeInvalidInput({ operation: 123, params: {} })
 * // => 'Received: { operation, params } ("operation" is number, expected string)'
 */
export function describeInvalidInput(input: unknown): string {
  if (input === null) return 'Received: null';
  if (input === undefined) return 'Received: undefined';
  if (Array.isArray(input)) return `Received: array with ${input.length} items (use { operations: [...] } for batch calls)`;
  if (typeof input !== 'object') return `Received: ${typeof input}`;

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Truncate key list for very large inputs
  const keyPreview = keys.length > 8
    ? keys.slice(0, 8).join(', ') + `, ... (${keys.length} keys total)`
    : keys.join(', ');

  const hints: string[] = [];
  if (!keys.includes('operation')) {
    hints.push('missing "operation" field');
  } else if (typeof obj.operation !== 'string') {
    hints.push(`"operation" is ${typeof obj.operation}, expected string`);
  }

  const hintStr = hints.length > 0 ? ` (${hints.join('; ')})` : '';
  return `Received: { ${keyPreview} }${hintStr}`;
}

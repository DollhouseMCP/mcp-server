/**
 * SchemaDispatcher - Generic dispatcher for schema-driven operations
 *
 * This module provides automatic dispatch from operation schemas to handler methods.
 * It eliminates the need for manual switch statements in MCPAQLHandler by:
 *
 * 1. Looking up operation in schema
 * 2. Resolving handler from registry
 * 3. Building method arguments from params
 * 4. Calling the handler method
 * 5. Applying field selection/transformation to response (Issue #202)
 *
 * ARCHITECTURE:
 * - SchemaDispatcher.dispatch(operation, params, registry) → Promise<unknown>
 * - Uses argBuilder to determine how to pass parameters to handler
 * - Validates required parameters before dispatch
 * - Provides clear error messages for missing handlers/methods
 *
 * INPUT NORMALIZATION (Issue #251):
 * - Parameters can have multiple sources via `sources` field
 * - Resolution order: sources[0], sources[1], ..., params[key]
 * - Supports dot notation: 'input.elementType', 'params.type'
 * - Operations with `needsFullInput: true` have access to full OperationInput
 *
 * FIELD SELECTION (Issue #202):
 * - When `fields` param is provided, filters response to requested fields only
 * - Transforms field names for LLM consistency (name → element_name)
 * - Supports preset field sets: 'minimal', 'standard', 'full'
 *
 * @see Issue #247 - Schema-driven operation definitions
 * @see Issue #251 - ElementCRUD input normalization
 * @see Issue #202 - GraphQL field selection for response token optimization
 */

import yaml from 'js-yaml';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import {
  getOperationSchema,
  isSchemaOperation,
  type OperationDef,
  type ParamSchema,
  type ParamDef,
  type HandlerKey,
} from './OperationSchema.js';
import { IntrospectionResolver } from './IntrospectionResolver.js';
import { NormalizerRegistry } from './normalizers/index.js';
import type { NormalizerContext } from './normalizers/types.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import type { OperationInput } from './types.js';
import { ElementType } from '../../portfolio/types.js';
// Note: Field selection is now applied at MCPAQLHandler level (Issue #202)

// ============================================================================
// Input Normalization (Issue #251)
// ============================================================================

/**
 * Validate property path to prevent prototype pollution attacks.
 * Only allows alphanumeric characters, underscores, and dots.
 */
const SAFE_PATH_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/;
const FORBIDDEN_PATHS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve a value from a dot-notation path on an object.
 * Example: getNestedValue({ input: { elementType: 'persona' } }, 'input.elementType') => 'persona'
 *
 * Security: Validates path format and blocks prototype pollution vectors.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // Validate path format to prevent injection attacks
  if (!SAFE_PATH_PATTERN.test(path)) {
    throw new Error(`Invalid property path format: ${path}`);
  }

  const parts = path.split('.');

  // Check for prototype pollution attempts
  for (const part of parts) {
    if (FORBIDDEN_PATHS.has(part)) {
      throw new Error(`Forbidden property path segment: ${part}`);
    }
  }

  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Resolve a parameter value from multiple sources.
 *
 * The resolution order is:
 * 1. Check each source in `sources` array (if defined)
 * 2. Fall back to the direct parameter value
 * 3. Fall back to default value (if defined)
 *
 * @param key - Parameter name
 * @param def - Parameter definition with possible sources
 * @param context - Resolution context containing input, params, and raw params
 * @returns Resolved value or undefined
 */
function resolveParamValue(
  key: string,
  def: ParamDef,
  context: {
    input?: OperationInput;
    params: Record<string, unknown>;
  }
): unknown {
  // If sources are defined, check them in order
  if (def.sources && def.sources.length > 0) {
    for (const source of def.sources) {
      // Build the resolution context as a flat object for getNestedValue
      const resolveContext: Record<string, unknown> = {
        params: context.params,
      };

      // Add input fields to the context if available
      if (context.input) {
        resolveContext.input = context.input;
      }

      const value = getNestedValue(resolveContext, source);
      if (value !== undefined) {
        return value;
      }
    }
  }

  // Fall back to direct param value
  const directValue = context.params[key];
  if (directValue !== undefined) {
    return directValue;
  }

  // Fall back to default
  return def.default;
}

// ============================================================================
// Parameter Style Conversion (Issue #252)
// ============================================================================

/**
 * Convert a snake_case string to camelCase.
 *
 * @example
 * snakeToCamel('dry_run') => 'dryRun'
 * snakeToCamel('max_results') => 'maxResults'
 * snakeToCamel('already_camel') => 'alreadyCamel'
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Apply param style conversion to a key based on the operation schema.
 * Individual `mapTo` overrides take precedence over style conversion.
 */
function applyParamStyle(
  key: string,
  def: ParamDef,
  paramStyle?: 'snakeToCamel'
): string {
  // Explicit mapTo takes precedence
  if (def.mapTo) {
    return def.mapTo;
  }

  // Apply style conversion if specified
  if (paramStyle === 'snakeToCamel') {
    return snakeToCamel(key);
  }

  // Default: use original key
  return key;
}

// ============================================================================
// Parameter Mapping
// ============================================================================

/**
 * Map input parameters to handler arguments based on param schema.
 * Supports multi-source parameter resolution and param style conversion.
 */
function mapParams(
  params: Record<string, unknown>,
  schema: ParamSchema,
  input?: OperationInput,
  paramStyle?: 'snakeToCamel'
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  const context = { input, params };

  for (const [key, def] of Object.entries(schema)) {
    const value = resolveParamValue(key, def, context);
    const targetKey = applyParamStyle(key, def, paramStyle);

    if (value !== undefined) {
      mapped[targetKey] = value;
    }
  }

  return mapped;
}

/**
 * Validate required parameters are present.
 *
 * Uses multi-source resolution to check all possible sources for each
 * required parameter. Provides detailed error messages showing:
 * - Which parameter is missing
 * - Which sources were checked (in order)
 * - What was actually provided in params
 *
 * @param params - Parameters provided by the caller
 * @param schema - Parameter schema defining requirements
 * @param operation - Operation name for error context
 * @param input - Optional full OperationInput for source resolution
 * @throws Error with debugging context if required parameter is missing
 */
function validateRequiredParams(
  params: Record<string, unknown>,
  schema: ParamSchema,
  operation: string,
  input?: OperationInput
): void {
  const context = { input, params };

  for (const [key, def] of Object.entries(schema)) {
    if (def.required) {
      const value = resolveParamValue(key, def, context);
      if (value === undefined) {
        // Build detailed error message for debugging
        const sourcesChecked = def.sources
          ? `Sources checked (in order): [${def.sources.join(' → ')}] → params.${key}`
          : `Source: params.${key}`;

        const providedParams = Object.keys(params).length > 0
          ? `Provided params: {${Object.keys(params).join(', ')}}`
          : 'No params provided';

        // Issue #290: Check both snake_case and camelCase for element_type
        const elementTypeValue = input?.element_type || input?.elementType;
        const hasElementType = elementTypeValue
          ? `input.element_type: '${elementTypeValue}'`
          : 'input.element_type: undefined';

        throw new Error(
          `Missing required parameter '${key}' for operation '${operation}'. ` +
          `${sourcesChecked}. ${providedParams}. ${hasElementType}`
        );
      }
    }
  }
}

// ============================================================================
// Type Validation (Issue #255)
// ============================================================================

/**
 * Get a human-readable type description for error messages
 */
function getActualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a single parameter value against its type definition
 *
 * @param value - The parameter value to validate
 * @param def - The parameter definition from schema
 * @param key - The parameter name (for error messages)
 * @param operation - The operation name (for error messages)
 * @throws Error if type validation fails
 *
 * @see Issue #255 - Runtime type validation
 */
function validateParamType(
  value: unknown,
  def: ParamDef,
  key: string,
  operation: string
): void {
  // Skip validation for undefined values (handled by required check)
  if (value === undefined) return;

  const actualType = getActualType(value);

  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be a string, got ${actualType}`
        );
      }
      break;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be a number, got ${actualType}`
        );
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be a boolean, got ${actualType}`
        );
      }
      break;

    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be an object, got ${actualType}`
        );
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be an array, got ${actualType}`
        );
      }
      break;

    case 'string[]':
      if (!Array.isArray(value)) {
        throw new Error(
          `Parameter '${key}' for operation '${operation}' must be a string array, got ${actualType}`
        );
      }
      // Validate array elements are strings
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== 'string') {
          throw new Error(
            `Parameter '${key}[${i}]' for operation '${operation}' must be a string, got ${getActualType(value[i])}`
          );
        }
      }
      break;

    case 'unknown':
      // Allow any type - no validation needed
      break;
  }
}

/**
 * Validate all parameter types against schema definitions
 *
 * @param params - The parameters to validate
 * @param schema - The parameter schema
 * @param operation - The operation name (for error messages)
 * @throws Error if any type validation fails
 *
 * @see Issue #255 - Runtime type validation
 */
function validateParamTypes(
  params: Record<string, unknown>,
  schema: ParamSchema,
  operation: string
): void {
  for (const [key, def] of Object.entries(schema)) {
    const value = params[key];
    validateParamType(value, def, key, operation);
  }
}

// ============================================================================
// Handler Resolution
// ============================================================================

/**
 * Type guard to check if a value is a non-null object.
 * Used for safe property access without type assertions.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Type guard to check if an object has a callable method.
 * Provides type-safe method lookup without unsafe assertions.
 *
 * @param obj - Object to check
 * @param methodName - Name of method to look for
 * @returns True if obj has a function property with the given name
 */
function hasMethod(
  obj: unknown,
  methodName: string
): obj is Record<string, (...args: unknown[]) => unknown> {
  return isObject(obj) && typeof obj[methodName] === 'function';
}

/**
 * Get handler from registry with proper error handling.
 *
 * Resolves a handler by key from the registry, providing clear error messages
 * when handlers are missing. Differentiates between required and optional handlers.
 *
 * @param registry - Handler registry containing all configured handlers
 * @param handlerKey - Key identifying which handler to retrieve
 * @param operation - Operation name for error context
 * @param optional - Whether the handler is optional (affects error messaging)
 * @returns The resolved handler
 * @throws Error if handler is not configured
 */
function getHandler(
  registry: HandlerRegistry,
  handlerKey: HandlerKey,
  operation: string,
  optional: boolean
): unknown {
  const handler = registry[handlerKey as keyof HandlerRegistry];

  if (!handler && !optional) {
    throw new Error(
      `Handler '${handlerKey}' is required for operation '${operation}' but not configured. ` +
      `Ensure the handler is registered in the HandlerRegistry.`
    );
  }

  if (!handler && optional) {
    throw new Error(
      `${handlerKey.charAt(0).toUpperCase() + handlerKey.slice(1)} operations not available: ` +
      `${handlerKey} not configured. This is an optional handler that may not be available in all configurations.`
    );
  }

  return handler;
}

/**
 * Get method from handler with type-safe lookup.
 *
 * Uses type guards instead of unsafe type assertions to verify the handler
 * has the expected method. Provides detailed error messages for debugging.
 *
 * @param handler - Handler object to get method from
 * @param methodName - Name of the method to retrieve
 * @param handlerKey - Handler key for error context
 * @param operation - Operation name for error context
 * @returns Bound method ready to call
 * @throws Error if method is not found or is not callable
 */
function getMethod(
  handler: unknown,
  methodName: string,
  handlerKey: string,
  operation: string
): (...args: unknown[]) => Promise<unknown> {
  // Use type guard instead of unsafe assertion
  if (!hasMethod(handler, methodName)) {
    const availableMethods = isObject(handler)
      ? Object.keys(handler).filter(k => typeof handler[k] === 'function')
      : [];

    throw new Error(
      `Method '${methodName}' not found on handler '${handlerKey}' for operation '${operation}'. ` +
      `Available methods: [${availableMethods.join(', ') || 'none'}]`
    );
  }

  // Now TypeScript knows handler[methodName] is a function
  const method = handler[methodName];
  return method.bind(handler) as (...args: unknown[]) => Promise<unknown>;
}

// ============================================================================
// Argument Building
// ============================================================================

/**
 * Params that are handled at the dispatch level and should NOT be passed to handlers.
 * These are cross-cutting concerns processed by SchemaDispatcher itself.
 *
 * @see Issue #202 - fields is used for response filtering, not by handlers
 */
const DISPATCH_ONLY_PARAMS = new Set(['fields']);

/**
 * Filter out dispatch-only params from a params object.
 * These params are handled at the dispatch level (e.g., field selection)
 * and should not be passed to handlers.
 */
function filterDispatchOnlyParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!DISPATCH_ONLY_PARAMS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Build arguments for handler method based on argBuilder type
 *
 * - 'single': Pass params in schema order as positional args (default)
 * - 'spread': Pass query + remaining params
 * - 'named': Pass mapped params as named object
 * - 'namedWithType': Like 'named' but ensures 'type' is included from resolved sources
 * - 'typeWithParams': Pass resolved type + full params object
 *
 * Note: Params in DISPATCH_ONLY_PARAMS are filtered out before passing to handlers.
 */
function buildArgs(
  params: Record<string, unknown>,
  schema: OperationDef,
  mappedParams: Record<string, unknown>,
  input?: OperationInput
): unknown[] {
  const builder = schema.argBuilder ?? 'single';

  switch (builder) {
    case 'spread':
      // For handlers that take (query, options)
      return [params.query, filterDispatchOnlyParams(params)];

    case 'named': {
      // For handlers that take a named params object
      // Filter out dispatch-only params
      const filtered = filterDispatchOnlyParams(mappedParams);
      return [filtered];
    }

    case 'namedWithType': {
      // Like 'named' but ensures 'elementType' and 'elementName' are available
      // This handles the ElementCRUD pattern where type comes from input.element_type OR params.element_type
      // Issue #290: element_name maps to elementName, element_type maps to elementType
      const result = { ...mappedParams };

      // If 'elementType' wasn't in mappedParams but is available from input.element_type (or legacy elementType), add it
      // Issue #290: Prefer snake_case element_type, fallback to camelCase elementType for backward compat
      if (!result.elementType && (input?.element_type || input?.elementType)) {
        result.elementType = input.element_type || input.elementType;
      }
      // Set 'type' from 'elementType' for handlers that expect it
      if (!result.type && result.elementType) {
        result.type = result.elementType;
      }
      // Set 'name' from 'elementName' for handlers that expect it (Issue #290)
      if (!result.name && result.elementName) {
        result.name = result.elementName;
      }

      // Issue #278: For ensembles, merge top-level elements into metadata
      // LLMs often pass elements at params level, not inside metadata
      // Issue #290: Prefer snake_case element_type, fallback to camelCase elementType
      const resolvedType = result.elementType || result.type || input?.element_type || input?.elementType;
      // Check for ensemble type (handles both plural constant and singular form)
      const isEnsemble = resolvedType === ElementType.ENSEMBLE || resolvedType === 'ensemble';
      if (isEnsemble) {
        const elements = params.elements;
        const currentMetadata = result.metadata as Record<string, unknown> | undefined;
        if (elements && (!currentMetadata || !currentMetadata.elements)) {
          result.metadata = { ...currentMetadata, elements };
        }
      }

      // Issue #722: Common fields (tags, triggers) — LLMs pass at params level for any element type.
      {
        let currentMeta = result.metadata as Record<string, unknown> | undefined;
        let updatedMeta = currentMeta;

        if (params.tags !== undefined && Array.isArray(params.tags) && (!updatedMeta || updatedMeta.tags === undefined)) {
          updatedMeta = { ...updatedMeta, tags: params.tags };
        }
        if (params.triggers !== undefined && Array.isArray(params.triggers) && (!updatedMeta || updatedMeta.triggers === undefined)) {
          updatedMeta = { ...updatedMeta, triggers: params.triggers };
        }

        if (updatedMeta !== currentMeta) {
          result.metadata = updatedMeta;
        }
      }

      // Agent V2 fields: goal, activates, tools, systemPrompt, autonomy, resilience
      const isAgent = resolvedType === ElementType.AGENT || resolvedType === 'agent';
      if (isAgent) {
        const currentMetadata = result.metadata as Record<string, unknown> | undefined;
        let updatedMetadata = currentMetadata;

        if (params.goal !== undefined && (!updatedMetadata || updatedMetadata.goal === undefined)) {
          updatedMetadata = { ...updatedMetadata, goal: params.goal };
        }
        if (params.activates !== undefined && (!updatedMetadata || updatedMetadata.activates === undefined)) {
          updatedMetadata = { ...updatedMetadata, activates: params.activates };
        }
        if (params.tools !== undefined && (!updatedMetadata || updatedMetadata.tools === undefined)) {
          updatedMetadata = { ...updatedMetadata, tools: params.tools };
        }
        // Issue #725: Accept both systemPrompt and system_prompt (LLMs commonly use snake_case)
        const systemPromptValue = params.systemPrompt ?? params.system_prompt;
        if (systemPromptValue !== undefined && (!updatedMetadata || updatedMetadata.systemPrompt === undefined)) {
          updatedMetadata = { ...updatedMetadata, systemPrompt: systemPromptValue };
        }
        if (params.autonomy !== undefined && (!updatedMetadata || updatedMetadata.autonomy === undefined)) {
          updatedMetadata = { ...updatedMetadata, autonomy: params.autonomy };
        }
        // Issue #722: resilience was missing from the agent V2 merge
        if (params.resilience !== undefined && (!updatedMetadata || updatedMetadata.resilience === undefined)) {
          updatedMetadata = { ...updatedMetadata, resilience: params.resilience };
        }

        if (updatedMetadata !== currentMetadata) {
          result.metadata = updatedMetadata;
        }
      }

      // Issue #666: LLMs often pass gatekeeper at top-level params, not inside metadata.
      // Merge it into metadata for all element types.
      if (params.gatekeeper && typeof params.gatekeeper === 'object') {
        const currentMeta = result.metadata as Record<string, unknown> | undefined;
        if (!currentMeta || !currentMeta.gatekeeper) {
          console.debug(`[SchemaDispatcher] Merging top-level gatekeeper into metadata for element '${result.name ?? 'unknown'}'`);
          result.metadata = { ...currentMeta, gatekeeper: params.gatekeeper };
        }
      }

      // Filter out dispatch-only params before returning
      return [filterDispatchOnlyParams(result)];
    }

    case 'typeWithParams': {
      // Pass resolved type + full params object (minus dispatch-only params)
      // Used for operations like list_elements that need (type, paginationParams)
      // Issue #290: element_type maps to elementType, with backward compat for type
      // Prefer snake_case element_type, fallback to camelCase elementType
      const resolvedType = mappedParams.elementType ?? mappedParams.type ?? input?.element_type ?? input?.elementType;
      return [resolvedType, filterDispatchOnlyParams(params)];
    }

    case 'single':
    default: {
      // Extract params in schema order, using resolved values
      if (!schema.params || Object.keys(schema.params).length === 0) {
        return [];
      }

      // For simple handlers, pass resolved params in schema order
      // Skip dispatch-only params (like 'fields') that are handled by SchemaDispatcher
      const args: unknown[] = [];
      for (const key of Object.keys(schema.params)) {
        // Skip dispatch-level params that shouldn't be passed to handlers
        if (DISPATCH_ONLY_PARAMS.has(key)) {
          continue;
        }
        // Use mapped value if available (handles source resolution)
        const targetKey = schema.params[key].mapTo ?? key;
        args.push(mappedParams[targetKey]);
      }
      return args;
    }
  }
}

// ============================================================================
// Special Operation Handlers
// ============================================================================

/**
 * Handle introspection operation (uses IntrospectionResolver directly)
 */
async function handleIntrospection(
  params: Record<string, unknown>
): Promise<unknown> {
  return IntrospectionResolver.resolve(params);
}

/**
 * Handle build info operation (formats output)
 */
async function handleBuildInfo(
  registry: HandlerRegistry
): Promise<unknown> {
  const service = registry.buildInfoService;
  if (!service) {
    throw new Error('BuildInfo operations not available: BuildInfoService not configured');
  }

  const info = await service.getBuildInfo();
  return {
    content: [{
      type: 'text',
      text: service.formatBuildInfo(info),
    }],
  };
}

/**
 * Handle cache budget report operation (formats output as markdown table)
 */
function handleCacheBudgetReport(
  registry: HandlerRegistry
): unknown {
  const budget = registry.cacheMemoryBudget;
  if (!budget) {
    throw new Error('Cache budget not available: CacheMemoryBudget not configured');
  }

  const report = budget.getReport();
  const lines: string[] = [
    '# Cache Memory Budget Report',
    '',
    `**Budget:** ${report.budgetMB} MB`,
    `**Used:** ${report.totalMemoryMB} MB (${report.utilizationPercent}%)`,
    `**Registered Caches:** ${report.caches.length}`,
    '',
  ];
  if (report.caches.length > 0) {
    lines.push('| Cache | Entries | Memory (MB) | Hit Rate | Last Activity |');
    lines.push('|-------|---------|-------------|----------|---------------|');
    for (const c of report.caches) {
      const activity = c.lastActivityMs > 0
        ? `${((Date.now() - c.lastActivityMs) / 1000).toFixed(0)}s ago`
        : 'never';
      lines.push(`| ${c.name} | ${c.entries} | ${c.memoryMB} | ${(c.hitRate * 100).toFixed(1)}% | ${activity} |`);
    }
  } else {
    lines.push('_No caches registered._');
  }
  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

/**
 * ExportPackage interface for element export.
 * Matches the format expected by import operations.
 */
interface ExportPackage {
  exportVersion: string;
  exportedAt: string;
  elementType: string;
  elementName: string;
  format: 'json' | 'yaml';
  data: string;
}

/**
 * Handle element export operation.
 * Returns an ExportPackage that can be used for import operations.
 */
async function handleExportElement(
  mappedParams: Record<string, unknown>,
  registry: HandlerRegistry
): Promise<ExportPackage> {
  const handler = registry.elementCRUD;
  if (!handler) {
    throw new Error('ElementCRUD operations not available: handler not configured');
  }

  // Get the exportable data from the element
  // Issue #290: Use mapped names (elementName, elementType) from schema mapTo
  const name = mappedParams.elementName as string;
  const type = mappedParams.elementType as string;
  const format = (mappedParams.format as 'json' | 'yaml') || 'json';

  // Use the element query service to get element details
  const elementDetails = await handler.getElementDetails(name, type);
  if (!elementDetails) {
    throw new Error(`Element not found: ${type}/${name}`);
  }

  // Build export package (matches MCPAQLHandler.handleExportElement format)
  const exportPackage: ExportPackage = {
    exportVersion: '1.0',
    exportedAt: new Date().toISOString(),
    elementType: type,
    elementName: name,
    format,
    data: '',
  };

  // Serialize to requested format
  if (format === 'yaml') {
    exportPackage.data = yaml.dump(elementDetails, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });
  } else {
    exportPackage.data = JSON.stringify(elementDetails, null, 2);
  }

  return exportPackage;
}

/**
 * Handle element import operation.
 * Parses export package and delegates to ElementCRUD.
 *
 * Supports two export package formats:
 * 1. MCPAQLHandler format: { exportVersion, elementType, elementName, format, data }
 * 2. Legacy format: { version, element: { type, name, ... } }
 */
async function handleImportElement(
  mappedParams: Record<string, unknown>,
  registry: HandlerRegistry
): Promise<unknown> {
  const handler = registry.elementCRUD;
  if (!handler) {
    throw new Error('ElementCRUD operations not available: handler not configured');
  }

  const data = mappedParams.data;
  const overwrite = mappedParams.overwrite as boolean | undefined;

  // Parse the export package (accept string or already-parsed object)
  let exportPackage: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      exportPackage = JSON.parse(data);
    } catch {
      throw new Error('Invalid export package: not valid JSON');
    }
  } else if (typeof data === 'object' && data !== null) {
    exportPackage = data as Record<string, unknown>;
  } else {
    throw new Error('Invalid export package: data must be a string or object');
  }

  // Determine element details based on package format
  let elementType: string;
  let elementName: string;
  let elementData: Record<string, unknown>;

  if (exportPackage.elementType && exportPackage.data) {
    // MCPAQLHandler format: { exportVersion, elementType, elementName, format, data }
    elementType = exportPackage.elementType as string;
    elementName = exportPackage.elementName as string;
    const format = exportPackage.format as string | undefined;

    // Parse the nested data field based on format
    const nestedData = exportPackage.data;
    if (typeof nestedData === 'string') {
      try {
        if (format === 'yaml') {
          // Use SecureYamlParser.parseRawYaml for safe YAML parsing (CORE_SCHEMA, size limits)
          elementData = SecureYamlParser.parseRawYaml(nestedData);
        } else {
          elementData = JSON.parse(nestedData);
        }
      } catch {
        throw new Error(`Invalid export package: data field is not valid ${format || 'JSON'}`);
      }
    } else if (typeof nestedData === 'object' && nestedData !== null) {
      elementData = nestedData as Record<string, unknown>;
    } else {
      throw new Error('Invalid export package: data field must be string or object');
    }
  } else if (exportPackage.element) {
    // Legacy format: { version, element: { type, name, ... } }
    const element = exportPackage.element as Record<string, unknown>;
    elementType = element.type as string;
    elementName = element.name as string;
    elementData = element;
  } else {
    throw new Error('Invalid export package: missing element data');
  }

  // Check if element already exists when overwrite is false
  if (!overwrite) {
    try {
      const existing = await handler.getElementDetails(elementName, elementType);
      if (existing) {
        throw new Error(
          `Element '${elementName}' already exists. Use overwrite: true to replace.`
        );
      }
    } catch (e) {
      // Element doesn't exist, which is what we want
      if (!(e instanceof Error) || !e.message.includes('not found')) {
        throw e;
      }
    }
  }

  // Create the element
  return handler.createElement({
    name: (elementData.name as string) || elementName,
    type: elementType,
    description: (elementData.description as string) || '',
    content: elementData.content as string | undefined,
    instructions: elementData.instructions as string | undefined,
    metadata: elementData.metadata as Record<string, unknown> | undefined,
  });
}

// ============================================================================
// Main Dispatcher
// ============================================================================

/**
 * SchemaDispatcher - Dispatch operations using schema definitions
 *
 * This class provides the core dispatch logic for schema-driven operations.
 * It replaces the manual dispatch methods in MCPAQLHandler for operations
 * that are defined in the schema.
 */
export class SchemaDispatcher {
  /**
   * Check if an operation can be handled by schema dispatch
   */
  static canDispatch(operation: string): boolean {
    return isSchemaOperation(operation);
  }

  /**
   * Dispatch an operation using its schema definition
   *
   * @param operation - Operation name (e.g., 'browse_collection')
   * @param params - Operation parameters
   * @param registry - Handler registry with all configured handlers
   * @param input - Optional full OperationInput for source resolution
   * @returns Promise resolving to operation result
   * @throws Error if operation not found, handler missing, or params invalid
   */
  static async dispatch(
    operation: string,
    params: Record<string, unknown>,
    registry: HandlerRegistry,
    input?: OperationInput
  ): Promise<unknown> {
    // Get schema definition
    const schema = getOperationSchema(operation);
    if (!schema) {
      throw new Error(`No schema definition found for operation '${operation}'`);
    }

    // Apply normalizer if schema specifies one (Issue #243)
    // Normalizers transform raw input params before validation and dispatch
    if (schema.normalizer) {
      const normalizer = NormalizerRegistry.get(schema.normalizer);
      if (!normalizer) {
        throw new Error(
          `Normalizer '${schema.normalizer}' not found for operation '${operation}'. ` +
          `Registered normalizers: [${NormalizerRegistry.list().join(', ') || 'none'}]`
        );
      }

      // Build normalizer context for debugging and future extensibility
      const normalizerContext: NormalizerContext = {
        operation,
        endpoint: schema.endpoint,
        handler: schema.handler,
        method: schema.method,
        elementType: input?.elementType,
      };

      // Normalize params - this may transform, validate, or enrich parameters
      const result = normalizer.normalize(params, normalizerContext);
      if (!result.success) {
        throw new Error(result.error);
      }

      // Use normalized params for the rest of dispatch
      params = result.params as Record<string, unknown>;
    }

    // Determine if we need full input context for source resolution
    const needsInput = schema.needsFullInput && input;

    // Handle special operations
    if (schema.method === '__introspect__') {
      return handleIntrospection(params);
    }

    if (schema.method === '__buildInfo__') {
      return handleBuildInfo(registry);
    }

    if (schema.method === '__cacheBudget__') {
      return handleCacheBudgetReport(registry);
    }

    // Map params according to schema (with input context and param style)
    // For operations with normalizers, the normalized params ARE the mapped params
    // (the normalizer already transforms input to handler-ready format)
    const mappedParams = schema.normalizer
      ? params  // Normalizer already produced the correct output format
      : schema.params
        ? mapParams(params, schema.params, needsInput ? input : undefined, schema.paramStyle)
        : {};

    // Validate params: required params first, then type validation (Issue #255)
    // Skip validation for normalized operations (normalizer handles validation)
    if (schema.params && !schema.normalizer) {
      validateRequiredParams(params, schema.params, operation, needsInput ? input : undefined);
      validateParamTypes(params, schema.params, operation);
    }

    // Handle special ElementCRUD operations
    if (schema.method === '__export__') {
      return handleExportElement(mappedParams, registry);
    }

    if (schema.method === '__import__') {
      return handleImportElement(mappedParams, registry);
    }

    // Get handler from registry
    const handler = getHandler(
      registry,
      schema.handler,
      operation,
      schema.optional ?? false
    );

    // Get method from handler
    const method = getMethod(handler, schema.method, schema.handler, operation);

    // Build arguments based on argBuilder type (with input context if needed)
    const args = buildArgs(params, schema, mappedParams, needsInput ? input : undefined);

    // Call the handler method
    // Note: Field selection is applied at MCPAQLHandler level (Issue #202)
    return method(...args);
  }
}

// ============================================================================
// Exports
// ============================================================================

export { isSchemaOperation, getOperationSchema };

// Test exports for security boundary verification
export const __test__ = {
  getNestedValue,
  SAFE_PATH_PATTERN,
  FORBIDDEN_PATHS,
};

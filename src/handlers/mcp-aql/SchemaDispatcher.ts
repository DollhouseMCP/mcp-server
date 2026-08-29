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
import { SECURITY_LIMITS } from '../../security/constants.js';
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

function getLegacyInputElementType(input?: OperationInput): ElementType | undefined {
  const legacyInput = input as unknown as { elementType?: ElementType } | undefined;
  return legacyInput?.elementType;
}

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
  return str.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
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
    if (!def.required || resolveParamValue(key, def, context) !== undefined) {
      continue;
    }
    throw new Error(buildMissingParamMessage(key, def, operation, params, input));
  }
}

function buildMissingParamMessage(
  key: string,
  definition: ParamDef,
  operation: string,
  params: Record<string, unknown>,
  input?: OperationInput
): string {
  const sourcesChecked = definition.sources
    ? `Sources checked (in order): [${definition.sources.join(' → ')}] → params.${key}`
    : `Source: params.${key}`;
  const providedParams = Object.keys(params).length > 0
    ? `Provided params: {${Object.keys(params).join(', ')}}`
    : 'No params provided';
  const elementTypeValue = input?.element_type || getLegacyInputElementType(input);
  const hasElementType = elementTypeValue
    ? `input.element_type: '${elementTypeValue}'`
    : 'input.element_type: undefined';
  return `Missing required parameter '${key}' for operation '${operation}'. ` +
    `${sourcesChecked}. ${providedParams}. ${hasElementType}`;
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

function isStringOrStringArray(value: unknown): value is string | string[] {
  return typeof value === 'string'
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
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
      assertParamType(typeof value === 'string', key, operation, 'a string', actualType);
      break;

    case 'number':
      assertParamType(typeof value === 'number' && !Number.isNaN(value), key, operation, 'a number', actualType);
      break;

    case 'boolean':
      assertParamType(typeof value === 'boolean', key, operation, 'a boolean', actualType);
      break;

    case 'object':
      assertParamType(
        typeof value === 'object' && value !== null && !Array.isArray(value),
        key,
        operation,
        'an object',
        actualType
      );
      break;

    case 'array':
      assertParamType(Array.isArray(value), key, operation, 'an array', actualType);
      break;

    case 'string[]':
      validateStringArrayParam(value, key, operation, actualType);
      break;

    case 'string | string[]':
      assertParamType(isStringOrStringArray(value), key, operation, 'a string or string array', actualType);
      break;

    case 'unknown':
      // Allow any type - no validation needed
      break;
  }
}

function assertParamType(
  condition: boolean,
  key: string,
  operation: string,
  expected: string,
  actualType: string
): void {
  if (!condition) {
    throw new Error(
      `Parameter '${key}' for operation '${operation}' must be ${expected}, got ${actualType}`
    );
  }
}

function validateStringArrayParam(
  value: unknown,
  key: string,
  operation: string,
  actualType: string
): void {
  assertParamType(Array.isArray(value), key, operation, 'a string array', actualType);
  const values = value as unknown[];
  for (let index = 0; index < values.length; index++) {
    if (typeof values[index] !== 'string') {
      throw new TypeError(
        `Parameter '${key}[${index}]' for operation '${operation}' must be a string, got ${getActualType(values[index])}`
      );
    }
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

function buildNamedWithTypeArgs(
  params: Record<string, unknown>,
  mappedParams: Record<string, unknown>,
  input?: OperationInput
): unknown[] {
  const result = { ...mappedParams };
  const inputElementType = input?.element_type || getLegacyInputElementType(input);
  if (!result.elementType && inputElementType) {
    result.elementType = inputElementType;
  }
  if (!result.type && result.elementType) {
    result.type = result.elementType;
  }
  if (!result.name && result.elementName) {
    result.name = result.elementName;
  }

  const resolvedType = result.elementType || result.type || inputElementType;
  mergeEnsembleParams(result, params, resolvedType);
  mergeCommonMetadataParams(result, params);
  mergeTemplateParams(result, params, resolvedType);
  mergeAgentParams(result, params, resolvedType);
  mergeGatekeeperParam(result, params);
  return [filterDispatchOnlyParams(result)];
}

function mergeEnsembleParams(
  result: Record<string, unknown>,
  params: Record<string, unknown>,
  resolvedType: unknown
): void {
  if (resolvedType !== ElementType.ENSEMBLE && resolvedType !== 'ensemble') {
    return;
  }
  const currentMetadata = result.metadata as Record<string, unknown> | undefined;
  if (params.elements && !currentMetadata?.elements) {
    result.metadata = { ...currentMetadata, elements: params.elements };
  }
}

function mergeCommonMetadataParams(
  result: Record<string, unknown>,
  params: Record<string, unknown>
): void {
  const currentMetadata = result.metadata as Record<string, unknown> | undefined;
  let updatedMetadata = currentMetadata;
  if (params.tags !== undefined && Array.isArray(params.tags) && updatedMetadata?.tags === undefined) {
    updatedMetadata = { ...updatedMetadata, tags: params.tags };
  }
  if (params.triggers !== undefined && Array.isArray(params.triggers) && updatedMetadata?.triggers === undefined) {
    updatedMetadata = { ...updatedMetadata, triggers: params.triggers };
  }
  if (updatedMetadata !== currentMetadata) {
    result.metadata = updatedMetadata;
  }
}

function mergeTemplateParams(
  result: Record<string, unknown>,
  params: Record<string, unknown>,
  resolvedType: unknown
): void {
  const isTemplate = resolvedType === ElementType.TEMPLATE || resolvedType === 'template';
  if (!isTemplate || !Array.isArray(params.variables)) {
    return;
  }
  const currentMetadata = result.metadata as Record<string, unknown> | undefined;
  if (currentMetadata?.variables === undefined) {
    result.metadata = { ...currentMetadata, variables: params.variables };
  }
}

function mergeAgentParams(
  result: Record<string, unknown>,
  params: Record<string, unknown>,
  resolvedType: unknown
): void {
  const isAgent = resolvedType === ElementType.AGENT || resolvedType === 'agent';
  if (!isAgent) {
    return;
  }
  const currentMetadata = result.metadata as Record<string, unknown> | undefined;
  let updatedMetadata = currentMetadata;
  if (params.goal !== undefined && updatedMetadata?.goal === undefined) {
    updatedMetadata = { ...updatedMetadata, goal: params.goal };
  }
  if (params.activates !== undefined && updatedMetadata?.activates === undefined) {
    updatedMetadata = { ...updatedMetadata, activates: params.activates };
  }
  if (params.tools !== undefined && updatedMetadata?.tools === undefined) {
    updatedMetadata = { ...updatedMetadata, tools: params.tools };
  }
  const systemPromptValue = params.systemPrompt ?? params.system_prompt;
  if (systemPromptValue !== undefined && updatedMetadata?.systemPrompt === undefined) {
    updatedMetadata = { ...updatedMetadata, systemPrompt: systemPromptValue };
  }
  if (params.autonomy !== undefined && updatedMetadata?.autonomy === undefined) {
    updatedMetadata = { ...updatedMetadata, autonomy: params.autonomy };
  }
  if (params.resilience !== undefined && updatedMetadata?.resilience === undefined) {
    updatedMetadata = { ...updatedMetadata, resilience: params.resilience };
  }
  if (updatedMetadata !== currentMetadata) {
    result.metadata = updatedMetadata;
  }
}

function mergeGatekeeperParam(
  result: Record<string, unknown>,
  params: Record<string, unknown>
): void {
  if (!params.gatekeeper || typeof params.gatekeeper !== 'object') {
    return;
  }
  const currentMetadata = result.metadata as Record<string, unknown> | undefined;
  if (currentMetadata?.gatekeeper) {
    return;
  }
  const resultName = typeof result.name === 'string' ? result.name : 'unknown';
  console.debug(`[SchemaDispatcher] Merging top-level gatekeeper into metadata for element '${resultName}'`);
  result.metadata = { ...currentMetadata, gatekeeper: params.gatekeeper };
}

function buildSingleArgs(schema: OperationDef, mappedParams: Record<string, unknown>): unknown[] {
  if (!schema.params || Object.keys(schema.params).length === 0) {
    return [];
  }
  const args: unknown[] = [];
  for (const key of Object.keys(schema.params)) {
    if (DISPATCH_ONLY_PARAMS.has(key)) {
      continue;
    }
    const targetKey = schema.params[key].mapTo ?? key;
    args.push(mappedParams[targetKey]);
  }
  return args;
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
      return buildNamedWithTypeArgs(params, mappedParams, input);
    }

    case 'typeWithParams': {
      // Pass resolved type + full params object (minus dispatch-only params)
      // Used for operations like list_elements that need (type, paginationParams)
      // Issue #290: element_type maps to elementType, with backward compat for type
      // Prefer snake_case element_type, fallback to camelCase elementType
      const resolvedType = mappedParams.elementType ?? mappedParams.type ?? input?.element_type ?? getLegacyInputElementType(input);
      return [resolvedType, filterDispatchOnlyParams(params)];
    }

    case 'single':
    default: {
      return buildSingleArgs(schema, mappedParams);
    }
  }
}

// ============================================================================
// Special Operation Handlers
// ============================================================================

/**
 * Handle introspection operation (uses IntrospectionResolver directly)
 */
function handleIntrospection(
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return Promise.resolve(IntrospectionResolver.resolve(params));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Handle get_capabilities operation (uses IntrospectionResolver directly)
 * @see Issue #1760 - get_capabilities operation
 */
function handleCapabilities(
  params: Record<string, unknown>
): Promise<unknown> {
  try {
    return Promise.resolve(IntrospectionResolver.getCapabilities(params));
  } catch (error) {
    return Promise.reject(error);
  }
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
    structuredContent: info,
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
    lines.push(
      '| Cache | Entries | Memory (MB) | Hit Rate | Last Activity |',
      '|-------|---------|-------------|----------|---------------|',
    );
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

  // Get the exportable data from the element
  // Issue #290: Use mapped names (elementName, elementType) from schema mapTo
  const name = mappedParams.elementName as string;
  const type = mappedParams.elementType as string;
  const format = mappedParams.format as 'json' | 'yaml';

  // Use the element query service to get element details
  const elementDetails = await handler.getElementDetails(name, type);

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

interface ImportElementDetails {
  elementType: string;
  elementName: string;
  elementData: Record<string, unknown>;
}

function parseImportPackage(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error('Invalid export package: not valid JSON');
    }
  }
  if (typeof data === 'object' && data !== null) {
    return data as Record<string, unknown>;
  }
  throw new Error('Invalid export package: data must be a string or object');
}

function parseNestedImportData(nestedData: unknown, format: string | undefined): Record<string, unknown> {
  if (typeof nestedData === 'object') {
    return nestedData as Record<string, unknown>;
  }
  if (typeof nestedData !== 'string') {
    throw new TypeError('Invalid export package: data field must be string or object');
  }
  try {
    return format === 'yaml'
      ? SecureYamlParser.parseRawYaml(nestedData, {
        maxSize: SECURITY_LIMITS.MAX_CONTENT_LENGTH,
        schema: 'json',
        contentPolicy: 'structure-only',
      })
      : JSON.parse(nestedData) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid export package: data field is not valid ${format || 'JSON'}`);
  }
}

function resolveImportElementDetails(exportPackage: Record<string, unknown>): ImportElementDetails {
  if (exportPackage.elementType && exportPackage.data) {
    return {
      elementType: exportPackage.elementType as string,
      elementName: exportPackage.elementName as string,
      elementData: parseNestedImportData(exportPackage.data, exportPackage.format as string | undefined),
    };
  }
  if (exportPackage.element) {
    const element = exportPackage.element as Record<string, unknown>;
    return {
      elementType: element.type as string,
      elementName: element.name as string,
      elementData: element,
    };
  }
  throw new Error('Invalid export package: missing element data');
}

async function assertImportTargetAvailable(
  handler: HandlerRegistry['elementCRUD'],
  elementName: string,
  elementType: string,
  overwrite: boolean | undefined
): Promise<void> {
  if (overwrite) {
    return;
  }
  try {
    await handler.getElementDetails(elementName, elementType);
    throw new Error(`Element '${elementName}' already exists. Use overwrite: true to replace.`);
  } catch (lookupError) {
    if (!(lookupError instanceof Error) || !lookupError.message.includes('not found')) {
      throw lookupError;
    }
  }
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

  const overwrite = mappedParams.overwrite as boolean | undefined;
  const exportPackage = parseImportPackage(mappedParams.data);
  const { elementType, elementName, elementData } = resolveImportElementDetails(exportPackage);
  await assertImportTargetAvailable(handler, elementName, elementType, overwrite);

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

function applyOperationNormalizer(
  params: Record<string, unknown>,
  schema: OperationDef,
  operation: string,
  input?: OperationInput
): Record<string, unknown> {
  if (!schema.normalizer) {
    return params;
  }
  const normalizer = NormalizerRegistry.get(schema.normalizer);
  if (!normalizer) {
    throw new Error(
      `Normalizer '${schema.normalizer}' not found for operation '${operation}'. ` +
      `Registered normalizers: [${NormalizerRegistry.list().join(', ') || 'none'}]`
    );
  }
  const normalizerContext: NormalizerContext = {
    operation,
    endpoint: schema.endpoint,
    handler: schema.handler,
    method: schema.method,
    elementType: getLegacyInputElementType(input),
  };
  const result = normalizer.normalize(params, normalizerContext);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.params;
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

    // Apply normalizer if schema specifies one (Issue #243).
    params = applyOperationNormalizer(params, schema, operation, input);

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

    if (schema.method === '__capabilities__') {
      return handleCapabilities(params);
    }

    // Map params according to schema (with input context and param style)
    // For operations with normalizers, the normalized params ARE the mapped params
    // (the normalizer already transforms input to handler-ready format)
    const inputContext = needsInput ? input : undefined;
    let mappedParams: Record<string, unknown> = {};
    if (schema.normalizer) {
      mappedParams = params;
    } else if (schema.params) {
      mappedParams = mapParams(params, schema.params, inputContext, schema.paramStyle);
    }

    // Validate params: required params first, then type validation (Issue #255)
    // Skip validation for normalized operations (normalizer handles validation)
    if (schema.params && !schema.normalizer) {
      validateRequiredParams(params, schema.params, operation, inputContext);
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

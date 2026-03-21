import { ElementType } from '../../portfolio/PortfolioManager.js';
import { Skill } from '../../elements/skills/Skill.js';
import { Template } from '../../elements/templates/Template.js';
import { Agent } from '../../elements/agents/Agent.js';
import { Memory } from '../../elements/memories/Memory.js';
import { Ensemble } from '../../elements/ensembles/Ensemble.js';
import type { EnsembleElementInput } from '../../elements/ensembles/types.js';
import { resolveElementTypes } from '../../utils/elementTypeResolver.js';
import { ElementCrudContext } from './types.js';
import { generateMemoryId } from '../../elements/memories/utils.js';
import { logger } from '../../utils/logger.js';
import { normalizeVersion } from '../../elements/BaseElement.js';
import { ValidationService, type ValidationFieldType } from '../../services/validation/ValidationService.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { deepMerge, DANGEROUS_PROPERTIES } from '../../utils/deepMerge.js';
import {
  normalizeElementTypeInput,
  formatValidElementTypesList,
  getElementFilename,
  getElementTypeLabel,
  resolveElementByName,
  ElementManagerOperations,
  KNOWN_METADATA_PROPERTIES,
  detectUnknownMetadataProperties,
  formatUnknownPropertyWarnings,
  formatElementResolutionWarnings
} from './helpers.js';
import type { ResolveElementTypesResult } from '../../utils/elementTypeResolver.js';

type ElementManagerWithPersistence<T> = ElementManagerOperations<T> & {
  save(element: T, filePath: string): Promise<void>;
  delete?(filePath: string): Promise<void>;
};

/**
 * GraphQL-aligned input for editing elements.
 * Uses nested objects (like create_element) instead of MongoDB-style dot notation.
 *
 * @example
 * // Update description and nested metadata
 * {
 *   name: "my-skill",
 *   type: "skills",
 *   input: {
 *     description: "Updated description",
 *     metadata: {
 *       triggers: ["code", "review"],
 *       settings: { theme: "dark" }
 *     }
 *   }
 * }
 */
export interface EditElementArgs {
  name: string;
  type: string;
  /** Nested input object - fields are deep-merged with existing element */
  input: Record<string, unknown>;
}

// Read-only fields that cannot be modified through the edit API
const READ_ONLY_FIELDS = new Set([
  'id',
  'type',
  'filePath',
  'filename',
  '_status',
  '_isDirty'
]);

/**
 * Issue #662: Systematic field type validation at the editElement boundary.
 *
 * Defines expected types for known metadata fields across all element types.
 * Prevents silent data corruption when LLMs send wrong types (e.g., dict instead of array).
 *
 * Key: field name, Value: { expected: type description, check: validator function }
 */
const FIELD_TYPE_RULES: Record<string, {
  expected: string;
  check: (value: unknown) => boolean;
  elementTypes?: ElementType[];
}> = {
  // Array fields (across multiple types)
  tags: { expected: 'array of strings', check: (v) => Array.isArray(v) },
  triggers: { expected: 'array of strings', check: (v) => Array.isArray(v) },
  domains: { expected: 'array of strings', check: (v) => Array.isArray(v) },
  examples: { expected: 'array', check: (v) => Array.isArray(v) },
  prerequisites: { expected: 'array of strings', check: (v) => Array.isArray(v) },
  capabilities: { expected: 'array', check: (v) => Array.isArray(v) },
  goals: { expected: 'array', check: (v) => Array.isArray(v) },
  constraints: { expected: 'array', check: (v) => Array.isArray(v) },
  actions: { expected: 'array', check: (v) => Array.isArray(v) },
  skills: { expected: 'array', check: (v) => Array.isArray(v) },
  // Issue #724: activates and tools are objects for agents (not arrays)
  activates: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.AGENT] },
  tools: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.AGENT] },
  variables: { expected: 'array', check: (v) => Array.isArray(v), elementTypes: [ElementType.TEMPLATE] },
  entries: { expected: 'array', check: (v) => Array.isArray(v), elementTypes: [ElementType.MEMORY] },
  // elements handled separately by validateAndNormalizeEnsembleElements (accepts dict too)

  // Object fields
  goal: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.AGENT] },
  autonomy: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.AGENT] },
  resilience: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.AGENT] },
  gatekeeper: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) },
  retentionPolicy: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.MEMORY] },
  retention_policy: { expected: 'object', check: (v) => typeof v === 'object' && v !== null && !Array.isArray(v), elementTypes: [ElementType.MEMORY] },

  // String fields
  // Issue #724: systemPrompt was missing from field type rules.
  // Both camelCase and snake_case variants accepted because LLMs frequently
  // pass snake_case keys; normalization to camelCase happens downstream in
  // AgentManager.parseMetadata() (Issue #722).
  systemPrompt: { expected: 'string', check: (v) => typeof v === 'string', elementTypes: [ElementType.AGENT] },
  system_prompt: { expected: 'string', check: (v) => typeof v === 'string', elementTypes: [ElementType.AGENT] },
  name: { expected: 'string', check: (v) => typeof v === 'string' },
  description: { expected: 'string', check: (v) => typeof v === 'string' },
  author: { expected: 'string', check: (v) => typeof v === 'string' },
  version: { expected: 'string', check: (v) => typeof v === 'string' || typeof v === 'number' },
  category: { expected: 'string', check: (v) => typeof v === 'string' },
  domain: { expected: 'string', check: (v) => typeof v === 'string' },
  tone: { expected: 'string', check: (v) => typeof v === 'string' },

  // Number fields
  maxEntries: { expected: 'number', check: (v) => typeof v === 'number', elementTypes: [ElementType.MEMORY] },
  max_entries: { expected: 'number', check: (v) => typeof v === 'number', elementTypes: [ElementType.MEMORY] },
  priority: { expected: 'number', check: (v) => typeof v === 'number' },
};

/**
 * Issue #662: Validate field types in input before applying to element.
 *
 * Checks each field in the input against `FIELD_TYPE_RULES`. Fields not in the
 * rules map are skipped (they'll be caught by unknown-property detection later).
 * Element-type-scoped rules only apply when the target type matches.
 *
 * @param input - The edit input object containing fields to validate
 * @param elementType - The normalized element type being edited
 * @returns Array of error messages for fields with wrong types (empty if all valid)
 */
function validateFieldTypes(
  input: Record<string, unknown>,
  elementType: ElementType
): string[] {
  const errors: string[] = [];

  for (const [field, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;

    const rule = FIELD_TYPE_RULES[field];
    if (!rule) continue;

    // Skip if rule doesn't apply to this element type
    if (rule.elementTypes && !rule.elementTypes.includes(elementType)) continue;

    if (!rule.check(value)) {
      errors.push(`Field '${field}' expects ${rule.expected}, got ${Array.isArray(value) ? 'array' : typeof value}`);
    }
  }

  return errors;
}

// Merge options for secure deep merging
const MERGE_OPTIONS = {
  skipProperties: DANGEROUS_PROPERTIES,
  readOnlyFields: READ_ONLY_FIELDS
};

/**
 * Map field names to their appropriate validation field types.
 * This ensures consistent validation between edit (input) and load (output).
 */
function getFieldTypeForValidation(fieldName: string): ValidationFieldType | null {
  // Normalize field name (handle both 'description' and 'metadata.description')
  const normalizedField = fieldName.replace(/^metadata\./, '');

  switch (normalizedField) {
    case 'name':
      return 'name';
    case 'description':
      return 'description';
    case 'content':
      return 'content';
    default:
      return null; // No special validation needed
  }
}

/**
 * Validate a field value before setting it on an element.
 * Returns null if valid, or an error message if invalid.
 *
 * @param validationService - Injected validation service for testability
 * @param field - The field name being validated
 * @param value - The value to validate
 */
function validateFieldValue(
  validationService: ValidationService,
  field: string,
  value: unknown
): string | null {
  // Only validate string values for text fields
  if (typeof value !== 'string') {
    return null; // Non-string values (arrays, objects, booleans, numbers) skip text validation
  }

  const fieldType = getFieldTypeForValidation(field);
  if (!fieldType) {
    return null; // No validation rules for this field
  }

  // Determine max length based on field type, using system constants
  const maxLength = fieldType === 'name' ? 100 :
                    fieldType === 'description' ? 500 :
                    fieldType === 'content' ? SECURITY_LIMITS.MAX_CONTENT_LENGTH : 1000;

  const result = validationService.validateAndSanitizeInput(value, {
    maxLength,
    allowSpaces: true,
    fieldType
  });

  if (!result.isValid) {
    return result.errors?.join(', ') || 'Validation failed';
  }

  return null; // Valid
}

/**
 * Validate and normalize ensemble elements input.
 *
 * Issue #658: LLMs often send elements in dict-keyed format instead of array format.
 * This function normalizes both formats to a valid array of EnsembleElement-like objects.
 *
 * Accepted formats:
 * - Array: [{ element_name: "foo", element_type: "memory", ... }]
 * - Dict:  { "foo": { type: "memory", ... } }  → converted to array
 *
 * @param value - The elements input to validate
 * @returns Object with success flag, normalized elements array, and optional error
 */
function validateAndNormalizeEnsembleElements(value: unknown): {
  success: boolean;
  elements: EnsembleElementInput[];
  error?: string;
} {
  // Case 1: Already an array — validate each item
  if (Array.isArray(value)) {
    const errors: string[] = [];
    const normalized: EnsembleElementInput[] = [];

    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`Element at index ${i} must be an object with element_name and element_type`);
        continue;
      }
      const obj = item as Record<string, unknown>;
      const name = obj.element_name || obj.name;
      const type = obj.element_type || obj.type;
      if (!name) {
        errors.push(`Element at index ${i} is missing element_name (or name)`);
        continue;
      }
      // Validate _remove is strictly boolean if present
      if ('_remove' in obj && typeof obj._remove !== 'boolean') {
        errors.push(`Element '${String(name)}' has invalid _remove value — must be boolean true, got ${typeof obj._remove}`);
        continue;
      }
      // Normalize to standard field names, only including defined values
      const entry: EnsembleElementInput = { ...obj, element_name: String(name) };
      if (type) {
        entry.element_type = String(type);
      }
      normalized.push(entry);
    }

    if (errors.length > 0) {
      return { success: false, elements: [], error: errors.join('; ') };
    }
    return { success: true, elements: normalized };
  }

  // Case 2: Dict-keyed format — convert to array
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const dict = value as Record<string, unknown>;
    const normalized: EnsembleElementInput[] = [];

    for (const [key, val] of Object.entries(dict)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        return {
          success: false,
          elements: [],
          error: `Element '${key}' in dict format must be an object with at least element_type (or type). ` +
            `Expected: { "${key}": { type: "memory", role: "support", ... } }`
        };
      }
      const inner = val as Record<string, unknown>;
      normalized.push({
        ...inner,
        element_name: String(inner.element_name || inner.name || key),
        element_type: String(inner.element_type || inner.type),
        role: (inner.role as EnsembleElementInput['role']) || 'support',
        activation: (inner.activation as EnsembleElementInput['activation']) || 'always',
        priority: (inner.priority as number) ?? 50,
      });
    }
    return { success: true, elements: normalized };
  }

  // Case 3: Invalid type
  return {
    success: false,
    elements: [],
    error: `'elements' must be an array of objects or a dict-keyed object. Got: ${typeof value}`
  };
}

/**
 * Merge incoming ensemble elements with existing elements.
 *
 * Issue #658/#662: Unified collection editing semantics — each item in the input
 * declares its own intent via its properties:
 *
 * - Existing element with updates → merge properties (incoming wins)
 * - New element (not found by name) → appended
 * - Element with `_remove: true` → dropped from collection
 * - Existing elements not in incoming → preserved unchanged
 *
 * This pattern extends to any future grouping type (workflows, pipelines, teams).
 *
 * @param existing - Current elements array from the ensemble
 * @param incoming - New/updated/removed elements from the edit input
 * @returns Object with merged array and any warnings
 */
function mergeEnsembleElements(
  existing: EnsembleElementInput[],
  incoming: EnsembleElementInput[]
): { elements: EnsembleElementInput[]; warnings: string[] } {
  const result: EnsembleElementInput[] = existing.map(e => ({ ...e }));
  const warnings: string[] = [];

  for (const inc of incoming) {
    const name = String(inc.element_name || inc.name || '');
    if (!name) continue;

    const existingIndex = result.findIndex(
      e => String(e.element_name || e.name || '') === name
    );

    // Issue #662: _remove marker — drop element from collection
    if (inc._remove === true) {
      if (existingIndex >= 0) {
        result.splice(existingIndex, 1);
      } else {
        warnings.push(`Element '${name}' not found in ensemble — nothing to remove`);
      }
      continue;
    }

    // Strip transient/alias fields that shouldn't be persisted
    const { _remove: _discardRemove, name: _discardName, type: _discardType, ...persistable } = inc;

    if (existingIndex >= 0) {
      // Upsert: merge incoming properties into existing (incoming wins)
      result[existingIndex] = { ...result[existingIndex], ...persistable };
    } else {
      // Append new element
      result.push({ ...persistable });
    }
  }

  return { elements: result, warnings };
}

/**
 * Validate, normalize, and merge ensemble elements into the update object.
 * Extracted to avoid duplication between the top-level `elements` key handler
 * and the `metadata.elements` key handler (Claude review).
 *
 * @returns An error string if validation fails, or null on success
 */
function isEnsembleElementInput(value: unknown): value is EnsembleElementInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyEnsembleElementsUpdate(
  elementsInput: unknown,
  element: unknown,
  updateObj: Record<string, unknown>,
  collectionWarnings: string[]
): string | null {
  const validated = validateAndNormalizeEnsembleElements(elementsInput);
  if (!validated.success) {
    return `Invalid 'elements' format: ${validated.error}`;
  }
  const elementRecord = element as Record<string, unknown>;
  const metadata = elementRecord.metadata as Record<string, unknown> | undefined;
  const rawElements = metadata?.elements;
  const existingTyped: EnsembleElementInput[] = Array.isArray(rawElements)
    ? rawElements.filter(isEnsembleElementInput).map(e => ({ ...e }))
    : [];
  const mergeResult = mergeEnsembleElements(existingTyped, validated.elements);
  collectionWarnings.push(...mergeResult.warnings);
  if (!updateObj.metadata) {
    updateObj.metadata = {};
  }
  (updateObj.metadata as Record<string, unknown>).elements = mergeResult.elements;
  return null;
}

/**
 * Sync ensemble elements from metadata after an update.
 *
 * Ensembles store their element references in metadata.elements,
 * and need to sync the internal elements array when that changes.
 *
 * Issue #466: Before syncing, resolve any missing element_type fields
 * by searching the portfolio via the context managers.
 *
 * @param element - The ensemble element to sync
 * @param input - The input object to check for element updates
 * @param context - Element CRUD context with managers for type resolution
 */
async function syncEnsembleElementsIfNeeded(
  element: unknown,
  input: Record<string, unknown>,
  context?: ElementCrudContext
): Promise<ResolveElementTypesResult | undefined> {
  const hasElementsUpdate = input.elements || (input.metadata as Record<string, unknown>)?.elements;

  if (hasElementsUpdate && element instanceof Ensemble) {
    // Issue #466: Resolve missing element_type via portfolio lookup before sync
    if (context && element.metadata.elements) {
      const result = await resolveElementTypes(
        element.metadata.elements,
        {
          skillManager: context.skillManager,
          templateManager: context.templateManager,
          agentManager: context.agentManager,
          memoryManager: context.memoryManager,
          personaManager: context.personaManager,
          ensembleManager: context.ensembleManager,
        }
      );
      element.metadata.elements = result.resolved;
      element.syncElementsFromMetadata();
      return result;
    }

    element.syncElementsFromMetadata();
  }
  return undefined;
}

/**
 * Handle memory entry updates with validation and normalization.
 *
 * Memory entries require special handling because they:
 * - Need ID generation if missing
 * - Require timestamp parsing and validation
 * - Use a Map structure internally
 *
 * @param entries - Array of memory entries from input
 * @returns Result with success status, optional error message, and normalized entries map
 */
function handleMemoryEntryUpdate(entries: unknown[]): {
  success: boolean;
  message?: string;
  entriesMap: Map<string, unknown>;
} {
  const entriesMap = new Map();
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      errors.push(`Entry at index ${i} is not a valid object`);
      continue;
    }

    const entryObj = entry as Record<string, unknown>;
    const entryId = entryObj.id as string | undefined;
    if (!entryId) {
      entryObj.id = generateMemoryId();
    }

    try {
      const timestamp = entryObj.timestamp ? new Date(entryObj.timestamp as string) : new Date();
      if (Number.isNaN(timestamp.getTime())) {
        throw new Error('Invalid timestamp');
      }

      const normalizedEntry = {
        ...entryObj,
        timestamp,
        tags: Array.isArray(entryObj.tags) ? entryObj.tags : [],
        metadata: typeof entryObj.metadata === 'object' && entryObj.metadata !== null ? entryObj.metadata : {}
      };

      entriesMap.set(entryObj.id, normalizedEntry);
    } catch {
      errors.push(`Entry '${entryObj.id}' has invalid timestamp`);
    }
  }

  if (errors.length > 0) {
    return { success: false, message: errors.join('\n'), entriesMap };
  }

  return { success: true, entriesMap };
}

/**
 * Edit an existing element using GraphQL-aligned nested input.
 *
 * @param context - Element CRUD context with managers
 * @param args - Edit arguments (name, type, input)
 * @param validationService - Optional validation service for DI (creates default if not provided)
 */
export async function editElement(
  context: ElementCrudContext,
  args: EditElementArgs,
  validationService?: ValidationService
) {
  await context.ensureInitialized();

  // Use injected validation service or create default
  const validator = validationService ?? new ValidationService();

  const { name, type, input } = args;

  // Validate input is provided
  if (!input || typeof input !== 'object') {
    return error('Missing or invalid input object. Provide fields to update as a nested object.');
  }

  const { type: normalizedType } = normalizeElementTypeInput(type);

  if (!normalizedType) {
    return error(`Invalid element type '${type}'. Valid types: ${formatValidElementTypesList()}`);
  }

  const manager = getManagerForType(context, normalizedType);
  if (!manager) {
    const labelPlural = getElementTypeLabel(normalizedType, { plural: true });
    return error(`Element type '${labelPlural}' is not yet supported for editing`);
  }

  const element = await resolveElementByName(manager, normalizedType, name);
  if (!element) {
    const label = getElementTypeLabel(normalizedType);
    throw new ElementNotFoundError(label, name);
  }

  // Check for unknown properties and generate warnings
  const unknownPropertyWarnings = detectUnknownMetadataProperties(
    normalizedType,
    input as Record<string, unknown>
  );
  const warningText = formatUnknownPropertyWarnings(unknownPropertyWarnings);

  if (unknownPropertyWarnings.length > 0) {
    logger.warn(`[editElement] Unknown properties detected`, {
      elementType: normalizedType,
      elementName: name,
      warningCount: unknownPropertyWarnings.length,
      unknownProperties: unknownPropertyWarnings.map(w => ({
        property: w.property,
        suggestion: w.suggestion
      }))
    });
  }

  // Issue #1591: Validate element-specific constraints before attempting edits
  // Memory content is read-only (append-only architecture) - reject attempts to edit it
  if (normalizedType === ElementType.MEMORY && 'content' in input) {
    return error(
      `Memory content cannot be modified via edit_element. ` +
      `Memory uses an append-only architecture. ` +
      `Use the 'addEntry' operation to add new entries to this memory.`
    );
  }

  // Issue #662: Validate field types before applying (prevents silent data corruption)
  const typeErrors = validateFieldTypes(input, normalizedType);
  if (typeErrors.length > 0) {
    return error(`Field type validation failed:\n${typeErrors.map(e => `  • ${e}`).join('\n')}`);
  }

  // Validate string field values using injected validator
  for (const [field, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const validationError = validateFieldValue(validator, field, value);
      if (validationError) {
        return error(`Invalid value for '${field}': ${validationError}`);
      }
    }
  }

  // Build the update object, mapping top-level fields to metadata where appropriate
  // Issue #565: Use type-specific metadata properties from authoritative source
  const metadataFields = KNOWN_METADATA_PROPERTIES[normalizedType] ?? new Set<string>();
  const updateObj: Record<string, unknown> = {};
  const unrecognizedFieldWarnings: string[] = [];
  const collectionWarnings: string[] = [];

  // Fields handled by dedicated branches (not metadata routing)
  const specialRouteFields = new Set(['instructions', 'content', 'elements', 'metadata', 'entries', 'version']);

  for (const [key, value] of Object.entries(input)) {
    // Skip dangerous properties
    if (DANGEROUS_PROPERTIES.includes(key)) {
      continue;
    }

    // Skip read-only fields
    if (READ_ONLY_FIELDS.has(key)) {
      logger.warn(`[editElement] Skipping read-only field: ${key}`);
      continue;
    }

    // Map known metadata fields automatically (type-specific)
    if (metadataFields.has(key) && !specialRouteFields.has(key)) {
      if (!updateObj.metadata) {
        updateObj.metadata = {};
      }
      (updateObj.metadata as Record<string, unknown>)[key] = value;
    } else if (key === 'elements' && normalizedType === ElementType.ENSEMBLE) {
      // Issue #658: Validate and normalize elements input (array or dict format)
      const elemError = applyEnsembleElementsUpdate(value, element, updateObj, collectionWarnings);
      if (elemError) return error(elemError);
    } else if (key === 'metadata' && typeof value === 'object' && value !== null) {
      const metaValue = value as Record<string, unknown>;

      // If metadata.elements is provided for an ensemble, extract and route through
      // the ensemble elements handler for proper validation/normalization/merge.
      if (normalizedType === ElementType.ENSEMBLE && metaValue.elements) {
        const elemError = applyEnsembleElementsUpdate(metaValue.elements, element, updateObj, collectionWarnings);
        if (elemError) return error(elemError);

        // Remove elements from metadata value before deep merge to avoid double-processing
        const { elements: _extracted, ...restMetadata } = metaValue;
        if (Object.keys(restMetadata).length > 0) {
          updateObj.metadata = deepMerge(
            updateObj.metadata as Record<string, unknown>,
            restMetadata,
            MERGE_OPTIONS
          );
        }
      } else {
        // Merge nested metadata with security options
        updateObj.metadata = deepMerge(
          (updateObj.metadata || {}) as Record<string, unknown>,
          metaValue,
          MERGE_OPTIONS
        );
      }
    } else if (key === 'instructions' && typeof value === 'string') {
      // Issue #602 resolved: 'instructions' is a first-class field (behavioral directives)
      const contentContextMap: Record<string, 'persona' | 'skill' | 'template' | 'agent' | 'memory'> = {
        [ElementType.AGENT]: 'agent',
        [ElementType.SKILL]: 'skill',
        [ElementType.TEMPLATE]: 'template',
        [ElementType.PERSONA]: 'persona',
        [ElementType.MEMORY]: 'memory',
      };
      const contentValidation = ContentValidator.validateAndSanitize(value, {
        maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH,
        contentContext: contentContextMap[normalizedType]
      });
      const sanitizedInstructions = contentValidation.sanitizedContent || '';
      // Set instructions on the element directly (all types now have this property)
      (element as any).instructions = sanitizedInstructions;
      // For agents, also update extensions.instructions for backward compat
      if (normalizedType === ElementType.AGENT) {
        if (!element.extensions) {
          (element as any).extensions = {};
        }
        (element as any).extensions.instructions = sanitizedInstructions;
      }
    } else if (key === 'content' && typeof value === 'string') {
      // Issue #585/#602: Handle content updates (reference material)
      const contentContextMap: Record<string, 'persona' | 'skill' | 'template' | 'agent' | 'memory'> = {
        [ElementType.AGENT]: 'agent',
        [ElementType.SKILL]: 'skill',
        [ElementType.TEMPLATE]: 'template',
        [ElementType.PERSONA]: 'persona',
        [ElementType.MEMORY]: 'memory',
      };
      const contentValidation = ContentValidator.validateAndSanitize(value, {
        maxLength: SECURITY_LIMITS.MAX_CONTENT_LENGTH,
        contentContext: contentContextMap[normalizedType]
      });
      const sanitizedContent = contentValidation.sanitizedContent || '';
      // Set content on the element directly (all types now have this property)
      (element as any).content = sanitizedContent;
    } else if (!specialRouteFields.has(key)) {
      // Issue #565: Field not in type-specific metadata set and not a special route —
      // still route to updateObj for backward compat, but warn that it may not persist
      updateObj[key] = value;
      unrecognizedFieldWarnings.push(
        `Field '${key}' is not a recognized metadata property for ${getElementTypeLabel(normalizedType)} — it may not persist after save.`
      );
      logger.warn(`[editElement] Unrecognized field '${key}' for ${normalizedType}, routing to element object`, {
        elementType: normalizedType,
        elementName: name,
        field: key,
      });
    }
  }

  // Deep merge the update into the element with security options
  const elementData = element as unknown as Record<string, unknown>;
  const mergedData = deepMerge(elementData, updateObj, MERGE_OPTIONS);

  // Apply merged data back to element
  for (const [key, value] of Object.entries(mergedData)) {
    if (key !== 'metadata') {
      (element as any)[key] = value;
    }
  }

  // Handle metadata separately to preserve element structure
  if (mergedData.metadata && element.metadata) {
    Object.assign(element.metadata, mergedData.metadata);
  }

  // Handle memory entries specially (extracted for clarity)
  if (normalizedType === ElementType.MEMORY && input.entries && Array.isArray(input.entries)) {
    const memoryResult = handleMemoryEntryUpdate(input.entries);
    if (!memoryResult.success) {
      return error(`Memory entry validation errors:\n${memoryResult.message}\n\nValid entries were saved.`);
    }
    (element as any).entries = memoryResult.entriesMap;
  }

  // Sync ensemble elements from metadata (extracted for clarity)
  // Issue #466: Resolve element_type via portfolio lookup before sync, surface warnings
  let resolutionWarningText = '';
  if (normalizedType === ElementType.ENSEMBLE) {
    const resolutionResult = await syncEnsembleElementsIfNeeded(element, input, context);
    if (resolutionResult) {
      resolutionWarningText = formatElementResolutionWarnings(resolutionResult);
    }
  }

  // Handle version updates
  if (input.version !== undefined) {
    const update = updateVersionExplicit(element, String(input.version));
    if (!update.success) {
      return error(update.message || 'Failed to update version');
    }
  } else {
    autoIncrementVersion(element);
  }

  // Determine file path for saving
  const filePathCandidate = typeof (element as any).getFilePath === 'function'
    ? (element as any).getFilePath()
    : ((element as any).filePath || (element as any).filename);
  const filename = typeof filePathCandidate === 'string' && filePathCandidate.length > 0
    ? filePathCandidate
    : getElementFilename(normalizedType, element.metadata?.name || name);

  try {
    await manager.save(element, filename);
  } catch (err) {
    return error(`Failed to save element: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  const label = getElementTypeLabel(normalizedType);
  const displayName = element.metadata?.name || name;
  const updatedFields = Object.keys(input).join(', ');

  // Issue #565: Include warnings for unrecognized fields in response
  let unrecognizedWarningText = '';
  if (unrecognizedFieldWarnings.length > 0) {
    const lines = ['⚠️ **Unrecognized Field Warnings:**'];
    for (const warning of unrecognizedFieldWarnings) {
      lines.push(`   • ${warning}`);
    }
    lines.push('');
    unrecognizedWarningText = lines.join('\n');
  }

  // Issue #662: Include collection operation warnings
  let collectionWarningText = '';
  if (collectionWarnings.length > 0) {
    const lines = ['⚠️ **Collection Warnings:**'];
    for (const warning of collectionWarnings) {
      lines.push(`   • ${warning}`);
    }
    lines.push('');
    collectionWarningText = lines.join('\n');
  }

  return {
    content: [{
      type: 'text',
      text: `${warningText}${resolutionWarningText}${unrecognizedWarningText}${collectionWarningText}✅ Updated ${label} '${displayName}' - fields: ${updatedFields}`
    }]
  };
}

function error(message: string) {
  return {
    content: [{
      type: 'text',
      text: `❌ ${message}`
    }]
  };
}

function getManagerForType(context: ElementCrudContext, type: ElementType): ElementManagerWithPersistence<any> | null {
  switch (type) {
    case ElementType.PERSONA:
      return context.personaManager as ElementManagerWithPersistence<any>;
    case ElementType.SKILL:
      return context.skillManager as ElementManagerWithPersistence<Skill>;
    case ElementType.TEMPLATE:
      return context.templateManager as ElementManagerWithPersistence<Template>;
    case ElementType.AGENT:
      return context.agentManager as ElementManagerWithPersistence<Agent>;
    case ElementType.MEMORY:
      return context.memoryManager as ElementManagerWithPersistence<Memory>;
    case ElementType.ENSEMBLE:
      return context.ensembleManager as ElementManagerWithPersistence<any>;
    default:
      return null;
  }
}

function updateVersionExplicit(element: any, versionString: string) {
  const isValid = /^(\d+)(\.\d+)?(\.\d+)?(-[a-zA-Z0-9.-]+)?$/.test(versionString);
  if (!isValid) {
    return {
      success: false,
      message: `Invalid version format: '${versionString}'. Please use format like 1.0.0, 1.0, or 1`
    };
  }

  try {
    element.version = versionString;
    if (element.metadata) {
      element.metadata.version = versionString;
    }
    return { success: true };
  } catch (error) {
    logger.error('Failed to update version', { error });
    return {
      success: false,
      message: `Failed to update version: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

function autoIncrementVersion(element: any) {
  try {
    if (element.version) {
      // First normalize the version to 3-part format (handles legacy 2-part versions)
      const normalized = normalizeVersion(String(element.version));

      // Check for pre-release versions
      const preReleaseMatch = normalized.match(/^(\d+\.\d+\.\d+)(-([a-zA-Z0-9.-]+))?$/);

      if (preReleaseMatch) {
        const baseVersion = preReleaseMatch[1];
        const preReleaseTag = preReleaseMatch[3];

        if (preReleaseTag) {
          // Increment pre-release version (e.g., "1.0.0-beta.1" → "1.0.0-beta.2")
          const preReleaseNumberMatch = preReleaseTag.match(/^([a-zA-Z]+)\.?(\d+)?$/);
          if (preReleaseNumberMatch) {
            const preReleaseType = preReleaseNumberMatch[1];
            const preReleaseNumber = Number.parseInt(preReleaseNumberMatch[2] || '0') + 1;
            element.version = `${baseVersion}-${preReleaseType}.${preReleaseNumber}`;
          } else {
            // No pre-release number, bump patch
            const [major, minor, patch] = baseVersion.split('.').map(Number);
            element.version = `${major}.${minor}.${patch + 1}`;
          }
        } else {
          // Standard version, bump patch (e.g., "1.0.0" → "1.0.1")
          const [major, minor, patch] = baseVersion.split('.').map(Number);
          element.version = `${major}.${minor}.${patch + 1}`;
        }
      } else {
        // Shouldn't reach here after normalization, but fallback to safe default
        element.version = '1.0.1';
      }
    } else {
      // No version, start at 1.0.0
      element.version = '1.0.0';
    }

    // Sync version to metadata
    if (element.metadata) {
      element.metadata.version = element.version;
    }
  } catch (error) {
    logger.error('Failed to auto-increment version', { error });
  }
}

/**
 * Generic test data generators for element CRUD testing
 *
 * This module provides factory functions for generating test element data.
 * These factories are generic and work with any element type configuration.
 *
 * Key Design Principles:
 * - Generic: Generate data for any element type
 * - Flexible: Support overrides for customization
 * - Minimal: Generate minimal valid elements
 * - Complete: Generate fully populated elements
 * - Invalid: Generate invalid elements for validation testing
 */

import type { ElementData, ElementTypeTestConfig, FieldConfig } from '../config/types.js';
import { ElementType } from '../../../../src/portfolio/types.js';

/**
 * Create a minimal valid element
 *
 * Generates an element with only required fields populated.
 * Useful for testing minimum viable element creation.
 *
 * @param config - Element type test configuration
 * @param overrides - Optional field overrides
 * @returns Minimal valid element data
 *
 * @example
 * ```typescript
 * const minPersona = createMinimalElement(personaConfig, {
 *   name: 'test-persona'
 * });
 * ```
 */
export function createMinimalElement(
  config: ElementTypeTestConfig,
  overrides?: Partial<ElementData>
): ElementData {
  // Start with base required fields
  const element: ElementData = {
    name: overrides?.name ?? `test-${config.type}-${Date.now()}`,
    description: overrides?.description ?? `Test ${config.displayName} element`,
  };

  // Add required metadata fields
  const metadata: Record<string, any> = {};

  config.requiredFields.forEach(fieldPath => {
    if (fieldPath.startsWith('metadata.')) {
      const fieldName = fieldPath.replace('metadata.', '');
      const fieldConfig = config.editableFields.find(f => f.path === fieldPath);

      if (fieldConfig && fieldConfig.validValues && fieldConfig.validValues.length > 0) {
        metadata[fieldName] = fieldConfig.validValues[0];
      } else {
        // Generate default value based on field type
        metadata[fieldName] = getDefaultValueForField(fieldConfig);
      }
    }
  });

  if (Object.keys(metadata).length > 0) {
    element.metadata = { ...metadata, ...overrides?.metadata };
  }

  return element;
}

/**
 * Create a complete element with all fields populated
 *
 * Generates an element with all editable fields set to valid values.
 * Useful for testing full element functionality.
 *
 * @param config - Element type test configuration
 * @param overrides - Optional field overrides
 * @returns Complete element data
 *
 * @example
 * ```typescript
 * const completeSkill = createCompleteElement(skillConfig, {
 *   name: 'comprehensive-skill'
 * });
 * ```
 */
export function createCompleteElement(
  config: ElementTypeTestConfig,
  overrides?: Partial<ElementData>
): ElementData {
  // Start with minimal element
  const element = createMinimalElement(config, overrides);

  // Add all editable fields
  config.editableFields.forEach(fieldConfig => {
    if (fieldConfig.path.startsWith('metadata.')) {
      const fieldName = fieldConfig.path.replace('metadata.', '');

      // Skip if already set by overrides
      if (overrides?.metadata?.[fieldName] !== undefined) {
        return;
      }

      // Set to first valid value or default
      const value = fieldConfig.validValues?.[0] ?? getDefaultValueForField(fieldConfig);

      if (!element.metadata) {
        element.metadata = {};
      }

      element.metadata[fieldName] = value;
    }
  });

  // Add content if element type typically has it
  if (!element.content && shouldHaveContent(config.type)) {
    element.content = overrides?.content ?? `# ${element.name}\n\nTest content for ${config.displayName}`;
  }

  return element;
}

/**
 * Create an invalid element for validation testing
 *
 * Generates an element with a specific field set to an invalid value.
 * Useful for testing validation error handling.
 *
 * @param config - Element type test configuration
 * @param invalidField - Field to make invalid
 * @param invalidValue - Invalid value to use (optional, uses first invalid value from config)
 * @returns Invalid element data
 *
 * @example
 * ```typescript
 * const invalidAgent = createInvalidElement(agentConfig, 'metadata.role');
 * ```
 */
export function createInvalidElement(
  config: ElementTypeTestConfig,
  invalidField: string,
  invalidValue?: any
): ElementData {
  // Start with valid element
  const element = createMinimalElement(config);

  // Find field config
  const fieldConfig = config.editableFields.find(f => f.path === invalidField);

  // Determine invalid value
  let value: any;
  if (invalidValue !== undefined) {
    value = invalidValue;
  } else if (fieldConfig?.invalidValues && fieldConfig.invalidValues.length > 0) {
    value = fieldConfig.invalidValues[0].value;
  } else {
    // Generate generic invalid value based on field type
    value = getInvalidValueForField(fieldConfig);
  }

  // Set invalid value
  if (invalidField.startsWith('metadata.')) {
    const fieldName = invalidField.replace('metadata.', '');
    if (!element.metadata) {
      element.metadata = {};
    }
    element.metadata[fieldName] = value;
  } else if (invalidField === 'name') {
    element.name = value;
  } else if (invalidField === 'description') {
    element.description = value;
  } else {
    (element as any)[invalidField] = value;
  }

  return element;
}

/**
 * Create an element with missing required field
 *
 * Generates an element with a required field omitted.
 * Useful for testing required field validation.
 *
 * @param config - Element type test configuration
 * @param missingField - Required field to omit
 * @returns Element data with missing field
 *
 * @example
 * ```typescript
 * const noName = createElementWithMissingField(templateConfig, 'name');
 * ```
 */
export function createElementWithMissingField(
  config: ElementTypeTestConfig,
  missingField: string
): ElementData {
  const element = createMinimalElement(config);

  // Remove the field
  if (missingField.startsWith('metadata.')) {
    const fieldName = missingField.replace('metadata.', '');
    if (element.metadata) {
      delete element.metadata[fieldName];
    }
  } else if (missingField === 'name') {
    element.name = '';
  } else if (missingField === 'description') {
    element.description = '';
  } else {
    delete (element as any)[missingField];
  }

  return element;
}

/**
 * Create a batch of test elements
 *
 * Generates multiple test elements with unique names.
 * Useful for testing list operations and bulk operations.
 *
 * @param config - Element type test configuration
 * @param count - Number of elements to create
 * @param baseOverrides - Base overrides applied to all elements
 * @returns Array of element data
 *
 * @example
 * ```typescript
 * const personas = createElementBatch(personaConfig, 5);
 * ```
 */
export function createElementBatch(
  config: ElementTypeTestConfig,
  count: number,
  baseOverrides?: Partial<ElementData>
): ElementData[] {
  const elements: ElementData[] = [];

  for (let i = 0; i < count; i++) {
    const element = createMinimalElement(config, {
      ...baseOverrides,
      name: `${baseOverrides?.name ?? 'test'}-${config.type}-${i + 1}`,
      description: `${baseOverrides?.description ?? 'Test element'} ${i + 1}`,
    });
    elements.push(element);
  }

  return elements;
}

/**
 * Generate a unique element name
 *
 * Creates a unique name using timestamp and optional prefix.
 *
 * @param prefix - Name prefix (default: 'test')
 * @param suffix - Additional suffix (optional)
 * @returns Unique element name
 */
export function generateUniqueName(prefix: string = 'test', suffix?: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return suffix ? `${prefix}-${timestamp}-${random}-${suffix}` : `${prefix}-${timestamp}-${random}`;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get default value for a field based on its type
 */
function getDefaultValueForField(fieldConfig?: FieldConfig): any {
  if (!fieldConfig) return '';

  switch (fieldConfig.type) {
    case 'string':
      return 'test-value';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'enum':
      return fieldConfig.validValues?.[0] ?? 'default';
    case 'date':
      return new Date().toISOString();
    default:
      return '';
  }
}

/**
 * Get an invalid value for a field based on its type
 */
function getInvalidValueForField(fieldConfig?: FieldConfig): any {
  if (!fieldConfig) return null;

  switch (fieldConfig.type) {
    case 'string':
      return 123; // Number instead of string
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    case 'enum':
      return 'invalid-enum-value';
    case 'date':
      return 'invalid-date';
    default:
      return null;
  }
}

/**
 * Determine if element type typically has content field
 */
function shouldHaveContent(type: ElementType): boolean {
  // Templates and personas typically have content
  return type === ElementType.TEMPLATE || type === ElementType.PERSONA;
}

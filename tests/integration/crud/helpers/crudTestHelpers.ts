/**
 * Generic CRUD+Activate assertion helpers
 *
 * This module provides generic assertion functions for testing CRUD operations
 * across all element types. These helpers work with any element type without
 * hardcoded type-specific logic.
 *
 * Key Design Principles:
 * - Generic: Work with any element type
 * - Reusable: Single implementation for all test suites
 * - Clear: Descriptive error messages
 * - Flexible: Support various assertion patterns
 */

import { expect } from '@jest/globals';
import type { ElementData } from '../config/types.js';

/**
 * Assert that an element was created successfully
 *
 * Verifies:
 * - MCP tool response indicates success
 * - Expected data matches response
 * - Success message is present
 *
 * @param result - MCP tool call result
 * @param expectedData - Expected element data
 */
export function assertElementCreated(result: any, expectedData: Partial<ElementData>): void {
  // Check for success indicator
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();
  expect(result.content[0].text).toContain('✅');

  // Check for success keywords
  const text = result.content[0].text.toLowerCase();
  expect(text).toMatch(/created|success/);

  // Check element name is mentioned
  if (expectedData.name) {
    expect(result.content[0].text).toContain(expectedData.name);
  }
}

/**
 * Assert that an element was retrieved successfully
 *
 * Verifies:
 * - MCP tool response contains element data
 * - Retrieved data matches expected data
 *
 * @param result - MCP tool call result
 * @param expectedData - Expected element data
 */
export function assertElementRetrieved(result: any, expectedData: Partial<ElementData>): void {
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();

  const text = result.content[0].text;

  // Check element name is present
  if (expectedData.name) {
    expect(text).toContain(expectedData.name);
  }

  // Check description is present if provided
  if (expectedData.description) {
    expect(text).toContain(expectedData.description);
  }
}

/**
 * Assert that an element was updated successfully
 *
 * Verifies:
 * - MCP tool response indicates success
 * - Update operation completed
 * - New data differs from old data
 *
 * @param result - MCP tool call result
 * @param oldData - Original element data
 * @param newData - Updated element data
 */
export function assertElementUpdated(
  result: any,
  oldData: Partial<ElementData>,
  newData: Partial<ElementData>
): void {
  // Check for success indicator
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();
  expect(result.content[0].text).toContain('✅');

  // Check for update keywords
  const text = result.content[0].text.toLowerCase();
  expect(text).toMatch(/updated|modified|changed|edited/);

  // Verify data actually changed
  if (oldData.name && newData.name && oldData.name === newData.name) {
    // Same element - verify other fields changed
    expect(oldData).not.toEqual(newData);
  }
}

/**
 * Assert that an element was deleted successfully
 *
 * Verifies:
 * - MCP tool response indicates success
 * - Deletion message is present
 * - Element identifier is mentioned
 *
 * @param result - MCP tool call result
 * @param elementId - Element name/identifier
 */
export function assertElementDeleted(result: any, elementId: string): void {
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();
  expect(result.content[0].text).toContain('✅');

  const text = result.content[0].text.toLowerCase();
  expect(text).toMatch(/deleted|removed/);

  // Check element name is mentioned
  expect(result.content[0].text).toContain(elementId);
}

/**
 * Assert that element validation completed
 *
 * Verifies:
 * - MCP tool response contains validation report
 * - Expected errors/warnings are present (if any)
 *
 * @param result - MCP tool call result
 * @param expectedErrors - Expected error messages (optional)
 */
export function assertElementValidated(result: any, expectedErrors?: string[]): void {
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();

  const text = result.content[0].text;

  // Check for validation report
  expect(text).toMatch(/validation|valid/i);

  // If errors expected, verify they're present
  if (expectedErrors && expectedErrors.length > 0) {
    expectedErrors.forEach(error => {
      expect(text.toLowerCase()).toContain(error.toLowerCase());
    });
  }
}

/**
 * Assert that element activation completed successfully
 *
 * Verifies:
 * - MCP tool response indicates activation success
 * - Expected state changes occurred (if applicable)
 *
 * @param result - MCP tool call result
 * @param expectedState - Expected activation state (optional)
 */
export function assertElementActivated(result: any, expectedState?: Record<string, any>): void {
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();

  const text = result.content[0].text.toLowerCase();

  // Check for activation keywords
  // FIX: Issue #20 - Accept "ready to use" for templates (they're stateless)
  expect(text).toMatch(/activated|active|enabled|ready to use/);

  // If expected state provided, verify it
  if (expectedState) {
    Object.entries(expectedState).forEach(([_key, value]) => {
      expect(text).toContain(String(value).toLowerCase());
    });
  }
}

/**
 * Assert that an operation failed with expected error
 *
 * Verifies:
 * - MCP tool response indicates failure
 * - Error message matches expected pattern
 *
 * @param result - MCP tool call result
 * @param expectedError - Expected error message or pattern
 */
export function assertOperationFailed(result: any, expectedError?: string): void {
  expect(result.content).toBeDefined();
  expect(result.content[0]).toBeDefined();

  const text = result.content[0].text.toLowerCase();

  // Check for failure indicator
  expect(text).toMatch(/❌|error|failed|invalid/);

  // If specific error expected, verify it
  if (expectedError) {
    expect(text).toContain(expectedError.toLowerCase());
  }
}

/**
 * Assert that a field value matches expected value
 *
 * Generic helper for verifying field values in element data.
 *
 * @param actualData - Actual element data
 * @param fieldPath - Dot-notation field path
 * @param expectedValue - Expected value
 */
export function assertFieldValue(
  actualData: any,
  fieldPath: string,
  expectedValue: any
): void {
  const value = getNestedValue(actualData, fieldPath);
  expect(value).toEqual(expectedValue);
}

/**
 * Assert that a field exists in element data
 *
 * @param data - Element data
 * @param fieldPath - Dot-notation field path
 */
export function assertFieldExists(data: any, fieldPath: string): void {
  const value = getNestedValue(data, fieldPath);
  expect(value).toBeDefined();
}

/**
 * Assert that a field does not exist in element data
 *
 * @param data - Element data
 * @param fieldPath - Dot-notation field path
 */
export function assertFieldNotExists(data: any, fieldPath: string): void {
  const value = getNestedValue(data, fieldPath);
  expect(value).toBeUndefined();
}

/**
 * Assert that an array contains expected number of items
 *
 * @param array - Array to check
 * @param expectedCount - Expected number of items
 */
export function assertArrayLength(array: any[], expectedCount: number): void {
  expect(Array.isArray(array)).toBe(true);
  expect(array).toHaveLength(expectedCount);
}

/**
 * Assert that an array contains an item matching criteria
 *
 * @param array - Array to search
 * @param predicate - Matching function
 */
export function assertArrayContains(
  array: any[],
  predicate: (item: any) => boolean
): void {
  expect(Array.isArray(array)).toBe(true);
  const found = array.some(predicate);
  expect(found).toBe(true);
}

/**
 * Get nested value from object using dot notation
 *
 * @param obj - Object to traverse
 * @param path - Dot-notation path
 * @returns Value at path or undefined
 *
 * @example
 * ```typescript
 * const value = getNestedValue(data, 'metadata.activationStrategy');
 * ```
 */
export function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Set nested value in object using dot notation
 *
 * @param obj - Object to modify
 * @param path - Dot-notation path
 * @param value - Value to set
 *
 * @example
 * ```typescript
 * setNestedValue(data, 'metadata.activationStrategy', 'all');
 * ```
 */
export function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => {
    if (!current[key]) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
}

/**
 * Deep clone an object
 *
 * @param obj - Object to clone
 * @returns Deep copy of object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Wait for a condition to be true
 *
 * Useful for testing async operations or state changes.
 *
 * @param condition - Function that returns true when condition met
 * @param timeout - Maximum time to wait in ms (default: 5000)
 * @param interval - Check interval in ms (default: 100)
 * @returns Promise that resolves when condition is true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await condition();
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

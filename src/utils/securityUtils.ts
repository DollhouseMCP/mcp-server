/**
 * Security utility functions for preventing prototype pollution and other vulnerabilities
 */

/**
 * List of property names that should never be used as object keys
 * to prevent prototype pollution attacks
 */
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * Validates that a property key is safe to use (not a prototype pollution vector)
 * @param key The property key to validate
 * @param context Optional context for the error message (e.g., "path" or "section")
 * @throws Error if the key is forbidden
 */
export function validatePropertyKey(key: string, context: string = 'property'): void {
  if (FORBIDDEN_KEYS.includes(key as any)) {
    throw new Error(`Forbidden property in ${context}: ${key}`);
  }
}

/**
 * Validates all keys in a dot-notation path
 * @param path Dot-notation path (e.g., "user.settings.theme")
 * @param context Optional context for the error message (e.g., "path" or "section")
 * @throws Error if any key in the path is forbidden
 */
export function validatePropertyPath(path: string, context: string = 'path'): void {
  const keys = path.split('.');
  for (const key of keys) {
    validatePropertyKey(key, context);
  }
}

/**
 * Safely sets a property on an object using Object.defineProperty
 * to prevent prototype pollution
 * @param target The target object
 * @param key The property key
 * @param value The value to set
 */
export function safeSetProperty(target: any, key: string, value: any): void {
  validatePropertyKey(key);

  Object.defineProperty(target, key, {
    value: value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

/**
 * Creates a new object without prototype chain (using Object.create(null))
 * This prevents prototype pollution attacks on newly created objects
 * @returns A new object with no prototype
 */
export function createSafeObject(): Record<string, any> {
  return Object.create(null);
}

/**
 * Safely checks if an object has a property without traversing the prototype chain
 * @param target The target object
 * @param key The property key to check
 * @returns true if the object has the property, false otherwise
 */
export function safeHasOwnProperty(target: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Safely navigates an object path, creating intermediate objects as needed
 * All created objects are prototype-less to prevent pollution
 * @param root The root object to navigate
 * @param path Dot-notation path (e.g., "user.settings.theme")
 * @returns The final object in the path where the value should be set
 */
export function safeNavigateObject(root: any, path: string): any {
  validatePropertyPath(path);

  const keys = path.split('.');
  let current = root;

  // Navigate to the parent object, creating safe objects as needed
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!safeHasOwnProperty(current, key)) {
      current[key] = createSafeObject();
    }
    current = current[key];
  }

  return { parent: current, lastKey: keys[keys.length - 1] };
}

/**
 * Safely sets a value at a dot-notation path in an object
 * @param root The root object
 * @param path Dot-notation path (e.g., "user.settings.theme")
 * @param value The value to set
 */
export function safeSetPath(root: any, path: string, value: any): void {
  const { parent, lastKey } = safeNavigateObject(root, path);
  safeSetProperty(parent, lastKey, value);
}
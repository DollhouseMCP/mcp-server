/**
 * NormalizerRegistry - Central registry for parameter normalizers
 *
 * Manages registration and retrieval of normalizers by name.
 * Normalizers are registered at startup and looked up during
 * schema-driven dispatch.
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

import type { Normalizer } from './types.js';

/**
 * Registry for managing parameter normalizers.
 *
 * Provides a centralized location for registering and retrieving
 * normalizers used by the schema-driven dispatch system.
 *
 * @example
 * ```typescript
 * // Register a normalizer
 * NormalizerRegistry.register(new SearchParamsNormalizer());
 *
 * // Retrieve by name
 * const normalizer = NormalizerRegistry.get('searchParams');
 * ```
 */
export class NormalizerRegistry {
  private static readonly normalizers = new Map<string, Normalizer>();

  /**
   * Register a normalizer.
   *
   * @param normalizer - The normalizer to register
   * @throws Error if a normalizer with the same name is already registered
   */
  static register(normalizer: Normalizer): void {
    if (this.normalizers.has(normalizer.name)) {
      throw new Error(
        `Normalizer '${normalizer.name}' is already registered. ` +
        'Use unregister() first if you need to replace it.'
      );
    }
    this.normalizers.set(normalizer.name, normalizer);
  }

  /**
   * Unregister a normalizer by name.
   *
   * @param name - The normalizer name to unregister
   * @returns true if the normalizer was removed, false if not found
   */
  static unregister(name: string): boolean {
    return this.normalizers.delete(name);
  }

  /**
   * Get a normalizer by name.
   *
   * @param name - The normalizer name
   * @returns The normalizer, or undefined if not found
   */
  static get(name: string): Normalizer | undefined {
    return this.normalizers.get(name);
  }

  /**
   * Check if a normalizer is registered.
   *
   * @param name - The normalizer name
   * @returns true if registered
   */
  static has(name: string): boolean {
    return this.normalizers.has(name);
  }

  /**
   * Get all registered normalizer names.
   *
   * @returns Array of normalizer names
   */
  static list(): string[] {
    return Array.from(this.normalizers.keys());
  }

  /**
   * Clear all registered normalizers.
   *
   * Primarily used for testing.
   */
  static clear(): void {
    this.normalizers.clear();
  }

  /**
   * Get the count of registered normalizers.
   *
   * @returns Number of registered normalizers
   */
  static get size(): number {
    return this.normalizers.size;
  }
}

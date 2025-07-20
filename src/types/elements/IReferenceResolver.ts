/**
 * Reference resolver system for handling element references.
 * Supports lazy loading, caching, and various reference types.
 */

import { Reference } from './IElement.js';

// Main resolver interface
export interface IReferenceResolver {
  resolve(ref: Reference): Promise<ResolvedReference>;
  cache(ref: Reference, data: any): Promise<void>;
  invalidate(ref: Reference): Promise<void>;
  
  // Batch operations
  resolveMany(refs: Reference[]): Promise<ResolvedReference[]>;
  invalidateAll(): Promise<void>;
  
  // Cache management
  getCacheSize(): number;
  clearCache(): Promise<void>;
  setCacheLimit(limit: number): void;
}

// Resolved reference with metadata
export interface ResolvedReference {
  reference: Reference;
  data: any;
  resolvedAt: Date;
  expiresAt?: Date;
  fromCache: boolean;
  error?: Error;
}

// Reference resolution strategies
export interface IResolutionStrategy {
  canResolve(ref: Reference): boolean;
  resolve(ref: Reference): Promise<any>;
  getCacheKey(ref: Reference): string;
}

// Cache interface for reference data
export interface IReferenceCache {
  get(key: string): Promise<CachedReference | null>;
  set(key: string, data: CachedReference): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): number;
}

// Cached reference data
export interface CachedReference {
  data: any;
  cachedAt: Date;
  expiresAt?: Date;
  reference: Reference;
}

// Reference validation
export interface IReferenceValidator {
  validate(ref: Reference): ReferenceValidationResult;
  validateUri(uri: string, type: Reference['type']): boolean;
  sanitizeUri(uri: string): string;
}

// Validation result for references
export interface ReferenceValidationResult {
  valid: boolean;
  errors?: string[];
  sanitizedReference?: Reference;
}
/**
 * Element manager interface for handling element operations.
 * Each element type should have a corresponding manager implementation.
 */

import { IElement, ElementValidationResult } from './IElement.js';
import { ElementType } from '../../portfolio/types.js';

// Generic element manager interface
export interface IElementManager<T extends IElement> {
  // CRUD operations
  load(path: string): Promise<T>;
  save(element: T, path: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  
  // Collection operations
  list(): Promise<T[]>;
  find(predicate: (element: T) => boolean): Promise<T | undefined>;
  findMany(predicate: (element: T) => boolean): Promise<T[]>;
  
  // Validation
  validate(element: T): ElementValidationResult;
  validatePath(path: string): boolean;
  
  // Element type info
  getElementType(): ElementType;
  getFileExtension(): string;
  
  // Import/Export
  importElement(data: string, format?: 'json' | 'yaml' | 'markdown'): Promise<T>;
  exportElement(element: T, format?: 'json' | 'yaml' | 'markdown'): Promise<string>;
}

// Element factory for creating new instances
export interface IElementFactory<T extends IElement> {
  create(metadata: Partial<T['metadata']>): T;
  createFromTemplate(templateId: string, overrides?: Partial<T>): Promise<T>;
  getDefaultMetadata(): T['metadata'];
}

// Element lifecycle manager
export interface IElementLifecycleManager<T extends IElement> {
  // Activation
  activate(element: T): Promise<void>;
  deactivate(element: T): Promise<void>;
  isActive(element: T): boolean;
  getActiveElements(): T[];
  
  // State management
  suspend(element: T): Promise<void>;
  resume(element: T): Promise<void>;
  
  // Events
  onActivate(handler: (element: T) => void): void;
  onDeactivate(handler: (element: T) => void): void;
  onStatusChange(handler: (element: T, oldStatus: string, newStatus: string) => void): void;
}

// Batch operations interface
export interface IBatchOperations<T extends IElement> {
  loadMany(paths: string[]): Promise<T[]>;
  saveMany(elements: Map<string, T>): Promise<void>;
  deleteMany(paths: string[]): Promise<void>;
  validateMany(elements: T[]): Map<T, ElementValidationResult>;
}

// Search and filter interface
export interface IElementSearch<T extends IElement> {
  search(query: string): Promise<T[]>;
  searchByTag(tag: string): Promise<T[]>;
  searchByAuthor(author: string): Promise<T[]>;
  filter(criteria: FilterCriteria<T>): Promise<T[]>;
}

// Filter criteria for elements
export interface FilterCriteria<T extends IElement> {
  type?: ElementType;
  tags?: string[];
  author?: string;
  minRating?: number;
  maxRating?: number;
  hasReferences?: boolean;
  custom?: (element: T) => boolean;
}

// Element versioning interface
export interface IElementVersioning<T extends IElement> {
  getVersion(element: T): string;
  incrementVersion(element: T, type: 'major' | 'minor' | 'patch'): T;
  compareVersions(v1: string, v2: string): -1 | 0 | 1;
  isCompatible(element: T, constraint: string): boolean;
}
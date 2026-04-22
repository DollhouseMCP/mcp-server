/**
 * ElementResolver - Name/ID resolution for element managers.
 *
 * Owns findByName(), findInCache(), tryDirectLoad(), find(), and findMany().
 * Receives a host reference for utility methods that must remain on
 * BaseElementManager (normalizeFilename, getElementFilename, resolveAbsolutePath)
 * and for calling the public load() and list() methods.
 * Extracted from BaseElementManager; no behaviour changed.
 */

import { IElement } from '../../types/elements/IElement.js';
import { IStorageLayer } from '../../storage/IStorageLayer.js';
import type { ElementCache } from './ElementCache.js';

/**
 * Host interface: the resolver calls back into BaseElementManager for
 * utilities that stay on the base class.
 */
export interface ElementResolverHost<T extends IElement> {
  load(filePath: string): Promise<T>;
  list(options?: { includePublic?: boolean }): Promise<T[]>;
  normalizeFilename(name: string): string;
  getElementFilename(name: string): string;
  getFileExtension(): string;
  resolveAbsolutePath(filePath: string): string;
}

export class ElementResolver<T extends IElement> {
  constructor(
    private readonly host: ElementResolverHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly storageLayer: IStorageLayer,
  ) {}

  /**
   * Find an element by name or ID without loading all elements.
   * Tries cache → storage index → direct file → full list (fallback).
   * Identical to the former BaseElementManager.findByName() body.
   */
  async findByName(identifier: string): Promise<T | undefined> {
    const cachedElement = await this.findInCache(identifier);
    if (cachedElement) return cachedElement;

    const indexedPath = this.storageLayer.getPathByName(identifier);
    if (indexedPath) {
      try {
        return await this.host.load(indexedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const directLoadAttempt = await this.tryDirectLoad(identifier);
    if (directLoadAttempt) return directLoadAttempt;

    if (this.storageLayer.hasCompletedScan()) {
      return undefined;
    }

    const elements = await this.host.list();
    const normalizedIdentifier = this.host.normalizeFilename(identifier);
    return elements.find(e =>
      this.host.normalizeFilename(e.metadata.name) === normalizedIdentifier ||
      e.metadata.name.toLowerCase() === identifier.toLowerCase() ||
      e.id === identifier,
    );
  }

  /**
   * Search cache for element by name or ID.
   */
  async findInCache(identifier: string): Promise<T | undefined> {
    const possibleFilenames = [
      identifier,
      `${identifier}${this.host.getFileExtension()}`,
      this.host.getElementFilename(identifier),
    ];

    for (const filename of possibleFilenames) {
      const absolutePath = this.host.resolveAbsolutePath(filename);
      const element = this.cache.getCachedByAbsolutePath(absolutePath);
      if (element) return element;
    }

    return undefined;
  }

  /**
   * Try loading element directly by constructing expected filenames.
   */
  async tryDirectLoad(identifier: string): Promise<T | undefined> {
    const possiblePaths = [
      this.host.getElementFilename(identifier),
      `${identifier}${this.host.getFileExtension()}`,
      identifier,
    ];

    for (const filePath of possiblePaths) {
      try {
        const element = await this.host.load(filePath);
        const normalizedMetaName = this.host.normalizeFilename(element.metadata.name);
        const normalizedIdentifier = this.host.normalizeFilename(identifier);
        if (
          normalizedMetaName === normalizedIdentifier ||
          element.metadata.name.toLowerCase() === identifier.toLowerCase() ||
          element.id === identifier
        ) {
          return element;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }

    return undefined;
  }

  /**
   * Find an element by predicate (full list scan).
   */
  async find(predicate: (element: T) => boolean): Promise<T | undefined> {
    const elements = await this.host.list();
    return elements.find(predicate);
  }

  /**
   * Find multiple elements by predicate (full list scan).
   */
  async findMany(predicate: (element: T) => boolean): Promise<T[]> {
    const elements = await this.host.list();
    return elements.filter(predicate);
  }
}

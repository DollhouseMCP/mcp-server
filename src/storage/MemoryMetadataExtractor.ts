/**
 * Extracts metadata from pure YAML memory files for lightweight indexing.
 *
 * Memory files differ from other elements: they are pure YAML (not markdown
 * with frontmatter). Metadata lives under a top-level `metadata` key or
 * directly as top-level keys. This extractor reads raw YAML and returns
 * the subset of fields needed for ElementIndexEntry without constructing
 * a full Memory object.
 */

import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { MEMORY_CONSTANTS } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import type { ElementIndexEntry } from './types.js';
import { logger } from '../utils/logger.js';

export class MemoryMetadataExtractor {
  /**
   * Align with the memory save/load limit (256KB). Issue #2329: this was 64KB,
   * so memories that grew past it indexed as 'unnamed' with default metadata.
   */
  private static readonly MAX_YAML_SIZE = MEMORY_CONSTANTS.MAX_YAML_SIZE;

  /**
   * Extract index-relevant metadata from raw YAML memory content.
   *
   * @param rawContent - Full YAML file content
   * @param relativePath - Path relative to the memories element directory
   * @returns Partial ElementIndexEntry with extracted fields
   */
  static extractMetadata(rawContent: string, relativePath: string): Partial<ElementIndexEntry> {
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      return MemoryMetadataExtractor.defaultEntry(relativePath);
    }

    const yamlData = MemoryMetadataExtractor.parseMetadataYaml(rawContent, relativePath);
    if (!yamlData) return MemoryMetadataExtractor.defaultEntry(relativePath);

    // Memory files store metadata under a top-level `metadata` key or directly as top-level keys
    const metadataSource = MemoryMetadataExtractor.getMetadataSource(yamlData);
    const memoryType = MemoryMetadataExtractor.normalizedString(metadataSource.memoryType)
      || MemoryMetadataExtractor.inferMemoryType(relativePath);

    const entry: Partial<ElementIndexEntry> = {
      filePath: relativePath,
      name: MemoryMetadataExtractor.normalizedString(metadataSource.name) || 'unnamed',
      description: MemoryMetadataExtractor.normalizedString(metadataSource.description),
      version: MemoryMetadataExtractor.normalizedString(metadataSource.version) || '1.0.0',
      author: MemoryMetadataExtractor.normalizedString(metadataSource.author),
      tags: MemoryMetadataExtractor.normalizedTags(metadataSource.tags),
      memoryType,
    };

    const autoLoad = MemoryMetadataExtractor.booleanValue(metadataSource.autoLoad);
    const priority = MemoryMetadataExtractor.numberValue(metadataSource.priority);
    const totalEntries = MemoryMetadataExtractor.getTotalEntries(yamlData);
    if (autoLoad !== undefined) entry.autoLoad = autoLoad;
    if (priority !== undefined) entry.priority = priority;
    if (totalEntries !== undefined) entry.totalEntries = totalEntries;

    return entry;
  }

  private static parseMetadataYaml(
    rawContent: string,
    relativePath: string
  ): Record<string, unknown> | undefined {
    const primaryParse = MemoryMetadataExtractor.tryParseYamlObject(rawContent);
    if (primaryParse.data) return primaryParse.data;

    // Multi-document streams (frontmatter + content) fail single-doc parsing.
    const frontmatter = MemoryMetadataExtractor.extractFrontmatter(rawContent);
    if (!frontmatter) {
      if (primaryParse.errorMessage) {
        logger.debug('MemoryMetadataExtractor: failed to parse YAML, returning default metadata', {
          relativePath,
          stage: 'primary',
          error: primaryParse.errorMessage,
        });
      }
      return undefined;
    }

    const fallbackParse = MemoryMetadataExtractor.tryParseYamlObject(frontmatter);
    if (fallbackParse.data) return fallbackParse.data;

    logger.debug('MemoryMetadataExtractor: failed to parse YAML (primary + frontmatter fallback), returning default metadata', {
      relativePath,
      primaryError: primaryParse.errorMessage,
      fallbackError: fallbackParse.errorMessage,
    });
    return undefined;
  }

  private static getMetadataSource(yamlData: Record<string, unknown>): Record<string, unknown> {
    const metadata = yamlData.metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : yamlData;
  }

  private static normalizedString(value: unknown): string {
    return typeof value === 'string' ? MemoryMetadataExtractor.normalizeText(value) : '';
  }

  private static normalizedTags(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(tag => typeof tag === 'string')) return [];
    return value
      .map(tag => MemoryMetadataExtractor.normalizeText(tag))
      .filter(tag => tag.length > 0);
  }

  private static booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private static numberValue(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  private static getTotalEntries(yamlData: Record<string, unknown>): number | undefined {
    const stats = yamlData.stats;
    if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
      const totalEntries = (stats as Record<string, unknown>).totalEntries;
      if (typeof totalEntries === 'number') return totalEntries;
    }
    return Array.isArray(yamlData.entries) ? yamlData.entries.length : undefined;
  }

  /**
   * Infer the memory type from the file's relative path.
   *
   * @param relativePath - Path relative to the memories directory
   * @returns 'system' | 'adapter' | 'user'
   */
  static inferMemoryType(relativePath: string): string {
    // Normalize separators to forward slash for consistent matching
    const normalized = relativePath.replaceAll('\\', '/');

    if (normalized.startsWith('system/')) return 'system';
    if (normalized.startsWith('adapters/')) return 'adapter';
    return 'user';
  }

  /**
   * Extract YAML content between --- frontmatter markers.
   * Returns null if no valid frontmatter block found.
   */
  private static extractFrontmatter(rawContent: string): string | null {
    const trimmed = rawContent.trim();
    if (!trimmed.startsWith('---')) return null;

    const endIndex = trimmed.indexOf('\n---', 3);
    if (endIndex === -1) return null;

    return trimmed.substring(3, endIndex).trim();
  }

  /**
   * Parse raw YAML using the centralized secure parser.
   * Returns parse diagnostics so callers can fail closed while preserving error context.
   */
  private static tryParseYamlObject(content: string): { data?: Record<string, unknown>; errorMessage?: string } {
    try {
      const data = SecureYamlParser.parseRawYaml(content, {
        maxSize: MemoryMetadataExtractor.MAX_YAML_SIZE,
        contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(data)) {
        return { errorMessage: 'Malicious memory control content detected' };
      }
      return { data };
    } catch (error) {
      return {
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Return a minimal default entry for empty/corrupt content. */
  private static defaultEntry(relativePath: string): Partial<ElementIndexEntry> {
    return {
      filePath: relativePath,
      name: 'unnamed',
      description: '',
      version: '1.0.0',
      author: '',
      tags: [],
      memoryType: MemoryMetadataExtractor.inferMemoryType(relativePath),
    };
  }

  private static normalizeText(value: string): string {
    return UnicodeValidator.normalize(value).normalizedContent;
  }
}

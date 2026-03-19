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
import type { ElementIndexEntry } from './types.js';
import { logger } from '../utils/logger.js';

export class MemoryMetadataExtractor {
  /** Align with SecureYamlParser default raw YAML limit (64KB). */
  private static readonly MAX_YAML_SIZE = 64 * 1024;

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

    const primaryParse = MemoryMetadataExtractor.tryParseYamlObject(rawContent);
    let yamlData = primaryParse.data;
    if (!yamlData) {
      // Multi-document streams (frontmatter + content) fail single-doc parsing.
      // Extract just the frontmatter block and retry parsing safely.
      const fmContent = MemoryMetadataExtractor.extractFrontmatter(rawContent);
      if (!fmContent) {
        if (primaryParse.errorMessage) {
          logger.debug('MemoryMetadataExtractor: failed to parse YAML, returning default metadata', {
            relativePath,
            stage: 'primary',
            error: primaryParse.errorMessage,
          });
        }
        return MemoryMetadataExtractor.defaultEntry(relativePath);
      }
      const fallbackParse = MemoryMetadataExtractor.tryParseYamlObject(fmContent);
      yamlData = fallbackParse.data;
      if (!yamlData) {
        logger.debug('MemoryMetadataExtractor: failed to parse YAML (primary + frontmatter fallback), returning default metadata', {
          relativePath,
          primaryError: primaryParse.errorMessage,
          fallbackError: fallbackParse.errorMessage,
        });
        return MemoryMetadataExtractor.defaultEntry(relativePath);
      }
    }

    // Memory files store metadata under a top-level `metadata` key or directly as top-level keys
    const metadataSource = (
      yamlData.metadata && typeof yamlData.metadata === 'object' && !Array.isArray(yamlData.metadata)
        ? yamlData.metadata
        : yamlData
    ) as Record<string, unknown>;

    const normalizedName = typeof metadataSource.name === 'string'
      ? MemoryMetadataExtractor.normalizeText(metadataSource.name)
      : '';
    const name = normalizedName.length > 0
      ? normalizedName
      : 'unnamed';

    const description = typeof metadataSource.description === 'string'
      ? MemoryMetadataExtractor.normalizeText(metadataSource.description)
      : '';

    const normalizedVersion = typeof metadataSource.version === 'string'
      ? MemoryMetadataExtractor.normalizeText(metadataSource.version)
      : '';
    const version = normalizedVersion.length > 0
      ? normalizedVersion
      : '1.0.0';

    const author = typeof metadataSource.author === 'string'
      ? MemoryMetadataExtractor.normalizeText(metadataSource.author)
      : '';

    const tags = Array.isArray(metadataSource.tags) && metadataSource.tags.every((t: unknown) => typeof t === 'string')
      ? (metadataSource.tags as string[])
        .map(tag => MemoryMetadataExtractor.normalizeText(tag))
        .filter(tag => tag.length > 0)
      : [];

    const autoLoad = typeof metadataSource.autoLoad === 'boolean'
      ? metadataSource.autoLoad
      : undefined;

    const priority = typeof metadataSource.priority === 'number'
      ? metadataSource.priority
      : undefined;

    const normalizedMemoryType = typeof metadataSource.memoryType === 'string'
      ? MemoryMetadataExtractor.normalizeText(metadataSource.memoryType)
      : '';
    const memoryType = normalizedMemoryType.length > 0
      ? normalizedMemoryType
      : MemoryMetadataExtractor.inferMemoryType(relativePath);

    // totalEntries: prefer stats.totalEntries, fall back to entries array length
    let totalEntries: number | undefined;
    const stats = yamlData.stats as Record<string, unknown> | undefined;
    if (stats && typeof stats === 'object' && typeof stats.totalEntries === 'number') {
      totalEntries = stats.totalEntries;
    } else if (Array.isArray(yamlData.entries)) {
      totalEntries = yamlData.entries.length;
    }

    const entry: Partial<ElementIndexEntry> = {
      filePath: relativePath,
      name,
      description,
      version,
      author,
      tags,
      memoryType,
    };

    if (autoLoad !== undefined) entry.autoLoad = autoLoad;
    if (priority !== undefined) entry.priority = priority;
    if (totalEntries !== undefined) entry.totalEntries = totalEntries;

    return entry;
  }

  /**
   * Infer the memory type from the file's relative path.
   *
   * @param relativePath - Path relative to the memories directory
   * @returns 'system' | 'adapter' | 'user'
   */
  static inferMemoryType(relativePath: string): string {
    // Normalize separators to forward slash for consistent matching
    const normalized = relativePath.replace(/\\/g, '/');

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
      return { data: SecureYamlParser.parseRawYaml(content, MemoryMetadataExtractor.MAX_YAML_SIZE) };
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

/**
 * Extracts metadata from pure YAML memory files for lightweight indexing.
 *
 * Memory files differ from other elements: they are pure YAML (not markdown
 * with frontmatter). Metadata lives under a top-level `metadata` key or
 * directly as top-level keys. This extractor reads raw YAML and returns
 * the subset of fields needed for ElementIndexEntry without constructing
 * a full Memory object.
 */

import { SecureYamlParser, matchFrontmatterFrame, hasFrontmatterFraming } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { MEMORY_CONSTANTS, DEFAULT_MEMORY_NAME } from '../elements/memories/constants.js';
import { validateMemoryControlFields } from '../elements/memories/memoryYamlValidation.js';
import type { ElementIndexEntry } from './types.js';
import { SecurityError } from '../errors/SecurityError.js';

/** Metadata rejected by parsing or validation must not be indexed with defaults. */
export class MemoryMetadataExtractionError extends Error {
  constructor(relativePath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot extract memory metadata from ${relativePath}: ${reason}`, { cause });
    this.name = 'MemoryMetadataExtractionError';
  }
}

export class MemoryMetadataExtractor {
  /**
   * Align with the memory load limit. Issue #2329: this was 64KB, so memories
   * that grew past it indexed as 'unnamed' with default metadata. Issue #2864:
   * uses the legacy recovery limit so a memory written before the 256KB save
   * cap still lists under its own name; it loads read-only.
   */
  private static readonly MAX_YAML_SIZE = MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE;

  /**
   * Extract index-relevant metadata from raw YAML memory content.
   *
   * @param rawContent - Full YAML file content
   * @param relativePath - Path relative to the memories element directory
   * @returns Partial ElementIndexEntry with extracted fields
   */
  static extractMetadata(rawContent: string, relativePath: string): Partial<ElementIndexEntry> {
    // Empty documents have no metadata yet; parser rejections are never defaults.
    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      return MemoryMetadataExtractor.defaultEntry(relativePath);
    }

    const yamlData = MemoryMetadataExtractor.parseMetadataYaml(rawContent, relativePath);

    // Memory files store metadata under a top-level `metadata` key or directly as top-level keys
    const metadataSource = MemoryMetadataExtractor.getMetadataSource(yamlData);
    const memoryType = MemoryMetadataExtractor.normalizedString(metadataSource.memoryType)
      || MemoryMetadataExtractor.inferMemoryType(relativePath);

    const entry: Partial<ElementIndexEntry> = {
      filePath: relativePath,
      name: MemoryMetadataExtractor.normalizedString(metadataSource.name) || DEFAULT_MEMORY_NAME,
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

  private static parseMetadataYaml(rawContent: string, relativePath: string): Record<string, unknown> {
    try {
      // After empty input, bound the whole file before selecting its framing.
      // No frame means default metadata; only parsed metadata gets Unicode validation.
      // Framed prose is not metadata, matching the loader content policy.
      if (rawContent.length > MemoryMetadataExtractor.MAX_YAML_SIZE) {
        throw SecurityError.contentValidation('Memory document exceeds size limits');
      }
      let yamlContent = rawContent;
      if (hasFrontmatterFraming(rawContent)) {
        const frame = matchFrontmatterFrame(rawContent);
        if (!frame) return {};
        yamlContent = frame.frontmatter;
      }
      const data = SecureYamlParser.parseRawYaml(yamlContent, {
        maxSize: MemoryMetadataExtractor.MAX_YAML_SIZE,
        contentPolicy: 'structure-only',
      });
      if (!validateMemoryControlFields(data)) {
        throw SecurityError.contentValidation('Malicious memory control content detected');
      }
      return data;
    } catch (error) {
      throw new MemoryMetadataExtractionError(relativePath, error);
    }
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

  /** Return a minimal default entry for an empty document. */
  private static defaultEntry(relativePath: string): Partial<ElementIndexEntry> {
    return {
      filePath: relativePath,
      name: DEFAULT_MEMORY_NAME,
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

/**
 * Thin wrapper around SecureYamlParser for extracting element metadata
 * from markdown frontmatter.
 *
 * Provides defaults for missing fields so callers always get a complete
 * FrontmatterData object without null checks.
 */

import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface FrontmatterData {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  [key: string]: unknown;
}

export class FrontmatterParser {
  /**
   * Extract metadata from raw markdown file content.
   * Uses SecureYamlParser.parse() which validates and sanitizes YAML.
   *
   * @param rawContent - Full file content including frontmatter delimiters
   * @returns Extracted metadata with defaults for missing fields
   */
  static extractMetadata(rawContent: string): FrontmatterData {
    const parsed = SecureYamlParser.parse(rawContent, {
      validateContent: true,
      validateFields: false,
    });

    const data = parsed.data;

    const normalizedName = typeof data.name === 'string'
      ? FrontmatterParser.normalizeText(data.name)
      : '';
    const normalizedDescription = typeof data.description === 'string'
      ? FrontmatterParser.normalizeText(data.description)
      : '';
    const normalizedVersion = typeof data.version === 'string'
      ? FrontmatterParser.normalizeText(data.version)
      : '';
    const normalizedAuthor = typeof data.author === 'string'
      ? FrontmatterParser.normalizeText(data.author)
      : '';
    const normalizedTags = Array.isArray(data.tags) && data.tags.every((t: unknown) => typeof t === 'string')
      ? (data.tags as string[])
        .map(tag => FrontmatterParser.normalizeText(tag))
        .filter(tag => tag.length > 0)
      : [];

    return {
      ...data,
      name: normalizedName.length > 0
        ? normalizedName
        : 'unnamed',
      description: normalizedDescription.length > 0
        ? normalizedDescription
        : '',
      version: normalizedVersion.length > 0
        ? normalizedVersion
        : '1.0.0',
      author: normalizedAuthor.length > 0
        ? normalizedAuthor
        : '',
      tags: normalizedTags,
    };
  }

  private static normalizeText(value: string): string {
    return UnicodeValidator.normalize(value).normalizedContent;
  }
}

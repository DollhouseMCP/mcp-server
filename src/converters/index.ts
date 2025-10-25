/**
 * Converters Module - Bidirectional conversion between Anthropic Skills and DollhouseMCP Skills
 *
 * This module provides perfect 1:1 bidirectional conversion between:
 * - Anthropic Skills (multi-file directory structure)
 * - DollhouseMCP Skills (single .md file with rich metadata)
 *
 * Based on the 1:1 mapping specification:
 * business/documents/legal/evidence/anthropic-dollhouse-skills-mapping.md
 */

// Core converters
export { DollhouseToAnthropicConverter } from './DollhouseToAnthropicConverter.js';
export { AnthropicToDollhouseConverter } from './AnthropicToDollhouseConverter.js';

// Utilities
export { SchemaMapper } from './SchemaMapper.js';
export { ContentExtractor } from './ContentExtractor.js';

// Types
export type {
    AnthropicSkillMetadata,
    DollhouseMCPSkillMetadata
} from './SchemaMapper.js';

export type {
    ExtractedSection
} from './ContentExtractor.js';

export type {
    AnthropicSkillStructure
} from './DollhouseToAnthropicConverter.js';

export type {
    AnthropicSkillDirectory
} from './AnthropicToDollhouseConverter.js';

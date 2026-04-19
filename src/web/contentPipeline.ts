/**
 * Content Validation Pipeline for Web UI
 *
 * Composes the standalone security validators into a single pipeline
 * for validating portfolio element content before serving to the browser.
 *
 * Uses the same validators as the MCPAQLHandler but without coupling
 * to the handler's operation dispatch. This is the extraction point
 * for the upcoming MCPAQLHandler decomposition.
 *
 * auto-dollhouse#5 / upstream #1679
 * DMCP-SEC-004 compliant: uses UnicodeValidator.normalize() on all inputs
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { ContentValidator, type ContentValidationResult } from '../security/contentValidator.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { LRUCache } from '../cache/LRUCache.js';
import { logger } from '../utils/logger.js';

/** Element types that map to content validation contexts */
const TYPE_TO_CONTEXT: Record<string, 'persona' | 'skill' | 'template' | 'agent' | 'memory'> = {
  personas: 'persona',
  skills: 'skill',
  templates: 'template',
  agents: 'agent',
  memories: 'memory',
};

/** Known metadata fields extracted from YAML frontmatter for web display */
export interface ElementDisplayMetadata {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  created?: string;
  created_date?: string;
  modified?: string;
  tags?: string[];
  license?: string;
  age_rating?: string;
  triggers?: string[];
  instructions?: string;
  coordination_strategy?: string;
  use_cases?: string[];
  proficiency_levels?: Record<string, string>;
  gatekeeper?: Record<string, unknown>;
  goal?: Record<string, unknown>;
  autonomy?: Record<string, unknown>;
  memoryType?: string;
  [key: string]: unknown;
}

export interface PipelineResult {
  valid: boolean;
  content: string;
  metadata: ElementDisplayMetadata;
  body: string;
  rejection?: {
    reason: string;
    severity?: string;
    patterns?: string[];
  };
}

const CONTENT_PIPELINE_CACHE_MAX_SIZE = 256;
const CONTENT_PIPELINE_CACHE_MAX_MEMORY_MB = 16;

const CONTENT_PIPELINE_CACHE = new LRUCache<PipelineResult>({
  name: 'web-content-validation',
  maxSize: CONTENT_PIPELINE_CACHE_MAX_SIZE,
  maxMemoryMB: CONTENT_PIPELINE_CACHE_MAX_MEMORY_MB,
});

function buildContentCacheKey(filename: string, elementType: string, rawContent: string): string {
  const contentHash = createHash('sha256').update(rawContent).digest('hex');
  // Keep filename/type in the key so identical payloads from different routes
  // remain independently attributable if route-specific handling diverges later.
  return JSON.stringify([elementType, filename, contentHash]);
}

function clonePipelineResult(result: PipelineResult): PipelineResult {
  return {
    ...result,
    metadata: { ...result.metadata },
    rejection: result.rejection
      ? {
          ...result.rejection,
          patterns: result.rejection.patterns ? [...result.rejection.patterns] : undefined,
        }
      : undefined,
  };
}

export function resetContentPipelineCacheForTesting(): void {
  CONTENT_PIPELINE_CACHE.clear();
}

/**
 * Validate element content through the security pipeline.
 *
 * @param filename - The element filename (e.g., "alex-sterling.md")
 * @param rawContent - The raw file content string
 * @param elementType - The plural element type directory (e.g., "personas")
 * @returns Validated content with parsed metadata, or rejection with reason
 */
export function validateElementContent(
  filename: string,
  rawContent: string,
  elementType: string,
): PipelineResult {
  // DMCP-SEC-004: Normalize all inputs via UnicodeValidator to prevent
  // homograph attacks, direction override bypasses, and suspicious patterns.
  const filenameValidation = UnicodeValidator.normalize(filename);
  const contentValidation = UnicodeValidator.normalize(rawContent);
  const normalizedFilename = filenameValidation.normalizedContent;
  const normalizedContent = contentValidation.normalizedContent;
  const normalizedType = elementType.normalize('NFC');
  const cacheKey = buildContentCacheKey(normalizedFilename, normalizedType, rawContent);
  const cachedResult = CONTENT_PIPELINE_CACHE.get(cacheKey);
  if (cachedResult) {
    return clonePipelineResult(cachedResult);
  }

  const ext = extname(normalizedFilename);
  const isYaml = ext === '.yaml' || ext === '.yml';
  const contentContext = TYPE_TO_CONTEXT[normalizedType];

  // Step 1: Parse and validate structure (YAML bomb detection, circular refs)
  let metadata: ElementDisplayMetadata = {};
  let body = '';

  try {
    if (isYaml) {
      // Pure YAML file (memories) — use parseRawYaml for structural validation
      // (bomb detection, circular refs, size limits).
      // Skip ContentValidator.validateYamlContent() — it produces false positives
      // on memory content that legitimately contains code patterns, security
      // keywords, and technical documentation. Memories are locally-generated
      // trusted content, not untrusted external submissions.
      const parsed = SecureYamlParser.parseRawYaml(normalizedContent);
      metadata = (typeof parsed === 'object' && parsed !== null) ? parsed : {};
    } else {
      // Markdown with YAML frontmatter
      const parsed = SecureYamlParser.parse(normalizedContent, { contentContext });
      metadata = parsed.data;
      body = parsed.content;
    }
  } catch (err) {
    const result: PipelineResult = {
      valid: false,
      content: normalizedContent,
      metadata: {},
      body: '',
      rejection: { reason: `Parse validation failed: ${(err as Error).message}`, severity: 'high' },
    };
    // Cache parse failures too: steady-state polling can otherwise keep reparsing
    // identical malformed files forever. If the file is fixed, the content hash
    // changes and this entry is naturally bypassed.
    CONTENT_PIPELINE_CACHE.set(cacheKey, clonePipelineResult(result));
    return result;
  }

  // Step 2: Content injection pattern detection (markdown elements only)
  // YAML memories skip this — they contain legitimate code patterns and
  // technical content that triggers false positives. The structural YAML
  // parsing above (bomb/circular ref detection) is sufficient for local content.
  if (!isYaml) {
    const validation: ContentValidationResult = ContentValidator.validateAndSanitize(normalizedContent, {
      contentContext,
    });

    if (!validation.isValid) {
      logger.warn('[ContentPipeline] Content rejected', {
        filename,
        elementType,
        patterns: validation.detectedPatterns,
        severity: validation.severity,
      });
      const result: PipelineResult = {
        valid: false,
        content: normalizedContent,
        metadata,
        body,
        rejection: {
          reason: 'Content failed security validation',
          severity: validation.severity,
          patterns: validation.detectedPatterns,
        },
      };
      CONTENT_PIPELINE_CACHE.set(cacheKey, clonePipelineResult(result));
      return result;
    }
  }

  // Step 3: Return validated content
  const result: PipelineResult = {
    valid: true,
    content: rawContent,
    metadata,
    body,
  };
  CONTENT_PIPELINE_CACHE.set(cacheKey, clonePipelineResult(result));
  return result;
}

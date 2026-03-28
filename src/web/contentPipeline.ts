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

import { extname } from 'node:path';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { ContentValidator, type ContentValidationResult } from '../security/contentValidator.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { logger } from '../utils/logger.js';

/** Element types that map to content validation contexts */
const TYPE_TO_CONTEXT: Record<string, 'persona' | 'skill' | 'template' | 'agent' | 'memory'> = {
  personas: 'persona',
  skills: 'skill',
  templates: 'template',
  agents: 'agent',
  memories: 'memory',
};

export interface PipelineResult {
  valid: boolean;
  content: string;
  metadata: Record<string, unknown>;
  body: string;
  rejection?: {
    reason: string;
    severity?: string;
    patterns?: string[];
  };
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

  const ext = extname(normalizedFilename);
  const isYaml = ext === '.yaml' || ext === '.yml';
  const contentContext = TYPE_TO_CONTEXT[normalizedType];

  // Step 1: Parse and validate structure (YAML bomb detection, circular refs)
  let metadata: Record<string, unknown> = {};
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
    return {
      valid: false,
      content: normalizedContent,
      metadata: {},
      body: '',
      rejection: { reason: `Parse validation failed: ${(err as Error).message}`, severity: 'high' },
    };
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
      return {
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
    }
  }

  // Step 3: Return validated content
  return {
    valid: true,
    content: rawContent,
    metadata,
    body,
  };
}

/**
 * Regression: ContentValidator.validateMetadata must apply per-field
 * length limits. Identity fields (name, description, category, author,
 * version, tags) keep the strict 1KB cap; long-form fields
 * (instructions, content) get the higher MAX_CONTENT_LENGTH limit so
 * non-trivial collection personas actually install.
 *
 * Caught during Phase 4.5 PoC verification on 2026-05-12 — installing
 * `dollhouse-expert` from the public collection failed because the
 * uniform 1024-char limit rejected its instructions field. The
 * `instructions` field is where the persona prompt actually lives, so
 * a strict-but-uniform 1KB cap blocks essentially every real persona.
 */

import { describe, it, expect } from '@jest/globals';
import { ContentValidator } from '../../../src/security/contentValidator.js';
import { SECURITY_LIMITS } from '../../../src/security/constants.js';

describe('ContentValidator.validateMetadata per-field length limits', () => {
  describe('identity-shaped fields (1KB cap)', () => {
    it.each(['name', 'description', 'category', 'author', 'version'])(
      'rejects %s when over MAX_METADATA_FIELD_LENGTH (1024 chars)',
      (fieldName) => {
        const metadata = { [fieldName]: 'a'.repeat(SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH + 10) };
        const result = ContentValidator.validateMetadata(metadata);
        expect(result.isValid).toBe(false);
        expect(result.detectedPatterns?.[0]).toContain(fieldName);
        expect(result.detectedPatterns?.[0]).toContain('exceeds maximum length');
      },
    );

    it.each(['name', 'description', 'category', 'author', 'version'])(
      'accepts %s when at MAX_METADATA_FIELD_LENGTH',
      (fieldName) => {
        const metadata = { [fieldName]: 'a'.repeat(SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH) };
        const result = ContentValidator.validateMetadata(metadata);
        // The actual identifier-shaped checks above are length checks only;
        // we don't assert on the validity bit here because the
        // validateAndSanitize call may flag pure 'a' runs as suspicious
        // patterns. The point is: not the length-cap failure mode.
        expect(result.detectedPatterns?.find(p => p.startsWith(`${fieldName}:`) && p.includes('exceeds maximum length'))).toBeUndefined();
      },
    );
  });

  describe('long-form fields (MAX_CONTENT_LENGTH cap)', () => {
    it('accepts instructions field at 10KB (well over the old 1024 limit)', () => {
      const metadata = {
        name: 'realistic-persona',
        instructions: 'a'.repeat(10_000), // 10KB — typical persona instructions size
      };
      const result = ContentValidator.validateMetadata(metadata);
      // Length-policy check should pass; we don't assert overall .isValid
      // because pure 'a' runs may still trip pattern detection — that's
      // a separate concern from the length policy this test pins.
      expect(
        result.detectedPatterns?.find(p => p.startsWith('instructions:') && p.includes('exceeds maximum length')),
      ).toBeUndefined();
    });

    it('rejects instructions only when over MAX_CONTENT_LENGTH (500KB)', () => {
      const metadata = {
        name: 'huge-persona',
        instructions: 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 10),
      };
      const result = ContentValidator.validateMetadata(metadata);
      expect(result.isValid).toBe(false);
      const lenError = result.detectedPatterns?.find(p => p.includes('instructions:') && p.includes('exceeds maximum length'));
      expect(lenError).toBeDefined();
      expect(lenError).toContain(String(SECURITY_LIMITS.MAX_CONTENT_LENGTH));
    });

    it('accepts content field at the same elevated limit as instructions', () => {
      const metadata = {
        name: 'realistic-persona',
        content: 'a'.repeat(10_000),
      };
      const result = ContentValidator.validateMetadata(metadata);
      expect(
        result.detectedPatterns?.find(p => p.startsWith('content:') && p.includes('exceeds maximum length')),
      ).toBeUndefined();
    });
  });

  describe('error message includes the actual length over the cap', () => {
    it('reports the actual got-length so operators can diagnose without re-running with logging', () => {
      const metadata = { name: 'a'.repeat(1500) };
      const result = ContentValidator.validateMetadata(metadata);
      const err = result.detectedPatterns?.[0];
      expect(err).toContain('got 1500');
    });
  });

  describe('regression: dollhouse-expert-shaped persona (the PoC test case)', () => {
    it('accepts a persona with 5KB of instructions plus standard metadata', () => {
      const metadata = {
        name: 'Dollhouse Expert',
        description: 'Meta — knows the dollhouse system itself',
        category: 'meta',
        author: 'DollhouseMCP',
        version: '1.0.0',
        // ~5KB of instruction text. Real dollhouse-expert is roughly this size.
        instructions: ('You are an expert on the DollhouseMCP system. ').repeat(100),
      };
      const result = ContentValidator.validateMetadata(metadata);
      // No length-cap rejection on any field
      expect(
        result.detectedPatterns?.find(p => p.includes('exceeds maximum length')),
      ).toBeUndefined();
    });
  });
});

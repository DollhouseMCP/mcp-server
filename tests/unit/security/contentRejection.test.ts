import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { isContentRejection, markContentRejection } from '../../../src/security/contentRejection.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { ContentValidator } from '../../../src/security/contentValidator.js';
import { SecurityError } from '../../../src/errors/SecurityError.js';
import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';

function failure(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error('Expected the read to fail');
}

beforeEach(() => SecurityMonitor.clearAllEventsForTesting());
afterEach(() => jest.restoreAllMocks());

describe('content rejection provenance', () => {
  it('preserves error identity and follows causes without trusting codes or names', () => {
    const cause = new SecurityError('invalid', 'YAML_NUMERIC_PRECISION');
    expect(isContentRejection(cause)).toBe(false);
    expect(markContentRejection(cause)).toBe(cause);
    expect(isContentRejection(new Error('context', { cause }))).toBe(true);
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    expect(isContentRejection(cyclic)).toBe(false);
  });

  it.each([
    () => SecureYamlParser.parseRawYaml('name: [', { contentPolicy: 'structure-only' }),
    () => SecureYamlParser.parseRawYaml('value: 9007199254740993', { numericPolicy: 'read-fidelity', schema: 'core' }),
    () => SecureYamlParser.parseRawYaml('- item'),
    () => ContentValidator.validateAndSanitize('a'.repeat(30), { maxLength: 10 }),
    () => MemoryMetadataExtractor.extractMetadata('metadata: [', 'memory.yaml'),
  ])('marks direct byte-derived refusals', action => {
    expect(isContentRejection(failure(action))).toBe(true);
  });

  it('does not mark unsupported parser configuration', () => {
    const error = failure(() => SecureYamlParser.parseRawYaml('value: 1', { numericPolicy: 'read-fidelity', schema: 'json' }));
    expect(isContentRejection(error)).toBe(false);
  });

  it('propagates unmarked infrastructure errors without relabeling them as bad memory content', () => {
    const error = new SecurityError('temporary failure', 'high');
    jest.spyOn(SecureYamlParser, 'parseRawYaml').mockImplementation(() => { throw error; });
    expect(failure(() => MemoryMetadataExtractor.extractMetadata('name: healthy', 'memory.yaml'))).toBe(error);
    expect(isContentRejection(error)).toBe(false);
  });

  it('does not mark mutable content-policy refusals', () => {
    jest.spyOn(ContentValidator, 'validateAndSanitize').mockReturnValue({ isValid: false, severity: 'critical', detectedPatterns: [] });
    const error = failure(() => ContentValidator.sanitizePersonaContent('body'));
    expect(isContentRejection(error)).toBe(false);
  });
});

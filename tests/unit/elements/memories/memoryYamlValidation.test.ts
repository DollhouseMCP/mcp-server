import { validateMemoryControlFields } from '../../../../src/elements/memories/memoryYamlValidation.js';

describe('validateMemoryControlFields', () => {
  it.each([
    "Historical example using require('child_process')",
    'Historical example containing !!python/object',
  ])('leaves historical entry prose to the trust-level scanner: %s', (content) => {
    expect(validateMemoryControlFields({
      name: 'Security research',
      entries: [{
        content,
        sanitizedContent: 'Historical example using [REDACTED]',
        sanitizedPatterns: ['Subprocess execution'],
        trustLevel: 'flagged',
      }],
    })).toBe(true);
  });

  it('continues blocking malicious auxiliary entry fields', () => {
    expect(validateMemoryControlFields({
      name: 'Unsafe source',
      entries: [{
        content: 'Harmless prose',
        source: "require('child_process')",
      }],
    })).toBe(false);
  });

  it('fails closed when a control value cannot be serialized', () => {
    expect(validateMemoryControlFields({
      name: 'Unsupported control value',
      extension: () => 'not serializable',
      entries: [],
    })).toBe(false);
  });
});

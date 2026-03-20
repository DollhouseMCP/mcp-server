/**
 * Unit tests for MemoryMetadataExtractor
 */

import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';

describe('MemoryMetadataExtractor', () => {
  describe('extractMetadata', () => {
    it('should extract fields from YAML with a metadata key wrapper', () => {
      const raw = `
metadata:
  name: Session Context
  description: Stores session context
  version: 2.0.0
  author: System
  tags:
    - session
    - context
  autoLoad: true
  priority: 1
  memoryType: system
entries:
  - content: "first entry"
  - content: "second entry"
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'system/session-context.yml');

      expect(result.name).toBe('Session Context');
      expect(result.description).toBe('Stores session context');
      expect(result.version).toBe('2.0.0');
      expect(result.author).toBe('System');
      expect(result.tags).toEqual(['session', 'context']);
      expect(result.autoLoad).toBe(true);
      expect(result.priority).toBe(1);
      expect(result.memoryType).toBe('system');
      expect(result.totalEntries).toBe(2);
      expect(result.filePath).toBe('system/session-context.yml');
    });

    it('should extract fields from flat YAML (no metadata key)', () => {
      const raw = `
name: Flat Memory
description: A flat YAML memory
version: 1.1.0
author: Bob
tags:
  - flat
  - simple
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'flat-memory.yml');

      expect(result.name).toBe('Flat Memory');
      expect(result.description).toBe('A flat YAML memory');
      expect(result.version).toBe('1.1.0');
      expect(result.author).toBe('Bob');
      expect(result.tags).toEqual(['flat', 'simple']);
      expect(result.filePath).toBe('flat-memory.yml');
    });

    it('should provide defaults for missing fields', () => {
      const raw = `
someOtherKey: value
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'misc.yml');

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBe('');
      expect(result.tags).toEqual([]);
      expect(result.autoLoad).toBeUndefined();
      expect(result.priority).toBeUndefined();
      expect(result.totalEntries).toBeUndefined();
    });

    it('should handle empty content gracefully', () => {
      const result = MemoryMetadataExtractor.extractMetadata('', 'empty.yml');

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBe('');
      expect(result.tags).toEqual([]);
      expect(result.filePath).toBe('empty.yml');
    });

    it('should handle whitespace-only content gracefully', () => {
      const result = MemoryMetadataExtractor.extractMetadata('   \n  \n  ', 'blank.yml');

      expect(result.name).toBe('unnamed');
      expect(result.filePath).toBe('blank.yml');
    });

    it('should handle corrupt/non-object YAML gracefully', () => {
      // A plain scalar string parses as a string, not an object
      const result = MemoryMetadataExtractor.extractMetadata('just a plain string', 'bad.yml');

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.filePath).toBe('bad.yml');
    });

    it('should handle YAML that parses as an array gracefully', () => {
      const raw = `
- item1
- item2
`;
      const result = MemoryMetadataExtractor.extractMetadata(raw, 'array.yml');

      expect(result.name).toBe('unnamed');
      expect(result.filePath).toBe('array.yml');
    });

    it('should parse frontmatter-style metadata by extracting the YAML block', () => {
      const raw = `---
name: Frontmatter Memory
description: frontmatter metadata
version: 1.2.3
author: Frontmatter Author
---
This is body content that should be ignored for metadata extraction.
`;
      const result = MemoryMetadataExtractor.extractMetadata(raw, 'frontmatter.yml');

      expect(result.name).toBe('Frontmatter Memory');
      expect(result.description).toBe('frontmatter metadata');
      expect(result.version).toBe('1.2.3');
      expect(result.author).toBe('Frontmatter Author');
      expect(result.filePath).toBe('frontmatter.yml');
    });

    it('should fail closed for malicious YAML tags', () => {
      const raw = `
name: Malicious
payload: !!js/function "function () { return process.env; }"
`;
      const result = MemoryMetadataExtractor.extractMetadata(raw, 'malicious.yml');

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.filePath).toBe('malicious.yml');
    });

    it('should fail closed for oversized YAML input', () => {
      const hugeValue = 'a'.repeat(70 * 1024);
      const raw = `
name: Oversized
description: ${hugeValue}
`;
      const result = MemoryMetadataExtractor.extractMetadata(raw, 'oversized.yml');

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.filePath).toBe('oversized.yml');
    });

    it('should extract totalEntries from stats.totalEntries', () => {
      const raw = `
name: Stats Memory
stats:
  totalEntries: 42
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'stats-mem.yml');

      expect(result.totalEntries).toBe(42);
    });

    it('should extract totalEntries from entries array length', () => {
      const raw = `
name: Entries Memory
entries:
  - content: "one"
  - content: "two"
  - content: "three"
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'entries-mem.yml');

      expect(result.totalEntries).toBe(3);
    });

    it('should prefer stats.totalEntries over entries array length', () => {
      const raw = `
name: Both Memory
stats:
  totalEntries: 10
entries:
  - content: "one"
  - content: "two"
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'both.yml');

      expect(result.totalEntries).toBe(10);
    });

    it('should extract autoLoad and priority fields', () => {
      const raw = `
name: Auto Load Memory
autoLoad: true
priority: 5
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'autoload.yml');

      expect(result.autoLoad).toBe(true);
      expect(result.priority).toBe(5);
    });

    it('should not set autoLoad or priority when not present', () => {
      const raw = `
name: No Load Config
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'noconfig.yml');

      expect(result.autoLoad).toBeUndefined();
      expect(result.priority).toBeUndefined();
    });

    it('should ignore non-boolean autoLoad', () => {
      const raw = `
name: Bad AutoLoad
autoLoad: "yes"
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'bad-autoload.yml');

      expect(result.autoLoad).toBeUndefined();
    });

    it('should ignore non-number priority', () => {
      const raw = `
name: Bad Priority
priority: "high"
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'bad-priority.yml');

      expect(result.priority).toBeUndefined();
    });

    it('should default non-string tags to empty array', () => {
      const raw = `
name: Bad Tags
tags:
  - 123
  - true
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'bad-tags.yml');

      expect(result.tags).toEqual([]);
    });

    it('should default tags when not an array', () => {
      const raw = `
name: Scalar Tags
tags: not-an-array
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'scalar-tags.yml');

      expect(result.tags).toEqual([]);
    });

    it('should infer memoryType from path when not in metadata', () => {
      const raw = `
name: Inferred Type
`;

      const systemResult = MemoryMetadataExtractor.extractMetadata(raw, 'system/core.yml');
      expect(systemResult.memoryType).toBe('system');

      const adapterResult = MemoryMetadataExtractor.extractMetadata(raw, 'adapters/slack.yml');
      expect(adapterResult.memoryType).toBe('adapter');

      const userResult = MemoryMetadataExtractor.extractMetadata(raw, 'my-notes.yml');
      expect(userResult.memoryType).toBe('user');
    });

    it('should use explicit memoryType over inferred', () => {
      const raw = `
name: Explicit Type
memoryType: adapter
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'system/override.yml');

      expect(result.memoryType).toBe('adapter');
    });

    it('should normalize canonically equivalent Unicode metadata fields', () => {
      const raw = `
name: Cafe\u0301 Memory
description: Session for cafe\u0301 notes
author: Jose\u0301
tags:
  - cafe\u0301
  - notes
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'unicode.yml');

      expect(result.name).toBe('Café Memory');
      expect(result.description).toBe('Session for café notes');
      expect(result.author).toBe('José');
      expect(result.tags).toEqual(['café', 'notes']);
    });
  });

  describe('inferMemoryType', () => {
    it('should return system for system/ prefix', () => {
      expect(MemoryMetadataExtractor.inferMemoryType('system/core.yml')).toBe('system');
      expect(MemoryMetadataExtractor.inferMemoryType('system/deep/nested.yml')).toBe('system');
    });

    it('should return adapter for adapters/ prefix', () => {
      expect(MemoryMetadataExtractor.inferMemoryType('adapters/slack.yml')).toBe('adapter');
      expect(MemoryMetadataExtractor.inferMemoryType('adapters/teams/config.yml')).toBe('adapter');
    });

    it('should return user for date folders', () => {
      expect(MemoryMetadataExtractor.inferMemoryType('2024/01/notes.yml')).toBe('user');
    });

    it('should return user for root-level files', () => {
      expect(MemoryMetadataExtractor.inferMemoryType('my-memory.yml')).toBe('user');
    });

    it('should handle backslash separators (Windows paths)', () => {
      expect(MemoryMetadataExtractor.inferMemoryType('system\\core.yml')).toBe('system');
      expect(MemoryMetadataExtractor.inferMemoryType('adapters\\slack.yml')).toBe('adapter');
      expect(MemoryMetadataExtractor.inferMemoryType('user\\notes.yml')).toBe('user');
    });
  });
});

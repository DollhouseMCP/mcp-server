import * as path from 'node:path';
/**
 * Unit tests for MemoryMetadataExtractor
 */

import { Memory } from '../../../src/elements/memories/Memory.js';
import { createRealMemoryManager, createTestMetadataService } from '../../helpers/di-mocks.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { jest, afterAll } from '@jest/globals';
import { SecureYamlParser, hasFrontmatterFraming, matchFrontmatterFrame } from '../../../src/security/secureYamlParser.js';
import { MemoryMetadataExtractor, MemoryMetadataExtractionError } from '../../../src/storage/MemoryMetadataExtractor.js';
import { MEMORY_CONSTANTS, DEFAULT_MEMORY_NAME } from '../../../src/elements/memories/constants.js';

describe('MemoryMetadataExtractor', () => {
  const manager = createRealMemoryManager(path.resolve('tmp', 'memory-metadata-parity'));
  afterAll(() => manager.dispose());
  describe('extractMetadata', () => {
    it('keeps the memory constructor default aligned with the shared name', () => {
      const memory = new Memory({}, createTestMetadataService());
      expect(memory.metadata.name).toBe(DEFAULT_MEMORY_NAME);
    });

    it('rejects an oversized document even when no frame matches', () => {
      const raw = `\n---\n${'a'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE)}`;
      expect(() => MemoryMetadataExtractor.extractMetadata(raw, 'oversized.yaml')).toThrow(MemoryMetadataExtractionError);
    });

    const metadata = 'name: Framed\nautoLoad: true\npriority: 7\nmemoryType: system';
    const legacy = `---\n${metadata}\n---\nBenign body`;
    const framingCases = [
      ['leading blank line', `\n${legacy}`],
      ['opening fence trailing spaces', legacy.replace('---\n', '---  \n')],
      ['CRLF', legacy.replaceAll('\n', '\r\n')],
      ['BOM (default entry on both sides)', `\uFEFF${legacy}`],
      ['no closing fence', `---\n${metadata}`],
      ['unsafe Unicode only in body', `${legacy}\nunsafe \u202E text`],
      ['fence inside body', `${legacy}\n---\nname: Body`],
      ['empty', ''],
      ['pure YAML', metadata],
      ['legacy benign', legacy],
    ];
    it.each(framingCases)('matches loader metadata for %s', (_label, raw) => {
      const loaded = manager['parseContent'](raw).data;
      manager['migrateMetadataDefaults'](loaded, 'sample.yaml');
      const entry = MemoryMetadataExtractor.extractMetadata(raw, 'sample.yaml');
      expect({ name: entry.name, autoLoad: entry.autoLoad, priority: entry.priority, memoryType: entry.memoryType }).toEqual({
        name: loaded.name,
        autoLoad: loaded.autoLoad,
        priority: loaded.priority,
        memoryType: loaded.memoryType ?? 'user',
      });
      if (loaded.name === DEFAULT_MEMORY_NAME) {
        expect(entry).toEqual(MemoryMetadataExtractor.extractMetadata('', 'sample.yaml'));
      }
    });

    it.each(framingCases)('shares the loader framing route for %s', (_label, raw) => {
      const frontmatterRoute = new SerializationService().hasFrontmatter(raw);
      expect(hasFrontmatterFraming(raw)).toBe(frontmatterRoute);
      const parser = jest.spyOn(SecureYamlParser, 'parseRawYaml');
      try {
        MemoryMetadataExtractor.extractMetadata(raw, 'sample.yaml');
        const frame = frontmatterRoute ? matchFrontmatterFrame(raw) : null;
        if (!raw.trim() || (frontmatterRoute && !frame)) {
          expect(parser).not.toHaveBeenCalled();
        } else {
          expect(parser).toHaveBeenCalledWith(frame?.frontmatter ?? raw, expect.objectContaining({ contentPolicy: 'structure-only' }));
        }
      } finally {
        parser.mockRestore();
      }
    });

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

      expect(result.name).toBe(DEFAULT_MEMORY_NAME);
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

      expect(result.name).toBe(DEFAULT_MEMORY_NAME);
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBe('');
      expect(result.tags).toEqual([]);
      expect(result.filePath).toBe('empty.yml');
    });

    it('should handle whitespace-only content gracefully', () => {
      const result = MemoryMetadataExtractor.extractMetadata('   \n  \n  ', 'blank.yml');

      expect(result.name).toBe(DEFAULT_MEMORY_NAME);
      expect(result.filePath).toBe('blank.yml');
    });

    it('should reject non-object YAML', () => {
      // A plain scalar string parses as a string, not an object
      const extract = () => MemoryMetadataExtractor.extractMetadata('just a plain string', 'bad.yml');
      expect(extract).toThrow(MemoryMetadataExtractionError);
      expect(extract).toThrow('bad.yml');
      expect(extract).toThrow(/Cannot extract memory metadata.*: .+/);
    });

    it('should reject YAML arrays', () => {
      const raw = `
- item1
- item2
`;
      const extract = () => MemoryMetadataExtractor.extractMetadata(raw, 'array.yml');
      expect(extract).toThrow(MemoryMetadataExtractionError);
      expect(extract).toThrow('array.yml');
      expect(extract).toThrow(/Cannot extract memory metadata.*: .+/);
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

    it('decides legacy framing before parsing and treats tag-like body text as content', () => {
      const frontmatter = 'name: Accepted\nautoLoad: true';
      const body = 'payload: !!js/function "function() {}"';
      const parse = jest.spyOn(SecureYamlParser, 'parseRawYaml');
      try {
        const metadata = MemoryMetadataExtractor.extractMetadata(`---\n${frontmatter}\n---\n${body}`, 'legacy.yml');
        expect(metadata).toMatchObject({ name: 'Accepted', autoLoad: true });
        expect(parse).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledWith(frontmatter, expect.objectContaining({ contentPolicy: 'structure-only' }));
      } finally {
        parse.mockRestore();
      }
    });

    it('does not retry rejected frontmatter as another YAML fragment', () => {
      const parse = jest.spyOn(SecureYamlParser, 'parseRawYaml');
      try {
        expect(() => MemoryMetadataExtractor.extractMetadata('---\nname: !!js/function "function() {}"\n---\nBenign body', 'rejected.yml'))
          .toThrow(MemoryMetadataExtractionError);
        expect(parse).toHaveBeenCalledTimes(1);
      } finally {
        parse.mockRestore();
      }
    });

    it('rejects oversized whole documents even when their frontmatter is small', () => {
      const raw = `---\nname: Small\n---\n${'a'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE)}`;
      expect(() => MemoryMetadataExtractor.extractMetadata(raw, 'large.yml')).toThrow(MemoryMetadataExtractionError);
    });

    it('preserves code-bearing legacy content above the strict prose scanner limit', () => {
      const raw = `---\nname: Legacy\n---\n${'process.env example\n'.repeat(35_000)}`;
      expect(MemoryMetadataExtractor.extractMetadata(raw, 'legacy-large.yml').name).toBe('Legacy');
    });

    it('should fail closed for malicious YAML tags', () => {
      const raw = `
name: Malicious
payload: !!js/function "function () { return process.env; }"
`;
      const extract = () => MemoryMetadataExtractor.extractMetadata(raw, 'malicious.yml');
      expect(extract).toThrow(MemoryMetadataExtractionError);
      expect(extract).toThrow('malicious.yml');
      expect(extract).toThrow(/Cannot extract memory metadata.*: .+/);
    });

    it('should fail closed for oversized YAML input', () => {
      // Issue #2329 raised the cap from 64KB. Issue #2864: extraction uses the
      // legacy recovery limit (2MB, matching load); past it fails closed.
      const hugeValue = 'a'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1024);
      const raw = `
name: Oversized
description: ${hugeValue}
`;
      const extract = () => MemoryMetadataExtractor.extractMetadata(raw, 'oversized.yml');
      expect(extract).toThrow(MemoryMetadataExtractionError);
      expect(extract).toThrow('oversized.yml');
      expect(extract).toThrow(/Cannot extract memory metadata.*: .+/);
    });

    it('should extract a legacy memory between MAX_YAML_SIZE and LEGACY_MAX_YAML_SIZE (#2864)', () => {
      // Written before the 256KB save cap; must still list under its own name.
      const entries = Array.from({ length: 40 }, (_, i) =>
        `  - id: mem_${i}\n    timestamp: '2026-05-07T00:00:00.000Z'\n    content: ${'b'.repeat(8 * 1024)}`
      ).join('\n');
      const raw = `metadata:\n  name: Legacy State\n  description: Pre-2329 memory\nentries:\n${entries}\n`;
      expect(raw.length).toBeGreaterThan(MEMORY_CONSTANTS.MAX_YAML_SIZE);

      const result = MemoryMetadataExtractor.extractMetadata(raw, '2026-05-07/legacy-state.yaml');

      expect(result.name).toBe('Legacy State');
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

    it('should preserve metadata when untrusted entry prose matches scanner patterns', () => {
      const raw = `
metadata:
  name: Scanner Research
  description: Historical security examples
  autoLoad: true
  priority: 2
entries:
  - content: "Example using require('child_process') for analysis"
    trustLevel: untrusted
`;

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'scanner-research.yml');

      expect(result.name).toBe('Scanner Research');
      expect(result.description).toBe('Historical security examples');
      expect(result.autoLoad).toBe(true);
      expect(result.priority).toBe(2);
      expect(result.totalEntries).toBe(1);
    });

    it('should still fail closed when memory metadata matches scanner patterns', () => {
      const raw = `
metadata:
  name: Unsafe Metadata
  description: "require('child_process')"
entries:
  - content: harmless prose
`;

      const extract = () => MemoryMetadataExtractor.extractMetadata(raw, 'unsafe-metadata.yml');
      expect(extract).toThrow(MemoryMetadataExtractionError);
      expect(extract).toThrow('unsafe-metadata.yml');
      expect(extract).toThrow(/Cannot extract memory metadata.*: .+/);
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

    it('should extract metadata from memory files larger than 64KB (#2329)', () => {
      // Memories up to MAX_YAML_SIZE (256KB) are valid on disk; the extractor
      // previously capped at 64KB and indexed such files as 'unnamed'.
      const bigEntry = 'research finding lorem ipsum dolor sit amet '.repeat(400);
      const entries = Array.from({ length: 6 }, (_, i) =>
        `  - content: "entry-${i} ${bigEntry}"`
      ).join('\n');
      const raw = `
metadata:
  name: Large Memory
  description: Grown past the old 64KB extractor cap
  version: 1.0.0
entries:
${entries}
`;
      expect(raw.length).toBeGreaterThan(64 * 1024);

      const result = MemoryMetadataExtractor.extractMetadata(raw, 'large.yml');

      expect(result.name).toBe('Large Memory');
      expect(result.description).toBe('Grown past the old 64KB extractor cap');
      expect(result.totalEntries).toBe(6);
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

/**
 * Unit tests for FrontmatterParser
 */

import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';

describe('FrontmatterParser', () => {
  describe('extractMetadata', () => {
    it('should extract all fields from valid frontmatter', () => {
      const raw = `---
name: Creative Writer
description: A creative writing persona
version: 1.2.0
author: Alice
tags:
  - writing
  - creative
---

Some markdown content here.`;

      const result = FrontmatterParser.extractMetadata(raw);

      expect(result.name).toBe('Creative Writer');
      expect(result.description).toBe('A creative writing persona');
      expect(result.version).toBe('1.2.0');
      expect(result.author).toBe('Alice');
      expect(result.tags).toEqual(['writing', 'creative']);
    });

    it('should provide defaults for missing fields', () => {
      const raw = `---
name: Minimal
---

Content only.`;

      const result = FrontmatterParser.extractMetadata(raw);

      expect(result.name).toBe('Minimal');
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('should default name to "unnamed" when empty', () => {
      const raw = `---
description: Has description but no name
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);
      expect(result.name).toBe('unnamed');
    });

    it('should default name to "unnamed" when it is an empty string', () => {
      const raw = `---
name: ""
description: Empty name
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);
      expect(result.name).toBe('unnamed');
    });

    it('should handle content without frontmatter', () => {
      const raw = 'Just plain content, no frontmatter.';

      const result = FrontmatterParser.extractMetadata(raw);

      expect(result.name).toBe('unnamed');
      expect(result.description).toBe('');
      expect(result.version).toBe('1.0.0');
      expect(result.author).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('should preserve extra fields in the result', () => {
      const raw = `---
name: ExtraFields
category: testing
custom_field: hello
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);

      expect(result.name).toBe('ExtraFields');
      expect(result.category).toBe('testing');
      expect(result.custom_field).toBe('hello');
    });

    it('should ignore non-string tags arrays', () => {
      const raw = `---
name: BadTags
tags:
  - 123
  - true
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);
      // tags array has non-string elements, so defaults to empty
      expect(result.tags).toEqual([]);
    });

    it('should default tags when not an array', () => {
      const raw = `---
name: ScalarTags
tags: not-an-array
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);
      expect(result.tags).toEqual([]);
    });

    it('should handle non-string description gracefully', () => {
      const raw = `---
name: NumericDesc
description: 42
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);
      // CORE_SCHEMA parses 42 as a number, so it falls back to default
      expect(result.description).toBe('');
    });

    it('should normalize canonically equivalent Unicode metadata values', () => {
      const raw = `---
name: Cafe\u0301
description: Decomposed cafe\u0301
author: Jose\u0301
tags:
  - cafe\u0301
---

Content.`;

      const result = FrontmatterParser.extractMetadata(raw);

      expect(result.name).toBe('Café');
      expect(result.description).toBe('Decomposed café');
      expect(result.author).toBe('José');
      expect(result.tags).toEqual(['café']);
    });
  });
});

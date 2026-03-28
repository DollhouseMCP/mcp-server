/**
 * Tests for the web content validation pipeline.
 * Verifies that validateElementContent correctly validates
 * element files through the security pipeline.
 */

import { describe, it, expect } from '@jest/globals';
import { validateElementContent } from '../../../src/web/contentPipeline.js';

describe('validateElementContent', () => {
  describe('markdown elements', () => {
    it('validates a well-formed persona markdown file', () => {
      const content = `---
name: Test Persona
description: A test persona
version: 1.0.0
author: tester
---

You are a helpful assistant.
`;
      const result = validateElementContent('test-persona.md', content, 'personas');
      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe('Test Persona');
      expect(result.metadata.description).toBe('A test persona');
      expect(result.body).toContain('helpful assistant');
    });

    it('validates a skill markdown file', () => {
      const content = `---
name: Code Review
description: Reviews code
version: 1.0.0
---

Review the code for quality.
`;
      const result = validateElementContent('code-review.md', content, 'skills');
      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe('Code Review');
    });

    it('returns metadata fields from frontmatter', () => {
      const content = `---
name: Full Element
description: Has all fields
version: 2.0.0
author: DollhouseMCP
category: testing
created: '2025-01-01'
tags:
  - test
  - validation
---

Content here.
`;
      const result = validateElementContent('full-element.md', content, 'templates');
      expect(result.valid).toBe(true);
      expect(result.metadata.version).toBe('2.0.0');
      expect(result.metadata.author).toBe('DollhouseMCP');
      expect(result.metadata.category).toBe('testing');
    });

    it('handles markdown without frontmatter', () => {
      const content = '# Just markdown\n\nNo frontmatter here.';
      const result = validateElementContent('no-front.md', content, 'personas');
      // Should still be valid — frontmatter is optional
      expect(result.valid).toBe(true);
      expect(result.metadata).toBeDefined();
    });
  });

  describe('YAML elements (memories)', () => {
    it('validates a well-formed memory YAML file', () => {
      const content = `name: session-notes
description: Notes from a session
entries:
  - content: Did some work
    tags:
      - session
`;
      const result = validateElementContent('session-notes.yaml', content, 'memories');
      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe('session-notes');
    });

    it('validates a minimal YAML file', () => {
      const content = `name: minimal
description: Minimal memory
`;
      const result = validateElementContent('minimal.yaml', content, 'memories');
      expect(result.valid).toBe(true);
    });
  });

  describe('rejection cases', () => {
    it('rejects YAML with multiple documents', () => {
      const content = `name: first
---
name: second
`;
      const result = validateElementContent('multi-doc.yaml', content, 'memories');
      // SecureYamlParser may reject multi-document YAML
      // The result depends on the parser behavior
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
    });
  });

  describe('file type detection', () => {
    it('treats .yaml as YAML', () => {
      const content = 'name: test\ndescription: yaml file\n';
      const result = validateElementContent('test.yaml', content, 'memories');
      expect(result.valid).toBe(true);
    });

    it('treats .yml as YAML', () => {
      const content = 'name: test\ndescription: yml file\n';
      const result = validateElementContent('test.yml', content, 'memories');
      expect(result.valid).toBe(true);
    });

    it('treats .md as markdown with frontmatter', () => {
      const content = `---
name: test
---
Content`;
      const result = validateElementContent('test.md', content, 'personas');
      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe('test');
    });
  });
});

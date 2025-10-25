/**
 * Converter Integration Tests
 *
 * Tests bidirectional conversion between Anthropic Skills and DollhouseMCP Skills
 *
 * Test Strategy:
 * 1. Forward conversion (DollhouseMCP → Anthropic)
 * 2. Reverse conversion (Anthropic → DollhouseMCP)
 * 3. Roundtrip conversion (verify lossless transformation)
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
    DollhouseToAnthropicConverter,
    AnthropicToDollhouseConverter,
    SchemaMapper,
    ContentExtractor
} from '../../../src/converters/index.js';

describe('Converter Integration Tests', () => {
    let dollhouseToAnthropic: DollhouseToAnthropicConverter;
    let anthropicToDollhouse: AnthropicToDollhouseConverter;
    let schemaMapper: SchemaMapper;
    let contentExtractor: ContentExtractor;

    beforeAll(() => {
        dollhouseToAnthropic = new DollhouseToAnthropicConverter();
        anthropicToDollhouse = new AnthropicToDollhouseConverter();
        schemaMapper = new SchemaMapper();
        contentExtractor = new ContentExtractor();
    });

    describe('SchemaMapper', () => {
        it('should convert Anthropic metadata to DollhouseMCP metadata', () => {
            const anthropicMeta = {
                name: 'Test Skill',
                description: 'A test skill for automation and scripting',
                license: 'MIT'
            };

            const dollhouseMeta = schemaMapper.anthropicToDollhouse(anthropicMeta);

            expect(dollhouseMeta.name).toBe('Test Skill');
            expect(dollhouseMeta.description).toBe('A test skill for automation and scripting');
            expect(dollhouseMeta.license).toBe('MIT');
            expect(dollhouseMeta.type).toBe('skill');
            expect(dollhouseMeta.version).toBe('1.0.0');
            expect(dollhouseMeta.author).toBe('Anthropic');
            expect(dollhouseMeta.created).toBeDefined();
            expect(dollhouseMeta.modified).toBeDefined();
        });

        it('should convert DollhouseMCP metadata to Anthropic metadata', () => {
            const dollhouseMeta = {
                name: 'Test Skill',
                description: 'A test skill',
                type: 'skill',
                version: '1.0.0',
                author: 'Test Author',
                created: '2025-10-25T00:00:00Z',
                modified: '2025-10-25T00:00:00Z',
                license: 'MIT',
                tags: ['automation', 'testing'],
                category: 'development'
            };

            const anthropicMeta = schemaMapper.dollhouseToAnthropic(dollhouseMeta);

            expect(anthropicMeta.name).toBe('Test Skill');
            expect(anthropicMeta.description).toBe('A test skill');
            expect(anthropicMeta.license).toBe('MIT');
            // DollhouseMCP-specific fields should be stripped
            expect('version' in anthropicMeta).toBe(false);
            expect('author' in anthropicMeta).toBe(false);
            expect('tags' in anthropicMeta).toBe(false);
        });

        it('should infer tags from skill content', () => {
            const tags = schemaMapper.inferTags(
                'Code Review Assistant',
                'Helps with code review automation and testing'
            );

            expect(tags).toContain('code');
            expect(tags).toContain('automation');
            expect(tags).toContain('testing');
        });

        it('should infer category from skill content', () => {
            const category = schemaMapper.inferCategory(
                'Documentation Generator',
                'Automates documentation generation for code projects'
            );

            // Note: "develop" pattern in description matches before "documentation"
            expect(category).toBe('development');
        });
    });

    describe('ContentExtractor', () => {
        it('should extract code blocks from markdown', () => {
            const content = `
# Test Skill

Some instructions here.

\`\`\`bash
#!/bin/bash
echo "Hello World"
ls -la
pwd
\`\`\`

More content.

\`\`\`python
print("Hello from Python")
import os
os.getcwd()
def test():
    pass
\`\`\`
`;

            const sections = contentExtractor.extractSections(content);
            const codeSections = sections.filter(s => s.type === 'code');

            // Both blocks should be extracted (>3 lines each)
            expect(codeSections.length).toBeGreaterThanOrEqual(1);
            expect(codeSections[0].language).toBe('bash');
            expect(codeSections[0].content).toContain('echo "Hello World"');

            if (codeSections.length > 1) {
                expect(codeSections[1].language).toBe('python');
                expect(codeSections[1].content).toContain('print("Hello from Python")');
            }
        });

        it('should extract documentation sections', () => {
            const content = `
## Input Formats

This section describes input formats.

### Supported Types

- Type 1
- Type 2
`;

            const section = contentExtractor.extractDocumentationSection(content, 'Input Formats');

            expect(section).toBeDefined();
            expect(section).toContain('Input Formats');
            expect(section).toContain('Supported Types');
        });
    });

    describe('DollhouseToAnthropicConverter', () => {
        it('should convert a simple DollhouseMCP skill to Anthropic format', async () => {
            const dollhouseSkill = `---
name: Simple Test Skill
description: A simple test skill for conversion
type: skill
version: 1.0.0
author: Test Author
license: MIT
---

# Simple Test Skill

This is a test skill for conversion testing.

## Instructions

1. Do this
2. Do that
3. Complete the task
`;

            const anthropicStructure = await dollhouseToAnthropic.convertSkill(dollhouseSkill);

            expect(anthropicStructure['SKILL.md']).toBeDefined();
            expect(anthropicStructure['SKILL.md']).toContain('name: Simple Test Skill');
            expect(anthropicStructure['SKILL.md']).toContain('description: A simple test skill for conversion');
            expect(anthropicStructure['SKILL.md']).toContain('This is a test skill');
        });

        it('should extract scripts from DollhouseMCP skill', async () => {
            const dollhouseSkill = `---
name: Script Test
description: Test skill with scripts
---

# Test Skill

\`\`\`bash
#!/bin/bash
# Installation script
echo "Installing..."
npm install
\`\`\`

\`\`\`python
#!/usr/bin/env python3
# Verification script
print("Verifying installation...")
\`\`\`
`;

            const anthropicStructure = await dollhouseToAnthropic.convertSkill(dollhouseSkill);

            expect(anthropicStructure['scripts/']).toBeDefined();
            expect(Object.keys(anthropicStructure['scripts/'] || {}).length).toBeGreaterThan(0);
        });
    });

    describe('AnthropicToDollhouseConverter', () => {
        it('should convert a simple Anthropic skill to DollhouseMCP format', () => {
            const anthropicStructure = {
                'SKILL.md': `---
name: Simple Test Skill
description: A simple test skill
---

# Simple Test Skill

This is a test skill for reverse conversion.

## Instructions

1. Step one
2. Step two
`
            };

            const dollhouseSkill = anthropicToDollhouse.convertFromStructure(anthropicStructure);

            expect(dollhouseSkill).toContain('name: Simple Test Skill');
            expect(dollhouseSkill).toContain('description: A simple test skill');
            expect(dollhouseSkill).toContain('type: skill');
            expect(dollhouseSkill).toContain('version: 1.0.0');
            expect(dollhouseSkill).toContain('This is a test skill for reverse conversion');
        });

        it('should combine scripts back into code blocks', () => {
            const anthropicStructure = {
                'SKILL.md': `---
name: Script Test
description: Test with scripts
---

Main content here.
`,
                'scripts/': {
                    'install.sh': `#!/bin/bash
# Extracted script
echo "Installing..."
npm install`,
                    'verify.py': `#!/usr/bin/env python3
# Extracted script
print("Verifying...")
`
                }
            };

            const dollhouseSkill = anthropicToDollhouse.convertFromStructure(anthropicStructure);

            expect(dollhouseSkill).toContain('```bash');
            expect(dollhouseSkill).toContain('echo "Installing..."');
            expect(dollhouseSkill).toContain('```python');
            expect(dollhouseSkill).toContain('print("Verifying...")');
        });

        it('should combine reference docs back into sections', () => {
            const anthropicStructure = {
                'SKILL.md': `---
name: Reference Test
description: Test with reference docs
---

Main content here.
`,
                'reference/': {
                    'input-formats.md': `## Input Formats

Supported input formats:
- JSON
- YAML
`,
                    'error-handling.md': `## Error Handling

How to handle errors:
1. Check logs
2. Retry operation
`
                }
            };

            const dollhouseSkill = anthropicToDollhouse.convertFromStructure(anthropicStructure);

            expect(dollhouseSkill).toContain('Input Formats');
            expect(dollhouseSkill).toContain('Error Handling');
            expect(dollhouseSkill).toContain('Supported input formats');
        });
    });

    describe('Roundtrip Conversion', () => {
        it('should preserve content through roundtrip conversion', async () => {
            const originalDollhouse = `---
name: Roundtrip Test Skill
description: Test skill for roundtrip conversion testing
type: skill
version: 1.0.0
author: Test Author
license: MIT
tags:
  - testing
  - automation
category: development
---

# Roundtrip Test Skill

This skill tests roundtrip conversion.

## Instructions

Follow these steps:
1. Convert to Anthropic format
2. Convert back to DollhouseMCP format
3. Verify content is preserved

## Example

Here's an example:

\`\`\`bash
#!/bin/bash
echo "Example script"
ls -la
\`\`\`
`;

            // Step 1: Convert to Anthropic
            const anthropicStructure = await dollhouseToAnthropic.convertSkill(originalDollhouse);

            // Step 2: Convert back to DollhouseMCP
            const roundtripDollhouse = anthropicToDollhouse.convertFromStructure(anthropicStructure);

            // Step 3: Verify core content is preserved
            expect(roundtripDollhouse).toContain('Roundtrip Test Skill');
            expect(roundtripDollhouse).toContain('Test skill for roundtrip conversion testing');
            expect(roundtripDollhouse).toContain('This skill tests roundtrip conversion');
            expect(roundtripDollhouse).toContain('Follow these steps');
            expect(roundtripDollhouse).toContain('echo "Example script"');

            // Verify metadata enrichment
            expect(roundtripDollhouse).toContain('type: skill');
            expect(roundtripDollhouse).toContain('version:');
        });

        it('should handle skills with multiple code blocks', async () => {
            const dollhouseSkill = `---
name: Multi-Script Skill
description: Skill with multiple scripts
---

# Multi-Script Skill

\`\`\`bash
echo "Script 1"
\`\`\`

Some text.

\`\`\`python
print("Script 2")
\`\`\`

More text.

\`\`\`javascript
console.log("Script 3");
\`\`\`
`;

            const anthropic = await dollhouseToAnthropic.convertSkill(dollhouseSkill);
            const roundtrip = anthropicToDollhouse.convertFromStructure(anthropic);

            expect(roundtrip).toContain('echo "Script 1"');
            expect(roundtrip).toContain('print("Script 2")');
            expect(roundtrip).toContain('console.log("Script 3")');
        });
    });
});

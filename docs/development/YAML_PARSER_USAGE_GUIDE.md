# YAML Parser Usage Guide for DollhouseMCP

## Critical Distinction: Two Different Parsers for Two Different File Types

DollhouseMCP uses **two different YAML parsers** for different file types. Using the wrong parser will cause failures!

## Quick Reference

| File Type | Extension | Parser to Use | Example Files |
|-----------|-----------|---------------|---------------|
| **Pure YAML** | `.yml`, `.yaml` | `js-yaml` with `FAILSAFE_SCHEMA` | `config.yml`, data files |
| **Markdown with Frontmatter** | `.md` | `SecureYamlParser` | personas, skills, templates |

## 1. Pure YAML Files - Use `js-yaml`

### When to Use
- Configuration files (`config.yml`)
- Data files that are purely YAML
- Any `.yml` or `.yaml` file without markdown content

### File Format
```yaml
# Pure YAML - no frontmatter markers needed
version: 1.0.0
user:
  username: johndoe
  email: john@example.com
settings:
  enabled: true
  max_items: 100
```

### How to Parse
```typescript
import * as yaml from 'js-yaml';
import { promises as fs } from 'fs';

// For reading pure YAML files
const content = await fs.readFile('config.yml', 'utf-8');
const data = yaml.load(content, {
  schema: yaml.FAILSAFE_SCHEMA  // Prevents code execution attacks
});

// For writing pure YAML files
const yamlContent = yaml.dump(data, {
  indent: 2,
  lineWidth: 120,
  noRefs: true,
  sortKeys: false
});
await fs.writeFile('config.yml', yamlContent);
```

### Security Note
Always use `FAILSAFE_SCHEMA` when loading to prevent code execution via YAML tags.

## 2. Markdown Files with YAML Frontmatter - Use `SecureYamlParser`

### When to Use
- Persona files (`personas/*.md`)
- Skill files (`skills/*.md`)
- Template files (`templates/*.md`)
- Agent files (`agents/*.md`)
- Memory files (`memories/*.md`)
- Ensemble files (`ensembles/*.md`)
- Any markdown file with YAML metadata

### File Format
```markdown
---
name: Creative Writer
description: A creative writing assistant
version: 1.0.0
author: dollhousemcp
---

# Creative Writer Persona

You are a creative writer who helps users with storytelling...

## Guidelines
- Be imaginative
- Use vivid descriptions
- ...
```

### How to Parse
```typescript
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { promises as fs } from 'fs';

// For reading markdown files with frontmatter
const fileContent = await fs.readFile('personas/creative-writer.md', 'utf-8');
const parsed = SecureYamlParser.parse(fileContent, {
  maxYamlSize: 64 * 1024,      // Max 64KB for YAML section
  maxContentSize: 1024 * 1024,  // Max 1MB total file
  validateContent: true,         // Apply security checks
  validateFields: true          // Validate specific fields
});

// Result structure:
// parsed.data = { name: 'Creative Writer', description: '...', ... }
// parsed.content = 'You are a creative writer who helps...'
```

### Key Differences
- `SecureYamlParser` expects frontmatter markers (`---`)
- Returns both `data` (YAML) and `content` (markdown)
- Includes built-in security validation
- Validates specific fields for personas/elements

## Common Mistakes to Avoid

### ❌ Wrong: Using SecureYamlParser for config files
```typescript
// THIS WILL FAIL - config.yml has no frontmatter markers
const parsed = SecureYamlParser.parse(configContent);
// Result: parsed.data = {} (empty!)
```

### ❌ Wrong: Using js-yaml for persona files
```typescript
// THIS WILL PARSE INCORRECTLY - includes the markdown content
const data = yaml.load(personaFileContent);
// Result: Parsing error or mixed YAML/markdown mess
```

### ✅ Correct: Match parser to file type
```typescript
// For config.yml (pure YAML)
const configData = yaml.load(configContent, { schema: yaml.FAILSAFE_SCHEMA });

// For personas/creative-writer.md (markdown with frontmatter)
const personaParsed = SecureYamlParser.parse(personaContent);
const metadata = personaParsed.data;
const instructions = personaParsed.content;
```

## Implementation Examples in DollhouseMCP

### ConfigManager (Pure YAML)
```typescript
// src/config/ConfigManager.ts
private async loadConfig(): Promise<void> {
  const content = await fs.readFile(this.configPath, 'utf-8');
  
  // Pure YAML file - use js-yaml
  const loadedData = yaml.load(content, {
    schema: yaml.FAILSAFE_SCHEMA
  });
  
  this.config = this.mergeWithDefaults(loadedData);
}
```

### PersonaLoader (Markdown with Frontmatter)
```typescript
// src/persona/PersonaLoader.ts (example)
private async loadPersona(filePath: string): Promise<Persona> {
  const content = await fs.readFile(filePath, 'utf-8');
  
  // Markdown file with frontmatter - use SecureYamlParser
  const parsed = SecureYamlParser.parse(content);
  
  return {
    metadata: parsed.data,
    instructions: parsed.content
  };
}
```

## Future Element Types

When implementing new element types:

1. **If it's a configuration or data file** (`.yml`/`.yaml`):
   - Use `js-yaml` with `FAILSAFE_SCHEMA`
   - File contains only YAML, no markdown

2. **If it's an element file** (`.md`):
   - Use `SecureYamlParser`
   - File has YAML frontmatter + markdown content
   - Examples: skills, templates, agents, memories, ensembles

## Security Considerations

### js-yaml Security
- Always use `FAILSAFE_SCHEMA` when loading
- Never use `DEFAULT_SCHEMA` (allows code execution)
- Validate loaded data structure before use

### SecureYamlParser Security
- Built-in size limits (configurable)
- Content validation for malicious patterns
- Field-specific validators for known fields
- Prevents YAML injection attacks
- Safe handling of user-provided content

## Testing Your Parser Choice

Quick test to verify you're using the right parser:

```typescript
// Test file content
const testContent = `---
name: Test
---
Content here`;

// SecureYamlParser will work
const parsed = SecureYamlParser.parse(testContent);
console.log(parsed.data.name); // "Test"

// js-yaml will fail or give unexpected results
try {
  const data = yaml.load(testContent);
  // This will treat the whole thing as YAML and fail
} catch (e) {
  console.log('Failed as expected for frontmatter format');
}
```

## Summary

- **Pure YAML files** → `js-yaml` with `FAILSAFE_SCHEMA`
- **Markdown with frontmatter** → `SecureYamlParser`
- **Config files** → Pure YAML
- **Element files** → Markdown with frontmatter
- **Always match the parser to the file format!**

---

*Last updated: September 8, 2025*
*Critical fix: ConfigManager was using wrong parser, causing config persistence failures*
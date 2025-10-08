# Manual Element Construction

This guide explains how to manually create DollhouseMCP elements by directly creating and editing files. This is intended for developers, testing, and advanced use cases.

**⚠️ Important**: For normal use, **always use the MCP tools** provided by DollhouseMCP. Manual construction is only appropriate for:

- DollhouseMCP development and testing
- Creating test fixtures
- Debugging element parsing
- Understanding the element format specification
- Advanced customization beyond MCP tool capabilities

## Why Use MCP Tools

The MCP tools (`create_element`, `edit_element`, etc.) handle:

- ✅ Proper directory structure (e.g., memories organized by date)
- ✅ Automatic metadata generation and validation
- ✅ Proper YAML/Markdown formatting
- ✅ Correct file permissions
- ✅ Naming validation and sanitization
- ✅ Cross-platform compatibility

Manual construction bypasses these safeguards and can lead to:

- ❌ Malformed YAML or frontmatter
- ❌ Files in wrong locations
- ❌ Invalid metadata
- ❌ Platform-specific path issues

## Element File Formats

### Personas, Skills, Templates, Agents

These elements use Markdown files with YAML frontmatter.

**File location**: `~/.dollhouse/portfolio/{type}/{name}.md`

**Format**:
```markdown
---
name: element-name
description: Brief description of the element
type: persona  # or skill, template, agent
version: 1.0.0
author: Your Name
tags:
  - tag1
  - tag2
created: 2025-10-08T09:00:00Z
updated: 2025-10-08T09:00:00Z
---

# Element Content

Your element content goes here in Markdown format.

For personas, describe the AI behavior and personality.
For skills, describe the capability and how to use it.
For templates, provide the template structure.
For agents, include agent directives and behavior.
```

**Example - Persona**:

```markdown
---
name: helpful-coder
description: A helpful TypeScript coding assistant focused on clean code
type: persona
version: 1.0.0
author: Jane Developer
tags:
  - coding
  - typescript
  - helpful
created: 2025-10-08T10:00:00Z
updated: 2025-10-08T10:00:00Z
---

# Helpful Coder

You are a helpful TypeScript coding assistant who focuses on clean, maintainable code.

## Behavior

- Provide clear explanations for your suggestions
- Follow TypeScript best practices
- Prioritize code readability and maintainability
- Ask clarifying questions when requirements are ambiguous

## Code Style

- Use descriptive variable names
- Add comments for complex logic
- Follow the project's existing patterns
- Suggest refactoring when appropriate
```

### Memories

Memories use pure YAML format (no Markdown) and are organized by date.

**File location**: `~/.dollhouse/portfolio/memories/YYYY-MM-DD/{name}.yaml`

**Format**:
```yaml
name: memory-name
description: Brief description of the memory
version: 1.0.0
retention: permanent  # or temporary, session
tags:
  - tag1
  - tag2
created: 2025-10-08T09:00:00Z
updated: 2025-10-08T09:00:00Z

entries:
  - timestamp: 2025-10-08T09:00:00Z
    type: note
    content: |
      Memory content goes here.

      Can be multiple lines using YAML block scalar.

  - timestamp: 2025-10-08T10:00:00Z
    type: reference
    content: |
      Additional entry with more information.
```

**Example - Session Memory**:

```yaml
name: session-2025-10-08-morning-documentation-refactoring
description: Session work on refactoring CLAUDE.md into modular documentation
version: 1.0.0
retention: permanent
tags:
  - session-notes
  - documentation
  - refactoring
created: 2025-10-08T09:00:00Z
updated: 2025-10-08T11:30:00Z

entries:
  - timestamp: 2025-10-08T09:00:00Z
    type: summary
    content: |
      Refactored monolithic CLAUDE.md into modular structure:
      - Created docs/CONVENTIONS.md for naming standards
      - Created docs/development/SESSION_MANAGEMENT.md
      - Enhanced CONTRIBUTING.md with architecture details

  - timestamp: 2025-10-08T11:00:00Z
    type: outcome
    content: |
      Successfully created PR #1270 with all changes.
      Follow-up issues created for style guide and link checking.
```

## Manual Creation Procedure

### Step 1: Verify Directory Structure

Ensure the portfolio directory exists:

```bash
ls -la ~/.dollhouse/portfolio/
```

You should see directories for each element type:
```
personas/
skills/
templates/
agents/
memories/
ensembles/
```

### Step 2: Create Element File

#### For Personas, Skills, Templates, Agents:

```bash
# Create the file (replace {type} and {name})
touch ~/.dollhouse/portfolio/{type}/{name}.md

# Edit with your preferred editor
nano ~/.dollhouse/portfolio/personas/my-persona.md
# or
code ~/.dollhouse/portfolio/personas/my-persona.md
```

#### For Memories:

```bash
# Create date directory if it doesn't exist
mkdir -p ~/.dollhouse/portfolio/memories/$(date +%Y-%m-%d)

# Create the memory file
touch ~/.dollhouse/portfolio/memories/$(date +%Y-%m-%d)/my-memory.yaml

# Edit with your preferred editor
nano ~/.dollhouse/portfolio/memories/$(date +%Y-%m-%d)/my-memory.yaml
```

### Step 3: Add Required Frontmatter

Copy the appropriate template from the "Element File Formats" section above and fill in the details.

**Required fields**:
- `name` - lowercase-with-hyphens (must match filename without extension)
- `description` - Clear, concise description
- `type` - Element type (for Markdown elements)
- `version` - Semantic version (1.0.0)
- `created` - ISO 8601 timestamp
- `updated` - ISO 8601 timestamp

**Optional but recommended**:
- `author` - Your name or identifier
- `tags` - Array of relevant tags
- `retention` - For memories: permanent, temporary, or session

### Step 4: Add Content

Below the frontmatter (for Markdown elements) or in the `entries` section (for memories), add your content.

**Tips**:
- Use clear, descriptive language
- Follow [STYLE_GUIDE.md](../STYLE_GUIDE.md) for content style
- Test that YAML parses correctly
- Validate Markdown renders properly

### Step 5: Validate the Element

Use the MCP tools to validate your manually created element:

Ask your AI assistant:
> "Validate the element I just created at ~/.dollhouse/portfolio/personas/my-persona.md"

Or if you're an LLM reading this, use:
```
validate_element(type="personas", name="my-persona")
```

## Common Pitfalls

### 1. Invalid YAML Frontmatter

**Problem**: Malformed YAML causes parse errors

**Solution**:
- Use a YAML validator
- Watch for indentation (2 spaces, not tabs)
- Quote strings with special characters
- Use `|` for multi-line strings

### 2. Wrong File Location

**Problem**: Element not found by MCP server

**Solution**:
- Memories must be in date folders: `memories/YYYY-MM-DD/`
- Other elements in their type folder: `personas/`, `skills/`, etc.
- Filename must match the `name` field

### 3. Mismatched Name and Filename

**Problem**: Element name in frontmatter doesn't match filename

**Solution**:
```yaml
# File: helpful-coder.md
name: helpful-coder  # ✅ Match
# NOT: name: Helpful Coder  # ❌ Doesn't match filename
```

### 4. Invalid Timestamps

**Problem**: Timestamps not in ISO 8601 format

**Solution**:
```yaml
✅ created: 2025-10-08T09:00:00Z
❌ created: 10/08/2025 9:00 AM
❌ created: 2025-10-08
```

### 5. Missing Required Fields

**Problem**: Element won't load due to missing metadata

**Solution**: Always include all required fields listed in Step 3

## Testing Manually Created Elements

After manually creating an element, test it:

1. **List elements** - Verify it appears in the element list:
   > "List all personas in my portfolio"

2. **Get details** - Check the metadata parsed correctly:
   > "Show me details about the helpful-coder persona"

3. **Activate** - Test activation works:
   > "Activate the helpful-coder persona"

4. **Validate** - Run validation:
   > "Validate the helpful-coder persona"

## Bulk Creation for Testing

When creating multiple test elements:

```bash
#!/bin/bash
# create-test-personas.sh

PORTFOLIO="$HOME/.dollhouse/portfolio/personas"

for i in {1..5}; do
  cat > "$PORTFOLIO/test-persona-$i.md" <<EOF
---
name: test-persona-$i
description: Test persona number $i
type: persona
version: 1.0.0
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
tags:
  - test
  - automated
---

# Test Persona $i

This is a test persona created for automated testing.
EOF
done

echo "Created 5 test personas"
```

## Advanced: Custom Element Types (Future)

**Note**: Custom element types are planned for DollhouseMCP v2.0 or later. This functionality is not yet available.

When custom element types are supported, this guide will be updated with:
- Element type schema definition
- Registration process
- Validation rules
- Manager class implementation

## Related Documentation

- [STYLE_GUIDE.md](../STYLE_GUIDE.md) - How to write element content
- [CONVENTIONS.md](../CONVENTIONS.md) - Naming standards
- [SESSION_MANAGEMENT.md](./SESSION_MANAGEMENT.md) - Session workflow
- [ELEMENT_IMPLEMENTATION_GUIDE.md](./ELEMENT_IMPLEMENTATION_GUIDE.md) - Element system architecture

## When to Use This Guide

**Use manual construction when**:
- Testing element parsing logic
- Creating test fixtures for automated tests
- Debugging element loading issues
- Understanding the element format specification
- Batch creating elements via scripts

**Use MCP tools when**:
- Normal element creation workflow
- User-facing element management
- Production element creation
- Any situation where reliability matters

---

*This guide is for developers and advanced users only. For normal use, always prefer MCP tools.*

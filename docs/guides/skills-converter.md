# Skills Converter Guide

**Bidirectional conversion between Dollhouse Skills and agent skills**

---

## Overview

The DollhouseMCP Skills Converter provides **lossless bidirectional translation** between DollhouseMCP Skills and agent skills formats. This enables seamless interoperability between ecosystems while maintaining full fidelity of skill content and functionality.

### Timeline and Context

- **July 2025**: DollhouseMCP Skills premiered as part of the comprehensive six-element customization architecture
- **October 2025**: Anthropic introduced Skills for claude.ai
- **October 2025**: DollhouseMCP released bidirectional converter for ecosystem interoperability

The converter enables agent skills to operate within the DollhouseMCP ecosystem. Once converted, skills gain:
- **Automatic backups** in the Dollhouse portfolio
- **Security validation** against injection patterns and content attacks (agent skills have no built-in validation)
- **Ensemble composition** — combine with Dollhouse Personas, Templates, Memories, and other Skills into coordinated configurations managed by Dollhouse Agents
- **Cross-platform deployment** — use on any MCP-compatible platform, not just agent-skill-compatible platforms

### Interface

The Skills Converter is accessed through the `convert_skill_format` MCP-AQL operation on the **READ endpoint**. There is no CLI command for conversion (see [issue #860](https://github.com/DollhouseMCP/mcp-server/issues/860)).

All conversion happens through MCP tool calls:

```
mcp_aql_read { "operation": "convert_skill_format", "params": { ... } }
```

You can also invoke conversion through natural language when the DollhouseMCP server is active:

- "Convert this agent skill to a Dollhouse Skill"
- "Import this SKILL.md as a Dollhouse element"
- "Export my-skill to agent skills format"
- "Convert this skill for use on claude.ai"

---

## Quick Start

### Import agent skills

To convert an agent skill into DollhouseMCP format, use the `agent_to_dollhouse` direction. Pass the agent skill's file contents as a dictionary keyed by filename:

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": {
      "SKILL.md": "---\nname: code-reviewer\ndescription: Reviews code for quality and best practices\nlicense: MIT\n---\n\n# Code Reviewer\n\nReview code for correctness, style, and security issues.\n\n## Guidelines\n- Check for common anti-patterns\n- Verify error handling\n- Assess test coverage"
    }
  }
}
```

For agent skills with multiple files (scripts, references, etc.):

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": {
      "SKILL.md": "---\nname: setup-wizard\ndescription: Project setup automation\n---\n\n# Setup Wizard\n\nAutomates project initialization.\n\nSee [scripts/setup.sh](scripts/setup.sh) for implementation.",
      "scripts/setup.sh": "#!/bin/bash\nnpm init -y\nnpm install",
      "references/conventions.md": "# Conventions\n\nFollow standard naming conventions..."
    }
  }
}
```

With security and path options for trusted migration workflows:

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "security_mode": "warn",
    "path_mode": "lossless",
    "agent_skill": {
      "SKILL.md": "---\nname: my-skill\ndescription: test\n---\n\nUse this skill."
    }
  }
}
```

**Output**: A `SkillConversionResult` object containing the converted Dollhouse Skill markdown, a conversion report, and any warnings.

### Export to agent skills format

To convert a DollhouseMCP Skill into agent skills format, use the `dollhouse_to_agent` direction. You can pass either raw markdown or a structured object:

**From markdown** (most common):

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "dollhouse_markdown": "---\nname: code-reviewer\ndescription: Reviews code for quality and best practices\ntype: skill\nversion: 1.0.0\nauthor: my-org\nlicense: MIT\ntags: [code-quality, review]\ninstructions: Review code for correctness, style, and security issues.\n---\n\n## Guidelines\n- Check for common anti-patterns\n- Verify error handling\n- Assess test coverage"
  }
}
```

**From structured object**:

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "dollhouse": {
      "metadata": { "name": "code-reviewer", "description": "Reviews code" },
      "instructions": "Review code for correctness, style, and security issues.",
      "content": "## Guidelines\n- Check for common anti-patterns"
    }
  }
}
```

**With lossless path handling** (preserves non-allowlisted paths for full fidelity):

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "path_mode": "lossless",
    "dollhouse_markdown": "---\nname: my-skill\ndescription: test\ninstructions: Use this skill.\n---\n\nReference content"
  }
}
```

**Output**: A `SkillConversionResult` object containing the agent skills directory structure, a conversion report, and any warnings.

---

## Conversion Architecture

### DollhouseMCP Skills Schema (Source)

DollhouseMCP Skills use a **comprehensive metadata schema** with rich structured data:

**File Format**: Single Markdown file with YAML frontmatter

**Structure**:
```markdown
---
name: skill-name
description: Detailed description
type: skill
version: 1.0.0
author: author-name
created: 2025-10-25T12:00:00.000Z
modified: 2025-10-25T12:00:00.000Z
license: MIT
tags: [tag1, tag2, tag3]
category: category-name
complexity: beginner|intermediate|advanced
domains: [domain1, domain2]
dependencies: []
prerequisites: []
parameters: []
examples: []
languages: [language1, language2]
proficiency_level: 0-10
custom:
  additional: fields
---

# Skill Name

Skill content in Markdown format with embedded code blocks...

```python
# Code examples embedded directly
def example():
    pass
```

Additional documentation...
```

**Key Characteristics**:
- **15+ metadata fields** for versioning, categorization, and dependency tracking
- **Single-file architecture** for portability and easy backup
- **Embedded code blocks** with language-specific syntax highlighting
- **Extensible schema** with custom fields support
- **Rich documentation** with Markdown formatting

### Agent Skills Format (Target)

Agent skills use a **minimal metadata schema** focused on essential information:

**File Format**: Multi-file directory structure

**Structure**:
```
skill-name/
├── SKILL.md              # Main documentation
├── metadata/
│   └── dollhouse.yaml    # DollhouseMCP metadata (roundtrip preservation)
├── scripts/
│   ├── script1.sh
│   └── script2.py
├── reference/
│   └── documentation.md
└── examples/
    └── example.md
```

**SKILL.md Format**:
```markdown
---
name: skill-name
description: Detailed description
license: MIT
---

# Skill Name

Documentation content...

See [scripts/script1.sh](scripts/script1.sh) for implementation.
```

**Key Characteristics**:
- **Minimal metadata** (name, description, license only)
- **Multi-file structure** with separate directories for different content types
- **External script files** referenced from main documentation
- **Fixed schema** with limited extensibility

---

## Conversion Process

### Import: Agent Skills → DollhouseMCP

**Process Overview**:

1. **Detection**: Identify agent skills format (SKILL.md presence)
2. **Metadata Enrichment**: Add DollhouseMCP schema fields
3. **Content Consolidation**: Combine multi-file structure into single Markdown
4. **Code Embedding**: Extract scripts and embed as code blocks
5. **Validation**: Ensure schema compliance
6. **Output**: Single `.md` file in portfolio

**Metadata Enrichment**:

When importing agent skills, the converter **automatically enriches** the minimal metadata:

```yaml
# Agent skills (minimal)
name: example-skill
description: Example skill
license: MIT

# Becomes DollhouseMCP (enriched)
name: example-skill
description: Example skill
license: MIT
type: skill
version: 1.0.0
author: Anthropic
created: 2025-10-25T12:00:00.000Z
modified: 2025-10-25T12:00:00.000Z
tags: [inferred, from, content]
category: inferred
complexity: beginner
domains: []
dependencies: []
prerequisites: []
parameters: []
examples: []
languages: []
proficiency_level: 0
custom:
  source: anthropic-skills
  converted: 2025-10-25T12:00:00.000Z
```

**Benefits of Enrichment**:
- Enhanced searchability through tags and categories
- Version tracking and change management
- Dependency resolution for complex workflows
- Integration with DollhouseMCP ecosystem features

### Export: DollhouseMCP → Agent Skills

**Process Overview**:

1. **Metadata Simplification**: Extract name, description, license
2. **Content Decomposition**: Split single file into multi-file structure
3. **Code Extraction**: Convert embedded code blocks to separate script files
4. **Metadata Preservation**: Store full DollhouseMCP metadata for roundtrip
5. **Validation**: Ensure agent skills format compliance
6. **Output**: Directory structure ready for claude.ai upload

**Metadata Preservation**:

To enable **lossless roundtrip conversion**, the full DollhouseMCP metadata is preserved:

```
skill-name/
├── SKILL.md              # Agent skills format (simplified metadata)
├── metadata/
│   └── dollhouse.yaml    # Full DollhouseMCP metadata preserved
└── scripts/
    └── ...
```

This ensures that importing the exported skill back to DollhouseMCP restores **100% of the original metadata**.

---

## Advanced Features

### Lossless Roundtrip Conversion

The converter guarantees **perfect fidelity** in both directions. When you convert a skill from DollhouseMCP to agent skills format, the operation returns a `roundtrip_state` object. Pass this back on the reverse conversion for exact restoration:

```json
// Step 1: Export to agent skills format
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "path_mode": "lossless",
    "dollhouse_markdown": "<your Dollhouse skill markdown>"
  }
}
// Response includes: { result: { ... }, roundtrip_state: { ... } }

// Step 2: Import back with roundtrip state for exact restoration
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": { "SKILL.md": "<converted SKILL.md content>" },
    "roundtrip_state": { "<state from step 1>" },
    "prefer_roundtrip_state": true
  }
}
// Result: identical to original Dollhouse skill
```

**What's Preserved**:
- All metadata fields (15+ fields)
- All content sections
- All code blocks with language tags
- All documentation structure
- Custom metadata fields
- Version information
- Author attribution

### Parameters Reference

The `convert_skill_format` operation accepts the following parameters:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `direction` | string | Yes | — | `agent_to_dollhouse` or `dollhouse_to_agent` |
| `agent_skill` | object | For import | — | Agent skill file contents keyed by filename |
| `dollhouse_markdown` | string | For export | — | Serialized Dollhouse skill markdown |
| `dollhouse` | object | For export | — | Structured Dollhouse skill artifact (alternative to `dollhouse_markdown`) |
| `path_mode` | string | No | `safe` | `safe` (allowlisted/validated paths, security findings sanitized) or `lossless` (preserve non-allowlisted paths for full-fidelity conversions while still reporting security findings) |
| `security_mode` | string | No | `strict` | `strict` (fail conversion on high/critical findings) or `warn` (surface findings in report.warnings and continue). Use `warn` only for trusted migration workflows. |
| `roundtrip_state` | object | No | — | State object returned by a previous conversion for exact reverse conversion |
| `prefer_roundtrip_state` | boolean | No | `true` | When true, use `roundtrip_state` if valid for lossless restoration |

#### `path_mode` Details

- **`safe`** (default): All file paths are validated against an allowlist. Non-allowlisted paths are sanitized. Security findings in paths are cleaned. This is the right choice for untrusted input.
- **`lossless`**: Non-allowlisted paths are preserved as-is for full-fidelity conversion. Security findings are still reported but do not trigger sanitization. Use this when you trust the source and need exact path preservation.

Input bounds: 2 MiB per text field, 16 MiB aggregate, 2000 file entries. Conversion metrics are returned in `report.metrics`.

#### `security_mode` Details

- **`strict`** (default): Conversion fails immediately if high-severity or critical security findings are detected. Frontmatter is checked for unsafe YAML patterns including YAML-bomb/amplification patterns. This is the right choice for untrusted imports.
- **`warn`**: Security findings are surfaced in `report.warnings` but conversion proceeds. Use this only for trusted migration workflows where you need to inspect findings without blocking conversion.

### Conversion Reports

The `convert_skill_format` operation returns a structured `SkillConversionResult` that includes:

- **`result`**: The converted artifact (Dollhouse markdown or agent skills structure)
- **`report`**: Machine-readable conversion report with:
  - Conversion timestamp and direction
  - Metadata transformations applied
  - Operations performed
  - `report.warnings`: Any security or validation findings
  - `report.metrics`: Conversion performance metrics
- **`roundtrip_state`**: State object for lossless reverse conversion

---

## Use Cases

### 1. Import Agent Skills from claude.ai

**Scenario**: You have an agent skill definition and want to use it with DollhouseMCP.

**Workflow**:

First, convert the skill:

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": {
      "SKILL.md": "---\nname: code-reviewer\ndescription: Reviews code for quality and best practices\nlicense: MIT\n---\n\n# Code Reviewer\n\nReview submitted code for correctness, style, and security."
    }
  }
}
```

Then save the converted output to your portfolio and integrate:

```
// Reload elements
mcp_aql_read { "operation": "reload_elements", "params": { "type": "skills" } }

// Activate skill
mcp_aql_execute { "operation": "activate_element", "params": { "name": "code-reviewer", "type": "skills" } }
```

Or simply ask in natural language:
- "Convert this agent skill to a Dollhouse Skill and add it to my portfolio"
- "Import this SKILL.md as a DollhouseMCP skill"

**Benefits**:
- Access skill on any MCP-compatible platform, not just agent-skill-compatible platforms
- Automatic backups in the Dollhouse portfolio
- Security validation (injection protection, content scanning) — agent skills have no built-in validation
- Combine with other Dollhouse elements inside Ensembles — multiple Skills together, informed by Personas, guided by Templates and Memories, managed by Agents
- Enhanced metadata and searchability

### 2. Share DollhouseMCP Skills on claude.ai

**Scenario**: You created a skill in DollhouseMCP and want to share it on claude.ai.

**Workflow**:

```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "dollhouse_markdown": "---\nname: my-skill\ndescription: My custom skill\ntype: skill\nversion: 1.0.0\ninstructions: Perform the task as described.\n---\n\n## Reference\n\nDetailed documentation here."
  }
}
```

The response contains the agent skills directory structure ready for upload to claude.ai.

Or in natural language:
- "Export my-skill to agent skills format"
- "Convert my-skill so I can upload it to claude.ai"

**Benefits**:
- Reach Claude.ai user community
- Maintain single source of truth in DollhouseMCP
- Preserve full metadata for future updates
- Cross-platform skill distribution

### 3. Bidirectional Synchronization

**Scenario**: Maintain skills in both ecosystems with synchronized updates.

**Workflow**:

```json
// Export to agent skills format (save roundtrip_state for later)
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "path_mode": "lossless",
    "dollhouse_markdown": "<your skill markdown>"
  }
}

// Later: import updates back with roundtrip state
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": { "SKILL.md": "<updated SKILL.md content>" },
    "roundtrip_state": { "<saved roundtrip_state>" }
  }
}
// Full metadata restored, changes merged
```

### 4. Bulk Conversion via Natural Language

**Scenario**: Convert multiple skills at once.

Since the converter is an MCP operation, bulk conversion is best done through natural language requests:

- "Convert all my Dollhouse skills to agent skills format"
- "Import these three agent skills into my DollhouseMCP portfolio"

The LLM will iterate through the skills and call `convert_skill_format` for each one.

---

## Operation Reference

### `convert_skill_format` (READ endpoint)

Convert between agent skills and Dollhouse Skills formats with structured warnings and roundtrip support.

**Invocation**:
```
mcp_aql_read { "operation": "convert_skill_format", "params": { ... } }
```

**Import Example** (agent skills to Dollhouse):
```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "agent_skill": {
      "SKILL.md": "---\nname: my-skill\ndescription: test\n---\n\nUse this skill."
    }
  }
}
```

**Import with Options**:
```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "agent_to_dollhouse",
    "security_mode": "warn",
    "path_mode": "lossless",
    "agent_skill": {
      "SKILL.md": "---\nname: my-skill\ndescription: test\n---\n\nUse this skill."
    }
  }
}
```

**Export Example** (Dollhouse to agent skills):
```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "dollhouse_markdown": "---\nname: my-skill\ndescription: test\ninstructions: Use this skill.\n---\n\nReference content"
  }
}
```

**Export with Lossless Paths**:
```json
mcp_aql_read {
  "operation": "convert_skill_format",
  "params": {
    "direction": "dollhouse_to_agent",
    "path_mode": "lossless",
    "dollhouse_markdown": "---\nname: my-skill\ndescription: test\ninstructions: Use this skill.\n---\n\n### binaries/logo.png\n(binary link: ./skills/binaries/logo.png)"
  }
}
```

**Returns**: `SkillConversionResult` — converted artifact plus machine-readable conversion report and warnings.

> **Note**: The `dollhouse convert` CLI commands shown in older documentation do not exist. CLI support is tracked in [issue #860](https://github.com/DollhouseMCP/mcp-server/issues/860). All conversion is done through the MCP-AQL operation described above.

---

## Security and Validation

### Input Validation

The converter includes comprehensive security measures:

**Content Validation**:
- **Size limits**: 2 MiB per text field, 16 MiB aggregate, 2000 file entries
- **Path traversal prevention**: All paths sanitized and validated (in `safe` mode)
- **Unicode normalization**: Prevents homograph attacks
- **YAML validation**: Schema compliance checking, YAML-bomb/amplification detection
- **File type verification**: Only expected file types processed
- **Metadata validation**: Required fields enforced

### Security Modes

The `security_mode` parameter controls how security findings are handled during import:

- **`strict`** (default): Any high/critical finding causes the conversion to fail. Always use this for untrusted input.
- **`warn`**: Findings are reported in `report.warnings` but conversion proceeds. Use only for trusted migration workflows.

### Error Handling

**Common Errors and Solutions**:

**Error**: `Invalid SKILL.md format - missing required field: name`
- **Cause**: Agent skills SKILL.md missing required metadata
- **Solution**: Add missing field to SKILL.md content before conversion

**Error**: High/critical security finding blocks conversion
- **Cause**: `security_mode` is `strict` (default) and content triggered a security finding
- **Solution**: Review the findings, fix the content, or use `security_mode: "warn"` if you trust the source

**Error**: Input exceeds size limits
- **Cause**: Text field exceeds 2 MiB or aggregate exceeds 16 MiB
- **Solution**: Split large skills into smaller components

---

## Integration with DollhouseMCP

### After Importing

Once you've imported an agent skill, integrate it with the DollhouseMCP ecosystem:

**1. Reload Elements**:
```
Use MCP tool: reload_elements type="skills"
```

**2. Activate Skill**:
```
Use MCP tool: activate_element name="skill-name" type="skills"
```

**3. View Details**:
```
Use MCP tool: get_element_details name="skill-name" type="skills"
```

**4. Edit with Natural Language**:
```
"Edit the code-reviewer skill to add TypeScript support"
```

**5. Combine with Other Elements**:
```
"Activate the code-reviewer skill and the professional-developer persona"
```

### Version Control

DollhouseMCP skills integrate seamlessly with git:

```bash
cd ~/.dollhouse/portfolio

# Track changes
git add skills/my-skill.md
git commit -m "feat: Add code-reviewer skill from claude.ai"

# View history
git log skills/my-skill.md

# Revert if needed
git checkout HEAD~1 skills/my-skill.md
```

### Sync to GitHub Portfolio

Share with the DollhouseMCP community:

```
# Sync to your GitHub portfolio
# (Use MCP tool: sync_portfolio direction="push")

# Submit to DollhouseMCP Collection
# (Use MCP tool: submit_collection_content content="my-skill")
```

---

## Troubleshooting

### Conversion Fails

**Issue**: Conversion fails with unclear error message

**Diagnostic Steps**:
1. Check the `report.warnings` array in the response for details
2. Verify the `direction` parameter matches your input (`agent_to_dollhouse` needs `agent_skill`, `dollhouse_to_agent` needs `dollhouse_markdown` or `dollhouse`)
3. Try with `security_mode: "warn"` to see if a security finding is blocking conversion
4. Verify SKILL.md has valid YAML frontmatter with at least `name` and `description`

**Common Causes**:
- Malformed YAML frontmatter
- Missing required metadata fields (name, description)
- Security findings in strict mode
- Input exceeding size limits

### Metadata Loss

**Issue**: Metadata appears to be missing after roundtrip conversion

**Verification**:
- Ensure you saved the `roundtrip_state` from the first conversion
- Pass `roundtrip_state` and `prefer_roundtrip_state: true` on the reverse conversion
- Check `path_mode: "lossless"` was used in both directions

**Expected Behavior**:
- Full metadata preserved via roundtrip state
- Restored automatically when roundtrip state is provided
- No data loss in roundtrip

### Code Blocks Not Extracted

**Issue**: Code blocks remain in SKILL.md instead of being extracted to scripts/

**Explanation**: This is expected behavior for **export** (DollhouseMCP to agent skills). Code blocks are extracted to separate files.

**For Import** (agent skills to DollhouseMCP): Scripts are embedded as code blocks in the single .md file.

---

## Technical Implementation

### Converter Architecture

**Components**:

1. **SchemaMapper** (`src/converters/SchemaMapper.ts`)
   - Bidirectional metadata transformation
   - Tag and category inference
   - License normalization

2. **ContentExtractor** (`src/converters/ContentExtractor.ts`)
   - Code block extraction and parsing
   - Documentation section identification
   - Language detection

3. **DollhouseToAnthropicConverter** (`src/converters/DollhouseToAnthropicConverter.ts`)
   - Single-file to multi-file transformation
   - Metadata simplification
   - Script file generation

4. **AnthropicToDollhouseConverter** (`src/converters/AnthropicToDollhouseConverter.ts`)
   - Multi-file to single-file transformation
   - Metadata enrichment
   - Content consolidation

### Test Coverage

**Comprehensive Test Suite**: 13/13 tests passing

**Test Categories**:
- Schema mapping (4 tests)
- Content extraction (2 tests)
- DollhouseMCP to agent skills conversion (2 tests)
- Agent skills to DollhouseMCP conversion (3 tests)
- Roundtrip fidelity (2 tests)

**Location**: `test/__tests__/unit/converter.test.ts`

---

## FAQ

### Q: Is conversion lossless?

**A**: Yes, **100% lossless** in both directions when using `path_mode: "lossless"` and preserving the `roundtrip_state` object. The converter preserves all metadata, content, and code through roundtrip conversion.

### Q: How do I invoke the converter?

**A**: Through the `convert_skill_format` MCP-AQL operation on the READ endpoint. There is no CLI command. You can call it directly via `mcp_aql_read` or ask in natural language (e.g., "Convert this agent skill to a Dollhouse Skill"). See [issue #860](https://github.com/DollhouseMCP/mcp-server/issues/860) for CLI tracking.

### Q: Can I convert skills in bulk?

**A**: Yes. Ask in natural language ("Convert all my skills to agent skills format") and the LLM will iterate through them, calling `convert_skill_format` for each.

### Q: Do converted skills work on other MCP platforms?

**A**: Yes, Dollhouse Skills work on any MCP-compatible platform — Claude Desktop, Claude Code, VS Code, Cursor, Gemini, Codex, and any other client implementing the Model Context Protocol.

### Q: What happens to agent skills-specific features?

**A**: Agent skills features are preserved in the DollhouseMCP format. When exported back, they're restored to the original agent skills structure (especially when using `roundtrip_state`).

### Q: Can I edit converted skills?

**A**: Yes, use DollhouseMCP's natural language editing capabilities to modify any skill, regardless of its original source.

### Q: How do I update a skill after conversion?

**A**: Edit in DollhouseMCP (natural language or direct file editing), then re-export if needed for claude.ai distribution.

### Q: Are there size limits?

**A**: Per-field: 2 MiB. Aggregate: 16 MiB. File entries: 2000 max. These are enforced by the MCP-AQL operation regardless of path or security mode.

### Q: What is the difference between `safe` and `lossless` path modes?

**A**: `safe` (default) validates all paths against an allowlist and sanitizes non-conforming paths. `lossless` preserves all paths as-is while still reporting security findings. Use `safe` for untrusted input, `lossless` for trusted sources where you need full fidelity.

---

## Support

### Getting Help

- **Documentation**: This guide covers common scenarios
- **GitHub Issues**: [Report conversion problems](https://github.com/DollhouseMCP/mcp-server/issues)
- **GitHub Discussions**: [Ask questions](https://github.com/DollhouseMCP/mcp-server/discussions)

### Reporting Issues

When reporting conversion problems, include:

1. **Operation called**: Full `convert_skill_format` params used
2. **Error message**: Complete error output or `report.warnings` content
3. **Input format**: Direction, input structure, and approximate size
4. **Expected behavior**: What you expected to happen
5. **Actual behavior**: What actually happened
6. **Parameter settings**: `path_mode` and `security_mode` values used

### Feature Requests

Have ideas for converter improvements?

- [Open a feature request](https://github.com/DollhouseMCP/mcp-server/issues/new?template=feature_request.md)
- Tag with `enhancement` and `converter` labels
- Describe the use case and expected behavior

---

## Additional Resources

- **[DollhouseMCP Documentation](../../README.md)** - Main project documentation
- **[Public Beta Onboarding](public-beta-onboarding.md)** - Getting started with all element types
- **[Portfolio Setup Guide](portfolio-setup-guide.md)** - Managing your portfolio
- **[API Reference](../reference/api-reference.md)** - Complete MCP tool documentation
- **[Model Context Protocol](https://modelcontextprotocol.io)** - MCP specification

---

*This converter enables agent skills to operate within the DollhouseMCP ecosystem while maintaining full compatibility with claude.ai.*

# Skills Converter Guide

**Bidirectional conversion between DollhouseMCP Skills and Claude Skills**

---

## Overview

The DollhouseMCP Skills Converter provides **lossless bidirectional translation** between DollhouseMCP Skills and Claude Skills formats. This enables seamless interoperability between ecosystems while maintaining full fidelity of skill content and functionality.

### Timeline and Context

- **July 2025**: DollhouseMCP Skills premiered as part of the comprehensive six-element customization architecture
- **October 2025**: Anthropic introduced Skills for claude.ai
- **October 2025**: DollhouseMCP released bidirectional converter for ecosystem interoperability

The converter enables Claude Skills to operate within the DollhouseMCP ecosystem, providing access to enhanced features including version control, cross-platform deployment, and integration with other element types.

---

## Quick Start

### Import Claude Skills

```bash
# From a downloaded ZIP file from claude.ai
dollhouse convert from-anthropic ~/Downloads/my-skill.zip

# From an extracted directory
dollhouse convert from-anthropic ~/Downloads/my-skill-folder

# With verbose output
dollhouse convert from-anthropic ~/Downloads/my-skill.zip --verbose

# Custom output location
dollhouse convert from-anthropic ~/Downloads/my-skill.zip -o ~/.dollhouse/portfolio/skills
```

**Default output**: `~/.dollhouse/portfolio/skills/skill-name.md`

### Export to Claude Skills Format

```bash
# Export a DollhouseMCP skill
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md

# With verbose output
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md --verbose

# Custom output directory
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md -o ./exports

# Preview without executing
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md --dry-run
```

**Default output**: `./anthropic-skills/skill-name/` (directory structure)

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
- **Single-file architecture** for portability and version control
- **Embedded code blocks** with language-specific syntax highlighting
- **Extensible schema** with custom fields support
- **Rich documentation** with Markdown formatting

### Claude Skills Format (Target)

Claude Skills use a **minimal metadata schema** focused on essential information:

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

### Import: Claude Skills → DollhouseMCP

**Process Overview**:

1. **Detection**: Identify Claude Skills format (SKILL.md presence)
2. **Metadata Enrichment**: Add DollhouseMCP schema fields
3. **Content Consolidation**: Combine multi-file structure into single Markdown
4. **Code Embedding**: Extract scripts and embed as code blocks
5. **Validation**: Ensure schema compliance
6. **Output**: Single `.md` file in portfolio

**Metadata Enrichment**:

When importing Claude Skills, the converter **automatically enriches** the minimal metadata:

```yaml
# Claude Skills (minimal)
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

### Export: DollhouseMCP → Claude Skills

**Process Overview**:

1. **Metadata Simplification**: Extract name, description, license
2. **Content Decomposition**: Split single file into multi-file structure
3. **Code Extraction**: Convert embedded code blocks to separate script files
4. **Metadata Preservation**: Store full DollhouseMCP metadata for roundtrip
5. **Validation**: Ensure Claude Skills format compliance
6. **Output**: Directory structure ready for claude.ai upload

**Metadata Preservation**:

To enable **lossless roundtrip conversion**, the full DollhouseMCP metadata is preserved:

```
skill-name/
├── SKILL.md              # Claude Skills format (simplified metadata)
├── metadata/
│   └── dollhouse.yaml    # Full DollhouseMCP metadata preserved
└── scripts/
    └── ...
```

This ensures that importing the exported skill back to DollhouseMCP restores **100% of the original metadata**.

---

## Advanced Features

### Lossless Roundtrip Conversion

The converter guarantees **perfect fidelity** in both directions:

```bash
# Start with DollhouseMCP skill
original=~/.dollhouse/portfolio/skills/my-skill.md

# Export to Claude Skills format
dollhouse convert to-anthropic $original -o ./temp

# Import back to DollhouseMCP
dollhouse convert from-anthropic ./temp/my-skill -o ./roundtrip

# Verify identical content
diff $original ./roundtrip/my-skill.md
# No differences - perfect roundtrip
```

**What's Preserved**:
- ✅ All metadata fields (15+ fields)
- ✅ All content sections
- ✅ All code blocks with language tags
- ✅ All documentation structure
- ✅ Custom metadata fields
- ✅ Version information
- ✅ Author attribution

### Format Auto-Detection

The converter automatically identifies the source format:

```bash
# Detects ZIP file → extracts and converts
dollhouse convert from-anthropic skill.zip

# Detects directory with SKILL.md → Claude Skills format
dollhouse convert from-anthropic ./skill-directory

# Detects .md file with YAML frontmatter → DollhouseMCP format
dollhouse convert to-anthropic skill.md
```

No manual format specification required.

### Verbose Mode

Track every conversion operation:

```bash
dollhouse convert from-anthropic skill.zip --verbose
```

**Output Example**:
```
Reading Claude Skill...
  Input: skill.zip
  Size: 45.2 KB
  Extracting archive...

Converting to DollhouseMCP Skills format...
  ✓ Read SKILL.md metadata
  ✓ Enriched metadata (added 12 fields)
  ✓ Combined 3 script(s)
    - scripts/setup.sh
    - scripts/process.py
    - scripts/cleanup.sh
  ✓ Combined 1 reference document(s)
  ✓ Combined 2 example(s)

✓ Conversion complete
  Created: ~/.dollhouse/portfolio/skills/skill-name.md
  Size: 52.8 KB (15% larger due to metadata enrichment)
```

### Conversion Reports

Generate detailed conversion documentation:

```bash
dollhouse convert from-anthropic skill.zip --report
```

**Report Location**: `.conversion-report.md` in output directory

**Report Contents**:
- Conversion timestamp and direction
- Input/output file paths
- List of all files created/modified
- Metadata transformations applied
- Operations performed (step-by-step)
- Warnings or issues encountered
- Success/failure status

---

## Use Cases

### 1. Import Claude Skills from claude.ai

**Scenario**: You downloaded a skill from claude.ai and want to use it with DollhouseMCP.

**Workflow**:
```bash
# Download skill from claude.ai (receives ZIP file)
# Import to DollhouseMCP
dollhouse convert from-anthropic ~/Downloads/code-reviewer.zip --verbose

# Reload elements
# (Use MCP tool: reload_elements type="skills")

# Activate skill
# (Use MCP tool: activate_element name="code-reviewer" type="skills")
```

**Benefits**:
- Access skill across 378+ MCP-compatible platforms (not just claude.ai)
- Version control with git
- Combine with other DollhouseMCP elements (Personas, Templates, etc.)
- Enhanced metadata and searchability

### 2. Share DollhouseMCP Skills on claude.ai

**Scenario**: You created a skill in DollhouseMCP and want to share it on claude.ai.

**Workflow**:
```bash
# Export skill to Claude Skills format
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md --verbose

# Upload directory to claude.ai
# Output: ./anthropic-skills/my-skill/ (ready for upload)
```

**Benefits**:
- Reach Claude.ai user community
- Maintain single source of truth in DollhouseMCP
- Preserve full metadata for future updates
- Cross-platform skill distribution

### 3. Bidirectional Synchronization

**Scenario**: Maintain skills in both ecosystems with synchronized updates.

**Workflow**:
```bash
# Edit in DollhouseMCP (use natural language editing)
# Export to Claude Skills format
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md -o ./sync

# Upload to claude.ai

# Later: Import updates from Claude Skills format
dollhouse convert from-anthropic ./sync/my-skill --force

# Full metadata restored, changes merged
```

### 4. Bulk Conversion

**Scenario**: Convert multiple skills at once.

**Workflow**:
```bash
# Export all DollhouseMCP skills
for skill in ~/.dollhouse/portfolio/skills/*.md; do
  dollhouse convert to-anthropic "$skill" -o ./exports
done

# Import all Claude Skills
for skill in ~/Downloads/claude-skills/*.zip; do
  dollhouse convert from-anthropic "$skill"
done
```

---

## CLI Reference

### `dollhouse convert from-anthropic`

Import Claude Skills to DollhouseMCP format.

**Syntax**:
```bash
dollhouse convert from-anthropic <input> [options]
```

**Arguments**:
- `<input>` - Path to ZIP file, directory, or SKILL.md file

**Options**:
- `-o, --output <dir>` - Output directory (default: `~/.dollhouse/portfolio/skills`)
- `-v, --verbose` - Show detailed conversion steps
- `-r, --report` - Generate conversion report
- `--force` - Overwrite existing files without confirmation

**Examples**:
```bash
# Import from ZIP
dollhouse convert from-anthropic skill.zip

# Import from directory with custom output
dollhouse convert from-anthropic ./skill-dir -o ./custom-output

# Import with verbose output and report
dollhouse convert from-anthropic skill.zip -v -r
```

### `dollhouse convert to-anthropic`

Export DollhouseMCP Skills to Claude Skills format.

**Syntax**:
```bash
dollhouse convert to-anthropic <input> [options]
```

**Arguments**:
- `<input>` - Path to DollhouseMCP skill (.md file)

**Options**:
- `-o, --output <dir>` - Output directory (default: `./anthropic-skills`)
- `-v, --verbose` - Show detailed conversion steps
- `-r, --report` - Generate conversion report
- `--dry-run` - Preview without executing

**Examples**:
```bash
# Export skill
dollhouse convert to-anthropic skill.md

# Export with custom output and preview
dollhouse convert to-anthropic skill.md -o ./exports --dry-run

# Export with verbose output
dollhouse convert to-anthropic skill.md -v
```

---

## Security and Validation

### Input Validation

The converter includes comprehensive security measures:

**ZIP File Validation**:
- **Size limits**: Maximum 100 MB compressed
- **Zip bomb detection**: Maximum 500 MB extracted
- **Path traversal prevention**: All paths sanitized and validated
- **Automatic cleanup**: Temporary files removed on success/failure

**Content Validation**:
- **Unicode normalization**: Prevents homograph attacks
- **YAML validation**: Schema compliance checking
- **File type verification**: Only expected file types processed
- **Metadata validation**: Required fields enforced

### Error Handling

**Common Errors and Solutions**:

**Error**: `ZIP file too large (150 MB exceeds 100 MB limit)`
- **Cause**: Security limit on ZIP file size
- **Solution**: Split large skills into smaller components or contact support for enterprise limits

**Error**: `Zip bomb detected (750 MB extracted exceeds 500 MB limit)`
- **Cause**: Security protection against decompression attacks
- **Solution**: Reduce skill size or verify ZIP file integrity

**Error**: `Invalid SKILL.md format - missing required field: name`
- **Cause**: Claude Skills SKILL.md missing required metadata
- **Solution**: Add missing field to SKILL.md before conversion

**Error**: `File already exists: ~/.dollhouse/portfolio/skills/my-skill.md`
- **Cause**: Skill already exists in portfolio
- **Solution**: Use `--force` flag to overwrite or rename existing skill

---

## Integration with DollhouseMCP

### After Importing

Once you've imported a Claude Skill, integrate it with the DollhouseMCP ecosystem:

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

```bash
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
1. Run with `--verbose` flag to see detailed steps
2. Check input file exists and is readable: `ls -la <input>`
3. Verify format: `head -20 <input>/SKILL.md` (for Claude Skills)
4. Check permissions: `ls -la ~/.dollhouse/portfolio/skills/`

**Common Causes**:
- Malformed YAML frontmatter
- Missing required metadata fields
- Invalid file permissions
- Disk space issues

### Metadata Loss

**Issue**: Metadata appears to be missing after roundtrip conversion

**Verification**:
```bash
# Check for preserved metadata
ls -la ./anthropic-skills/my-skill/metadata/dollhouse.yaml

# Verify roundtrip
dollhouse convert from-anthropic ./anthropic-skills/my-skill
cat ~/.dollhouse/portfolio/skills/my-skill.md | head -30
```

**Expected Behavior**:
- Full metadata preserved in `metadata/dollhouse.yaml`
- Restored automatically on import
- No data loss in roundtrip

### Code Blocks Not Extracted

**Issue**: Code blocks remain in SKILL.md instead of being extracted to scripts/

**Explanation**: This is expected behavior for **export** (DollhouseMCP → Claude Skills). Code blocks are extracted to separate files.

**For Import** (Claude Skills → DollhouseMCP): Scripts are embedded as code blocks in the single .md file.

### Performance Issues

**Issue**: Conversion takes a long time for large skills

**Optimization**:
- Skills with 100+ code blocks may take 10-30 seconds
- Large documentation (>1MB) may take 30-60 seconds
- Network delays if downloading from claude.ai

**Expected Performance**:
- Small skills (<100KB): <1 second
- Medium skills (100KB-500KB): 1-5 seconds
- Large skills (500KB-2MB): 5-30 seconds

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
- DollhouseMCP → Claude Skills conversion (2 tests)
- Claude Skills → DollhouseMCP conversion (3 tests)
- Roundtrip fidelity (2 tests)

**Location**: `test/__tests__/unit/converter.test.ts`

---

## FAQ

### Q: Is conversion lossless?

**A**: Yes, **100% lossless** in both directions. The converter preserves all metadata, content, and code through roundtrip conversion.

### Q: Can I convert skills in bulk?

**A**: Yes, use shell loops to convert multiple skills at once. See [Bulk Conversion](#4-bulk-conversion) for examples.

### Q: Do converted skills work on other MCP platforms?

**A**: Yes, DollhouseMCP skills work across **378+ MCP-compatible applications** including Claude Desktop, VS Code, and any platform implementing the Model Context Protocol.

### Q: What happens to Claude Skills-specific features?

**A**: Claude Skills features are preserved in the DollhouseMCP format. When exported back, they're restored to the original Claude Skills structure.

### Q: Can I edit converted skills?

**A**: Yes, use DollhouseMCP's natural language editing capabilities to modify any skill, regardless of its original source.

### Q: How do I update a skill after conversion?

**A**: Edit in DollhouseMCP (natural language or direct file editing), then re-export if needed for claude.ai distribution.

### Q: Are there size limits?

**A**: ZIP files: 100 MB compressed, 500 MB extracted (security limits). Individual skill files: No practical limit, but very large skills (>10 MB) may have slower conversion.

---

## Support

### Getting Help

- **Documentation**: This guide covers common scenarios
- **GitHub Issues**: [Report conversion problems](https://github.com/DollhouseMCP/mcp-server/issues)
- **GitHub Discussions**: [Ask questions](https://github.com/DollhouseMCP/mcp-server/discussions)

### Reporting Issues

When reporting conversion problems, include:

1. **Command executed**: Full `dollhouse convert` command with flags
2. **Error message**: Complete error output
3. **Input source**: Type (ZIP, directory, .md file) and approximate size
4. **Expected behavior**: What you expected to happen
5. **Actual behavior**: What actually happened
6. **Verbose output**: Run with `--verbose` and include output

### Feature Requests

Have ideas for converter improvements?

- [Open a feature request](https://github.com/DollhouseMCP/mcp-server/issues/new?template=feature_request.md)
- Tag with `enhancement` and `converter` labels
- Describe the use case and expected behavior

---

## Additional Resources

- **[DollhouseMCP Documentation](../../README.md)** - Main project documentation
- **[Element Developer Guide](../ELEMENT_DEVELOPER_GUIDE.md)** - Creating custom elements
- **[Portfolio Setup Guide](PORTFOLIO_SETUP_GUIDE.md)** - Managing your portfolio
- **[API Reference](../API_REFERENCE.md)** - Complete MCP tool documentation
- **[Model Context Protocol](https://modelcontextprotocol.io)** - MCP specification

---

*This converter enables Claude Skills to operate within the DollhouseMCP ecosystem while maintaining full compatibility with claude.ai.*

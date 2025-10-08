# Bundled Starter Elements

## Purpose

This directory contains **default example elements** that ship with the DollhouseMCP NPM package. These are NOT user-generated files - they are part of the product.

## What Are Bundled Elements?

On first run, DollhouseMCP copies these example elements to the user's local portfolio (`~/.dollhouse/portfolio/`) to provide:

1. **Working examples** - Users can immediately try personas, skills, and templates
2. **Learning material** - See proper element structure and metadata
3. **Quick start** - No empty portfolio on first install

## Directory Structure

```
data/
├── personas/       Example AI behavioral profiles
├── skills/         Example discrete capabilities
├── templates/      Example reusable content structures
├── agents/         Example goal-oriented decision makers
├── memories/       Example persistent context storage
└── ensembles/      Example combined element orchestration
```

## Important Distinctions

| This Directory (data/) | User Portfolio (~/.dollhouse/portfolio/) |
|------------------------|------------------------------------------|
| ✅ In git repository   | ❌ NOT in repository                     |
| ✅ Ships with NPM      | ❌ Local user storage only               |
| ✅ Read-only examples  | ✅ User's active elements                |
| ✅ Version controlled  | ❌ .gitignored                           |

## For Developers

### NPM Package Inclusion

These files are explicitly included in package.json:

```json
"files": [
  "data/personas/**/*.md",
  "data/skills/**/*.md",
  "data/templates/**/*.md",
  "data/agents/**/*.md",
  "data/memories/**/*.md",
  "data/ensembles/**/*.md"
]
```

### Loading Mechanism

See `src/portfolio/DefaultElementProvider.ts` for the implementation that:
- Locates bundled data in NPM installation or git repo
- Copies elements to user portfolio on first run
- Handles development vs production modes

### Testing

`test/__tests__/basic.test.ts` verifies:
- Required directories exist
- Expected example files are present
- Proper structure is maintained

## Common Misconceptions

❌ "data/ should be in .gitignore" - **NO**, these are bundled examples, not user data
❌ "This is test data" - **NO**, this is production starter content
❌ "This is my local portfolio" - **NO**, your portfolio is in `~/.dollhouse/`

## Contributing New Examples

When adding new bundled elements:

1. Follow existing element structure (YAML frontmatter + Markdown)
2. Keep examples simple and educational
3. Test that DefaultElementProvider can load them
4. Update this README if adding new element types

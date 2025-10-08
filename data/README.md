# Bundled Starter Elements

## Purpose

This directory contains **default example elements** that ship with the DollhouseMCP NPM package. These are NOT user-generated files - they are part of the product.

## What Are Bundled Elements?

On first run, DollhouseMCP copies these example elements to the user's local portfolio (`~/.dollhouse/portfolio/`) to provide:

1. **Working examples** - Users can immediately try personas, skills, and templates
2. **Learning material** - See proper element structure and metadata
3. **Quick start** - No empty portfolio on first install

### First-Run Process

When a user installs DollhouseMCP via NPM:

1. **User installs**: `npm install @dollhousemcp/mcp-server`
2. **First launch**: User starts DollhouseMCP for the first time
3. **Empty portfolio detected**: System checks `~/.dollhouse/portfolio/` and finds it empty
4. **Bundled elements copied**: DefaultElementProvider copies files from `data/` → user portfolio
5. **User customizes**: User can now modify their local copies without affecting the originals

**Important**: The bundled elements in `data/` remain unchanged. Users work with *copies* in their portfolio.

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

See `src/portfolio/DefaultElementProvider.ts` for the implementation:

- **Population logic** (`populateDefaultElements()` around line 947): Main function that orchestrates copying bundled elements to user portfolio
- **File copying** (`copyElementFiles()` around line 679): Copies individual files while preserving existing user modifications
- **Directory detection** (`findDataDirectory()` around line 190): Locates bundled data in NPM installation or git repository
- **Development vs production mode** (lines 35-122): See below for detailed explanation

#### Development vs Production Modes

The loading mechanism behaves differently based on the environment:

**Production Mode** (NPM installation, no `.git` directory):
- ✅ Bundled elements ARE loaded by default
- Users get starter examples on first run
- Provides immediate value for new installations

**Development Mode** (Git clone, `.git` directory present):
- ❌ Bundled elements are NOT loaded by default
- Prevents test/example data from polluting developer's portfolio
- Developers can override with `DOLLHOUSE_LOAD_TEST_DATA=true` environment variable

This distinction ensures:
- End users get a great first-run experience with examples
- Developers working on the codebase don't get unwanted test data in their personal portfolio
- Test elements (marked with metadata) are blocked in production for security

### Testing

`test/__tests__/basic.test.ts` (lines 33-57) verifies:
- Required directories exist (including `data/personas`)
- Expected example files are present (e.g., `creative-writer.md`)
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

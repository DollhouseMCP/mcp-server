# Examples

Configuration examples and sample files for DollhouseMCP.

## Files

- `enabling-resources.yml` – MCP Resources configuration example showing how to enable resource support in various MCP clients.

## Ensemble Examples

Complete ensemble examples demonstrating different use cases and features:

### 1. Minimal Ensemble (`minimal-ensemble.md`)
**Quick Start Example**
- Strategy: All (parallel)
- Elements: 2 (friendly-assistant, code-documentation)
- Context Sharing: None
- Purpose: Simplest possible ensemble - perfect for learning the basics

### 2. Writing Studio (`writing-studio.md`)
**Parallel Content Creation**
- Strategy: All (parallel)
- Elements: 4 (creative-writer, grammar-checker, style-guide, fact-checker)
- Context Sharing: Selective
- Conflict Resolution: Priority
- Purpose: Demonstrates parallel activation with priority-based conflict resolution

### 3. Data Pipeline (`data-pipeline.md`)
**Priority-Based ETL Workflow**
- Strategy: Priority
- Elements: 4 (data-validator, data-transformer, data-analyzer, report-generator)
- Context Sharing: Full
- Conflict Resolution: Priority
- Purpose: Shows priority-based sequential execution (100→75→50→25)

### 4. Code Review Team (`code-review-team.md`)
**Sequential Workflow with Dependencies**
- Strategy: Sequential
- Elements: 4 (technical-analyst, code-reviewer, security-auditor, documentation-writer)
- Context Sharing: Full
- Conflict Resolution: Last-write
- Purpose: Demonstrates sequential activation with explicit dependencies

### 5. Debugging Assistant (`debugging-assistant.md`)
**Conditional Adaptive Tools**
- Strategy: Conditional
- Elements: 4 (error-detective, performance-profiler, security-scanner, memory-analyzer)
- Context Sharing: Full
- Conflict Resolution: Merge
- Purpose: Shows conditional activation based on context (with implementation notes)

## Learning Path

1. Start with `minimal-ensemble.md` - understand the basic structure
2. Try `writing-studio.md` - learn parallel activation and priority conflicts
3. Explore `data-pipeline.md` - see priority-based ordering
4. Study `code-review-team.md` - understand dependencies
5. Review `debugging-assistant.md` - see conditional patterns (future feature)

## Using These Examples

These ensemble files can be:
- Copied to your portfolio (`~/.dollhouse/portfolio/ensembles/`)
- Used as templates for your own ensembles
- Referenced when learning ensemble features
- Modified to fit your specific needs

For complete ensemble documentation, see `docs/guides/ensembles.md`.

Examples demonstrate real-world configurations and usage patterns. For conceptual guidance, see `docs/guides/`.

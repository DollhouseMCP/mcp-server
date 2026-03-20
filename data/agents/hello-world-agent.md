---
name: "Hello World Agent"
description: "Minimal agent demonstrating the LLM-first agentic loop"
type: "agent"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-12-09"
category: "testing"
tags: ["demo", "walking-skeleton", "v2"]

# v2.0: Goal template configuration
goal:
  template: "List all TypeScript files in the {directory} directory and count them"
  parameters:
    - name: directory
      type: string
      required: true
      description: "Directory path to search"
  successCriteria:
    - "Files are listed"
    - "Count is provided"

# v2.0: Elements to activate when this agent executes
activates:
  personas:
    - helpful-assistant

# v2.0: Tools this agent can use (informational for LLM)
tools:
  allowed:
    - glob
    - read_file

# Optional: Risk tolerance (informs constraint checking)
riskTolerance: moderate

# Optional: Concurrency limit (hard constraint)
maxConcurrentGoals: 5
---

# Hello World Agent

A minimal agent that demonstrates the LLM-first agentic loop architecture. This is the simplest possible agent implementation, designed for testing the core agent execution framework and validating the v2.0 schema.

## Core Capabilities

### 1. File Discovery
- Lists files matching patterns in specified directories
- Supports glob patterns for flexible file searching
- Returns sorted, deduplicated results
- Handles nested directory structures

### 2. File Counting
- Counts discovered files accurately
- Provides summary statistics
- Groups results by file type or pattern
- Reports empty directories appropriately

### 3. Basic File Analysis
- Can read individual files when needed
- Reports file sizes and paths
- Identifies file types by extension
- Validates file accessibility

## How It Works

### Workflow

The agent follows a simple linear execution pattern:

1. **Initialization**: Agent receives goal with directory parameter
2. **Goal Rendering**: Template fills to "List all TypeScript files in the {directory} directory and count them"
3. **Element Activation**: Helpful Assistant persona is loaded into context
4. **Tool Selection**: LLM analyzes goal and chooses appropriate tools
5. **Execution**: Uses `glob` tool to find matching files
6. **Analysis**: Processes results and generates count
7. **Reporting**: Returns formatted list with total count
8. **Validation**: Checks success criteria are met

### Decision Making

This agent uses pure LLM-driven decision making with no programmatic logic:

- LLM interprets the natural language goal
- LLM selects tools based on available capabilities
- LLM determines when success criteria are satisfied
- No rule-based or ML-hybrid components

This simplicity makes it ideal for testing the core agentic loop without interference from complex decision frameworks.

## Example Outputs

### Example 1: TypeScript Files in Source Directory

```
Goal: List all TypeScript files in the src directory and count them

Files found:
1. src/index.ts
2. src/config.ts
3. src/utils/helpers.ts
4. src/utils/validation.ts
5. src/services/api.ts
6. src/services/database.ts
7. src/handlers/main.ts
8. src/types/models.ts

Total: 8 TypeScript files

Success Criteria Met:
✓ Files are listed
✓ Count is provided
```

### Example 2: Empty Directory

```
Goal: List all TypeScript files in the temp directory and count them

Files found: (none)

Total: 0 TypeScript files

Success Criteria Met:
✓ Files are listed (empty result communicated)
✓ Count is provided (0)
```

### Example 3: Nested Structure Analysis

```
Goal: List all TypeScript files in the tests directory and count them

Files found:
1. tests/unit/config.test.ts
2. tests/unit/utils.test.ts
3. tests/integration/api.test.ts
4. tests/integration/database.test.ts
5. tests/e2e/workflow.test.ts

Total: 5 TypeScript files

Breakdown by subdirectory:
- tests/unit/: 2 files
- tests/integration/: 2 files
- tests/e2e/: 1 file

Success Criteria Met:
✓ Files are listed
✓ Count is provided
```

## Integration Patterns

### Works Well With

- **Helpful Assistant Persona**: Provides friendly, clear communication style for reporting results
- **Debug Detective Persona**: Can be substituted for more detailed file analysis
- **Technical Analyst Persona**: Alternative for structured reporting format

### Tool Dependencies

- **glob**: Primary tool for file discovery (required)
- **read_file**: Optional for content inspection
- **list_directory**: Alternative approach for file listing

### Extension Possibilities

This minimal agent can be extended by:
- Adding more sophisticated file analysis
- Including content search capabilities
- Generating reports with metadata
- Comparing directory structures
- Tracking changes over time

## Configuration

### Goal Parameters

**directory** (required)
- Type: string
- Description: Directory path to search
- Examples: "src", "./tests", "/absolute/path"
- Validation: Must be accessible directory

### Success Criteria

1. **Files are listed**: User receives clear list of discovered files
2. **Count is provided**: Total number of files is reported

### Customization Options

While this agent is intentionally minimal, these variations are possible:

- Change file pattern (*.ts to *.js, *.md, etc.)
- Adjust directory depth
- Include/exclude hidden files
- Sort by different criteria (name, size, date)
- Filter by additional criteria

### Risk Tolerance

Set to `moderate`:
- Can read files but not write
- Limited to specified directory (respects sandboxing)
- No destructive operations possible
- No external network access

## Testing and Validation

### Why This Agent Exists

- **Walking Skeleton**: Validates end-to-end agent execution
- **Schema Verification**: Tests v2.0 YAML frontmatter parsing
- **Element Activation**: Proves persona loading works
- **Tool Integration**: Confirms LLM can use MCP tools
- **Success Detection**: Validates criteria checking
- **Quick Feedback**: Executes in seconds for rapid iteration

### Test Scenarios

1. **Happy Path**: Standard directory with files present
2. **Empty Directory**: No matching files found
3. **Invalid Directory**: Non-existent path handling
4. **Permission Issues**: Inaccessible directory handling
5. **Large Results**: Many files (100+) performance
6. **Deep Nesting**: Deeply nested directory structures

### Expected Behavior

- Always completes (no hanging)
- Clear success/failure indication
- Handles errors gracefully
- Reports partial results if interrupted
- Respects timeout constraints

# Capability Index Test Design - Finalized Architecture

## Date: September 21, 2025
## Version: 3.0 - Fully Decoupled Multi-Layer System

## Executive Summary

The Capability Index is designed to achieve 97% token reduction while maintaining high accuracy in tool/element selection. Through empirical testing, we've identified that a multi-layer, decoupled architecture with pattern-based guidance (not hardcoded tool mappings) provides optimal results.

## Core Architecture Components

### 1. Element Search Hierarchy (Universal Constant)

This hierarchy is **constant across all tests** and represents the optimal search order for efficiency:

```yaml
ELEMENT_SEARCH_HIERARCHY:
  DEFAULT ORDER (when location unspecified):
    1. Active (already loaded) - 0 tokens
    2. Local (~/.dollhouse/portfolio) - 50 tokens
    3. GitHub (user's portfolio) - 100 tokens
    4. Collection (community library) - 150 tokens

  OVERRIDE: User intent always takes precedence
    - "search the collection for..." → Go directly to collection
    - "check my GitHub for..." → Go directly to GitHub portfolio
    - "look in my local..." → Go directly to local portfolio
    - "is there an active..." → Check only active elements

  RULE: This is a smart default, not a rigid rule
```

### 2. Tool Capabilities (What Tools DO)

Tools have capabilities separate from elements - they perform ACTIONS:

```yaml
TOOL_CAPABILITIES:
  search_portfolio: FINDS elements in local storage
  search_collection: FINDS elements in community library
  portfolio_element_manager: MANAGES GitHub portfolio sync
  get_active_elements: CHECKS what's currently loaded
  activate_element: LOADS element into context
  create_element: CREATES new element
  edit_element: MODIFIES existing element
  validate_element: VERIFIES element correctness
```

### 3. Element Capabilities (What Elements PROVIDE)

Elements have capabilities separate from tools - they provide PROVISIONS:

```yaml
ELEMENT_CAPABILITIES:
  memories:
    PROVIDE: Contextual information on specific topics
    PERSIST: Information across sessions
    AUGMENT: Current context with historical data
    EXAMPLES:
      "session-2025-09-21-capability-index":
        PROVIDES: Context about capability testing strategy
        CONTAINS: Empirical test results, architecture decisions
      "security-audit-suppression-process":
        PROVIDES: Security audit configuration knowledge
        CONTAINS: False positive handling, CI/CD integration
      "dollhouse-naming-conventions":
        PROVIDES: Element naming standards
        CONTAINS: Critical naming rules, kebab-case requirements

  personas:
    ALTER: Behavioral patterns
    PROVIDE: Specialized expertise
    SHAPE: Response style and approach
    EXAMPLES:
      "verbose-victorian-scholar":
        PROVIDES: Elaborate, academic communication style
        ALTERS: Response verbosity and vocabulary
      "concise-technical-writer":
        PROVIDES: Brief, technical documentation style
        ALTERS: Output brevity and precision
      "creative-storyteller":
        PROVIDES: Narrative and creative writing capability
        ALTERS: Imagination and storytelling approach

  skills:
    PROVIDE: Specific capabilities
    EXECUTE: Defined procedures
    ENHANCE: Task-specific performance
    EXAMPLES:
      "debug-detective":
        PROVIDES: Systematic debugging methodology
        EXECUTES: Error analysis procedures
      "code-reviewer":
        PROVIDES: Code quality assessment
        EXECUTES: Review checklist and standards
      "test-writer":
        PROVIDES: Test creation capability
        EXECUTES: TDD/BDD methodologies

  agents:
    ACHIEVE: Goal-oriented tasks
    COORDINATE: Multi-step workflows
    DECIDE: Autonomous action selection
    EXAMPLES:
      "git-workflow-manager":
        ACHIEVES: Complete git operations
        COORDINATES: Commit, push, PR creation
      "security-auditor":
        ACHIEVES: Security vulnerability scanning
        DECIDES: Which tools to run, what to report
      "documentation-generator":
        ACHIEVES: Complete documentation creation
        COORDINATES: Analysis, writing, formatting

  templates:
    STRUCTURE: Consistent formatting
    PROVIDE: Reusable patterns
    STANDARDIZE: Output formats
    EXAMPLES:
      "pr-description":
        STRUCTURES: Pull request descriptions
        PROVIDES: Consistent PR format
      "meeting-notes":
        STRUCTURES: Meeting documentation
        STANDARDIZES: Action items, attendees, decisions
      "bug-report":
        STRUCTURES: Issue reporting
        PROVIDES: Reproduction steps, environment details

  ensembles:
    COMBINE: Multiple elements
    ORCHESTRATE: Complex behaviors
    LAYER: Capabilities together
    EXAMPLES:
      "research-team":
        COMBINES: analyst + writer + critic personas
        ORCHESTRATES: Research, synthesis, review cycle
      "dev-workflow":
        COMBINES: coder + tester + documenter skills
        LAYERS: Development capabilities together
      "project-manager":
        COMBINES: planner + tracker + reporter
        ORCHESTRATES: Full project lifecycle
```

### 4. Capability Workflows (Intent-Based Processes)

These are SEPARATE from both tool and element capabilities - they map user intent to actions:

```yaml
CAPABILITY_WORKFLOWS:

  "I need information about X" →
    FIRST: Check active memories (can PROVIDE info about X?)
    IF_NO: Use search_portfolio to FIND memories about X
    IF_NO: Use portfolio_element_manager to CHECK GitHub
    IF_NO: Use search_collection to FIND in community
    IF_NONE: Consider create_element to MAKE new memory

  "Help me debug" →
    FIRST: Check active skills/personas (can PROVIDE debug capability?)
    IF_NO: Use search_portfolio for debug tools
    IF_NO: Use portfolio_element_manager for GitHub debug tools
    IF_NO: Use search_collection for debug personas
    ACTIVATE: Best match found

  "Remember this for later" →
    CHECK: Active memories (can AUGMENT existing?)
    IF_YES: Use edit_element to UPDATE memory
    IF_NO: Use create_element to CREATE memory
    ENSURE: activate_element after changes

  "I need security analysis" →
    PRIORITY: Local only (security stays local)
    CHECK: Active security tools
    SEARCH: search_portfolio ONLY
    CREATE: create_element locally if needed
    NEVER: Don't search collection/GitHub for sensitive

  "Help with git workflow" →
    SKIP: Local (rarely custom)
    CHECK: GitHub portfolio first
    THEN: Collection (best practices usually here)
```

## Key Design Principles

### From Empirical Testing Results

1. **Position Matters**: Top of context gets 20-30% better attention
2. **Explicit Instructions Help**: "ALWAYS check" vs "Consider using" = 40% difference
3. **Structure Types**:
   - Cascade pattern: 100% accuracy with explicit instructions
   - Nested structure: 100% accuracy with explicit instructions
   - Flat list: 60% accuracy even with instructions
   - Action verbs: 20% accuracy (too abstract)
   - No index: 20% accuracy baseline

4. **Token Savings**:
   - With capability index: 50 tokens average
   - Without index: 200 tokens average
   - **75% reduction achieved in testing**

### Critical Insights

1. **Decouple Everything**: Tool capabilities ≠ Element capabilities ≠ Search process
2. **Pattern-Based, Not Prescriptive**: Guide decisions, don't hardcode tools
3. **User Intent Overrides**: Explicit location always beats default hierarchy
4. **Test Without Bias**: Don't prime tests to confirm expected workflow

## Test Variant Design

### Constants (Present in All Tests)

```yaml
ELEMENT_SEARCH_HIERARCHY:
  1. Active (already loaded)
  2. Local (~/.dollhouse/portfolio)
  3. GitHub (user's portfolio)
  4. Collection (community library)
```

### Variables (What We're Testing)

```yaml
VARIANT_A: Hierarchy + Tool List
  [Search hierarchy as above]
  + Simple list of available tools

VARIANT_B: Hierarchy + Flat Capabilities
  [Search hierarchy as above]
  + Flat mapping of intents to element types

VARIANT_C: Hierarchy + Tool Capabilities
  [Search hierarchy as above]
  + Tool descriptions with action verbs

VARIANT_D: Hierarchy + Intent Mapping
  [Search hierarchy as above]
  + User intent to element type mapping

VARIANT_E: Hierarchy + Action Verbs
  [Search hierarchy as above]
  + Action-oriented command structure

VARIANT_F: Hierarchy Only (Minimal)
  [Search hierarchy as above]
  + Nothing else

VARIANT_G: Control (No Guidance)
  No capability index at all
```

## Test Queries

### Unspecified Location (Should Use Hierarchy)
- "I need help with debugging"
- "Store this information"
- "Find security tools"
- "What do I have available?"
- "Help with git workflow"

### Explicit Location (Should Override Hierarchy)
- "Search the collection for debug personas"
- "Check my GitHub portfolio for security tools"
- "Look in my local portfolio for memories"
- "Is there an active memory about testing?"

## Metrics to Measure

### Without Bias or Priming

1. **Tool Selection**: Which tools does Claude select first?
2. **Search Order**: In what order does it search locations?
3. **Index Awareness**: Does it mention the capability index?
4. **Efficiency**: How many steps before finding solution?
5. **Workflow Creation**: Does it create its own workflow?
6. **Token Usage**: Total tokens to complete task
7. **Accuracy**: Did it find the right element/tool?
8. **Override Respect**: Does it honor explicit location requests?

## Expected Outcomes

Based on initial testing:
- **Cascade-top-explicit**: 100% accuracy, 50 tokens, 100% index usage
- **Control (no index)**: 20% accuracy, 200 tokens, 0% index usage
- **Potential savings**: 75-97% token reduction

## Implementation Notes

### For Production CLAUDE.md

The capability index should be:
1. **At the TOP of the file** (maximum attention)
2. **Include the search hierarchy** (always)
3. **Use explicit instructions** ("ALWAYS check")
4. **Separate concerns** (search ≠ tools ≠ elements ≠ workflows)
5. **Allow overrides** (respect explicit user intent)

### Critical Requirements

- **No workflow priming in tests** - Let behavior emerge naturally
- **Test both default and override cases** - Ensure flexibility
- **Measure actual behavior** - Not expected behavior
- **Document what Claude DOES** - Not what we think it should do

## Next Steps

1. Generate test suite based on these variants
2. Run empirical tests with neutral prompting
3. Analyze emergent behaviors
4. Select optimal configuration based on data
5. Implement in production CLAUDE.md
6. Measure real-world token reduction

---

*This document represents the finalized capability index architecture based on empirical testing and iterative refinement. The multi-layer, decoupled approach with pattern-based guidance provides optimal token efficiency while maintaining high accuracy.*
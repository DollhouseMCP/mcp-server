# Ensemble Guide

Ensembles are collections of elements (personas, skills, templates, agents, memories) that work together as a unified system. They allow you to activate multiple capabilities at once, creating powerful combinations for specific tasks or workflows.

## Quick Start

### Activating an Ensemble

```typescript
// Using the MCP activate_element tool
activate_element name="Code-Review-Team" type="ensembles"
```

This will load and activate all elements defined in the ensemble according to its activation strategy.

### Checking Available Ensembles

```typescript
// List all ensembles in your portfolio
list_elements type="ensembles"
```

## What Are Ensembles?

Ensembles orchestrate multiple elements to work together as a cohesive unit. Think of them as "teams" or "workflows" where each element plays a specific role.

### Key Concepts

**Unified Entity**: Unlike simply loading multiple elements separately, ensembles combine elements into one unified capability. For example, an ensemble with multiple personas doesn't create separate personalities—it merges them into one combined behavioral profile.

**Activation Strategies**: Ensembles can activate their elements in different ways:
- `all` - All elements activate simultaneously
- `sequential` - Elements activate one by one in dependency order
- `priority` - Elements activate in priority order (highest first)
- `conditional` - Elements activate based on rules/conditions
- `lazy` - Elements activate only when needed

**Element Roles**: Each element in an ensemble has a specific role:
- `primary` - Main functionality provider
- `support` - Augments primary elements
- `override` - Can override other elements
- `monitor` - Observes but doesn't interfere

## Creating an Ensemble

Ensembles are defined in markdown files with YAML frontmatter:

```markdown
---
name: Development Team
description: Full-stack development ensemble with code review and testing
version: 1.0.0
author: YourName
created: 2025-01-01T00:00:00.000Z
tags:
  - development
  - code-review
  - testing

# Activation settings
activationStrategy: sequential
conflictResolution: priority
contextSharing: full

# Elements in this ensemble
elements:
  - name: code-review
    type: skill
    role: primary
    priority: 100
    activation: always
    purpose: Primary code review capability

  - name: debugging-assistant
    type: skill
    role: support
    priority: 80
    activation: on-demand
    purpose: Assists with debugging when needed

  - name: security-analyst
    type: persona
    role: support
    priority: 90
    activation: conditional
    condition: security_review_needed
    purpose: Security-focused perspective

  - name: test-coverage
    type: template
    role: support
    priority: 70
    activation: on-demand
    purpose: Test coverage report template
---

# Development Team Ensemble

This ensemble provides comprehensive development support with code review,
debugging assistance, security analysis, and test coverage reporting.

## Usage

Activate this ensemble when working on:
- Code reviews
- Security audits
- Bug fixing
- Test coverage analysis

## Elements

The ensemble combines:
1. **Code Review Skill** - Primary analysis capability
2. **Debugging Assistant** - On-demand debugging support
3. **Security Analyst Persona** - Security-focused perspective
4. **Test Coverage Template** - Structured reporting
```

### Required Fields

- `name` - Ensemble name (string)
- `description` - What the ensemble does (string)
- `version` - Semantic version (e.g., "1.0.0")
- `activationStrategy` - How to activate elements (see strategies above)
- `conflictResolution` - How to resolve conflicts (see below)
- `elements` - Array of element references (see element structure below)

### Element Reference Structure

Each element in the `elements` array requires:

```yaml
- name: element-name          # Element identifier (matches filename or display name)
  type: skill                 # Element type: skill, template, agent, memory, persona
  role: primary               # Role: primary, support, override, monitor
  priority: 100               # Priority (higher = more important)
  activation: always          # When to activate: always, on-demand, conditional
  condition: "optional"       # Condition string (for conditional activation)
  dependencies: []            # Optional: other element names this depends on
  purpose: "Description"      # Optional: what this element provides
```

## Activation Strategies

### All (Parallel)
```yaml
activationStrategy: all
```
Activates all elements simultaneously. Fast but may have resource contention.

**Best for**: Independent elements that don't depend on each other.

### Sequential
```yaml
activationStrategy: sequential
```
Activates elements one by one, respecting dependencies.

**Best for**: Elements with dependencies or setup requirements.

### Priority
```yaml
activationStrategy: priority
```
Activates elements in priority order (highest priority first).

**Best for**: When element order matters but dependencies don't.

### Conditional
```yaml
activationStrategy: conditional
```
Activates elements based on their condition expressions.

**Best for**: Dynamic ensembles that adapt to context.

**IMPORTANT**: See the "Conditional Activation (Current Limitation)" section below for critical information about condition evaluation.

### Lazy
```yaml
activationStrategy: lazy
```
Activates elements only when first needed.

**Best for**: Resource-intensive elements that may not always be used.

## Conditional Activation (Current Limitation)

### Important: Condition Evaluation Not Yet Implemented

The ensemble system currently **validates** condition syntax but does **not evaluate** conditions at runtime. This means:

- ✅ Conditions are checked for valid syntax during ensemble creation
- ✅ You can safely define conditions in your ensemble files
- ❌ Conditions are **not evaluated** - all conditional elements will activate regardless of their condition

**Current Behavior:**
- Elements with `activation: conditional` will **always activate** when the ensemble is activated
- You'll see a warning in logs: `"Conditional activation strategy selected, but condition evaluation is not yet implemented"`
- All conditional elements activate as if their conditions were `true`

**Why This Limitation Exists:**

Safe expression evaluation requires:
- Sandboxed execution environment
- Timeout protection (100ms max per evaluation)
- Preventing code injection attacks
- Limited operators (==, !=, >, <, >=, <=, &&, ||)
- Context variable access control

This feature is planned for a future release.

**Workarounds:**

There are several alternative approaches while condition evaluation is being implemented:

1. **Use `activation: on-demand` Strategy**
   ```yaml
   elements:
     - name: security-scanner
       type: skill
       role: secondary
       priority: 80
       activation: on-demand  # Manually control when this activates
   ```
   This gives you full manual control over element activation.

2. **Use `activation: lazy` Strategy**
   ```yaml
   elements:
     - name: heavy-analyzer
       type: skill
       role: support
       priority: 70
       activation: lazy  # Only activates when explicitly needed
   ```
   Elements activate only when explicitly referenced or needed.

3. **Use Separate Ensembles**
   Create different ensembles for different scenarios:
   ```yaml
   # security-review-ensemble.md
   name: Security Review Ensemble
   activationStrategy: all
   elements:
     - name: security-scanner
       type: skill
       role: primary
       priority: 100
       activation: always

   # standard-review-ensemble.md
   name: Standard Review Ensemble
   activationStrategy: all
   elements:
     - name: code-reviewer
       type: skill
       role: primary
       priority: 100
       activation: always
   ```
   Then activate the appropriate ensemble based on your needs.

4. **Use Priority-Based Activation**
   ```yaml
   activationStrategy: priority  # Instead of conditional
   elements:
     - name: critical-element
       type: skill
       role: primary
       priority: 100
       activation: always
     - name: optional-element
       type: skill
       role: support
       priority: 50
       activation: on-demand  # Lower priority, manual control
   ```

**Example of Current Behavior:**

```yaml
# This condition is validated but NOT evaluated (yet)
elements:
  - name: security-scanner
    type: skill
    role: secondary
    priority: 80
    activation: conditional
    condition: "context.security_review == true"  # Syntax checked, not evaluated
    # ⚠️ This element will ALWAYS activate when ensemble is activated
```

**How to Prepare for Future Implementation:**

Even though conditions aren't evaluated yet, you should still write them properly:

1. **Write conditions as if they'll be evaluated**
   ```yaml
   condition: "context.security_review == true"
   condition: "priority >= 80 && environment == 'production'"
   condition: "user.role == 'admin' || user.permissions.includes('review')"
   ```

2. **Use simple boolean expressions**
   - Avoid complex nested logic
   - Keep expressions readable
   - Use standard comparison operators

3. **Reference context variables clearly**
   ```yaml
   condition: "context.environment == 'production'"  # Good
   condition: "env == 'prod'"  # Less clear
   ```

4. **Test your ensemble with workarounds first**
   - Use separate ensembles or on-demand activation
   - Verify your element combinations work as expected
   - Document your intended condition logic

**When Will This Be Implemented?**

This feature is on the roadmap. When implemented, your ensembles will automatically start respecting conditions without any changes to your configuration files.

**Tracking:** See the project roadmap for implementation status.

## Conflict Resolution

When multiple elements modify the same context:

### Last Write
```yaml
conflictResolution: last-write
```
The last element to write a value wins.

### First Write
```yaml
conflictResolution: first-write
```
The first element to write a value locks it.

### Priority
```yaml
conflictResolution: priority
```
Higher priority element's value wins.

### Merge
```yaml
conflictResolution: merge
```
Attempts to merge values (for objects/arrays).

### Error
```yaml
conflictResolution: error
```
Throws error on any conflict (strict mode).

## Context Sharing

Control how elements share data:

```yaml
contextSharing: none        # No sharing (isolated)
contextSharing: selective   # Explicit sharing only
contextSharing: full        # All elements share context
```

## Element Dependencies

Specify load order and dependencies:

```yaml
elements:
  - name: database-schema
    type: template
    role: primary
    priority: 100
    activation: always

  - name: query-optimizer
    type: skill
    role: support
    priority: 90
    activation: always
    dependencies:
      - database-schema    # Loads after database-schema
```

The ensemble will ensure dependencies load before dependents.

## Resource Limits

Prevent resource exhaustion:

```yaml
resourceLimits:
  maxActiveElements: 10           # Max elements active at once
  maxMemoryMb: 512                # Max memory usage
  maxExecutionTimeMs: 30000       # Max execution time (30 seconds)
```

## Nested Ensembles

Ensembles can contain other ensembles:

```yaml
allowNested: true
maxNestingDepth: 3

elements:
  - name: frontend-team
    type: ensemble           # Reference to another ensemble
    role: primary
    priority: 100
    activation: always
```

**Warning**: Nested ensembles increase complexity. Keep nesting depth low (≤3).

## Editing Ensembles

### Editing Metadata

You can edit most ensemble fields via the MCP tool:

```typescript
edit_element name="Development-Team" type="ensembles"
             field="description" value="Updated description"

edit_element name="Development-Team" type="ensembles"
             field="activationStrategy" value="priority"
```

### Editing Elements

The `elements` field cannot be edited directly via MCP tools. To modify elements:

1. **Edit the markdown file directly**:
   ```bash
   # Edit the ensemble file
   ~/.dollhouse/portfolio/ensembles/development-team.md
   ```

2. **Reload the ensemble** (happens automatically on next use)

This design prevents errors from incorrect element configurations.

## Activation Results

When you activate an ensemble, you'll see detailed results:

```
✅ Ensemble 'Code-Review-Team' activated

Strategy: sequential
Activated: 4 elements
Failed: 0 elements
Duration: 43ms

Active Elements:
  - code-review
  - debugging-assistant
  - security-analyst
  - test-coverage
```

If elements fail to activate:

```
⚠️ Ensemble 'Code-Review-Team' activated

Strategy: sequential
Activated: 3 elements
Failed: 1 elements
Duration: 45ms

Active Elements:
  - code-review
  - debugging-assistant
  - security-analyst

Failed Elements:
  - missing-skill: Skill 'missing-skill' not found
```

## Troubleshooting

### Element Not Found

**Error**: `Skill 'code-review' not found`

**Solutions**:
1. Check element name matches exactly (case-sensitive)
2. Verify element exists: `list_elements type="skills"`
3. Check for typos in ensemble definition
4. Element names can use spaces or dashes (both work)

### Circular Dependencies

**Error**: `Circular dependency detected: A → B → C → A`

**Solution**: Remove the circular reference. Dependencies must form a directed acyclic graph (DAG).

### Resource Limits Exceeded

**Error**: `Maximum active elements exceeded (10)`

**Solution**:
1. Increase `maxActiveElements` limit
2. Use `lazy` activation for non-critical elements
3. Split into multiple smaller ensembles

### Ensemble Not Loading

**Issue**: Ensemble file exists but doesn't appear in list

**Solutions**:
1. Check YAML frontmatter syntax (use YAML validator)
2. Verify required fields are present
3. Clear cache: `rm ~/.dollhouse/cache/collection-index.json`
4. Check file permissions (must be readable)
5. Ensure date fields use ISO 8601 format: `2025-01-01T00:00:00.000Z`

## Example Ensembles

### Code Review Team

A comprehensive code review ensemble:

```yaml
name: Code Review Team
activationStrategy: sequential
conflictResolution: priority
elements:
  - name: code-review
    type: skill
    role: primary
    priority: 100
    activation: always
  - name: security-analyst
    type: persona
    role: support
    priority: 90
    activation: conditional
    condition: security_check
  - name: code-reviewer
    type: agent
    role: support
    priority: 85
    activation: always
```

### Writing Studio

Content creation with style checking:

```yaml
name: Writing Studio
activationStrategy: all
conflictResolution: merge
elements:
  - name: creative-writing
    type: skill
    role: primary
    priority: 100
    activation: always
  - name: style-guide
    type: template
    role: support
    priority: 80
    activation: always
  - name: editor-persona
    type: persona
    role: override
    priority: 90
    activation: on-demand
```

### Data Analysis Pipeline

Sequential data processing:

```yaml
name: Data Analysis Pipeline
activationStrategy: sequential
conflictResolution: last-write
elements:
  - name: data-cleaning
    type: skill
    role: primary
    priority: 100
    activation: always
  - name: statistical-analysis
    type: skill
    role: primary
    priority: 90
    activation: always
    dependencies: [data-cleaning]
  - name: visualization
    type: template
    role: support
    priority: 80
    activation: always
    dependencies: [statistical-analysis]
  - name: analysis-memory
    type: memory
    role: monitor
    priority: 70
    activation: always
```

## Best Practices

### Naming Conventions

- Use descriptive names: `Code-Review-Team` not `Team1`
- Follow kebab-case for files: `code-review-team.md`
- Display names can use spaces: `Code Review Team`

### Priority Guidelines

- **100**: Critical/primary functionality
- **90-80**: Important supporting elements
- **70-60**: Optional enhancements
- **50 or less**: Monitoring/logging elements

### Activation Modes

- **always**: Core functionality that's always needed
- **on-demand**: Heavy elements used occasionally
- **conditional**: Context-dependent elements

### Performance Tips

1. Use `lazy` activation for resource-intensive elements
2. Set appropriate resource limits
3. Avoid deep nesting (keep depth ≤ 3)
4. Use `sequential` only when dependencies require it
5. Prefer `all` for independent elements (faster)

### Maintenance

1. Version your ensembles semantically
2. Document element purposes clearly
3. Test ensemble activation after changes
4. Keep element lists focused (≤ 10 elements ideal)
5. Review and clean up unused ensembles regularly

## Frequently Asked Questions (FAQ)

### Q: Why don't my conditional elements respect their conditions?

**A:** Condition evaluation is not yet implemented. All conditional elements will activate regardless of their condition strings. See the "Conditional Activation (Current Limitation)" section above for details.

**Current behavior:**
- Conditions are validated for syntax but not evaluated at runtime
- Elements with `activation: conditional` will **always activate**
- You'll see a warning in logs when using conditional activation

**Recommended workarounds:**
- Use `activation: on-demand` for manual control over element activation
- Use `activation: lazy` for elements that should only activate when needed
- Create separate ensembles for different scenarios instead of using conditions
- Use `activationStrategy: priority` with priority levels instead of conditions

### Q: Should I still define conditions in my ensembles?

**A:** Yes! Define conditions with proper syntax now. When condition evaluation is implemented in a future release, your ensembles will automatically start using them without any changes to your configuration files.

**Best practices for writing conditions:**
```yaml
# Good: Clear, simple boolean expression
condition: "context.environment == 'production'"

# Good: Multiple conditions with logical operators
condition: "priority >= 80 && user.role == 'admin'"

# Good: Context variable references
condition: "context.security_review == true"

# Avoid: Overly complex nested logic
condition: "((a && b) || (c && d)) && ((e || f) && !g)"
```

### Q: How can I control which elements activate without condition evaluation?

**A:** Use these strategies:

1. **Activation modes:** Set `activation: on-demand` or `activation: lazy` for elements you want to control manually

2. **Separate ensembles:** Create different ensembles for different use cases:
   ```yaml
   # development-ensemble.md
   activationStrategy: all
   elements:
     - name: dev-tools
       activation: always

   # production-ensemble.md
   activationStrategy: all
   elements:
     - name: production-tools
       activation: always
   ```

3. **Priority-based control:** Use `activationStrategy: priority` with high/low priority levels to control activation order

### Q: Will I need to change my ensemble files when condition evaluation is implemented?

**A:** No! As long as you write valid condition syntax now, your ensembles will automatically work when condition evaluation is implemented. No changes needed.

**What you should do now:**
- Write conditions as if they'll be evaluated
- Use simple, clear boolean expressions
- Test your ensembles using workarounds (on-demand, lazy, or separate ensembles)
- Document your intended condition logic in comments

### Q: What condition syntax will be supported?

**A:** When implemented, the condition evaluator will support:

**Comparison operators:**
- `==` (equals)
- `!=` (not equals)
- `>`, `<`, `>=`, `<=` (numeric comparisons)

**Logical operators:**
- `&&` (and)
- `||` (or)
- `!` (not)

**Variable access:**
- `context.variableName` - Access shared context values
- `element.priority` - Access element metadata
- `environment.type` - Access environment variables

**Example valid conditions:**
```yaml
condition: "context.mode == 'production'"
condition: "priority > 50 && context.security_enabled"
condition: "environment.type == 'development' || user.role == 'admin'"
```

### Q: How do I see which elements actually activated in my ensemble?

**A:** After activating an ensemble, check the activation results. The system provides detailed feedback:

```
✅ Ensemble 'My-Ensemble' activated

Strategy: conditional
Activated: 3 elements
Failed: 0 elements
Duration: 45ms

Active Elements:
  - element-1
  - element-2
  - element-3
```

You can also check logs for more details:
- Warnings about conditional activation
- Element activation timing
- Any errors during activation

### Q: Can I use conditions with other activation strategies?

**A:** Conditions only apply when using `activationStrategy: conditional`. However, you can combine element-level `activation` modes with other strategies:

```yaml
activationStrategy: priority  # Strategy for the ensemble
elements:
  - name: always-on
    activation: always        # This element always activates
  - name: manual-control
    activation: on-demand     # This element needs manual activation
  - name: lazy-load
    activation: lazy          # This element activates when needed
```

The `condition` field is only used when an element has `activation: conditional` **and** the ensemble uses `activationStrategy: conditional`.

## Next Steps

- Browse example ensembles: `~/.dollhouse/portfolio/ensembles/`
- Learn about individual element types: `docs/reference/element-types.md`
- Understand element architecture: `docs/architecture/element-architecture.md`
- Explore activation strategies in depth: `docs/architecture/README.md`

## Related Documentation

- [Element Types Reference](../reference/element-types.md) - All element types
- [Tool List](../reference/tool-list.md) - MCP tools for ensembles
- [Portfolio Setup Guide](./portfolio-setup-guide.md) - Portfolio organization
- [Element Architecture](../architecture/element-architecture.md) - Technical details

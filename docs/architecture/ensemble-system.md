# Ensemble System Architecture

**Last Updated:** February 2, 2026
**Version:** 2.0.0-beta.2

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [Architecture](#architecture)
4. [Activation Strategies](#activation-strategies)
5. [Conflict Resolution](#conflict-resolution)
6. [Context Sharing](#context-sharing)
7. [Element Roles](#element-roles)
8. [Lifecycle Management](#lifecycle-management)
9. [Security & Validation](#security--validation)
10. [Performance Considerations](#performance-considerations)
11. [Best Practices](#best-practices)

---

## Overview

### What are Ensembles?

Ensembles are **coordinated groups of elements** (personas, skills, templates, agents, memories) that work together to provide complex, multi-faceted AI capabilities. An ensemble activates multiple elements as a unit, managing their interaction, activation order, and conflict resolution.

### Why Use Ensembles?

| Without Ensembles | With Ensembles |
|-------------------|----------------|
| Activate 5 elements manually | Activate 1 ensemble |
| No coordination between elements | Orchestrated activation with dependencies |
| Unclear activation order | Explicit priority or sequential ordering |
| Manual conflict resolution | Automatic conflict strategies |
| No shared context | Optional context sharing between elements |

### Key Benefits

- **One-Command Activation**: Activate complex multi-element workflows with a single command
- **Coordination**: Elements activate in the correct order with dependency management
- **Reusability**: Package common element combinations for repeated use
- **Conflict Management**: Built-in strategies for handling element conflicts
- **Resource Control**: Set limits on memory, execution time, and active elements
- **Context Sharing**: Share state and context between elements when needed

---

## Core Concepts

### Element Types

Ensembles can include any element type:

- **Personas**: AI behavioral profiles defining communication style
- **Skills**: Discrete capabilities (e.g., code review, data analysis)
- **Templates**: Reusable content structures
- **Agents**: Autonomous task actors
- **Memories**: Persistent context storage

### Ensemble Structure

```yaml
---
name: My Ensemble
description: What this ensemble does
version: 1.0.0

# Activation configuration
activationStrategy: priority  # How elements activate
conflictResolution: priority  # How conflicts are resolved
contextSharing: selective     # How context is shared

# Elements in the ensemble
elements:
  - name: element-1
    type: persona
    role: primary
    priority: 100
    activation: always

  - name: element-2
    type: skill
    role: support
    priority: 80
    activation: conditional
    condition: "task.type == 'code-review'"
    dependencies: [element-1]
---

# Ensemble content (markdown documentation)
```

### Metadata Fields

| Field | Required | Description | Default |
|-------|----------|-------------|---------|
| `name` | Yes | Ensemble name (unique identifier) | - |
| `description` | Yes | What the ensemble does | - |
| `version` | No | Semantic version (e.g., "1.0.0") | "1.0.0" |
| `author` | No | Ensemble creator | System user |
| `activationStrategy` | No | How elements activate (`all`, `sequential`, `lazy`, `conditional`, `priority`) | "sequential" |
| `conflictResolution` | No | How conflicts are handled (`last-write`, `first-write`, `priority`, `merge`, `error`) | "last-write" |
| `contextSharing` | No | Context sharing mode (`none`, `selective`, `full`) | "selective" |
| `elements` | Yes | Array of elements | - |
| `allowNested` | No | Allow nested ensembles | true |
| `maxNestingDepth` | No | Maximum nesting depth | 3 |
| `resourceLimits` | No | Resource constraints | See limits |

---

## Architecture

### Component Hierarchy

```
┌─────────────────────────────────────────────────┐
│         DollhouseMCPServer (index.ts)           │
│         Handles MCP tool requests               │
└────────────────┬────────────────────────────────┘
                 │
         ┌───────▼────────────┐
         │  ElementCRUDHandler │
         │  Routes ensemble    │
         │  operations         │
         └───────┬────────────┘
                 │
         ┌───────▼──────────────┐
         │   EnsembleManager    │
         │   Extends            │
         │   BaseElementManager │
         └───────┬──────────────┘
                 │
    ┌────────────┴───────────┐
    │                        │
┌───▼────────┐      ┌────────▼────────┐
│  Ensemble  │      │ ActivationEngine │
│  (Model)   │      │ Coordinates      │
│  Metadata  │      │ activation logic │
│  Elements  │      └──────────────────┘
└────────────┘
```

### Key Classes

#### `EnsembleManager` (`src/elements/ensembles/EnsembleManager.ts`)

Extends `BaseElementManager` to provide ensemble-specific operations:

- **YAML Parsing**: Parses ensemble metadata with snake_case/camelCase support
- **Validation**: Validates ensemble structure, element references, dependencies
- **CRUD Operations**: Create, read, update, delete ensembles
- **Element Reference Management**: Validates that referenced elements exist
- **Import/Export**: Supports multiple formats (YAML, JSON)

**Key Methods:**
- `parseMetadata(data)`: Converts YAML to `EnsembleMetadata`
- `createElement(metadata, content)`: Instantiates `Ensemble` object
- `validateElement(ensemble)`: Validates ensemble structure and references

#### `Ensemble` (`src/elements/ensembles/Ensemble.ts`)

Data model representing an ensemble:

```typescript
interface EnsembleMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  activationStrategy: ActivationStrategy;  // 'all', 'priority', 'sequential', 'conditional'
  conflictResolution: ConflictResolutionStrategy;  // 'priority', 'last-write', 'merge', 'fail'
  contextSharing: 'none' | 'selective' | 'full';
  elements: EnsembleElement[];
  allowNested?: boolean;
  maxNestingDepth?: number;
  resourceLimits?: ResourceLimits;
}

interface EnsembleElement {
  name: string;
  type: string;  // 'persona', 'skill', 'template', 'agent', 'memory'
  role: ElementRole;  // 'primary', 'support', 'optional'
  priority: number;  // 0-100 (higher = more important)
  activation: ActivationMode;  // 'always', 'conditional', 'manual'
  condition?: string;  // For conditional activation
  dependencies?: string[];  // Element names this depends on
  purpose?: string;  // Human-readable explanation
}
```

#### `ActivationEngine` (Conceptual)

Coordinates element activation based on ensemble configuration:

1. Parse activation strategy
2. Determine activation order (priority, dependencies, sequential)
3. Evaluate conditions for conditional elements
4. Activate elements in computed order
5. Apply conflict resolution if needed
6. Share context based on `contextSharing` mode

---

## Activation Strategies

### Overview

The `activationStrategy` field determines **how and when** ensemble elements activate.

### Strategy: `all` (Parallel Activation)

**Behavior:** All elements activate simultaneously in parallel.

**Use When:**
- Elements are independent (no dependencies)
- Order doesn't matter
- Fast activation is priority

**Example:**
```yaml
activationStrategy: all

elements:
  - name: friendly-assistant
    type: persona
    activation: always

  - name: code-documentation
    type: skill
    activation: always
```

**Activation Flow:**
```
Start → [friendly-assistant] + [code-documentation] → End
        (activate simultaneously)
```

---

### Strategy: `priority` (Priority-Based)

**Behavior:** Elements activate in order of priority (highest first). Elements with same priority may activate in parallel.

**Use When:**
- Some elements are more important than others
- Primary persona should load before support skills
- Conflict resolution based on importance

**Example:**
```yaml
activationStrategy: priority
conflictResolution: priority

elements:
  - name: technical-writer    # Activates first
    type: persona
    priority: 100

  - name: code-reviewer        # Activates second
    type: skill
    priority: 80

  - name: spell-checker        # Activates third
    type: skill
    priority: 60
```

**Activation Flow:**
```
Start → [technical-writer (100)]
        ↓
        [code-reviewer (80)]
        ↓
        [spell-checker (60)]
        ↓
        End
```

---

### Strategy: `sequential` (Sequential Activation)

**Behavior:** Elements activate one at a time in array order, waiting for each to complete before activating the next.

**Use When:**
- Strict ordering required
- Later elements depend on earlier ones
- State must be built up sequentially

**Example:**
```yaml
activationStrategy: sequential

elements:
  - name: data-loader         # Step 1
    type: skill

  - name: data-validator      # Step 2 (after loader)
    type: skill

  - name: data-transformer    # Step 3 (after validator)
    type: skill

  - name: data-exporter       # Step 4 (after transformer)
    type: skill
```

**Activation Flow:**
```
Start → [data-loader]
        ↓ (wait for completion)
        [data-validator]
        ↓ (wait for completion)
        [data-transformer]
        ↓ (wait for completion)
        [data-exporter]
        ↓
        End
```

---

### Strategy: `conditional` (Conditional Activation)

**Behavior:** Each element evaluates its `condition` field. Only elements with truthy conditions activate.

**Use When:**
- Elements should activate based on context
- Different workflows for different scenarios
- Dynamic behavior based on task type

**Example:**
```yaml
activationStrategy: conditional

elements:
  - name: frontend-expert
    type: persona
    activation: conditional
    condition: "task.type == 'frontend'"

  - name: backend-expert
    type: persona
    activation: conditional
    condition: "task.type == 'backend'"

  - name: security-scanner
    type: skill
    activation: conditional
    condition: "task.requiresSecurity == true"
```

**Activation Flow:**
```
Start → Evaluate conditions
        ↓
        If task.type == 'frontend':
          Activate [frontend-expert]
        If task.type == 'backend':
          Activate [backend-expert]
        If task.requiresSecurity:
          Activate [security-scanner]
        ↓
        End
```

---

## Conflict Resolution

### Overview

When multiple elements define conflicting values (e.g., two personas define different communication styles), the `conflictResolution` strategy determines which value wins.

### Strategy: `priority`

**Behavior:** Higher priority element's value wins.

**Use When:**
- Clear hierarchy of importance
- Primary persona should override support elements
- Predictable conflict resolution

**Example:**
```yaml
conflictResolution: priority

elements:
  - name: formal-writer        # Priority 100 - WINS conflicts
    type: persona
    priority: 100
    # tone: formal

  - name: casual-helper        # Priority 50 - LOSES conflicts
    type: persona
    priority: 50
    # tone: casual
```

**Result:** Formal tone used (priority 100 > 50)

---

### Strategy: `last-write`

**Behavior:** Last activated element's value wins.

**Use When:**
- Simple override semantics
- Order of activation determines precedence
- Useful with sequential strategy

**Example:**
```yaml
activationStrategy: sequential
conflictResolution: last-write

elements:
  - name: default-config       # Activates first
    type: template

  - name: user-overrides       # Activates last - WINS
    type: template
```

**Result:** `user-overrides` values win (activated last)

---

### Strategy: `merge`

**Behavior:** Attempt to merge conflicting values (strategy-dependent).

**Use When:**
- Values can be combined
- Want to preserve information from multiple elements
- Complex merging logic acceptable

**Merge Strategies:**
- **Arrays**: Concatenate unique values
- **Objects**: Deep merge properties
- **Primitives**: Apply fallback strategy (priority or last-write)

**Example:**
```yaml
conflictResolution: merge

elements:
  - name: skill-a
    # tags: [javascript, testing]

  - name: skill-b
    # tags: [testing, documentation]
```

**Result:** `tags: [javascript, testing, documentation]` (merged)

---

### Strategy: `fail`

**Behavior:** Throw error if conflicts detected.

**Use When:**
- Conflicts indicate misconfiguration
- Strict validation required
- Fail-fast behavior desired

**Example:**
```yaml
conflictResolution: fail

elements:
  - name: element-a
    # theme: dark

  - name: element-b
    # theme: light    # ERROR! Conflict detected
```

**Result:** Activation fails with error message identifying conflict

---

## Context Sharing

### Overview

The `contextSharing` mode controls whether elements can share state and context with each other.

### Mode: `none`

**Behavior:** Elements have isolated state. No sharing.

**Use When:**
- Elements are completely independent
- No coordination needed
- Maximum isolation for security

**Example:**
```yaml
contextSharing: none

elements:
  - name: grammar-checker
    # Cannot access code-reviewer's state

  - name: code-reviewer
    # Cannot access grammar-checker's state
```

---

### Mode: `selective`

**Behavior:** Elements explicitly declare what they share and what they consume.

**Use When:**
- Some coordination needed
- Explicit sharing for clarity
- Fine-grained control

**Example:**
```yaml
contextSharing: selective

elements:
  - name: data-loader
    # Provides: dataset

  - name: data-analyzer
    # Consumes: dataset
```

---

### Mode: `full`

**Behavior:** All elements share a common context object. All can read/write.

**Use When:**
- Tight coordination required
- Elements designed to work together
- Shared state is essential

**Example:**
```yaml
contextSharing: full

elements:
  - name: session-manager
    # Writes to shared context

  - name: request-handler
    # Reads from shared context

  - name: response-formatter
    # Reads from shared context
```

---

## Element Roles

### Overview

The `role` field categorizes an element's purpose within the ensemble. There are four valid roles: `primary`, `support`, `override`, and `monitor`.

> **Current limitation:** Roles are semantic labels used for documentation and organizational purposes. They are validated on creation (invalid roles are rejected) but do not influence runtime behavior. All elements activate and participate identically regardless of role. Functional role-based behavior (e.g., failing the ensemble when a `primary` element fails) is planned but not yet implemented.

### Role: `primary`

**Purpose:** Identifies the element as core functionality for the ensemble. Use this for elements that the ensemble fundamentally depends on.

**Example:**
```yaml
- name: technical-expert
  type: persona
  role: primary  # Core element this ensemble is built around
```

---

### Role: `support`

**Purpose:** Enhances or augments the primary elements. Use this for elements that add value but are not essential to the ensemble's core function.

**Example:**
```yaml
- name: spell-checker
  type: skill
  role: support  # Enhances output quality, not critical
```

---

### Role: `override`

**Purpose:** Indicates the element can take precedence over other elements when active. Use this for elements that provide specialized behavior intended to supersede default behavior.

**Example:**
```yaml
- name: strict-formatter
  type: skill
  role: override  # Supersedes default formatting behavior
```

---

### Role: `monitor`

**Purpose:** Observes ensemble activity without directly contributing to output. Use this for elements that perform logging, auditing, or quality checks.

**Example:**
```yaml
- name: quality-auditor
  type: skill
  role: monitor  # Observes without interfering
```

---

## Lifecycle Management

### Activation Flow

```
1. User calls: activate_element name="my-ensemble" type="ensembles"
   ↓
2. EnsembleManager loads ensemble file
   ↓
3. Parse metadata and validate structure
   ↓
4. Validate all referenced elements exist
   ↓
5. Check for circular dependencies
   ↓
6. Determine activation order (based on strategy)
   ↓
7. For each element:
   - Check activation mode (always/conditional/on-demand)
   - Evaluate condition if conditional
   - Check dependencies satisfied
   - Activate element via appropriate manager
   ↓
8. Apply conflict resolution if conflicts detected
   ↓
9. Setup context sharing if enabled
   ↓
10. Mark ensemble as active
```

### Deactivation Flow

```
1. User calls: deactivate_element name="my-ensemble" type="ensembles"
   ↓
2. Retrieve active ensemble instance
   ↓
3. Determine deactivation order (reverse of activation)
   ↓
4. For each element (in reverse order):
   - Call element's deactivation method
   - Cleanup shared context
   - Release resources
   ↓
5. Mark ensemble as inactive
   ↓
6. Cleanup ensemble-level resources
```

### Nesting Support

Ensembles can contain other ensembles (configurable):

```yaml
allowNested: true
maxNestingDepth: 3

elements:
  - name: code-review-ensemble  # Nested ensemble
    type: ensemble
    role: support
```

**Nesting Rules:**
- Maximum depth: `maxNestingDepth` (default: 3)
- Circular references detected and blocked
- Nested ensembles activate with parent's strategy
- Resource limits stack (child can't exceed parent)

---

## Security & Validation

### Input Validation

All ensemble metadata is validated and sanitized:

- **Name**: Alphanumeric, hyphens, max 100 chars
- **Description**: Max 500 chars, HTML stripped
- **Element Names**: Sanitized, Unicode normalized
- **Conditions**: Max 500 chars, injection-safe
- **Dependencies**: Max 10 per element

### Security Features

1. **Path Validation**: Prevents directory traversal
2. **YAML Bomb Prevention**: Uses `SecureYamlParser`
3. **File Locking**: `FileLockManager` for atomic operations
4. **Unicode Normalization**: Prevents homoglyph attacks
5. **Security Event Logging**: Audit trail for all operations

### Validation Checks

EnsembleManager validates:

- ✅ All required metadata fields present
- ✅ Activation strategy is valid (`all`, `priority`, `sequential`, `conditional`)
- ✅ Conflict resolution is valid (`priority`, `last-write`, `merge`, `fail`)
- ✅ Element count within limits (max 50 elements)
- ✅ All referenced elements exist in portfolio
- ✅ No circular dependencies
- ✅ Priority values in range (0-100)
- ✅ Roles are valid (`primary`, `support`, `optional`)
- ✅ Activation modes are valid (`always`, `conditional`, `manual`)
- ✅ Nesting depth within limits

---

## Performance Considerations

### Resource Limits

Ensembles support resource constraints:

```yaml
resourceLimits:
  maxActiveElements: 10      # Max concurrent active elements
  maxMemoryMb: 512          # Memory limit
  maxExecutionTimeMs: 30000 # Max activation time (30s)
```

### Optimization Tips

1. **Use Priority Strategy for Large Ensembles**: Avoids simultaneous activation of all elements
2. **Leverage Conditional Activation**: Only activate what's needed
3. **Limit Nesting Depth**: Each level adds overhead
4. **Use Context Sharing Wisely**: `full` sharing has more overhead than `none`
5. **Set Resource Limits**: Prevents runaway ensembles

### Caching

- Ensemble metadata cached in memory after first load
- Element references validated once per activation
- Dependency graphs computed once and cached

---

## Best Practices

### Ensemble Design

1. **Start Simple**: Begin with 2-3 elements, expand as needed
2. **Clear Naming**: Use descriptive names that explain purpose
3. **Document Purpose**: Each element should have `purpose` field
4. **Logical Grouping**: Group related elements together
5. **Avoid Deep Nesting**: Keep nesting to 1-2 levels max

### Activation Strategy Selection

| Scenario | Recommended Strategy |
|----------|---------------------|
| Independent elements | `all` |
| Priority-based loading | `priority` |
| Step-by-step workflow | `sequential` |
| Dynamic selection | `conditional` |

### Conflict Resolution Selection

| Scenario | Recommended Strategy |
|----------|---------------------|
| Clear hierarchy | `priority` |
| Override pattern | `last-write` |
| Combine values | `merge` |
| Strict validation | `fail` |

### Context Sharing Selection

| Scenario | Recommended Mode |
|----------|-----------------|
| Isolated elements | `none` |
| Some coordination | `selective` |
| Tight integration | `full` |

### Dependency Management

```yaml
# Good: Clear linear dependencies
elements:
  - name: foundation
    dependencies: []

  - name: middleware
    dependencies: [foundation]

  - name: application
    dependencies: [middleware]
```

```yaml
# Bad: Circular dependencies (will fail validation)
elements:
  - name: element-a
    dependencies: [element-b]

  - name: element-b
    dependencies: [element-a]  # ERROR!
```

### Error Handling

```yaml
# Include fallback elements for critical functions
elements:
  - name: primary-analyzer
    type: skill
    role: primary
    activation: always

  - name: backup-analyzer
    type: skill
    role: support
    activation: conditional
    condition: "primary-analyzer.failed == true"
```

---

## Examples

See the following example ensembles in `docs/examples/`:

1. **Minimal Ensemble** (`minimal-ensemble.md`)
   - 2 elements, `all` strategy
   - Perfect starting point

2. **Writing Studio** (`writing-studio.md`)
   - 4 elements, `priority` strategy
   - Shows priority-based conflict resolution

3. **Data Pipeline** (`data-pipeline.md`)
   - 4 elements, `sequential` strategy
   - Step-by-step data processing

4. **Code Review Team** (`code-review-team.md`)
   - 4 elements, dependencies
   - Complex coordination

5. **Debugging Assistant** (`debugging-assistant.md`)
   - 4 elements, `conditional` strategy
   - Dynamic activation based on context

---

## References

- **Implementation**: `src/elements/ensembles/EnsembleManager.ts`
- **Types**: `src/elements/ensembles/types.ts`
- **Constants**: `src/elements/ensembles/constants.ts`
- **Base Class**: `src/elements/base/BaseElementManager.ts`
- **Examples**: `docs/examples/`
- **User Guide**: `docs/guides/ensembles.md`

---

## Summary

Ensembles provide powerful orchestration of multiple elements, with:

- **5 activation strategies**: `all`, `sequential`, `lazy`, `conditional`, `priority`
- **5 conflict resolution strategies**: `last-write`, `first-write`, `priority`, `merge`, `error`
- **3 context sharing modes**: `none`, `selective`, `full`
- **4 element roles**: `primary`, `support`, `override`, `monitor`
- **3 activation modes**: `always`, `on-demand`, `conditional`

> **Known limitations (as of v2.0.0-beta.2):**
> - Element roles are semantic labels only; they do not affect runtime behavior.
> - Context sharing modes are stored in metadata but not enforced at runtime. All elements can access shared context regardless of the configured mode.
> - Conditional activation mode evaluates all elements when no condition expression is provided. Condition evaluation logic is not yet fully implemented.
>
> See `docs/guides/ensembles.md` for detailed workarounds and usage guidance.

This flexibility allows building everything from simple 2-element combinations to complex 50-element orchestrations with conditional activation, priority-based loading, and sophisticated conflict resolution.

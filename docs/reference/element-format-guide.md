# Element Format Guide

> Canonical reference for DollhouseMCP element file formats, field semantics, and naming conventions.
> For LLM-accessible format specs at runtime, use: `{ operation: "introspect", params: { query: "format" } }`

## Dual-Field Matrix

Every element supports two content fields with distinct semantic roles:

| Field | Purpose | Voice | Primary For |
|-------|---------|-------|-------------|
| `instructions` | Behavioral directives the AI must follow | Command voice ("You ARE...", "ALWAYS...", "NEVER...") | Personas, Skills, Agents |
| `content` | Reference material, knowledge, context | Descriptive/informational | Templates (REQUIRED), Skills, Memories |

### Per-Type Guidance

| Type | `instructions` | `content` |
|------|---------------|-----------|
| **Persona** | Primary field - personality and behavioral rules | Optional background lore/context |
| **Skill** | Behavioral directives when skill is active | Domain knowledge, checklists, reference examples |
| **Template** | Not typically used | **REQUIRED** - the template body with `{{variables}}` |
| **Agent** | Semantic behavioral profile (distinct from `systemPrompt`) | Reference material for execution |
| **Memory** | Not typically used | Initial entry content at creation time |
| **Ensemble** | Not used | Optional coordination description |

**Best practice for Skills:** Use BOTH fields together. `instructions` for what to do, `content` for reference material to consult.

## File Formats

| Type | Extension | Structure |
|------|-----------|-----------|
| Persona | `.md` | YAML frontmatter + markdown body |
| Skill | `.md` | YAML frontmatter + markdown body |
| Template | `.md` | YAML frontmatter + template body |
| Agent | `.md` | YAML frontmatter + markdown body |
| Memory | `.yml` | YAML document with structured entries |
| Ensemble | `.md` | YAML frontmatter + optional markdown body |

## Template Syntax

### Variable Substitution

Templates use simple `{{variable_name}}` substitution. This is NOT Handlebars.

**Supported:**
- `{{variable_name}}` - simple variable replacement

**NOT supported:**
- `{{#if condition}}` - conditionals
- `{{#each items}}` - loops
- `{{> partial}}` - partials
- Any block helpers or expressions

### Section Format (Page Templates)

For templates that include HTML, CSS, and JavaScript, use section format:

```html
<template>
<!DOCTYPE html>
<html>
<head><title>{{title}}</title></head>
<body>{{body}}</body>
</html>
</template>

<style>
body { font-family: sans-serif; }
.card { border: 1px solid #ccc; } /* }} safe here */
</style>

<script>
var state = { status: "all" };
function update() { return { bar: baz }; } // }} safe here
</script>
```

**Key rules:**
- Only `<template>` is variable-processed (`{{vars}}` are substituted)
- `<style>` and `<script>` are raw passthrough - `}}` is safe there
- All three sections are optional - use only what you need
- A style-only or script-only template is valid (no `<template>` needed)

### Variable Declaration

Declare variables in frontmatter for validation and documentation:

```yaml
variables:
  - { name: title, type: string, required: true, description: "Page title" }
  - { name: body, type: string, required: false, description: "Main content" }
```

### Pre-Formatted String Pattern

The template engine has **no loops or conditionals** — only `{{variable_name}}` substitution. When a template needs lists, tables, or conditional content, pass a **pre-formatted markdown string** as the variable value.

**Variable descriptions should specify the expected format:**

```yaml
variables:
  - { name: "risks", type: "string", required: false,
      description: "Pre-formatted table rows: | Risk | Probability | Impact | Mitigation |" }
  - { name: "attendees", type: "string", required: false,
      description: "Pre-formatted bullet list, one attendee per line" }
```

**Example — before (unsupported):**
```
{{#each attendees}}
- {{name}} ({{role}})
{{/each}}
```

**Example — after (correct):**
```
{{attendees}}
```
Where the caller passes a pre-formatted string like:
```
- Alice (Product Manager)
- Bob (Engineer)
- Carol (Designer)
```

All bundled templates follow this pattern. See `data/templates/` for examples.

## Per-Type Frontmatter Fields

### Common Fields (All Types)

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Element name (kebab-case, max 100 chars) |
| `description` | Yes | Brief description of the element |
| `version` | No | Version number (auto-incremented) |
| `tags` | No | Array of string tags for categorization |
| `author` | No | Author username |

### Persona-Specific

No additional frontmatter fields beyond common fields.

### Skill-Specific

| Field | Required | Description |
|-------|----------|-------------|
| `category` | No | Category label (`^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$`) |

### Template-Specific

| Field | Required | Description |
|-------|----------|-------------|
| `category` | No | Category label (`^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$`) |
| `variables` | No | Array of `{ name, type, required, description }` |

### Agent-Specific

| Field | Required | Description |
|-------|----------|-------------|
| `goal` | Recommended | `{ template, parameters, successCriteria }` |
| `activates` | No | `{ personas?, skills?, memories?, templates?, ensembles? }` |
| `tools` | No | `{ allowed: string[], denied?: string[] }` |
| `systemPrompt` | No | Custom LLM system prompt |
| `autonomy` | No | `{ maxSteps, allowedActions, requireConfirmation }` |
| `resilience` | No | `{ maxRetries, backoffMs, failureThreshold }` |

**Goal template syntax:** Uses single braces `{param}` (NOT `{{param}}`).

### Memory-Specific

| Field | Required | Description |
|-------|----------|-------------|
| `category` | No | Category label (`^[a-zA-Z][a-zA-Z0-9\-_]{0,20}$`) |
| `retentionDays` | No | Auto-expiry period for entries |

### Ensemble-Specific

| Field | Required | Description |
|-------|----------|-------------|
| `metadata.elements` | Yes | Array of `{ name, type, role }` |

Role values: `"primary"` or `"supporting"`.

## Naming Conventions

### General Rules
- Lowercase kebab-case: `my-element-name`
- Max 100 characters, must start with a letter
- Allowed characters: letters, digits, hyphens, underscores

### Type-Specific Patterns

| Type | Pattern | Examples |
|------|---------|----------|
| Persona | Describe the role | `security-analyst`, `code-reviewer`, `technical-writer` |
| Skill | Describe the capability | `code-review`, `threat-modeling`, `data-analysis` |
| Template | Describe the output | `bug-report`, `meeting-notes`, `dashboard-page` |
| Agent | Describe the agent role | `code-reviewer`, `data-pipeline`, `report-generator` |
| Memory (agent-linked) | `agent-{agent-name}-context` | `agent-code-reviewer-context` |
| Memory (persona-linked) | `persona-{persona-name}-preferences` | `persona-security-analyst-preferences` |
| Memory (session) | `session-context` | `session-context` |
| Memory (domain) | Describe the domain | `project-context`, `team-decisions` |
| Ensemble | Describe the team | `security-team`, `content-pipeline` |

## Runtime Discovery

Use the introspect operation to get format specs at runtime:

```json
// Get all format specs (overview)
{ "operation": "introspect", "params": { "query": "format" } }

// Get spec for a specific type
{ "operation": "introspect", "params": { "query": "format", "name": "template" } }

// Accepts plurals and mixed case
{ "operation": "introspect", "params": { "query": "format", "name": "memories" } }
```

Each format spec includes: `requiredFields`, `optionalFields`, `dualFieldGuidance`, `syntaxNotes`, `minimalExample`, `fullExample`, and `namingConventions`.

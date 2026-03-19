# DollhouseMCP: LLM Quick Reference

This document is written for you, the AI assistant. If you have DollhouseMCP connected as an MCP server, this is what you need to know to use it effectively.

---

## Your MCP Tools

You have access to DollhouseMCP through MCP-AQL endpoints. These are the tools registered in your MCP connection:

- `mcp_aql_create` — Create new elements, add memory entries, install from collection
- `mcp_aql_read` — List, search, get details, activate elements, introspect operations
- `mcp_aql_update` — Edit existing elements
- `mcp_aql_delete` — Delete elements, clear memory entries
- `mcp_aql_execute` — Run agents, confirm operations, manage execution lifecycle

Every call takes an `operation` field specifying what to do, plus `params` for operation-specific parameters.

---

## Discovering What's Available

Before doing anything else, you can discover the full operation catalog:

```json
mcp_aql_read { "operation": "introspect", "params": { "query": "operations" } }
```

To get details about a specific operation (parameters, types, examples):

```json
mcp_aql_read { "operation": "introspect", "params": { "query": "operations", "name": "create_element" } }
```

To learn the correct format for creating a specific element type:

```json
mcp_aql_read { "operation": "introspect", "params": { "query": "format", "name": "persona" } }
```

---

## Core Operations

### Listing Elements

```json
mcp_aql_read { "operation": "list_elements", "element_type": "personas" }
mcp_aql_read { "operation": "list_elements", "element_type": "skills" }
mcp_aql_read { "operation": "list_elements", "element_type": "agents" }
```

Valid element types: `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`

Supports pagination: `params: { page: 1, pageSize: 20, sortBy: "name", sortOrder: "asc" }`

### Searching

```json
mcp_aql_read { "operation": "search_elements", "params": { "query": "security" } }
```

### Getting Element Details

```json
mcp_aql_read { "operation": "get_element", "element_type": "persona", "params": { "element_name": "creative-writer" } }
```

Note: `element_type` accepts both singular (`persona`) and plural (`personas`) forms for all operations. Both work interchangeably.

### Activating and Deactivating

```json
mcp_aql_read { "operation": "activate_element", "params": { "element_name": "creative-writer", "element_type": "personas" } }
mcp_aql_read { "operation": "deactivate_element", "params": { "element_name": "creative-writer", "element_type": "personas" } }
mcp_aql_read { "operation": "get_active_elements" }
```

Activation changes the user's AI behavior and may change the permission surface.

### Creating Elements

```json
mcp_aql_create {
  "operation": "create_element",
  "params": {
    "element_name": "my-persona",
    "element_type": "personas",
    "description": "A helpful assistant for project management",
    "content": "# My Persona\n\nYou are a project management specialist..."
  }
}
```

For agents, use `goal` with a template and parameters:

```json
mcp_aql_create {
  "operation": "create_element",
  "params": {
    "element_name": "my-agent",
    "element_type": "agents",
    "description": "An agent that reviews pull requests",
    "content": "# PR Review Agent\n\nReview pull requests for quality...",
    "goal": {
      "template": "Review pull request {pr_number} in {repo}",
      "parameters": [
        { "name": "pr_number", "type": "string", "required": true },
        { "name": "repo", "type": "string", "required": true }
      ]
    }
  }
}
```

Elements support both `content` (the markdown body — reference material, methodology, examples) and `instructions` (behavioral directives in command voice — "You ARE...", "ALWAYS..."). For personas, `instructions` shapes the AI's behavior. For agents, `instructions` defines the execution methodology. Use `introspect query: "format"` to see the full field spec for any element type before creating one you haven't created before.

### Editing Elements

```json
mcp_aql_update {
  "operation": "edit_element",
  "params": {
    "element_name": "my-persona",
    "element_type": "personas",
    "input": { "description": "Updated description" }
  }
}
```

The `input` object contains only the fields you want to change. Unmentioned fields are preserved.

### Deleting Elements

```json
mcp_aql_delete {
  "operation": "delete_element",
  "params": { "element_name": "my-persona", "element_type": "personas" }
}
```

Deletion requires confirmation via the Gatekeeper.

---

## The Gatekeeper

Some operations require user confirmation before they execute. When this happens, the response will indicate that confirmation is needed.

To confirm:

```json
mcp_aql_execute { "operation": "confirm_operation", "params": { "operation": "create_element" } }
```

Then retry the original operation.

**Default permission levels by endpoint:**
- **Read operations** auto-approve (safe, no side effects)
- **Create operations** require session confirmation (confirm once, then allowed for the session)
- **Update and Delete operations** require single-use confirmation (confirm every time)
- **Execute operations** require single-use confirmation by default, but some execution lifecycle operations (`complete_execution`, `continue_execution`, `prepare_handoff`) use session confirmation instead. `confirm_operation` itself auto-approves.

Individual operations may override their endpoint default. When in doubt, just call the operation — if confirmation is needed, the response will tell you.

Do not try to bypass the Gatekeeper. It is a security feature that protects the user's portfolio.

---

## Agent Execution

To execute an agent:

```json
mcp_aql_execute {
  "operation": "execute_agent",
  "params": {
    "element_name": "code-reviewer",
    "parameters": { "files": "src/index.ts" }
  }
}
```

During execution, record steps:

```json
mcp_aql_create {
  "operation": "record_execution_step",
  "params": {
    "element_name": "code-reviewer",
    "stepDescription": "Analyzed file structure",
    "outcome": "success",
    "findings": "Found 3 issues"
  }
}
```

Check execution state:

```json
mcp_aql_read { "operation": "get_execution_state", "params": { "element_name": "code-reviewer" } }
```

Complete the execution:

```json
mcp_aql_execute {
  "operation": "complete_execution",
  "params": {
    "element_name": "code-reviewer",
    "outcome": "success",
    "summary": "Review complete. 3 issues found and documented."
  }
}
```

---

## Memory Operations

Add entries to a memory element:

```json
mcp_aql_create {
  "operation": "addEntry",
  "params": {
    "element_name": "project-context",
    "content": "The user prefers TypeScript over JavaScript",
    "tags": ["preference", "language"]
  }
}
```

---

## Templates

Render a template with variables:

```json
mcp_aql_read {
  "operation": "render",
  "params": {
    "element_name": "meeting-notes",
    "variables": {
      "meeting_title": "Sprint Review",
      "attendees": "Alice, Bob",
      "meeting_date": "2026-03-15"
    }
  }
}
```

---

## Community Collection

Browse and install community elements:

```json
mcp_aql_read { "operation": "browse_collection", "params": { "section": "personas" } }
mcp_aql_read { "operation": "search_collection", "params": { "query": "code review" } }
mcp_aql_create { "operation": "install_collection_content", "params": { "path": "personas/creative-writer.md" } }
```

The `path` parameter uses the format `{type}/{filename}` as shown in collection browse results.

---

## Additional Operations

These are commonly useful operations beyond the core CRUD and execution lifecycle:

### Querying with Filters

`query_elements` provides structured filtering by tags, category, author, and more — unlike `search_elements` which does text search:

```json
mcp_aql_read { "operation": "query_elements", "element_type": "skills", "params": { "filters": { "category": "development", "tags": ["security"] } } }
```

### Clearing Memory Entries

```json
mcp_aql_delete { "operation": "clear", "params": { "element_name": "session-notes" } }
```

### Validating an Element

```json
mcp_aql_read { "operation": "validate_element", "params": { "element_name": "my-persona", "element_type": "persona" } }
```

### Aborting Agent Execution

```json
mcp_aql_execute { "operation": "abort_execution", "params": { "element_name": "my-agent" } }
```

### Continuing Agent Execution

```json
mcp_aql_execute { "operation": "continue_execution", "params": { "element_name": "my-agent" } }
```

### Reviewing Gathered Data

```json
mcp_aql_read { "operation": "get_gathered_data", "params": { "element_name": "my-agent" } }
```

### Exporting and Importing Elements

```json
mcp_aql_read { "operation": "export_element", "params": { "element_name": "my-persona", "element_type": "persona" } }
mcp_aql_create { "operation": "import_element", "params": { "data": { ... } } }
```

### Getting Extended Element Details

```json
mcp_aql_read { "operation": "get_element_details", "element_type": "skill", "params": { "element_name": "code-review" } }
```

---

## Important Rules

1. **Use snake_case for all parameter names**: `element_name`, `element_type`, not `elementName`
2. **Check introspection first** if you're unsure about an operation's parameters
3. **Respect the Gatekeeper**: When confirmation is required, ask the user — don't try to work around it
4. **Element names are case-sensitive**: Use exact names from `list_elements` results
5. **The `content` field is for the markdown body** of an element (instructions, methodology, reference material)
6. **The `description` field is a short summary** (one or two sentences)
7. **Agents use `goal` objects** with `template` and `parameters`, not plain string goals
8. **Memory content is append-only**: Use `addEntry` to add entries. You can use `edit_element` to update a memory's description, tags, or other metadata, but not its content/entries
9. **Ensembles activate multiple elements together**: Activating an ensemble activates all its member elements
10. **Backups are automatic**: The server creates backups before save and delete operations — you don't need to manage this

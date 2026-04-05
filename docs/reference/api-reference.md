# DollhouseMCP API Reference (v2.0.0)

**Last Updated:** March 2026

This is a lookup reference for the DollhouseMCP MCP server API. It documents every operation, grouped by endpoint. For a workflow-oriented guide, see [LLM Quick Reference](../guides/llm-quick-reference.md). For architecture details, see [MCP-AQL Operations](../architecture/mcp-aql/OPERATIONS.md).

---

## Interface Modes

### MCP-AQL CRUDE (Default)

The server exposes **5 MCP tool endpoints** that accept an `operation` field routing to the appropriate handler:

| Endpoint | Tool Name | Semantics |
|----------|-----------|-----------|
| **Create** | `mcp_aql_create` | Additive, non-destructive (create elements, add entries, install, import) |
| **Read** | `mcp_aql_read` | Safe, read-only (list, get, search, activate, introspect, validate, render) |
| **Update** | `mcp_aql_update` | Modify existing state (edit elements, upgrade format) |
| **Delete** | `mcp_aql_delete` | Remove state (delete elements, clear memory entries) |
| **Execute** | `mcp_aql_execute` | Runtime execution lifecycle (run agents, confirm operations, manage handoffs) |

Every call follows this shape:

```json
{
  "operation": "<operation_name>",
  "element_type": "<type>",
  "params": { ... }
}
```

`element_type` accepts both singular (`persona`) and plural (`personas`) forms. It can appear at the top level or inside `params`.

### Discrete Mode (Backward Compatibility)

The server can also expose each operation as a separate MCP tool (40+ individual tools). This mode exists for backward compatibility with v1.x integrations. Configure via server startup options. The MCP-AQL CRUDE interface is the default and recommended mode.

---

## Response Format

All operations return a discriminated union:

```typescript
// Success
{ success: true, data: { ... } }

// Failure
{ success: false, error: "Human-readable error message" }
```

---

## Introspection

The server is self-documenting. Use introspection to get live, authoritative details about any operation:

```json
mcp_aql_read { "operation": "introspect", "params": { "query": "operations" } }
mcp_aql_read { "operation": "introspect", "params": { "query": "operations", "name": "create_element" } }
mcp_aql_read { "operation": "introspect", "params": { "query": "format", "name": "persona" } }
mcp_aql_read { "operation": "introspect", "params": { "query": "types" } }
mcp_aql_read { "operation": "introspect", "params": { "query": "categories" } }
```

When in doubt about an operation's exact parameters or behavior, introspect it. The schemas below are accurate at time of writing but introspection is always the authoritative source.

---

## Gatekeeper (Permission System)

Some operations require user confirmation before executing. Default permission levels by endpoint:

| Endpoint | Default Policy |
|----------|---------------|
| **Read** | Auto-approve (safe, no side effects) |
| **Create** | Session confirmation (confirm once, allowed for remainder of session) |
| **Update** | Single-use confirmation (confirm every time) |
| **Delete** | Single-use confirmation (confirm every time) |
| **Execute** | Single-use confirmation (some lifecycle operations use session confirmation) |

When confirmation is needed, the response will indicate it. Confirm with:

```json
mcp_aql_execute { "operation": "confirm_operation", "params": { "operation": "create_element" } }
```

Then retry the original operation. Individual operations may override their endpoint default. Elements can also define custom gatekeeper policies via the `gatekeeper` field that take effect when activated.

---

## Element Types

Six element types, each with different required fields for creation:

| Type | Required Fields | Purpose |
|------|----------------|---------|
| `persona` | `instructions` | Behavioral profiles — AI tone, priorities, workflows |
| `skill` | `content` | Discrete capabilities — domain knowledge, methodology |
| `template` | `content` | Reusable content structures with variable placeholders |
| `agent` | `content` or `goal` | Goal-oriented workflows with execution lifecycle |
| `memory` | _(none)_ | Persistent context storage — entries added via `addEntry` |
| `ensemble` | `metadata.elements` | Composite activation of multiple elements together |

All types support `instructions` (behavioral directives) and `content` (reference material) as distinct first-class fields. Use `introspect query: "format"` for full field specifications.

---

## Parameter Conventions

- **snake_case** for all parameter names: `element_name`, `element_type`
- Both `element_type` and `elementType` accepted (snake_case preferred)
- Element names are case-sensitive
- `element_type` can be singular or plural (`persona` / `personas`)

---

## CREATE Operations

Routed through `mcp_aql_create`.

### create_element

Create a new element of any type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | persona, skill, template, agent, memory, ensemble |
| `description` | string | Yes | Short summary (1-2 sentences) |
| `instructions` | string | Personas | Behavioral directives in command voice. Required for personas. |
| `content` | string | Skills/Templates | Reference material, knowledge, template body. Required for templates. |
| `goal` | object | Agents | Goal configuration: `{ template, parameters, successCriteria }` |
| `tags` | string[] | No | Categorization tags |
| `triggers` | string[] | No | Action verbs that trigger this element |
| `category` | string | No | Category label (skills, templates, memories only) |
| `activates` | object | Agents | Elements to auto-activate: `{ skills: [...], personas: [...] }` |
| `tools` | object | Agents | Tool access policy: `{ allowed: [...], denied: [...] }` |
| `systemPrompt` | string | Agents | Custom system prompt for LLM context |
| `autonomy` | object | Agents | `{ riskTolerance, maxAutonomousSteps, requiresApproval, autoApprove }` |
| `resilience` | object | Agents | `{ onStepLimitReached, onExecutionFailure, maxRetries, maxContinuations }` |
| `gatekeeper` | object | No | Per-element security policy: `{ allow?, confirm?, deny?, scopeRestrictions? }` |
| `metadata` | object | No | Additional metadata. For ensembles: include `elements` array. |

### import_element

Import an element from exported data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | string or object | Yes | Export package (JSON string or object) |
| `overwrite` | boolean | No | Overwrite if exists (default: false) |

### addEntry

Add an entry to a memory element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Memory element name |
| `content` | string | Yes | Entry text content |
| `tags` | string[] | No | Entry tags for categorization |
| `metadata` | object | No | Structured metadata for correlation |

### install_collection_content

Install an element from the community collection to the local portfolio.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Content path (e.g., `personas/creative-writer.md`) |

### submit_collection_content

Submit a local element to the community collection via GitHub.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Element reference to submit |

### import_persona

Import a persona from a file path or JSON string.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | Yes | File path or JSON string |
| `overwrite` | boolean | No | Overwrite existing persona |

### verify_challenge

Submit verification code to unblock a danger zone operation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `challenge_id` | string | Yes | UUID challenge ID from danger zone trigger |
| `code` | string | Yes | Verification code displayed to the user |

### beetlejuice_beetlejuice_beetlejuice

Safe-trigger the full danger zone verification pipeline for testing purposes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_name` | string | No | Agent to block (default: `beetlejuice-test-agent`) |

### init_portfolio

Initialize a new GitHub portfolio repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repository_name` | string | No | Name for the portfolio repository |
| `private` | boolean | No | Whether the repository should be private |
| `description` | string | No | Repository description |

### sync_portfolio

Sync local portfolio with GitHub repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | string | No | `push` or `pull` (default: `push`) |
| `mode` | string | No | Sync mode |
| `force` | boolean | No | Force sync even with conflicts |
| `dry_run` | boolean | No | Preview changes without applying |

### portfolio_element_manager

Manage individual elements between local and GitHub.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | Yes | `list-remote`, `download`, `upload`, `compare` |
| `element_name` | string | No | Element name to operate on |
| `element_type` | string | No | Element type |
| `options` | object | No | Operation options (`force`, `dry_run`, etc.) |

### setup_github_auth

Start GitHub device-code authentication. No parameters.

### configure_oauth

Configure GitHub OAuth client ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `client_id` | string | No | OAuth client ID |

---

## READ Operations

Routed through `mcp_aql_read`.

### list_elements

List elements with pagination, filtering, sorting, and aggregation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_type` | string | Yes | Element type to list |
| `page` | number | No | Page number, 1-indexed (default: 1) |
| `pageSize` | number | No | Items per page (default: 20, max: 100) |
| `sortBy` | string | No | `name`, `created`, `modified`, `version` (default: `name`) |
| `sortOrder` | string | No | `asc` or `desc` (default: `asc`) |
| `nameContains` | string | No | Partial name match (case-insensitive) |
| `tags` | string[] | No | Must have ALL tags (AND logic) |
| `tagsAny` | string[] | No | Must have ANY tag (OR logic) |
| `author` | string | No | Filter by author |
| `status` | string | No | `active`, `inactive`, or `all` |
| `category` | string | No | Filter by category (case-insensitive) |
| `aggregate` | object | No | `{ count: true, group_by?: "category" }` for count-only results |
| `fields` | string or string[] | No | Field selection: preset (`minimal`, `standard`, `full`) or array |

### get_element

Get an element by name and type, returning full content and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `fields` | string or string[] | No | Field selection preset or array |

### get_element_details

Get detailed information about a specific element (currently equivalent to `get_element`; future versions will include extended metadata like relationship graphs and gatekeeper policy resolution).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `fields` | string or string[] | No | Field selection preset or array |

### search_elements

Full-text search across element names, descriptions, and content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (max 1000 chars) |
| `element_type` | string | No | Filter by element type |
| `page` | number | No | Page number |
| `pageSize` | number | No | Results per page |
| `sort` | object | No | `{ sortBy, sortOrder }` |
| `fields` | string or string[] | No | Field selection preset or array |

### query_elements

Structured filtering by tags, category, author, and more.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_type` | string | Yes | Element type to query |
| `filters` | object | No | `{ nameContains, tags, author, status, category }` |
| `sort` | object | No | `{ sortBy, sortOrder }` |
| `pagination` | object | No | `{ page, pageSize }` |
| `aggregate` | object | No | `{ count?: boolean, group_by?: string }` |
| `fields` | string or string[] | No | Field selection preset or array |

### search

Unified search across local, GitHub, and collection sources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `scope` | string or string[] | No | `local`, `github`, `collection`, `all`, or array of scopes |
| `type` | string | No | Filter by element type |
| `page` | number | No | Page number |
| `limit` | number | No | Results per page |
| `sort` | object | No | `{ field, order }` |
| `filters` | object | No | `{ tags, author, createdAfter, createdBefore }` |
| `fields` | string or string[] | No | Field selection preset or array |

### activate_element

Activate an element for use in the current session. Persisted per-session via `DOLLHOUSE_SESSION_ID`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |

### deactivate_element

Deactivate an element, removing it from the current session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |

### get_active_elements

Get all currently active elements with rendered content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_type` | string | No | Filter by type (omit for all) |

### validate_element

Validate an existing element by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `strict` | boolean | No | Use strict validation |

### render

Render a template with provided variables. Section-format templates (`<template>`, `<style>`, `<script>`) render the `<template>` section by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Template name |
| `variables` | object | No | Variables to substitute |
| `section` | string | No | Extract a specific raw section: `style` or `script` |
| `all_sections` | boolean | No | Return all sections: `{ template, style, script }` |

### export_element

Export an element to a portable format.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `format` | string | No | `json` or `yaml` (default: `json`) |

### introspect

Query available operations, types, and element format specs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | `operations`, `types`, `format`, or `categories` |
| `name` | string | No | Specific item name (operation, type, or element type) |

### browse_collection

Browse the DollhouseMCP community collection by section and type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `section` | string | No | Collection section to browse |
| `type` | string | No | Element type filter |

### search_collection

Search the community collection by keywords.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |

### search_collection_enhanced

Advanced collection search with pagination, filtering, and sorting.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |

### get_collection_content

Get detailed information about content from the collection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Content path in collection |

### get_collection_cache_health

Get health status and statistics for the collection cache. No parameters.

### get_execution_state

Query current execution state including progress and findings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `includeDecisionHistory` | boolean | No | Include decision history |
| `includeContext` | boolean | No | Include execution context |

### get_gathered_data

Get aggregated execution data for a specific goal.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `goalId` | string | Yes | Goal ID to gather data for |

### permission_prompt

Evaluate CLI-level permission prompts for non-interactive sessions (used with `--permission-prompt-tool`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool_name` | string | Yes | Tool requesting permission (e.g., `Bash`, `Edit`) |
| `input` | object | Yes | Tool input parameters to evaluate |
| `agent_identity` | string | No | Identity of the sub-agent making the request |

### get_effective_cli_policies

Get effective CLI permission policies across all active elements.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool_name` | string | No | Evaluate a specific tool |
| `tool_input` | object | No | Tool input to evaluate |

### get_pending_cli_approvals

Get pending CLI tool approval requests for this session. No parameters.

### portfolio_status

Check GitHub portfolio repository status and element counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `username` | string | No | GitHub username to check |

### portfolio_config

Configure portfolio settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `auto_sync` | boolean | No | Enable automatic syncing |
| `auto_submit` | boolean | No | Automatically submit to collection |
| `repository_name` | string | No | Portfolio repository name |

### search_portfolio

Search local portfolio by content name, keywords, or tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `type` | string | No | Filter by element type |
| `fields` | string or string[] | No | Field selection preset or array |

### search_all

Unified search across local, GitHub, and collection sources (legacy; prefer `search`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `sources` | string[] | No | Sources to search: `local`, `github`, `collection` |
| `type` | string | No | Filter by element type |
| `fields` | string or string[] | No | Field selection preset or array |

### dollhouse_config

Manage DollhouseMCP configuration settings.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `get`, `set`, `reset`, `export`, `import`, `wizard` |
| `setting` | string | No | Setting key (for `get`/`set`) |
| `value` | string | No | Setting value (for `set`) |
| `section` | string | No | Config section (for `reset`) |
| `format` | string | No | Export format |

### convert_skill_format

Convert between Agent Skill and Dollhouse Skill formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | string | Yes | `agent_to_dollhouse` or `dollhouse_to_agent` |
| `agent_skill` | object | No | Agent Skill structure (for `agent_to_dollhouse`) |
| `dollhouse` | object | No | Dollhouse skill artifact (for `dollhouse_to_agent`) |
| `dollhouse_markdown` | string | No | Serialized markdown input (alternative to `dollhouse`) |
| `roundtrip_state` | object | No | State for lossless reverse conversion |

### get_build_info

Get build metadata, version, runtime environment. No parameters.

### get_cache_budget_report

Get global cache memory budget report with per-cache diagnostics. No parameters.

### query_logs

Query recent log entries from the in-memory buffer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | string | No | `application`, `security`, `performance`, `telemetry`, or `all` |
| `level` | string | No | Minimum level: `debug`, `info`, `warn`, `error` |
| `source` | string | No | Component name filter (substring match) |
| `message` | string | No | Free text search in message field |
| `since` | string | No | ISO 8601 timestamp (entries after) |
| `until` | string | No | ISO 8601 timestamp (entries before) |
| `limit` | number | No | Max results (1-500, default: 50) |
| `offset` | number | No | Skip results for pagination |

### check_github_auth

Check current GitHub authentication status. No parameters.

### oauth_helper_status

Get diagnostic information about OAuth helper process.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `verbose` | boolean | No | Include verbose diagnostics |

### find_similar_elements

Find semantically similar elements using NLP scoring.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | No | Element type |
| `limit` | number | No | Max results (default: 10) |
| `threshold` | number | No | Similarity threshold (default: 0.5) |

### get_element_relationships

Get all relationships for a specific element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | No | Element type |
| `relationship_types` | string[] | No | Filter by relationship type |

### search_by_verb

Search for elements that handle a specific action verb.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `verb` | string | Yes | Action verb |
| `limit` | number | No | Max results (default: 20) |

### get_relationship_stats

Get statistics about Enhanced Index relationships. No parameters.

### open_portfolio_browser

Start the portfolio web UI and open it in the system browser (localhost:5907). Supports URL parameters for deep-linking with pre-populated search, filters, and element navigation.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tab` | string | Tab to open: portfolio, logs, metrics, permissions, setup |
| `q` | string | Pre-populate search query on the target tab |
| `type` | string | Filter by element type (persona, skill, template, agent, memory, ensemble) |
| `name` | string | Navigate directly to element detail view |
| `level` | string | Filter by log level (debug, info, warn, error) on logs tab |
| `category` | string | Filter by category on logs tab |
| `since` | string | Time range filter (ISO 8601 or relative: 5m, 1h, 24h, 7d) |

### open_logs

Open the management console on the logs tab with optional filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | string | Minimum log level (debug, info, warn, error) |
| `category` | string | Log category (application, security, performance) |
| `source` | string | Log source component filter |
| `q` | string | Search log messages |
| `since` | string | Time range (ISO 8601 or relative: 5m, 1h, 24h, 7d) |

### open_metrics

Open the management console on the metrics tab with optional filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `since` | string | Time range (15m, 30m, 1h) |
| `refresh` | number | Auto-refresh interval in seconds (0 disables) |

---

## UPDATE Operations

Routed through `mcp_aql_update`.

### edit_element

Edit an element using nested input objects (deep-merged with existing).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `input` | object | Yes | Fields to update (deep-merged). Common: `instructions`, `content`, `description`, `tags`, `triggers`, `category`, `gatekeeper`. Agents: `goal`, `activates`, `tools`, `systemPrompt`, `autonomy`, `resilience`. |

### upgrade_element

Upgrade element from v1 single-body format to v2 dual-field format (`instructions` + `content`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `dry_run` | boolean | No | Preview changes without writing |
| `instructions_override` | string | No | Manually specify instructions |
| `content_override` | string | No | Manually specify content |

---

## DELETE Operations

Routed through `mcp_aql_delete`.

### delete_element

Permanently delete an element. Backups are created automatically before deletion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Element name |
| `element_type` | string | Yes | Element type |
| `deleteData` | boolean | No | Also delete associated data files |

### clear

Clear all entries from a memory element. Irreversible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Memory element name |

### clear_github_auth

Remove GitHub authentication and disconnect. No parameters.

---

## EXECUTE Operations

Routed through `mcp_aql_execute`.

### execute_agent

Start execution of an agent. The agent must have a `goal.template` defined. Elements in the agent's `activates` field are automatically activated for the duration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `parameters` | object | Yes | Values for goal template placeholders |
| `maxAutonomousSteps` | number | No | Runtime override for max autonomous steps |

**Returns:** `{ agentName, goal, goalId, stateVersion, activeElements, availableTools, successCriteria, safetyTier }`

### record_execution_step

Record execution progress or findings. Returns an autonomy directive indicating whether to continue or pause.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `stepDescription` | string | Yes | Description of step completed |
| `outcome` | string | Yes | `success`, `failure`, or `partial` |
| `findings` | string | No | Step findings or results |
| `confidence` | number | No | Confidence score (0-1) |
| `nextActionHint` | string | No | Hint about next planned action (for autonomy evaluation) |
| `riskScore` | number | No | Risk score for next action (0-100, higher = more likely to pause) |

**Note:** Routed through `mcp_aql_create` (not Execute), but documented here with the execution lifecycle.

### complete_execution

Signal that execution finished.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `outcome` | string | Yes | `success`, `failure`, or `partial` |
| `summary` | string | Yes | Summary of execution results |
| `goalId` | string | No | Goal ID if tracking specific goal |

### continue_execution

Resume execution from saved state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `previousStepResult` | string | No | Result from previous step |
| `parameters` | object | No | Additional parameters for continuation |

### abort_execution

Abort a running agent execution, rejecting further operations for the goalId.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `reason` | string | No | Reason for aborting |

### prepare_handoff

Serialize goal progress into a portable handoff block for session transfer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name |
| `goalId` | string | Yes | Goal ID to include in the handoff |

**Returns:** `{ handoffState, handoffBlock }` — the `handoffBlock` is a copy-pasteable text block with human-readable header and compressed base64 payload.

### resume_from_handoff

Resume agent execution from a handoff block. Validates integrity and verifies agent name match.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_name` | string | Yes | Agent name (must match handoff block) |
| `handoffBlock` | string | Yes | Full handoff block text (including payload markers) |
| `parameters` | object | No | Goal template parameters |

### confirm_operation

Confirm a pending operation that requires user approval (Gatekeeper flow).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operation` | string | Yes | Operation name to confirm (e.g., `create_element`) |
| `element_type` | string | No | Optional element type scope |

### approve_cli_permission

Approve a pending CLI tool permission request. Used by bridges to relay human approval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `request_id` | string | Yes | Approval request ID from `permission_prompt` deny response |
| `scope` | string | No | `single` (default) or `tool_session` |

---

## Operation-to-Endpoint Quick Reference

For fast lookup, here is every operation and its actual CRUDE endpoint:

| Operation | Endpoint |
|-----------|----------|
| `create_element` | CREATE |
| `import_element` | CREATE |
| `addEntry` | CREATE |
| `install_collection_content` | CREATE |
| `submit_collection_content` | CREATE |
| `import_persona` | CREATE |
| `verify_challenge` | CREATE |
| `beetlejuice_beetlejuice_beetlejuice` | CREATE |
| `init_portfolio` | CREATE |
| `sync_portfolio` | CREATE |
| `portfolio_element_manager` | CREATE |
| `setup_github_auth` | CREATE |
| `configure_oauth` | CREATE |
| `record_execution_step` | CREATE |
| `list_elements` | READ |
| `get_element` | READ |
| `get_element_details` | READ |
| `search_elements` | READ |
| `query_elements` | READ |
| `search` | READ |
| `search_portfolio` | READ |
| `search_all` | READ |
| `activate_element` | READ |
| `deactivate_element` | READ |
| `get_active_elements` | READ |
| `validate_element` | READ |
| `render` | READ |
| `export_element` | READ |
| `introspect` | READ |
| `browse_collection` | READ |
| `search_collection` | READ |
| `search_collection_enhanced` | READ |
| `get_collection_content` | READ |
| `get_collection_cache_health` | READ |
| `get_execution_state` | READ |
| `get_gathered_data` | READ |
| `permission_prompt` | READ |
| `get_effective_cli_policies` | READ |
| `get_pending_cli_approvals` | READ |
| `portfolio_status` | READ |
| `portfolio_config` | READ |
| `dollhouse_config` | READ |
| `convert_skill_format` | READ |
| `get_build_info` | READ |
| `get_cache_budget_report` | READ |
| `query_logs` | READ |
| `check_github_auth` | READ |
| `oauth_helper_status` | READ |
| `find_similar_elements` | READ |
| `get_element_relationships` | READ |
| `search_by_verb` | READ |
| `get_relationship_stats` | READ |
| `open_portfolio_browser` | READ |
| `edit_element` | UPDATE |
| `upgrade_element` | UPDATE |
| `delete_element` | DELETE |
| `clear` | DELETE |
| `clear_github_auth` | DELETE |
| `execute_agent` | EXECUTE |
| `complete_execution` | EXECUTE |
| `continue_execution` | EXECUTE |
| `abort_execution` | EXECUTE |
| `prepare_handoff` | EXECUTE |
| `resume_from_handoff` | EXECUTE |
| `confirm_operation` | EXECUTE |
| `approve_cli_permission` | EXECUTE |

---

## Inspecting Tools Locally

```bash
npm run build
npm run inspector
```

The MCP Inspector lists every tool, description, and JSON schema. From within a client, call `list_tools` to see the live registry.

---

## Implementation Notes

- Tool definitions: `src/handlers/mcp-aql/OperationSchema.ts` (schema-driven) and `src/handlers/mcp-aql/OperationRouter.ts` (route table)
- Handler implementations: `src/handlers/` — thin facades delegating to services/managers
- DI container: `src/di/Container.ts` wires managers, services, and handlers at startup
- For automation or docs that reference the tool list, prefer introspection or inspector output to guard against drift

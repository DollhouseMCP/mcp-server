# Migrating to DollhouseMCP v2.0

## TL;DR — What You Need to Know

**Your elements are fine.** All your personas, skills, templates, agents, and memories work without changes. The server reads them, normalizes them, and handles everything.

**You don't need to do anything special.** Install v2.0, restart your client, and keep working. Here's what you'll notice:

1. **The AI now asks for confirmation** before creating, editing, or deleting elements. This is the new Gatekeeper — a permission system that prevents accidental changes. When it asks, just confirm and it proceeds. First confirmation per operation type lasts the whole session.

2. **Your agents auto-upgrade.** The first time you run a v1.x agent, the server converts it to the v2.0 format automatically. Your original V1 agent is backed up first (at `~/.dollhouse/portfolio/.backups/agents/`), then the file is updated in place with the V2 format. It still does the same thing — the new format just has more capabilities available.

3. **Your memories stick around.** Retention enforcement is opt-in and disabled by default in both v1.x and v2.0 — memories are permanent unless you explicitly configure a retention policy. No action needed.

4. **Everything gets backed up automatically.** Before any save or delete, v2.0 creates a backup at `~/.dollhouse/portfolio/.backups/`. If anything goes wrong, your data is recoverable.

That's it for most users. The detailed technical changes are below if you need them.

---

## Quick Migration Checklist

For users who want to be thorough:

- [ ] Install v2.0 and restart your MCP client
- [ ] Confirm the Gatekeeper prompts when they appear (this is normal)
- [ ] If you have agents, run one to trigger auto-upgrade to V2 schema
- [ ] If you want time-limited memories, enable retention policy and add explicit `retention` values
- [ ] Explore new features: ensembles, introspection, community collection

---

## 1. Tool Interface: Discrete Tools → MCP-AQL

The biggest change in v2.0 is how you interact with the server.

### Before (v1.x): Many Discrete Tools

v1.x exposed ~40 individual tools, each with its own name and parameters:

```
create_persona({ name: "my-persona", instructions: "..." })
list_personas()
activate_persona({ name: "my-persona" })
create_skill({ name: "my-skill", content: "..." })
```

### After (v2.0): 5 CRUDE Endpoints

v2.0 routes all operations through 5 semantic endpoints:

```
mcp_aql_create({ operation: "create_element", params: { element_name: "my-persona", element_type: "persona", ... }})
mcp_aql_read({ operation: "list_elements", element_type: "personas" })
mcp_aql_read({ operation: "activate_element", params: { element_name: "my-persona", element_type: "persona" }})
mcp_aql_create({ operation: "create_element", params: { element_name: "my-skill", element_type: "skill", ... }})
```

The 5 endpoints are:

| Endpoint | What It Does | Permission Default |
|----------|-------------|-------------------|
| `mcp_aql_create` | Add new things | Confirm once per session |
| `mcp_aql_read` | Look at things (safe) | Auto-approve |
| `mcp_aql_update` | Modify existing things | Confirm every time |
| `mcp_aql_delete` | Remove things | Confirm every time |
| `mcp_aql_execute` | Run agents and workflows | Confirm every time |

### Configuration Options

The tool interface is configurable via environment variable:

| Mode | Env Var | Tools Exposed |
|------|---------|--------------|
| **CRUDE (default)** | `MCP_AQL_ENDPOINT_MODE=crude` | 5 CRUDE endpoints |
| Single | `MCP_AQL_ENDPOINT_MODE=single` | 1 unified `mcp_aql` endpoint |
| Discrete (v1.x compat) | `MCP_INTERFACE_MODE=discrete` | ~40 individual tools |

If you need v1.x tool names during transition, set `MCP_INTERFACE_MODE=discrete`. This is not recommended long-term.

---

## 2. Parameter Naming: camelCase → snake_case

All parameter names are now snake_case:

| v1.x | v2.0 |
|------|------|
| `elementName` | `element_name` |
| `elementType` | `element_type` |

Both forms are accepted during the transition period — the server normalizes internally. But snake_case is the canonical form and should be used in new code.

---

## 3. Operation Name Changes

Several operations were renamed for clarity:

| v1.x Operation | v2.0 Operation | Endpoint |
|---------------|---------------|----------|
| `record_agent_step` | `record_execution_step` | CREATE |
| `complete_agent_goal` | `complete_execution` | EXECUTE |
| `get_agent_state` | `get_execution_state` | READ |
| `continue_agent_execution` | `continue_execution` | EXECUTE |

New operations added in v2.0 (no v1.x equivalent):

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| `abort_execution` | EXECUTE | Stop a running agent |
| `get_gathered_data` | READ | Get aggregated execution data |
| `prepare_handoff` | EXECUTE | Serialize agent state for session transfer |
| `resume_from_handoff` | EXECUTE | Resume from a handoff block |
| `confirm_operation` | EXECUTE | Approve a gatekeeper-blocked operation |
| `introspect` | READ | Discover available operations at runtime |
| `query_elements` | READ | Structured filtering with tags, category, author |
| `upgrade_element` | UPDATE | Convert v1 elements to v2 format |
| `validate_element` | READ | Validate an element by name |

### Activation Routing Change

`activate_element` and `deactivate_element` moved from CREATE to **READ** in v2.0. Activation is treated as a read-only policy evaluation. If you're calling these via MCP-AQL, use `mcp_aql_read`.

---

## 4. The Gatekeeper (New in v2.0)

v2.0 introduces a three-layer permission system called the **Gatekeeper**. This is the most significant behavioral change from v1.x.

### What It Does

Every operation is checked server-side before execution:

1. **Route policies**: Each operation has a default permission level based on its endpoint (reads auto-approve, creates/deletes require confirmation)
2. **Element policies**: Active personas and skills can add `allow`, `confirm`, and `deny` lists that override defaults
3. **Session confirmation**: Once you confirm an operation type, it stays confirmed for the session

### What This Means for You

When you call an operation that requires confirmation, the response will indicate that approval is needed. You then call `confirm_operation` and retry:

```
// First attempt — blocked by Gatekeeper
mcp_aql_create({ operation: "create_element", params: { ... } })
// Response includes: { requiresConfirmation: true, operation: "create_element",
//   message: "Operation 'create_element' requires confirmation..." }

// Confirm (this is a session confirmation — only needed once per operation type)
mcp_aql_execute({ operation: "confirm_operation", params: { operation: "create_element" } })

// Retry — now it works
mcp_aql_create({ operation: "create_element", params: { ... } })
```

For most LLM clients, this happens transparently — the AI handles the confirmation flow automatically.

### Configuration

```bash
# Disable gatekeeper entirely (not recommended)
DOLLHOUSE_GATEKEEPER_ENABLED=false

# Disable element policy overrides (Layer 2 only)
DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES=false
```

---

## 5. Agent Schema: V1 → V2

Agent metadata has been significantly restructured. V1 agents still load and execute — the server auto-converts them on first execution.

### Key Differences

| Aspect | v1.x | v2.0 |
|--------|------|------|
| Goals | Freeform string | Parameterized template with `parameters` and `successCriteria` |
| Decision-making | Server-side rules | LLM-driven with advisory signals |
| Element activation | Type-specific | Element-agnostic `activates` object |
| System prompt | Implicit (in body) | Explicit `systemPrompt` field |
| Access control | None | `gatekeeper` policy on the agent |
| Failure recovery | Manual | `resilience` policy (retry, continue, abort) |

### V2 Agent Example

```yaml
---
name: code-reviewer
type: agent
description: Reviews code for quality and security
goal:
  template: "Review {files} for {review_type} issues"
  parameters:
    - name: files
      type: string
      required: true
    - name: review_type
      type: string
      required: true
  success_criteria:
    - "All issues documented"
    - "Recommendations provided"
activates:
  personas: ["security-analyst"]
  skills: ["code-review", "threat-modeling"]
tools:
  allowed: ["Read", "Grep", "Glob"]
system_prompt: "You are a thorough code reviewer..."
resilience:
  max_retries: 3
  on_step_limit_reached: continue
---
# Code Reviewer

Detailed methodology and reference material...
```

### Auto-Conversion

V1 agents are automatically converted to V2 on first execution via `execute_agent`. The original V1 file is backed up before conversion (via the universal backup system at `~/.dollhouse/portfolio/.backups/agents/`), then updated in place with the V2 format. You can also explicitly convert with:

```
mcp_aql_update({ operation: "upgrade_element", params: { element_name: "my-agent", element_type: "agent" } })
```

---

## 6. Ensembles (New Element Type)

v2.0 adds a 6th element type: **ensembles**. These bundle multiple elements into coordinated configurations with activation strategies and conflict resolution.

```yaml
---
name: development-team
type: ensemble
description: Coordinated development workflow
activation_strategy: all
elements:
  - element_name: technical-analyst
    element_type: persona
    role: primary
    priority: 80
  - element_name: code-review
    element_type: skill
    role: support
    priority: 60
---
```

Activating an ensemble activates all its member elements. Deactivating it deactivates them all. Member elements inherit combined gatekeeper policies.

No migration needed — v1.x simply doesn't have ensembles. They're additive.

---

## 7. Memory Retention & Backups

| | v1.x | v2.0 |
|--|------|------|
| **Retention enforcement** | Opt-in (disabled by default) | Opt-in (disabled by default) |
| **Default per-memory retention** | Permanent | Permanent |
| **Backup system** | None | Automatic pre-save and pre-delete backups |

Retention enforcement is **disabled by default** in both versions (`retentionPolicy.enabled: false` in ConfigManager). Memories are permanent unless you explicitly enable retention and set a retention period:

```yaml
---
name: my-session-notes
type: memory
retention: 30  # days — only enforced when retention policy is enabled
---
```

To enable automatic retention enforcement, set `retentionPolicy.enabled: true` in your DollhouseMCP configuration (`~/.dollhouse/config.yaml`).

Backups are stored at `~/.dollhouse/portfolio/.backups/{type}/YYYY-MM-DD/` with a default maximum of 3 per element per day (configurable via `DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT`).

---

## 8. Introspection (New in v2.0)

v2.0 introduces a self-describing API. Instead of hard-coding operation knowledge, the AI can discover capabilities at runtime:

```
mcp_aql_read({ operation: "introspect", params: { query: "operations" } })
mcp_aql_read({ operation: "introspect", params: { query: "format", name: "agent" } })
mcp_aql_read({ operation: "introspect", params: { query: "categories" } })
```

This eliminates the need to maintain static tool documentation — the server is the source of truth.

---

## 9. Element Dual-Field System

v2.0 introduces separate `instructions` and `content` fields for elements:

- **`instructions`**: Behavioral directives in command voice ("You ARE...", "ALWAYS...")
- **`content`**: The markdown body — reference material, methodology, examples

In v1.x, everything lived in the markdown body. In v2.0, the body becomes `content` and behavioral instructions can be specified separately in YAML front matter.

Both approaches work — the server handles the mapping. But the dual-field system is recommended for new elements because it separates "how to behave" from "what to reference."

---

## Environment Variables Reference

New configuration options in v2.0:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_INTERFACE_MODE` | `mcpaql` | Tool interface mode (`mcpaql` or `discrete`) |
| `MCP_AQL_ENDPOINT_MODE` | `crude` | MCP-AQL mode (`crude` or `single`) |
| `DOLLHOUSE_GATEKEEPER_ENABLED` | `true` | Enable/disable gatekeeper |
| `DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES` | `true` | Enable/disable element policy layer |
| `DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT` | `3` | Max backups per element per day (1-50) |
| `DOLLHOUSE_SESSION_ID` | auto | Session identifier for activation persistence |
| `DOLLHOUSE_USER` | OS username | Author attribution for created elements |
| `DOLLHOUSE_WEB_AUTH_ENABLED` | `false` | Enforce Bearer token auth on web console port 41715 (#1780). Phase 1 default-off — will flip to `true` in a follow-up release. |
| `DOLLHOUSE_CONSOLE_TOKEN_FILE` | `~/.dollhouse/run/console-token.auth.json` | Optional override for the console token file path. |
| `DOLLHOUSE_CONSOLE_ROTATION_REQUIRE_CONFIRMATION` | `true` | Require out-of-band confirmation (Phase 2: OS dialog or TOTP) for token rotation. Set `false` for headless CI. |

---

## Getting Help

- **Onboarding guide**: [Getting Started](public-beta-onboarding.md)
- **LLM reference**: [LLM Quick Reference](llm-quick-reference.md)
- **Understanding permissions**: [Why DollhouseMCP](why-dollhousemcp.md)
- **Troubleshooting**: [Troubleshooting Guide](troubleshooting.md)
- **Issues**: [github.com/DollhouseMCP/mcp-server/issues](https://github.com/DollhouseMCP/mcp-server/issues)

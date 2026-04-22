---
last_updated: 2026-03-18
version: 2.0.0
---

# MCP-AQL in DollhouseMCP

> **MCP-AQL** — Model Context Protocol – **A**dvanced **A**gent **A**PI **A**dapter **Q**uery **L**anguage

## What Is MCP-AQL?

MCP-AQL is a protocol layer on top of MCP, created by Dollhouse Research. It is an open protocol specification for consolidating multiple MCP tools into semantic endpoints. Those endpoints are semantic rather than tool-by-tool functional endpoints, which lets an LLM choose the action family first and then the specific operation and parameters. It's both a spec and a toolkit:

- **Protocol spec** — the CRUDE endpoint pattern, introspection grammar, and batch operations
- **Interrogator** — runtime introspection that lets LLMs discover operations on demand
- **Compiler** — schema-driven dispatch that validates and routes operations
- **Adapter generator** — code generation for creating MCP-AQL adapters across platforms and languages

The MCP-AQL project is stewarded by Dollhouse Research and published at [MCPAQL](https://github.com/MCPAQL):

| Repository | Description |
|-----------|-------------|
| [spec](https://github.com/MCPAQL/spec) | Formal protocol specification |
| [adapter-generator](https://github.com/MCPAQL/adapter-generator) | Code generator for MCP-AQL adapters |
| [mcpaql-adapter](https://github.com/MCPAQL/mcpaql-adapter) | Reference adapter implementation |
| [tools](https://github.com/MCPAQL/tools) | Conformance validators and CLI utilities |
| [examples](https://github.com/MCPAQL/examples) | Reference applications and examples |
| [website](https://github.com/MCPAQL/website) | Documentation and public-facing site |

**Any MCP server can adopt MCP-AQL** — it's not DollhouseMCP-specific. The adapter generator can create MCP-AQL interfaces for existing MCP servers automatically.

---

## How DollhouseMCP Uses MCP-AQL

DollhouseMCP is an implementation of that protocol layer, and it uses MCP-AQL as its default interface for exposing 50+ element management operations through 5 CRUDE endpoints:

| Endpoint | Tool Name | DollhouseMCP Operations |
|----------|-----------|------------------------|
| **Create** | `mcp_aql_create` | Create elements, add memory entries, install from collection, import, sync |
| **Read** | `mcp_aql_read` | List, search, get details, activate, introspect, validate, render, export |
| **Update** | `mcp_aql_update` | Edit elements, upgrade element format |
| **Delete** | `mcp_aql_delete` | Delete elements, clear memory entries |
| **Execute** | `mcp_aql_execute` | Run agents, confirm operations, manage execution lifecycle, handoffs |

### MCP-AQL Spec Features Implemented by DollhouseMCP

- **Gatekeeper** — The MCP-AQL spec defines an [optional Gatekeeper security model](https://github.com/MCPAQL/spec/blob/main/docs/security/gatekeeper.md) for multi-layer access control, confirmation requirements, and audit. DollhouseMCP implements this with element-driven policies, session confirmations, nuclear sandbox, and the full 4-layer enforcement pipeline.
- **CRUDE pattern** with all 5 endpoints, including the Execute endpoint for agent lifecycle
- **Introspection** with all query modes (operations, types, format, categories)
- **Batch operations** for multi-operation requests

### DollhouseMCP-Specific Extensions

- **Element-driven Gatekeeper policies** — Active Dollhouse elements (personas, skills, ensembles) dynamically add allow/confirm/deny policies that the Gatekeeper enforces. This is DollhouseMCP's extension beyond the base Gatekeeper spec.
- **Prescriptive Digest** — Active element state appended to every tool response, keeping the LLM aware of context changes.
- **Element-aware introspection** — `introspect` returns Dollhouse-specific format specs (`query: "format", name: "persona"`) alongside standard operation discovery.
- **Autonomy guidance** — Agent execution responses include `autonomy: { continue, factors, notifications }` for agentic loop control.

---

## The CRUDE Pattern

MCP-AQL extends traditional CRUD with an **Execute** endpoint:

| Endpoint | Safety | Description |
|----------|--------|-------------|
| **Create** | Non-destructive | Additive operations that create new state |
| **Read** | Read-only | Safe operations that query state |
| **Update** | Modifying | Operations that modify existing state |
| **Delete** | Destructive | Operations that remove state |
| **Execute** | Stateful | Runtime lifecycle operations (non-idempotent) |

The Execute endpoint exists because agent execution operations are inherently non-idempotent (calling `execute_agent` twice creates two separate executions) and manage runtime state rather than element definitions.

---

## Progressive Disclosure Through Introspection

The LLM starts with just 5 tool endpoints. It discovers everything else at runtime:

```javascript
// What operations exist?
{ operation: "introspect", params: { query: "operations" } }

// How do I use a specific operation?
{ operation: "introspect", params: { query: "operations", name: "create_element" } }

// What types are available?
{ operation: "introspect", params: { query: "types" } }

// What format does a persona need? (DollhouseMCP-specific)
{ operation: "introspect", params: { query: "format", name: "persona" } }
```

This is progressive disclosure built into the protocol — no special client features required. It works on any MCP client because introspection is just a standard tool call returning structured data.

---

## Token Efficiency

| Configuration | Tool Count | Token Cost | Reduction |
|--------------|------------|------------|-----------|
| Discrete Tools | ~50 tools | ~30,000 | Baseline |
| **CRUDE Mode** | 5 endpoints | ~4,300 | ~85% |
| **Single Mode** | 1 endpoint | ~350 | ~99% |

The savings scale with the number of operations — the more your server does, the greater the benefit.

---

## DollhouseMCP-Specific Documentation

| Document | Description |
|----------|-------------|
| [OVERVIEW.md](./OVERVIEW.md) | DollhouseMCP's MCP-AQL architecture, component diagram, request flow |
| [OPERATIONS.md](./OPERATIONS.md) | Complete DollhouseMCP operation reference with parameters and examples |
| [INTROSPECTION.md](./INTROSPECTION.md) | Introspection system details, schema integration, response structures |
| [ENDPOINT_MODES.md](./ENDPOINT_MODES.md) | CRUDE vs Single mode configuration, security trade-offs |
| [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) | Rationale for key design decisions |
| [DEBUGGING.md](./DEBUGGING.md) | Common errors, troubleshooting steps |

## DollhouseMCP Source Files

| Component | File | Description |
|-----------|------|-------------|
| MCPAQLHandler | `src/handlers/mcp-aql/MCPAQLHandler.ts` | Main entry point, orchestrates dispatch |
| OperationSchema | `src/handlers/mcp-aql/OperationSchema.ts` | Declarative operation definitions |
| SchemaDispatcher | `src/handlers/mcp-aql/SchemaDispatcher.ts` | Schema-driven handler dispatch |
| IntrospectionResolver | `src/handlers/mcp-aql/IntrospectionResolver.ts` | Runtime discovery system |
| Gatekeeper | `src/handlers/mcp-aql/Gatekeeper.ts` | Permission enforcement |
| UnifiedEndpoint | `src/handlers/mcp-aql/UnifiedEndpoint.ts` | Single mode routing |
| OperationRouter | `src/handlers/mcp-aql/OperationRouter.ts` | Operation-to-endpoint mapping |

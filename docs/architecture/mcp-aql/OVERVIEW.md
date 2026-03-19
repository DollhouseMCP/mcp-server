---
last_updated: 2026-01-03
version: 1.0.0
applies_to: PR #292 (MCP-AQL Single Endpoint)
---

# MCP-AQL Architecture Overview

> **MCP-AQL** (Model Context Protocol - Agent Query Language) is a unified interface
> that consolidates 50+ discrete MCP tools into 5 CRUDE endpoints (Create, Read,
> Update, Delete, Execute), providing ~96% token reduction while maintaining full
> functionality.

## Table of Contents

- [Architecture Summary](#architecture-summary)
- [The CRUDE Pattern](#the-crude-pattern)
- [Endpoint Modes](#endpoint-modes)
- [Token Efficiency](#token-efficiency)
- [Core Components](#core-components)
- [Request Flow](#request-flow)

---

## Architecture Summary

MCP-AQL provides a schema-driven operation dispatch system that:

1. **Consolidates Operations** - 50+ tools into 5 endpoints
2. **Enables Discovery** - GraphQL-style introspection for operation discovery
3. **Enforces Security** - Gatekeeper validates endpoint/operation matching
4. **Supports Flexibility** - Choose between CRUDE mode (5 endpoints) or Single mode (1 endpoint)

```mermaid
graph TB
    subgraph "MCP Client (LLM)"
        LLM[LLM Agent]
    end

    subgraph "MCP-AQL Layer"
        direction TB
        CRUDE[CRUDE Endpoints<br/>mcp_aql_create<br/>mcp_aql_read<br/>mcp_aql_update<br/>mcp_aql_delete<br/>mcp_aql_execute]
        SINGLE[Single Endpoint<br/>mcp_aql]

        GATE[Gatekeeper<br/>Route Validation]
        SCHEMA[OperationSchema<br/>Declarative Definitions]
        DISPATCH[SchemaDispatcher<br/>Handler Resolution]
        ROUTER[OperationRouter<br/>Endpoint Mapping]
    end

    subgraph "Handlers"
        ELEMENT[ElementCRUD]
        MEMORY[MemoryManager]
        AGENT[AgentManager]
        TEMPLATE[TemplateRenderer]
        PORTFOLIO[PortfolioHandler]
        COLLECTION[CollectionHandler]
    end

    LLM --> CRUDE
    LLM --> SINGLE
    CRUDE --> GATE
    SINGLE --> GATE
    GATE --> ROUTER
    ROUTER --> SCHEMA
    SCHEMA --> DISPATCH
    DISPATCH --> ELEMENT
    DISPATCH --> MEMORY
    DISPATCH --> AGENT
    DISPATCH --> TEMPLATE
    DISPATCH --> PORTFOLIO
    DISPATCH --> COLLECTION
```

---

## The CRUDE Pattern

MCP-AQL extends traditional CRUD with an **EXECUTE** endpoint, creating the CRUDE pattern:

| Endpoint | Safety | Description | Example Operations |
|----------|--------|-------------|-------------------|
| **CREATE** | Non-destructive | Additive operations that create new state | `create_element`, `import_element`, `activate_element` |
| **READ** | Read-only | Safe operations that query state | `list_elements`, `get_element`, `search`, `introspect` |
| **UPDATE** | Modifying | Operations that modify existing state | `edit_element` |
| **DELETE** | Destructive | Operations that remove state | `delete_element`, `clear` |
| **EXECUTE** | Stateful | Runtime lifecycle operations | `execute_agent`, `get_execution_state`, `complete_execution` |

### Permission Flags

Each endpoint has defined permission characteristics:

```typescript
// From src/handlers/mcp-aql/Gatekeeper.ts:67-73
private static readonly ENDPOINT_PERMISSIONS: Record<CRUDEndpoint, EndpointPermissions> = {
  CREATE: { readOnly: false, destructive: false },
  READ: { readOnly: true, destructive: false },
  UPDATE: { readOnly: false, destructive: true },
  DELETE: { readOnly: false, destructive: true },
  EXECUTE: { readOnly: false, destructive: true },  // Potentially destructive
};
```

### Why CRUDE not CRUD?

The EXECUTE endpoint was added because agent execution operations:
- Are inherently **non-idempotent** (calling `execute_agent` twice creates two executions)
- Manage **runtime state** rather than element definitions
- Require **lifecycle management** (start, update progress, complete)

```mermaid
graph LR
    subgraph "CRUD (Element Definitions)"
        C[Create]
        R[Read]
        U[Update]
        D[Delete]
    end

    subgraph "EXECUTE (Runtime Lifecycle)"
        E1[execute_agent]
        E2[get_execution_state]
        E3[record_execution_step]
        E4[complete_execution]
        E5[continue_execution]
    end

    C --> E1
    E1 --> E2
    E2 --> E3
    E3 --> E4
    E3 --> E5
```

---

## Endpoint Modes

MCP-AQL supports two operational modes, configurable via `MCP_INTERFACE_MODE`:

### CRUDE Mode (Default)

Exposes 5 separate endpoints, each with semantic meaning:

```
mcp_aql_create  - CREATE operations
mcp_aql_read    - READ operations
mcp_aql_update  - UPDATE operations
mcp_aql_delete  - DELETE operations
mcp_aql_execute - EXECUTE operations
```

**Advantages:**
- Clear semantic grouping
- Endpoint-level permission control
- Client can choose which endpoints to expose

**Token Cost:** ~4,314 tokens for tool registration

### Single Mode

Exposes 1 unified endpoint that routes internally:

```
mcp_aql - All operations through single entry point
```

**Advantages:**
- Minimal token footprint (~1,100 tokens)
- Simpler client integration
- Server-side routing enforcement

**Token Cost:** ~1,100 tokens for tool registration

```mermaid
graph TB
    subgraph "CRUDE Mode"
        C1[mcp_aql_create]
        C2[mcp_aql_read]
        C3[mcp_aql_update]
        C4[mcp_aql_delete]
        C5[mcp_aql_execute]
    end

    subgraph "Single Mode"
        S1[mcp_aql]
        S2[UnifiedEndpoint]
        S2 --> |routes to| C1
        S2 --> |routes to| C2
        S2 --> |routes to| C3
        S2 --> |routes to| C4
        S2 --> |routes to| C5
    end

    S1 --> S2
```

---

## Token Efficiency

### Token Reduction Analysis

Empirical measurements from Claude Code MCP tool listing:

| Configuration | Tool Registrations | Measured Tokens | Reduction |
|--------------|-------------------|-----------------|-----------|
| Discrete Tools | 42 | **~29,592** | — |
| CRUDE Mode | 5 endpoints | **~4,314** | 85% |
| Single Mode | 1 endpoint | **~1,100** | 96% |

### How LLMs Discover Operations

Instead of parsing 50+ tool schemas, LLMs use introspection:

```typescript
// Query all available operations
{ operation: "introspect", params: { query: "operations" } }

// Get details for a specific operation
{ operation: "introspect", params: { query: "operations", name: "create_element" } }

// Query available types
{ operation: "introspect", params: { query: "types", name: "ElementType" } }
```

---

## Core Components

### Component Architecture

```mermaid
classDiagram
    class MCPAQLHandler {
        +handleCreate(input)
        +handleRead(input)
        +handleUpdate(input)
        +handleDelete(input)
        +handleExecute(input)
        -executeOperation(input, endpoint)
        -dispatch(handlerRef, input)
    }

    class UnifiedEndpoint {
        +handle(input)
        -routeToHandler(endpoint, input)
    }

    class Gatekeeper {
        +validate(operation, endpoint)
        +enforce(input)
        +getPermissions(endpoint)
    }

    class OperationRouter {
        +getRoute(operation)
        +getOperationsForEndpoint(endpoint)
    }

    class OperationSchema {
        +SCHEMA_DRIVEN_OPERATIONS
        +isSchemaOperation(operation)
        +getOperationSchema(operation)
    }

    class SchemaDispatcher {
        +canDispatch(operation)
        +dispatch(operation, params, registry)
    }

    class IntrospectionResolver {
        +resolve(params)
        +listOperations()
        +getOperationDetails(name)
    }

    MCPAQLHandler --> Gatekeeper
    MCPAQLHandler --> OperationRouter
    MCPAQLHandler --> SchemaDispatcher
    UnifiedEndpoint --> MCPAQLHandler
    SchemaDispatcher --> OperationSchema
    IntrospectionResolver --> OperationSchema
```

### File Locations

| Component | File Path | Responsibility |
|-----------|-----------|----------------|
| MCPAQLHandler | `src/handlers/mcp-aql/MCPAQLHandler.ts` | Main entry point, orchestrates dispatch |
| UnifiedEndpoint | `src/handlers/mcp-aql/UnifiedEndpoint.ts` | Single endpoint mode routing |
| Gatekeeper | `src/handlers/mcp-aql/Gatekeeper.ts` | Route validation, policy enforcement |
| OperationRouter | `src/handlers/mcp-aql/OperationRouter.ts` | Operation-to-endpoint mapping |
| OperationSchema | `src/handlers/mcp-aql/OperationSchema.ts` | Declarative operation definitions |
| SchemaDispatcher | `src/handlers/mcp-aql/SchemaDispatcher.ts` | Schema-driven handler dispatch |
| IntrospectionResolver | `src/handlers/mcp-aql/IntrospectionResolver.ts` | GraphQL-style introspection |

---

## Request Flow

### Standard Request Flow

```mermaid
sequenceDiagram
    participant LLM as LLM Agent
    participant EP as Endpoint<br/>(CREATE/READ/UPDATE/DELETE/EXECUTE)
    participant Handler as MCPAQLHandler
    participant Gate as Gatekeeper
    participant Router as OperationRouter
    participant Schema as SchemaDispatcher
    participant Target as Target Handler

    LLM->>EP: { operation, params }
    EP->>Handler: handleCreate/Read/Update/Delete/Execute(input)
    Handler->>Handler: parseOperationInput(input)
    Handler->>Gate: validate(operation, endpoint)

    alt Invalid Route
        Gate-->>Handler: throw Error
        Handler-->>LLM: { success: false, error }
    end

    Handler->>Router: getRoute(operation)
    Router-->>Handler: { endpoint, handler, description }

    Handler->>Schema: canDispatch(operation)

    alt Schema-Driven Operation
        Schema->>Schema: getOperationSchema(operation)
        Schema->>Schema: validateRequiredParams()
        Schema->>Schema: mapParams()
        Schema->>Target: method(...args)
    else Legacy Operation
        Handler->>Target: dispatch via switch/case
    end

    Target-->>Handler: result
    Handler-->>LLM: { success: true, data: result }
```

### Batch Request Flow

MCP-AQL supports batch operations for executing multiple operations in a single request:

```typescript
// Batch request format
{
  operations: [
    { operation: "create_element", params: { ... } },
    { operation: "create_element", params: { ... } },
    { operation: "activate_element", params: { ... } }
  ]
}

// Batch result format
{
  success: true,
  results: [
    { index: 0, operation: "create_element", result: { success: true, data: ... } },
    { index: 1, operation: "create_element", result: { success: true, data: ... } },
    { index: 2, operation: "activate_element", result: { success: true, data: ... } }
  ],
  summary: { total: 3, succeeded: 3, failed: 0 }
}
```

---

## Related Documentation

- [OPERATIONS.md](./OPERATIONS.md) - Complete operation reference
- [INTROSPECTION.md](./INTROSPECTION.md) - Introspection system details
- [ENDPOINT_MODES.md](./ENDPOINT_MODES.md) - Mode configuration
- [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) - Design rationale
- [DEBUGGING.md](./DEBUGGING.md) - Troubleshooting guide

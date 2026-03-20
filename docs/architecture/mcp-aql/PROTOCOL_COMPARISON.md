---
last_updated: 2026-01-16
version: 1.3.0
applies_to: PR #297 (Field Selection)
---

# MCP-AQL Protocol Comparison Guide

> This document helps developers familiar with GraphQL, MongoDB, REST, SQL, or classic MCP
> understand MCP-AQL by mapping familiar concepts to their MCP-AQL equivalents.

## Table of Contents

- [Introduction](#introduction)
- [MCP-AQL vs Implementation](#mcp-aql-vs-implementation)
- [Quick Reference Table](#quick-reference-table)
- [For GraphQL Developers](#for-graphql-developers)
- [For MongoDB Developers](#for-mongodb-developers)
- [For REST API Developers](#for-rest-api-developers)
- [For SQL Developers](#for-sql-developers)
- [For Classic MCP Users](#for-classic-mcp-users)
- [Comprehensive Concept Mapping](#comprehensive-concept-mapping)
- [Code Examples: Same Operation Across Protocols](#code-examples-same-operation-across-protocols)

---

## Introduction

**MCP-AQL** (Model Context Protocol - Advanced Agent API Adapter Query Language) is a **protocol pattern**
for consolidating multiple MCP tools into semantic endpoints. The core ideas are:

- **CRUDE Endpoints** - Categorize operations by safety: Create, Read, Update, Delete, Execute
- **Operation Routing** - A single `operation` parameter dispatches to the appropriate handler
- **Schema-Driven Dispatch** - Declarative operation definitions with automatic validation
- **Introspection** - On-demand discovery replaces upfront schema parsing

### Token Efficiency by Mode

MCP-AQL supports multiple endpoint modes with different token trade-offs:

| Mode | Endpoints | Token Cost | Reduction | Use Case |
|------|-----------|------------|-----------|----------|
| **Discrete** | Many individual tools | ~30,000 | Baseline | Traditional MCP |
| **CRUDE** | 5 semantic endpoints | ~4,300 | ~85% | Host-level permission control |
| **Single** | 1 unified endpoint | ~1,100 | ~96% | Maximum token efficiency |

**Response Token Savings:** Field selection (`fields` parameter) provides additional ~73-86%
reduction in response tokens. Combined with endpoint consolidation, total savings can exceed 98%.

### Why Compare?

Developers often approach new protocols through the lens of what they already know. This guide
provides mental models for understanding MCP-AQL by drawing parallels to:

| Protocol | Similarity to MCP-AQL |
|----------|----------------------|
| **GraphQL** | Introspection, typed operations, nested input objects |
| **MongoDB** | Document-based operations, flexible queries |
| **REST** | Resource-oriented endpoints, HTTP-like semantics |
| **SQL** | Structured queries, CRUD operations |
| **Classic MCP** | Tool-based interface (what MCP-AQL can replace) |

---

## MCP-AQL vs Implementation

**Important Distinction:** MCP-AQL is a **protocol pattern**, not a specific implementation.

### MCP-AQL (The Protocol)

Core concepts that any MCP-AQL implementation shares:

| Concept | Description |
|---------|-------------|
| **CRUDE Endpoints** | 5 semantic categories based on operation safety |
| **`operation` parameter** | Routes requests to the appropriate handler |
| **`params` object** | Carries operation-specific parameters |
| **Schema-driven dispatch** | Operations defined declaratively, validated automatically |
| **Introspection** | Self-describing API via `introspect` operation |

### DollhouseMCP (A Reference Implementation)

This repository implements MCP-AQL for AI element management. DollhouseMCP-specific concepts include:

| Concept | Description |
|---------|-------------|
| **`element_type`** | DollhouseMCP resource types: persona, skill, template, agent, memory, ensemble |
| **`element_name`** | Identifier for a specific element instance |
| **Portfolio / Collection** | DollhouseMCP namespaces for local vs. community elements |
| **Operations like `create_element`** | DollhouseMCP's CRUD operations for elements |
| **Batch operations** | DollhouseMCP feature for multi-element processing |

### Adapting MCP-AQL for Your Project

If you're implementing MCP-AQL for a different domain (e.g., database management, file operations),
you would define your own:

- **Resource types** (instead of `element_type`)
- **Resource identifiers** (instead of `element_name`)
- **Domain-specific operations** (instead of `create_element`, etc.)

The protocol pattern remains the same; only the domain vocabulary changes.

---

### Core Design Philosophy

MCP-AQL optimizes for **LLM token efficiency** while maintaining **human readability**:

1. **Consolidated Endpoints** - Semantic grouping instead of many discrete tools
2. **On-Demand Discovery** - Introspection replaces upfront schema parsing
3. **Schema-Driven Dispatch** - Declarative operation definitions with automatic validation
4. **Flexible Parameter Resolution** - Multiple sources checked for each parameter

---

## Quick Reference Table

> **Note:** The MCP-AQL column shows examples using DollhouseMCP's domain vocabulary.
> Your implementation would use your own resource types and operation names.

| Concept | GraphQL | MongoDB | REST | SQL | MCP-AQL (Protocol) |
|---------|---------|---------|------|-----|-------------------|
| **Define Operation** | `mutation createUser` | `db.users.insertOne()` | `POST /users` | `INSERT INTO users` | `{ operation: "..." }` |
| **Specify Parameters** | `variables: { ... }` | `{ filter: { ... } }` | Request body / query params | `WHERE clause` | `params: { ... }` |
| **Target Type** | Type in schema | Collection name | URL path | Table name | Implementation-defined |
| **Read One** | `query { user(id) }` | `findOne({ _id })` | `GET /users/:id` | `SELECT ... WHERE id=` | Read operation |
| **Read Many** | `query { users }` | `find({})` | `GET /users` | `SELECT * FROM` | List operation |
| **Create** | `mutation { createUser }` | `insertOne()` | `POST /users` | `INSERT INTO` | Create operation |
| **Update** | `mutation { updateUser }` | `updateOne()` | `PUT /users/:id` | `UPDATE ... SET` | Update operation |
| **Delete** | `mutation { deleteUser }` | `deleteOne()` | `DELETE /users/:id` | `DELETE FROM` | Delete operation |
| **Search** | `query { search(q) }` | `find({ $text })` | `GET /search?q=` | `LIKE '%term%'` | Search operation |
| **Discover Schema** | `__schema` introspection | `db.getCollectionInfos()` | OpenAPI / Swagger | `DESCRIBE table` | `introspect` |
| **Field Selection** | Field list in query | Projection `{ field: 1 }` | `?fields=a,b` | `SELECT a, b` | `fields` param or preset |
| **Response Format** | `{ data, errors }` | Document / cursor | JSON body | Result set | `{ success, data/error }` |
| **Error Handling** | `errors` array | Exception | HTTP status codes | SQLSTATE | `{ success: false, error }` |

---

## For GraphQL Developers

If you're familiar with GraphQL, MCP-AQL will feel conceptually similar. Both protocols emphasize
typed operations, introspection, and structured inputs.

### Operations = Queries/Mutations

GraphQL separates read operations (queries) from write operations (mutations). MCP-AQL takes this
further with the **CRUDE pattern** (5 semantic categories):

| GraphQL | MCP-AQL Endpoint | Purpose |
|---------|------------------|---------|
| `query` | `mcp_aql_read` | Read-only operations |
| `mutation` (create) | `mcp_aql_create` | Additive operations |
| `mutation` (update) | `mcp_aql_update` | Modifying operations |
| `mutation` (delete) | `mcp_aql_delete` | Destructive operations |
| `subscription` | `mcp_aql_execute` | Runtime/stateful operations |

**GraphQL:**
```graphql
mutation CreateUser($input: UserInput!) {
  createUser(input: $input) {
    name
    email
  }
}
```

**MCP-AQL (generic pattern):**
```javascript
{
  operation: "create_resource",  // Operation name defined by implementation
  params: {
    resource_id: "user-123",     // Resource identifier
    name: "Alice",
    email: "alice@example.com"
  }
}
```

**DollhouseMCP example:**
```javascript
{
  operation: "create_element",      // DollhouseMCP operation
  element_type: "persona",          // DollhouseMCP resource type
  params: {
    element_name: "MyPersona",      // DollhouseMCP identifier
    description: "A helpful assistant",
    instructions: "You are helpful and thorough."
  }
}
```

### Resource Types

In GraphQL, you query specific types (`User`, `Post`). In MCP-AQL, implementations define their own
resource type parameter:

| GraphQL | MCP-AQL (Generic) | DollhouseMCP Example |
|---------|-------------------|---------------------|
| `type User` | Resource type parameter | `element_type: "persona"` |
| `type Post` | defined by implementation | `element_type: "skill"` |
| `type Comment` | | `element_type: "template"` |

### Introspection: `__schema` vs `introspect`

Both protocols support self-description. MCP-AQL's introspection is modeled after GraphQL:

**GraphQL:**
```graphql
{
  __schema {
    types { name }
    queryType { name }
  }
}
```

**MCP-AQL:**
```javascript
// List all operations
{ operation: "introspect", params: { query: "operations" } }

// Get specific operation details
{ operation: "introspect", params: { query: "operations", name: "create_resource" } }

// List available types
{ operation: "introspect", params: { query: "types" } }
```

### Nested Input Objects (GraphQL-style Updates)

MCP-AQL supports GraphQL-style nested `input` objects for updates. This allows partial updates
with deep merging:

**GraphQL:**
```graphql
mutation UpdateUser($id: ID!, $input: UpdateUserInput!) {
  updateUser(id: $id, input: $input) {
    name
  }
}
```

**MCP-AQL (generic pattern):**
```javascript
{
  operation: "update_resource",
  params: {
    resource_id: "user-123",
    input: {                    // Everything in 'input' gets deep-merged
      name: "Updated Name",
      settings: { theme: "dark" }
    }
  }
}
```

**DollhouseMCP example:**
```javascript
{
  operation: "edit_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    input: {
      description: "Updated description",
      metadata: { triggers: ["helper", "assistant"] }
    }
  }
}
```

### Field Selection (GraphQL-style)

MCP-AQL supports GraphQL-style field selection to reduce response token usage. Implementations
can support a `fields` parameter for specific fields or define presets for common use cases.

**MCP-AQL Pattern (Generic):**
```javascript
{
  operation: "list_resources",
  params: {
    fields: ["name", "description", "metadata.tags"]  // Implementation-defined field names
  }
}
// Returns only requested fields, reducing response tokens
```

**DollhouseMCP Example:**
```javascript
{
  operation: "list_elements",
  element_type: "persona",
  params: {
    fields: ["element_name", "description", "metadata.tags"]
  }
}
// Returns only requested fields, saving ~85% tokens
```

**Preset Field Sets (DollhouseMCP):**

DollhouseMCP defines preset field sets for common use cases:

```javascript
{
  operation: "get_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    fields: "minimal"  // Preset: element_name + description only
  }
}
```

| Preset | Fields Included | Token Savings |
|--------|-----------------|---------------|
| `minimal` | `element_name`, `description` | ~86% |
| `standard` | `element_name`, `description`, `metadata.tags`, `metadata.triggers` | ~73% |
| `full` | All fields (default) | 0% |

> **Note:** Preset names and field mappings are implementation-specific.
> Other MCP-AQL implementations may define different presets for their domain.

### Key Differences from GraphQL

| Aspect | GraphQL | MCP-AQL |
|--------|---------|---------|
| **Field Selection** | Client selects specific fields | `fields` param or presets (`minimal`, `standard`, `full`) |
| **Subscriptions** | Real-time WebSocket streams | EXECUTE for stateful lifecycle |
| **Schema Definition** | SDL files | Declarative `OperationSchema.ts` |
| **Fragments/Aliases** | Supported | Not applicable |
| **Batching** | DataLoader pattern | Built-in batch operations |

---

## For MongoDB Developers

If you're familiar with MongoDB, MCP-AQL's document-oriented operations and flexible query patterns
will feel natural.

> **Note:** Examples in this section use DollhouseMCP's vocabulary (`element_type`, `element_name`).
> Your implementation would define its own resource types and identifiers.

### Resource Types (like Collections)

MongoDB organizes documents into collections. MCP-AQL implementations define resource type parameters:

| MongoDB | MCP-AQL Pattern | DollhouseMCP Example |
|---------|-----------------|---------------------|
| `db.users` | Resource type parameter | `element_type: "persona"` |
| `db.posts` | defined by implementation | `element_type: "skill"` |
| `db.comments` | | `element_type: "template"` |
| Collection name in method | Passed as parameter | `element_type` parameter |

### CRUD Method Mapping

| MongoDB | MCP-AQL |
|---------|---------|
| `insertOne()` | `create_element` |
| `find()` | `list_elements` |
| `findOne()` | `get_element` |
| `updateOne()` | `edit_element` |
| `deleteOne()` | `delete_element` |
| `aggregate()` | `search` or `query_elements` |

**MongoDB:**
```javascript
db.personas.insertOne({
  name: "MyPersona",
  description: "A helpful assistant",
  instructions: "You are helpful and thorough."
})
```

**MCP-AQL:**
```javascript
{
  operation: "create_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    description: "A helpful assistant",
    instructions: "You are helpful and thorough."
  }
}
```

### Query Patterns

**MongoDB Find:**
```javascript
db.personas.find({
  tags: { $in: ["creative", "writing"] }
}).limit(10)
```

**MCP-AQL Search:**
```javascript
{
  operation: "search",
  params: {
    query: "creative writing",
    scope: "local",
    limit: 10
  }
}
```

### Update Patterns

MongoDB's `$set` operator is similar to MCP-AQL's deep-merge `input`:

**MongoDB:**
```javascript
db.personas.updateOne(
  { name: "MyPersona" },
  { $set: {
    description: "Updated",
    "metadata.triggers": ["helper"]
  }}
)
```

**MCP-AQL:**
```javascript
{
  operation: "edit_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    input: {
      description: "Updated",
      metadata: {
        triggers: ["helper"]
      }
    }
  }
}
```

### Key Differences from MongoDB

| Aspect | MongoDB | MCP-AQL |
|--------|---------|---------|
| **Query Operators** | Rich ($gt, $in, $regex) | Simplified search/filter |
| **Aggregation** | Complex pipelines | Normalized via `search` operation |
| **Indexes** | User-defined | Managed by server |
| **Transactions** | Multi-document ACID | Per-operation atomicity |
| **Cursors** | Iterable result sets | Paginated responses |

---

## For REST API Developers

If you're familiar with REST APIs, MCP-AQL maps cleanly to RESTful patterns while adding
semantic grouping and introspection.

> **Note:** Examples in this section use DollhouseMCP's vocabulary (`element_type`, `element_name`).
> Your implementation would define its own resource types, identifiers, and operation names.

### HTTP Methods = CRUDE Endpoints

REST uses HTTP methods for semantics. MCP-AQL uses 5 semantic endpoints:

| HTTP Method | MCP-AQL Endpoint | Description |
|-------------|------------------|-------------|
| `POST` (create) | `mcp_aql_create` | Create new resources |
| `GET` | `mcp_aql_read` | Read resources |
| `PUT` / `PATCH` | `mcp_aql_update` | Modify resources |
| `DELETE` | `mcp_aql_delete` | Remove resources |
| N/A | `mcp_aql_execute` | Runtime operations |

### URL Paths = operation + resource parameters

REST encodes resources in URLs. MCP-AQL uses `operation` plus implementation-defined parameters:

| REST Pattern | MCP-AQL Pattern | DollhouseMCP Example |
|--------------|-----------------|---------------------|
| `GET /resources` | `{ operation: "list_..." }` | `list_elements` + `element_type` |
| `GET /resources/:id` | `{ operation: "get_...", params: { id } }` | `get_element` + `element_name` |
| `POST /resources` | `{ operation: "create_...", params: { ... } }` | `create_element` |
| `PUT /resources/:id` | `{ operation: "update_...", params: { id, input } }` | `edit_element` |
| `DELETE /resources/:id` | `{ operation: "delete_...", params: { id } }` | `delete_element` |

### Request/Response Patterns

**REST:**
```http
POST /api/personas HTTP/1.1
Content-Type: application/json

{
  "name": "MyPersona",
  "description": "A helpful assistant",
  "instructions": "You are helpful and thorough."
}
```

Response:
```json
{
  "id": "123",
  "name": "MyPersona",
  "description": "A helpful assistant",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**MCP-AQL:**
```javascript
// Request
{
  operation: "create_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    description: "A helpful assistant",
    instructions: "You are helpful and thorough."
  }
}

// Response
{
  success: true,
  data: {
    name: "MyPersona",
    type: "persona",
    description: "A helpful assistant",
    // ... full element data
  }
}
```

### Error Handling

| REST | MCP-AQL |
|------|---------|
| HTTP 200 OK | `{ success: true, data: ... }` |
| HTTP 400 Bad Request | `{ success: false, error: "Invalid parameter..." }` |
| HTTP 404 Not Found | `{ success: false, error: "Element not found..." }` |
| HTTP 500 Internal Error | `{ success: false, error: "..." }` |

### API Documentation = Introspection

REST APIs use OpenAPI/Swagger for documentation. MCP-AQL uses introspection:

**OpenAPI (conceptual):**
```yaml
paths:
  /personas:
    post:
      summary: Create a persona
      parameters: [...]
```

**MCP-AQL:**
```javascript
// Discover all operations
{ operation: "introspect", params: { query: "operations" } }

// Get specific operation docs
{ operation: "introspect", params: { query: "operations", name: "create_element" } }

// Returns:
{
  operation: {
    name: "create_element",
    endpoint: "CREATE",
    mcpTool: "mcp_aql_create",
    description: "Create a new element of any type",
    parameters: [
      { name: "element_name", type: "string", required: true, description: "Element name" },
      // ...
    ],
    examples: [...]
  }
}
```

### Key Differences from REST

| Aspect | REST | MCP-AQL |
|--------|------|---------|
| **Transport** | HTTP | MCP (stdio/SSE) |
| **Versioning** | URL path (`/v1/...`) | Schema version in response |
| **HATEOAS** | Links in responses | Introspection for discovery |
| **Caching** | HTTP headers | Server-managed |
| **Authentication** | Headers (Bearer, API key) | MCP session/GitHub OAuth |

---

## For SQL Developers

If you're familiar with SQL, MCP-AQL's structured operations and type system will feel familiar,
though the query patterns differ.

> **Note:** Examples in this section use DollhouseMCP's vocabulary (`element_type`, `element_name`).
> Your implementation would define its own resource types and operation names.

### Resource Types (like Tables)

SQL organizes data into tables. MCP-AQL implementations define resource type parameters:

| SQL | MCP-AQL Pattern | DollhouseMCP Example |
|-----|-----------------|---------------------|
| `users` table | Resource type parameter | `element_type: "persona"` |
| `posts` table | defined by implementation | `element_type: "skill"` |
| `SELECT * FROM users` | List operation | `list_elements` with `element_type` |

### SQL Statement Mapping

| SQL | MCP-AQL Pattern | DollhouseMCP Example |
|-----|-----------------|---------------------|
| `INSERT INTO` | Create operation | `create_element` |
| `SELECT * FROM` | List operation | `list_elements` |
| `SELECT ... WHERE id =` | Get operation | `get_element` |
| `UPDATE ... SET` | Update operation | `edit_element` |
| `DELETE FROM` | Delete operation | `delete_element` |
| `SELECT ... WHERE ... LIKE` | Search operation | `search` |

### Query Examples

**SQL INSERT:**
```sql
INSERT INTO personas (name, description, instructions)
VALUES ('MyPersona', 'A helpful assistant', 'You are helpful and thorough.');
```

**MCP-AQL:**
```javascript
{
  operation: "create_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    description: "A helpful assistant",
    instructions: "You are helpful and thorough."
  }
}
```

**SQL SELECT:**
```sql
SELECT * FROM personas WHERE name = 'MyPersona';
```

**MCP-AQL:**
```javascript
{
  operation: "get_element",
  element_type: "persona",
  params: { element_name: "MyPersona" }
}
```

**SQL UPDATE:**
```sql
UPDATE personas
SET description = 'Updated description'
WHERE name = 'MyPersona';
```

**MCP-AQL:**
```javascript
{
  operation: "edit_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    input: { description: "Updated description" }
  }
}
```

**SQL SEARCH:**
```sql
SELECT * FROM personas
WHERE description LIKE '%creative%'
   OR instructions LIKE '%creative%'
LIMIT 10;
```

**MCP-AQL:**
```javascript
{
  operation: "search",
  params: {
    query: "creative",
    scope: "local",
    type: "persona",
    limit: 10
  }
}
```

### Schema Discovery

| SQL | MCP-AQL |
|-----|---------|
| `DESCRIBE personas` | `introspect` with `query: "types"` |
| `SHOW TABLES` | `introspect` with `query: "operations"` |

### Key Differences from SQL

| Aspect | SQL | MCP-AQL |
|--------|-----|---------|
| **Query Language** | Declarative SQL | Structured JSON |
| **Joins** | Complex multi-table joins | Element relationships via handlers |
| **Transactions** | BEGIN/COMMIT/ROLLBACK | Per-operation atomicity |
| **Indexes** | User-defined CREATE INDEX | Managed by server |
| **Stored Procedures** | User-defined functions | Agent execution |

---

## For Classic MCP Users (DollhouseMCP Migration)

This section is specific to **DollhouseMCP users** migrating from the discrete tool interface
to MCP-AQL. If you're implementing MCP-AQL for a different project, use this as a reference
for how consolidation works.

### Before: 40+ Discrete DollhouseMCP Tools

The original DollhouseMCP exposed each operation as a separate tool:

```
create_persona          delete_persona          list_personas
create_skill            delete_skill            list_skills
create_template         delete_template         list_templates
create_agent            delete_agent            list_agents
create_memory           delete_memory           list_memories
create_ensemble         delete_ensemble         list_ensembles
get_persona             edit_persona            activate_persona
get_skill               edit_skill              deactivate_persona
get_template            render_template         search_elements
get_agent               execute_agent           validate_element
get_memory              add_memory_entry        clear_memory
...and more (40+ total tools)
```

**Token cost:** ~30,000 tokens for tool registrations

### After: 5 CRUDE Endpoints

MCP-AQL consolidates into 5 semantic endpoints:

```
mcp_aql_create  - CREATE operations (create, import, activate, add entry)
mcp_aql_read    - READ operations (list, get, search, introspect)
mcp_aql_update  - UPDATE operations (edit)
mcp_aql_delete  - DELETE operations (delete, clear)
mcp_aql_execute - EXECUTE operations (execute_agent, update state)
```

**Token cost by mode:**
| Mode | Token Cost | Reduction |
|------|------------|-----------|
| CRUDE (5 endpoints) | ~4,300 | ~85% |
| Single (1 endpoint) | ~1,100 | ~96% |

### Migration Examples

**Before (Classic MCP):**
```javascript
// Tool: create_persona
{
  name: "MyPersona",
  description: "A helpful assistant",
  instructions: "You are helpful and thorough."
}
```

**After (MCP-AQL):**
```javascript
// Endpoint: mcp_aql_create
{
  operation: "create_element",
  element_type: "persona",
  params: {
    element_name: "MyPersona",
    description: "A helpful assistant",
    instructions: "You are helpful and thorough."
  }
}
```

**Before (Classic MCP):**
```javascript
// Tool: list_personas
{ page: 1, pageSize: 10 }
```

**After (MCP-AQL):**
```javascript
// Endpoint: mcp_aql_read
{
  operation: "list_elements",
  element_type: "persona",
  params: { page: 1, pageSize: 10 }
}
```

### Tool to Operation Mapping

| Classic Tool | MCP-AQL Operation | Endpoint |
|--------------|-------------------|----------|
| `create_persona` | `create_element` + `element_type: "persona"` | CREATE |
| `list_personas` | `list_elements` + `element_type: "persona"` | READ |
| `get_persona` | `get_element` + `element_type: "persona"` | READ |
| `edit_persona` | `edit_element` + `element_type: "persona"` | UPDATE |
| `delete_persona` | `delete_element` + `element_type: "persona"` | DELETE |
| `activate_persona` | `activate_element` + `element_type: "persona"` | CREATE |
| `search_elements` | `search` | READ |
| `render_template` | `render` | READ |
| `execute_agent` | `execute_agent` | EXECUTE |
| `add_memory_entry` | `addEntry` | CREATE |
| `clear_memory` | `clear` | DELETE |

### Permission Model Changes

**Before:** Each tool had implicit permissions based on naming convention.

**After:** Explicit CRUDE endpoint permissions:

| Endpoint | readOnly | destructive | Description |
|----------|----------|-------------|-------------|
| CREATE | false | false | Additive, non-destructive |
| READ | true | false | Safe, read-only |
| UPDATE | false | true | Modifying |
| DELETE | false | true | Destructive |
| EXECUTE | false | true | Potentially destructive, non-idempotent |

### Discovery Changes

**Before:** LLMs parsed all 40+ tool schemas upfront (~30,000 tokens).

**After:** LLMs use introspection for on-demand discovery:

```javascript
// Step 1: Quick discovery (~50 tokens)
{ operation: "introspect", params: { query: "operations" } }

// Step 2: Get details for relevant operation (~100 tokens)
{ operation: "introspect", params: { query: "operations", name: "create_resource" } }

// Step 3: Use the operation
{ operation: "create_resource", ... }
```

### Batch Operations (DollhouseMCP Feature)

DollhouseMCP's MCP-AQL implementation includes batch operations for multi-element processing:

```javascript
// Execute multiple operations in a single request
{
  operations: [
    { operation: "create_element", element_type: "persona", params: { ... } },
    { operation: "create_element", element_type: "skill", params: { ... } },
    { operation: "activate_element", element_type: "persona", params: { ... } }
  ]
}

// Response includes results for each operation
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

> **Note:** Batch operations are a DollhouseMCP feature. Other MCP-AQL implementations
> may or may not include similar functionality.

---

## Comprehensive Concept Mapping

This table maps concepts across all compared protocols. The MCP-AQL column shows **protocol-level**
concepts, while the DollhouseMCP column shows **implementation-specific** examples.

| Concept | GraphQL | MongoDB | REST | SQL | MCP-AQL (Protocol) | DollhouseMCP (Example) |
|---------|---------|---------|------|-----|-------------------|----------------------|
| **Namespace** | Schema | Database | Base URL | Schema | Implementation-defined | Portfolio / Collection |
| **Type/Entity** | Type | Collection | Resource | Table | Resource type param | `element_type` |
| **Instance** | Object | Document | Resource instance | Row | Element | Element |
| **Identifier** | ID field | `_id` | Path param | Primary key | Name | `element_name` |
| **Create** | Mutation | `insertOne` | POST | INSERT | `create_*` | `create_element` |
| **Read One** | Query | `findOne` | GET /:id | SELECT ... WHERE | `get_*` | `get_element` |
| **Read Many** | Query | `find` | GET / | SELECT * | `list_*` | `list_elements` |
| **Update** | Mutation | `updateOne` | PUT/PATCH | UPDATE | `edit_*` | `edit_element` |
| **Delete** | Mutation | `deleteOne` | DELETE | DELETE | `delete_*` | `delete_element` |
| **Search** | Query | `find`+text | GET /search | LIKE/FTS | `search_*` | `search` |
| **Schema Discovery** | `__schema` | `getCollectionInfos` | OpenAPI | DESCRIBE | Tool schemas | `introspect` |
| **Parameters** | Variables | Filter/options | Query/body | WHERE/VALUES | Tool params | `params` |
| **Response** | `{ data, errors }` | Document | JSON body | Result set | Tool result | `{ success, data/error }` |
| **Error** | `errors` array | Exception | HTTP status | SQLSTATE | Error text | `{ success: false, error }` |
| **Batch** | N/A (single) | `insertMany` | Bulk endpoint | Transaction | N/A | `operations` array |
| **Pagination** | `first/after` | `skip/limit` | Query params | OFFSET/LIMIT | `page/pageSize` | `page/limit` |

---

## Code Examples: Same Operation Across Protocols

> **Note:** The MCP-AQL examples in this section use DollhouseMCP's vocabulary.
> Your implementation would use your own resource types and operation names.

### Example 1: Create a Resource

**GraphQL:**
```graphql
mutation CreateUser($input: UserInput!) {
  createUser(input: $input) {
    id
    name
    email
  }
}

# Variables
{
  "input": {
    "name": "CreativeWriter",
    "email": "writer@example.com",
    "bio": "A creative writing assistant"
  }
}
```

**MongoDB:**
```javascript
db.users.insertOne({
  name: "CreativeWriter",
  email: "writer@example.com",
  bio: "A creative writing assistant",
  created_at: new Date()
});
```

**REST:**
```http
POST /api/personas HTTP/1.1
Content-Type: application/json

{
  "name": "CreativeWriter",
  "description": "A creative writing assistant",
  "instructions": "You are a creative writer who excels at storytelling, poetry, and imaginative content."
}
```

**SQL:**
```sql
INSERT INTO personas (name, description, instructions, created_at)
VALUES (
  'CreativeWriter',
  'A creative writing assistant',
  'You are a creative writer who excels at storytelling, poetry, and imaginative content.',
  NOW()
);
```

**Classic MCP:**
```javascript
// Tool: create_persona
{
  name: "CreativeWriter",
  description: "A creative writing assistant",
  instructions: "You are a creative writer who excels at storytelling, poetry, and imaginative content."
}
```

**MCP-AQL:**
```javascript
// Endpoint: mcp_aql_create
{
  operation: "create_element",
  element_type: "persona",
  params: {
    element_name: "CreativeWriter",
    description: "A creative writing assistant",
    instructions: "You are a creative writer who excels at storytelling, poetry, and imaginative content."
  }
}
```

### Example 2: Search for Elements

**GraphQL:**
```graphql
query SearchPersonas($query: String!, $limit: Int) {
  searchPersonas(query: $query, limit: $limit) {
    results {
      name
      description
    }
    total
  }
}

# Variables
{ "query": "creative writing", "limit": 10 }
```

**MongoDB:**
```javascript
db.personas.find({
  $text: { $search: "creative writing" }
}).limit(10).toArray();
```

**REST:**
```http
GET /api/personas/search?q=creative+writing&limit=10 HTTP/1.1
```

**SQL:**
```sql
SELECT * FROM personas
WHERE description LIKE '%creative%'
   OR description LIKE '%writing%'
LIMIT 10;
```

**Classic MCP:**
```javascript
// Tool: search_elements
{
  query: "creative writing",
  type: "persona",
  limit: 10
}
```

**MCP-AQL:**
```javascript
// Endpoint: mcp_aql_read
{
  operation: "search",
  params: {
    query: "creative writing",
    type: "persona",
    scope: "local",
    limit: 10
  }
}
```

### Example 3: Update an Element

**GraphQL:**
```graphql
mutation UpdatePersona($name: String!, $input: UpdatePersonaInput!) {
  updatePersona(name: $name, input: $input) {
    name
    description
  }
}

# Variables
{
  "name": "CreativeWriter",
  "input": {
    "description": "An enhanced creative writing assistant with poetry expertise"
  }
}
```

**MongoDB:**
```javascript
db.personas.updateOne(
  { name: "CreativeWriter" },
  { $set: { description: "An enhanced creative writing assistant with poetry expertise" } }
);
```

**REST:**
```http
PATCH /api/personas/CreativeWriter HTTP/1.1
Content-Type: application/json

{
  "description": "An enhanced creative writing assistant with poetry expertise"
}
```

**SQL:**
```sql
UPDATE personas
SET description = 'An enhanced creative writing assistant with poetry expertise'
WHERE name = 'CreativeWriter';
```

**Classic MCP:**
```javascript
// Tool: edit_persona
{
  name: "CreativeWriter",
  description: "An enhanced creative writing assistant with poetry expertise"
}
```

**MCP-AQL:**
```javascript
// Endpoint: mcp_aql_update
{
  operation: "edit_element",
  element_type: "persona",
  params: {
    element_name: "CreativeWriter",
    input: {
      description: "An enhanced creative writing assistant with poetry expertise"
    }
  }
}
```

### Example 4: Discover Available Operations

**GraphQL:**
```graphql
{
  __schema {
    mutationType {
      fields {
        name
        description
      }
    }
  }
}
```

**MongoDB:**
```javascript
// No direct equivalent - typically use documentation
db.getCollectionInfos();
```

**REST:**
```http
GET /api/openapi.json HTTP/1.1
# or
GET /api/swagger.json HTTP/1.1
```

**SQL:**
```sql
SHOW TABLES;
DESCRIBE personas;
```

**Classic MCP:**
```
# No dedicated operation - parsed from tool schemas
# (Consumed ~30,000 tokens for all 40+ tools)
```

**MCP-AQL:**
```javascript
// Endpoint: mcp_aql_read
// List all operations
{ operation: "introspect", params: { query: "operations" } }

// Get details for specific operation
{ operation: "introspect", params: { query: "operations", name: "edit_element" } }

// List available types
{ operation: "introspect", params: { query: "types" } }
```

---

## Summary

MCP-AQL combines the best patterns from established protocols:

- **From GraphQL:** Introspection, typed operations, nested input objects, **field selection**
- **From MongoDB:** Flexible document operations, simple query patterns
- **From REST:** Semantic endpoint grouping, clear resource addressing
- **From SQL:** Structured CRUD operations, schema awareness

The result is a protocol optimized for **LLM token efficiency** while remaining **human-readable**
and **developer-friendly**.

### Token Efficiency Summary

| Feature | Token Savings | Description |
|---------|---------------|-------------|
| **CRUDE Consolidation** | ~85-96% | Semantic endpoints instead of discrete tools |
| **On-Demand Introspection** | ~95% | Query schemas as needed vs. upfront parsing |
| **Field Selection** | ~70-90% | Return only requested fields in responses |

> Token savings are implementation-dependent. Values shown are from DollhouseMCP benchmarks.

For more details, see:
- [OVERVIEW.md](./OVERVIEW.md) - Architecture overview
- [OPERATIONS.md](./OPERATIONS.md) - Complete operation reference
- [INTROSPECTION.md](./INTROSPECTION.md) - Discovery system
- [DESIGN_DECISIONS.md](./DESIGN_DECISIONS.md) - Design rationale

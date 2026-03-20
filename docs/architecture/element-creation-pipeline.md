# Element Creation Pipeline Reference

> **Issue #722** | Last updated: 2026-03-12

This document maps the 6-stage pipeline that every `create_element` call passes through. Use it when:

- **Adding a new field** to an existing element type
- **Creating a new element type** entirely
- **Debugging** why a field isn't persisting or loading correctly

---

## Pipeline Overview

```
Client (create_element)
  │
  ▼
┌─────────────────────────────────────┐
│ Stage 1: OperationSchema            │  Declares parameter exists
│   src/handlers/mcp-aql/             │  (type, description, optional/required)
│   OperationSchema.ts                │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Stage 2: SchemaDispatcher           │  Routes param → metadata or top-level
│   src/handlers/mcp-aql/             │  (namedWithType case in buildArgs)
│   SchemaDispatcher.ts               │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Stage 3: createElement handler      │  Validates, sanitizes, delegates
│   src/handlers/element-crud/        │  to type-specific manager
│   createElement.ts                  │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Stage 4: Manager.create()           │  Assigns field to in-memory object
│   src/elements/{type}/              │  (or src/persona/ for personas)
│   {Type}Manager.ts                  │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Stage 5: Manager.serializeElement() │  Writes field to YAML frontmatter
│   Same manager file                 │  or body content
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Stage 6: Manager.parseMetadata()    │  Validates field on read
│   Same manager file                 │  (fail-open: strip malformed, log)
└─────────────────────────────────────┘
```

**Key principle:** The pipeline is NOT dynamic. Adding a new field requires manual changes at all 6 stages. Schema declaration alone is NOT sufficient.

---

## Stage Details

### Stage 1: OperationSchema — Parameter Declaration

**File:** `src/handlers/mcp-aql/OperationSchema.ts`
**Section:** `create_element` schema definition (~line 779)

This is where you tell the MCP protocol that a parameter exists. Every field a client can pass must be declared here with its type and description.

**Currently declared parameters:**

| Parameter | Type | Applies To | Required |
|-----------|------|-----------|----------|
| `element_name` | string | All | Yes |
| `element_type` | string | All | Yes |
| `description` | string | All | Yes |
| `instructions` | string | All | No |
| `content` | string | All | No |
| `category` | string | Skill, Template, Memory | No |
| `metadata` | object | All | No |
| `tags` | string[] | All | No |
| `triggers` | string[] | All | No |
| `goal` | object | Agent | No |
| `activates` | object | Agent | No |
| `tools` | object | Agent | No |
| `systemPrompt` | string | Agent | No |
| `autonomy` | object | Agent | No |
| `resilience` | object | Agent | No |
| `elements` | array | Ensemble | No |
| `gatekeeper` | object | All types | No |

**To add a new param:** Add an entry to the `params` object in the `create_element` schema. Include inline comments marking which element type it applies to and which issue introduced it.

---

### Stage 2: SchemaDispatcher — Field Routing

**File:** `src/handlers/mcp-aql/SchemaDispatcher.ts`
**Method:** `buildArgs()`, `namedWithType` case (~line 547)

This stage takes flat params from the client and routes them to the correct location in the args object. Fields that belong in metadata get merged into `result.metadata`.

**Routing rules:**

| Field | Routing | Condition |
|-------|---------|-----------|
| `tags` | → `metadata.tags` | Any element type |
| `triggers` | → `metadata.triggers` | Any element type |
| `goal` | → `metadata.goal` | Agent only (`isAgent` guard) |
| `activates` | → `metadata.activates` | Agent only |
| `tools` | → `metadata.tools` | Agent only |
| `systemPrompt` | → `metadata.systemPrompt` | Agent only |
| `autonomy` | → `metadata.autonomy` | Agent only |
| `resilience` | → `metadata.resilience` | Agent only |
| `elements` | → `metadata.elements` | Ensemble only |
| `gatekeeper` | → `metadata.gatekeeper` | Any type (Issue #666) |
| `description` | pass-through | — |
| `instructions` | pass-through | — |
| `content` | pass-through | — |
| `category` | pass-through | — |

**To add a new field:** Add merge logic in the `namedWithType` case. Use the `isAgent` / `isEnsemble` guard pattern for type-specific fields. Add the field name to the `dispatchOnlyParams` filter set so it's stripped from the final args (it's now in metadata).

---

### Stage 3: createElement Handler — Validation & Delegation

**File:** `src/handlers/element-crud/createElement.ts`
**Lines:** ~150–413

This stage validates inputs and delegates to the correct manager. It contains the central `switch` on element type.

**Cross-cutting validations performed here:**
- Content size check (~line 172)
- Instructions size check (~line 188)
- Category format validation — skills, templates, memories only (~line 207)
- Unknown metadata property detection (~line 215)
- `sanitizeMetadata()` on the metadata object (~line 201)

**Type-specific delegation:**

| Type | Manager Call | Signature |
|------|------------|-----------|
| Persona | `personaManager.create(metadata)` | `Partial<PersonaElementMetadata> & {instructions?, content?}` |
| Skill | `skillManager.create(metadata)` | `Partial<SkillMetadata> & {instructions?, content?}` |
| Template | `templateManager.create(metadata)` | `{name, description, content?, instructions?, metadata?}` |
| Agent | `agentManager.create(name, desc, instructions, metadata)` | 4 positional params |
| Memory | `memoryManager.create(metadata)` | `Partial<MemoryMetadata> & {content?, instructions?}` |
| Ensemble | `ensembleManager.create(metadata)` | `Partial<EnsembleMetadata> & {instructions?, content?}` |

**Note:** Agent has a unique 4-param signature. All others pass a single metadata object.

**To add a new field:** If validation is needed before reaching the manager (e.g., format checks like category), add it in the pre-dispatch section. Then ensure the field is included in the delegation call to the manager.

---

### Stage 4: Manager.create() — In-Memory Assignment

Each manager file lives in its own directory:

| Type | File |
|------|------|
| Persona | `src/persona/PersonaManager.ts` |
| Skill | `src/elements/skills/SkillManager.ts` |
| Template | `src/elements/templates/TemplateManager.ts` |
| Agent | `src/elements/agents/AgentManager.ts` |
| Memory | `src/elements/memories/MemoryManager.ts` |
| Ensemble | `src/elements/ensembles/EnsembleManager.ts` |

This stage takes the validated inputs and assigns them to the in-memory element object (or class instance).

**To add a new field:** Ensure the `create()` method reads the field from its input and assigns it to the element data structure. For agent V2 fields, this is inside the `if (metadata.goal)` / V2 detection block.

---

### Stage 5: Manager.serializeElement() — File Write

Same manager files as Stage 4. This stage writes the element to disk as YAML frontmatter + markdown body (or pure YAML for memories).

**Serialization formats by type:**

| Type | Format | Instructions | Content |
|------|--------|-------------|---------|
| Persona | YAML frontmatter + MD body | In frontmatter | Body |
| Skill | YAML frontmatter + MD body | In frontmatter | Body |
| Template | YAML frontmatter + MD body | In frontmatter | Body (template placeholders) |
| Agent | YAML frontmatter + MD body | In frontmatter | Body |
| Memory | Pure YAML (metadata + entries) | In metadata | Via entries |
| Ensemble | YAML frontmatter + MD body | In frontmatter | Body |

**Agent V2 serialization note:** Agent uses an explicit field whitelist in `serializeElement()`. New metadata fields MUST be added to this whitelist or they will be silently dropped.

**To add a new field:** Add the field to the serialization output. For agents, add it to the explicit whitelist. For other types that use `BaseElementManager.createFrontmatter()`, the field may flow through automatically if it's in the metadata object — but verify.

---

### Stage 6: Manager.parseMetadata() — Read Validation

Same manager files. This stage validates field structure when reading an element from disk. Uses **fail-open** semantics: malformed fields are stripped and logged, not thrown.

**Validation coverage by type:**

| Type | Validated Fields |
|------|-----------------|
| Persona | (via MetadataService normalization) |
| Skill | triggers (TriggerValidationService), gatekeeper (sanitize) |
| Template | (via sanitizeMetadata) |
| Agent | goal, activates, tools, systemPrompt, autonomy, resilience, tags, gatekeeper |
| Memory | (via SecureYamlParser), gatekeeper (sanitize) |
| Ensemble | name, description, activationStrategy, conflictResolution, contextSharing, resourceLimits, elements (deep validation), gatekeeper |

**To add a new field:** Add structural validation in the type's `parseMetadata()`. Follow the pattern: check type → strip if malformed → log warning. Never throw from parseMetadata — elements must remain loadable.

---

## Field Coverage Matrix

This matrix shows which fields are handled at each stage for each element type.

### Common Fields (All Types)

| Field | Schema | Dispatcher | createElement | create() | serialize | parse |
|-------|--------|-----------|--------------|----------|-----------|-------|
| name | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| element_type | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| description | ✓ | pass | ✓ | ✓ | ✓ | ✓ |
| instructions | ✓ | pass | ✓ | ✓ | ✓ | ✓ |
| content | ✓ | pass | ✓ | ✓ | ✓ | ✓ |
| tags | ✓ | → meta | ✓ | ✓ | ✓ | ✓ |
| triggers | ✓ | → meta | ✓ | ✓ | ✓ | validate |
| metadata | ✓ | pass | sanitize | ✓ | merged | ✓ |
| gatekeeper | ✓ | → meta | ✗ | varies | ✓ | sanitize |

### Agent V2 Fields

| Field | Schema | Dispatcher | createElement | create() | serialize | parse |
|-------|--------|-----------|--------------|----------|-----------|-------|
| goal | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |
| activates | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |
| tools | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |
| systemPrompt | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |
| autonomy | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |
| resilience | ✓ | → meta (agent) | ✓ | ✓ | ✓ | validate |

### Ensemble-Specific Fields

| Field | Schema | Dispatcher | createElement | create() | serialize | parse |
|-------|--------|-----------|--------------|----------|-----------|-------|
| elements | ✓ | → meta (ensemble) | ✓ | ✓ | ✓ | deep validate |

### Type-Specific Fields

| Field | Schema | Type | Notes |
|-------|--------|------|-------|
| category | ✓ | Skill, Template, Memory | Validated in createElement only |
| activationStrategy | ✗ | Ensemble | In metadata, not a schema param |
| conflictResolution | ✗ | Ensemble | In metadata, not a schema param |

---

## How To: Add a New Field to an Existing Type

### Example: Adding `priority` to Skills

1. **Stage 1 — OperationSchema.ts**
   ```typescript
   // In create_element params:
   // --- Skill-specific fields ---
   priority: { type: 'number', description: 'Execution priority (1-100)' },
   ```

2. **Stage 2 — SchemaDispatcher.ts**
   ```typescript
   // In buildArgs(), namedWithType case, after the isAgent block:
   const isSkill = normalizedType === 'skills' || normalizedType === 'skill';
   if (isSkill) {
     if (params.priority !== undefined) {
       result.metadata = result.metadata || {};
       result.metadata.priority = params.priority;
     }
   }
   // Add 'priority' to dispatchOnlyParams
   ```

3. **Stage 3 — createElement.ts**
   ```typescript
   // Add validation if needed (e.g., range check):
   if (metadata.priority !== undefined) {
     if (typeof metadata.priority !== 'number' || metadata.priority < 1 || metadata.priority > 100) {
       return formatError('priority must be a number between 1 and 100');
     }
   }
   ```

4. **Stage 4 — SkillManager.ts create()**
   ```typescript
   // Ensure priority is assigned from metadata:
   skill.priority = data.priority ?? data.metadata?.priority;
   ```

5. **Stage 5 — SkillManager.ts serializeElement()**
   ```typescript
   // Add to YAML frontmatter output:
   if (skill.priority !== undefined) {
     frontmatter.priority = skill.priority;
   }
   ```

6. **Stage 6 — SkillManager.ts parseMetadata()**
   ```typescript
   // Validate on load:
   if (metadata.priority !== undefined && typeof metadata.priority !== 'number') {
     logger.warn(`Skill '${metadata.name}': priority is not a number, stripping`);
     delete metadata.priority;
   }
   ```

---

## How To: Add a New Element Type

Adding a 7th element type requires changes across many files. Here is the minimum checklist:

### 1. Define the Type

- Add to `ElementType` enum in `src/portfolio/types.ts`
- Add type metadata interfaces in `src/elements/{newtype}/types.ts`

### 2. Create the Manager

- Create `src/elements/{newtype}/{NewType}Manager.ts`
- Extend `BaseElementManager` (or implement equivalent CRUD)
- Implement: `create()`, `serializeElement()`, `parseMetadata()`, `list()`, `get()`, `delete()`

### 3. Wire Into DI Container

- Register in `src/di/Container.ts`:
  ```typescript
  container.register('{newtype}Manager', new NewTypeManager(...));
  ```

### 4. Pipeline Stages

| Stage | File | Action |
|-------|------|--------|
| 1 | `OperationSchema.ts` | Add type-specific params to `create_element` schema |
| 2 | `SchemaDispatcher.ts` | Add routing for type-specific fields in `namedWithType` |
| 3 | `createElement.ts` | Add `case ElementType.NEWTYPE:` in the switch |
| 4 | Manager | Implement `create()` |
| 5 | Manager | Implement `serializeElement()` |
| 6 | Manager | Implement `parseMetadata()` |

### 5. Operation Router Registration

- `src/handlers/mcp-aql/OperationRouter.ts` — register CRUD routes for the new type
- `src/handlers/mcp-aql/OperationPolicies.ts` — add gatekeeper policies for new operations

### 6. Handler Registration

- `src/handlers/HandlerRegistry.ts` — register tool handlers with gatekeeper policies
- Update `src/handlers/element-crud/` handlers: `readElement.ts`, `editElement.ts`, `deleteElement.ts`, `listElements.ts`

### 7. Portfolio & Storage

- `src/portfolio/PortfolioManager.ts` — add directory mapping for the new type
- `src/storage/` — update storage layer if custom storage needed

### 8. Collection & Indexing

- `src/services/CollectionService.ts` — add collection support if elements can be shared
- `src/services/IndexingService.ts` — add to search index

### 9. Tests

- Unit tests: `tests/unit/elements/{newtype}/`
- Integration tests: update `tests/integration/crud/config/` with type config
- Add to `tests/integration/crud/ElementCRUD.test.ts` type matrix
- Security tests if the type handles user content

### 10. Documentation

- Add to `docs/reference/api-reference.md`
- Update `docs/architecture/element-architecture.md`
- Update this document's field coverage matrix

---

## Edit/Update Pipeline

The edit pipeline shares many of the same stages but with different entry points:

```
Client (edit_element)
  │
  ▼
OperationSchema (edit_element schema, separate from create_element)
  │
  ▼
SchemaDispatcher (namedWithType, same routing logic)
  │
  ▼
editElement.ts (src/handlers/element-crud/editElement.ts)
  │  — reads existing element, merges changes
  │
  ▼
Manager.update() or Manager.edit()
  │
  ▼
Manager.serializeElement() (same as create)
```

**Key difference:** Edit reads the existing element first, then merges incoming fields. The metadata field routing in `editElement.ts` (Issue #565) must also know about type-specific fields.

**File:** `src/handlers/element-crud/editElement.ts` — see the metadata field routing section for the merge logic.

---

## Delete Pipeline

```
Client (delete_element)
  │
  ▼
BackupService.backupBeforeDelete()  — universal backup (Issue #659)
  │
  ▼
Manager.delete()
  │
  ▼
File removal (or move-to-backup)
```

**File:** `src/handlers/element-crud/deleteElement.ts`

---

## Known Gaps & Future Work

1. ~~**Gatekeeper not in OperationSchema**~~ — Resolved in Issue #726. `gatekeeper` is now declared in `create_element` schema and surfaced in introspection format specs for all 6 element types.

2. **Category limited to 3 types** — Only skills, templates, and memories support `category`. Agents and ensembles could benefit from categorization.

3. **Persona is not a BaseElementManager subclass** — `PersonaManager` predates the base class pattern. It follows the same 6 stages but with different internal structure (`src/persona/` not `src/elements/personas/`).

4. **Agent serialization whitelist** — Agent `serializeElement()` uses an explicit field list. This is the most common place for new fields to be silently dropped.

5. **Edit pipeline metadata routing** — The edit handler has its own field routing logic (Issue #565) that must stay in sync with the create pipeline.

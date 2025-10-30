# Memory System Documentation

## Overview

The Memory System in DollhouseMCP provides persistent context storage across sessions with intelligent organization and retrieval capabilities. Memories enable AI systems to maintain context, remember project details, and provide consistent responses based on historical information.

**Version**: 1.9.0+
**Status**: Production Ready

---

## Key Features

- **Persistent Storage**: Context survives across sessions and server restarts
- **Date-Based Organization**: Automatic YYYY-MM-DD folder structure prevents flat directory issues
- **YAML Format**: Human-readable structured data optimized for context storage
- **Smart Deduplication**: SHA-256 hashing prevents duplicate content
- **Search Indexing**: Fast queries across thousands of memory entries
- **Auto-Load Memories**: Automatically load baseline knowledge on server startup (v1.9.25+)
- **Security**: Trust levels, validation, and injection protection

---

## Memory Metadata

### Core Fields

```yaml
---
name: project-context
type: memory
description: Project details and architectural decisions
version: 1.0.0
author: username
tags:
  - project
  - architecture
  - context
retention: permanent
privacyLevel: private
searchable: true
trustLevel: VALIDATED
---
```

### Metadata Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | - | Unique identifier for the memory |
| `type` | string | Yes | "memory" | Must be "memory" |
| `description` | string | Yes | - | Brief description of memory contents |
| `version` | string | Yes | "1.0.0" | Semantic version |
| `author` | string | No | "anonymous" | Creator's username |
| `tags` | array | No | [] | Searchable keywords |
| `retention` | string | No | "permanent" | Retention policy (see below) |
| `privacyLevel` | string | No | "private" | Privacy level (see below) |
| `searchable` | boolean | No | true | Include in search index |
| `trustLevel` | string | No | "UNTRUSTED" | Security trust level |
| `autoLoad` | boolean | No | false | Load on server startup (v1.9.25+) |
| `priority` | number | No | 999 | Auto-load priority (lower = first) |

### Auto-Load Fields (v1.9.25+)

**New in v1.9.25**: Memories can be marked for automatic loading on server startup.

#### `autoLoad: boolean`

Mark a memory to be automatically loaded when the server starts.

```yaml
autoLoad: true  # Load this memory on startup
```

**Use Cases**:
- Baseline system knowledge (e.g., DollhouseMCP capabilities)
- Team onboarding information
- Project context that should always be available
- Agent initialization data

#### `priority: number`

Control the order in which auto-load memories are loaded. Lower numbers load first.

```yaml
priority: 1     # Highest priority (loads first)
priority: 100   # Medium priority
priority: 999   # Lowest priority (default if not specified)
```

**Priority Guidelines**:
- `1-10`: Critical baseline knowledge (system capabilities, core concepts)
- `11-99`: Project context and team information
- `100-500`: Domain-specific knowledge
- `501-998`: Nice-to-have context
- `999`: Default priority (if not specified)

**Example: Baseline Knowledge Memory**

```yaml
---
name: dollhousemcp-baseline-knowledge
description: Baseline knowledge about DollhouseMCP capabilities
version: 1.0.0
autoLoad: true
priority: 1
retention: permanent
privacyLevel: public
trustLevel: VALIDATED
---

# DollhouseMCP Capabilities

Core features:
1. Persistent Memory System
2. Element-based AI Customization
3. Community Collection (169+ elements)
...
```

### Retention Policies

| Value | Duration | Description |
|-------|----------|-------------|
| `permanent` | Forever | Never automatically deleted |
| `perpetual` | Forever | Alias for permanent |
| `session` | Current session | Deleted on server restart |
| `30 days` | Specified duration | Deleted after time period |
| `7 days` | Specified duration | Deleted after time period |

### Privacy Levels

| Value | Description |
|-------|-------------|
| `public` | Can be shared in community collection |
| `private` | Local only, never shared |
| `team` | Shareable within organization |
| `restricted` | Requires explicit permission |

### Trust Levels

| Value | Description |
|-------|-------------|
| `UNTRUSTED` | Newly created, not yet validated |
| `VALIDATED` | Passed security validation |
| `FLAGGED` | Contains potentially suspicious content |
| `QUARANTINED` | Blocked from loading due to security concerns |

---

## Memory File Format

### File Structure

Memories are stored as YAML files in date-organized folders:

```
~/.dollhouse/portfolio/memories/
├── 2025-10-30/
│   ├── project-context.yaml
│   └── meeting-notes.yaml
└── 2025-10-31/
    └── research-findings.yaml
```

### YAML Structure

```yaml
---
name: project-context
type: memory
description: Project architectural decisions and constraints
version: 1.0.0
author: mickdarling
created: 2025-10-30T10:00:00Z
updated: 2025-10-30T14:30:00Z
tags:
  - project
  - architecture
  - decisions
retention: permanent
privacyLevel: private
searchable: true
trustLevel: VALIDATED
autoLoad: false
priority: 999
---

# Project Context

## Architecture

We're building a microservices architecture using:
- Node.js for API services
- PostgreSQL for persistence
- Redis for caching

## Key Decisions

1. **Database Choice**: PostgreSQL chosen for ACID compliance
2. **API Style**: REST API with OpenAPI specification
3. **Authentication**: JWT tokens with 15-minute expiry

## Constraints

- Must support 100,000 concurrent users
- 99.9% uptime SLA
- GDPR compliant data handling
```

---

## Creating Memories

### Using MCP Tools

```bash
# Create a basic memory
create_element type="memories" name="project-context" \
  description="Project architectural decisions"

# Create with auto-load enabled
create_element type="memories" name="team-onboarding" \
  description="Team onboarding checklist and guidelines" \
  content="# Team Onboarding\n\n1. Set up dev environment..." \
  metadata='{"autoLoad": true, "priority": 50}'
```

### Manual Creation

1. Create a date folder if it doesn't exist:
   ```bash
   mkdir -p ~/.dollhouse/portfolio/memories/$(date +%Y-%m-%d)
   ```

2. Create a YAML file:
   ```bash
   touch ~/.dollhouse/portfolio/memories/$(date +%Y-%m-%d)/my-memory.yaml
   ```

3. Add metadata and content following the format above

---

## Auto-Load Memory Configuration

### Enabling Auto-Load

Auto-load is enabled by default. Configure in `~/.dollhouse/config.yml`:

```yaml
autoLoad:
  enabled: true              # Enable/disable auto-load feature
  maxTokenBudget: 5000      # Maximum tokens for all auto-load memories
  memories: []              # Specific memories to load (empty = use autoLoad flags)
```

### Configuration Options

#### `enabled: boolean`

Enable or disable the auto-load feature entirely.

```yaml
autoLoad:
  enabled: false  # Disable auto-load, no memories loaded on startup
```

#### `maxTokenBudget: number`

Maximum number of tokens that can be consumed by auto-load memories. This prevents accidentally loading too much context on startup.

```yaml
autoLoad:
  maxTokenBudget: 10000  # Allow up to 10k tokens
```

**Note**: Token budget enforcement is currently not implemented (planned for future release).

#### `memories: string[]`

Explicitly specify which memories to load, overriding autoLoad flags. Useful for testing or specific deployment scenarios.

```yaml
autoLoad:
  memories:
    - dollhousemcp-baseline-knowledge
    - project-context
    - team-guidelines
```

**Behavior**:
- Empty array `[]`: Use autoLoad flags in memory files (default)
- Non-empty array: Load only specified memories, ignore autoLoad flags

---

## Memory Operations

### List Memories

```bash
list_elements type="memories"
```

### Activate Memory

```bash
activate_element name="project-context" type="memories"
```

### View Memory Details

```bash
get_element_details name="project-context" type="memories"
```

### Edit Memory

```bash
edit_element name="project-context" type="memories" \
  field="description" \
  value="Updated project context"
```

### Delete Memory

```bash
delete_element name="project-context" type="memories"
```

### Search Memories

```bash
search_portfolio query="architecture decisions" type="memories"
```

---

## Best Practices

### Naming Conventions

Use descriptive, hyphenated names:
- ✅ `project-architecture-decisions`
- ✅ `team-onboarding-checklist`
- ✅ `meeting-notes-2025-10-30`
- ❌ `mem_1234567890`
- ❌ `notes`
- ❌ `temp`

### Auto-Load Guidelines

**DO use auto-load for**:
- Baseline system knowledge
- Team onboarding information
- Critical project context
- Agent initialization data
- Frequently accessed reference material

**DON'T use auto-load for**:
- Session-specific notes
- Temporary research findings
- Large documents (>5k tokens)
- Rarely accessed context
- User-specific preferences

### Content Organization

```yaml
# Good: Structured, scannable content
---
name: api-documentation
---

# API Documentation

## Authentication
- Endpoint: /api/v1/auth
- Method: POST
- Returns: JWT token

## User Management
...

# Bad: Unstructured blob
---
name: notes
---

Various notes about the project including API endpoints, database schemas,
meeting discussions, and random thoughts all mixed together without organization...
```

### Memory Size

- **Recommended**: 1-5KB per memory (500-2500 tokens)
- **Maximum**: ~100KB per memory
- **Split large memories**: Use multiple related memories instead of one huge file

### Security

1. **Review untrusted memories**: Check `trustLevel` before activating
2. **Use privacy levels**: Mark sensitive data as `private`
3. **Enable validation**: Keep background validation running
4. **Audit auto-load**: Review which memories load automatically

---

## Troubleshooting

### Memory Not Loading

**Symptoms**: Memory file exists but doesn't appear in list

**Solutions**:
1. Check file extension is `.yaml` (not `.yml` or `.md`)
2. Verify file is in date-based folder (e.g., `2025-10-30/`)
3. Validate YAML syntax: `yamllint memory-file.yaml`
4. Check for parsing errors in server logs

### Auto-Load Not Working

**Symptoms**: Memory with `autoLoad: true` doesn't load on startup

**Solutions**:
1. Verify `autoLoad.enabled: true` in config
2. Check server startup logs for loading messages
3. Ensure memory has `autoLoad: true` in metadata
4. Verify memory file is in portfolio directory
5. Check for YAML syntax errors

### High Token Usage

**Symptoms**: Too many tokens consumed by auto-load memories

**Solutions**:
1. Reduce `maxTokenBudget` in config
2. Lower priority (higher numbers) for less critical memories
3. Split large memories into smaller, focused ones
4. Set `autoLoad: false` for rarely needed context

### Trust Level Issues

**Symptoms**: Memory marked as FLAGGED or QUARANTINED

**Solutions**:
1. Review memory content for security issues
2. Run validation: `validate_element name="memory-name" type="memories"`
3. If false positive, manually set `trustLevel: VALIDATED`
4. Check security logs for specific violation

---

## Architecture

### Storage Layer

```
MemoryManager
  ↓
PortfolioManager
  ↓
File System (~/.dollhouse/portfolio/memories/)
  ↓
Date-based folders (YYYY-MM-DD/)
  ↓
YAML files (memory-name.yaml)
```

### Auto-Load Flow

```
Server Startup
  ↓
ConfigManager.initialize()
  ↓
Check config.autoLoad.enabled
  ↓ (if enabled)
MemoryManager.getAutoLoadMemories()
  ↓ Read all memory files
  ↓ Filter by autoLoad: true
  ↓ Sort by priority (ascending)
  ↓ Return Memory[]
  ↓
Activate memories in priority order
  ↓
Log loaded memories
  ↓
Server ready
```

### Security Validation

```
Memory Created/Loaded
  ↓
Set trustLevel: UNTRUSTED
  ↓
BackgroundValidator.start()
  ↓ (runs every 5 minutes)
Scan for security patterns
  ↓
Update trustLevel:
  - VALIDATED (safe)
  - FLAGGED (suspicious)
  - QUARANTINED (blocked)
```

---

## API Reference

### MemoryManager Methods

#### `getAutoLoadMemories(): Promise<Memory[]>`

Returns memories marked for auto-loading, sorted by priority.

```typescript
const memories = await memoryManager.getAutoLoadMemories();
// Returns: Memory[] sorted by priority (ascending)
```

#### `loadMemory(name: string): Promise<Memory>`

Load a specific memory by name.

```typescript
const memory = await memoryManager.loadMemory('project-context');
```

#### `saveMemory(memory: Memory): Promise<void>`

Save or update a memory.

```typescript
await memoryManager.saveMemory(memory);
```

#### `deleteMemory(name: string): Promise<void>`

Delete a memory and its associated files.

```typescript
await memoryManager.deleteMemory('old-notes');
```

---

## Examples

### Example 1: Team Onboarding Memory

```yaml
---
name: team-onboarding-checklist
type: memory
description: Step-by-step onboarding checklist for new team members
version: 1.0.0
author: team-lead
tags:
  - onboarding
  - team
  - checklist
retention: permanent
privacyLevel: team
searchable: true
autoLoad: true
priority: 20
---

# Team Onboarding Checklist

## Week 1: Environment Setup

- [ ] Install development tools
- [ ] Clone repositories
- [ ] Set up database
- [ ] Run test suite

## Week 2: Codebase Orientation

- [ ] Review architecture documentation
- [ ] Complete code review tutorial
- [ ] Pair program with team member
- [ ] Submit first PR

## Week 3: Domain Knowledge

- [ ] Review business requirements
- [ ] Learn API endpoints
- [ ] Understand data models
- [ ] Shadow customer support call
```

### Example 2: Project Context Memory

```yaml
---
name: project-alpha-context
type: memory
description: Project Alpha technical context and constraints
version: 2.1.0
author: architect
tags:
  - project-alpha
  - architecture
  - constraints
retention: permanent
privacyLevel: private
searchable: true
autoLoad: true
priority: 10
---

# Project Alpha - Technical Context

## Overview

E-commerce platform for specialty coffee retailers.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **Backend**: Node.js 20, Express, TypeScript
- **Database**: PostgreSQL 15
- **Cache**: Redis 7
- **Deployment**: AWS ECS, CloudFront CDN

## Critical Constraints

1. **Performance**: Page load < 2 seconds
2. **Availability**: 99.9% uptime SLA
3. **Security**: PCI DSS compliant
4. **Scale**: Support 50k concurrent users

## Integration Points

- Payment: Stripe API
- Shipping: ShipStation API
- Email: SendGrid API
- Analytics: Segment + Google Analytics

## Known Issues

- Redis connection pooling needs optimization
- CloudFront cache invalidation is slow
- Need to implement circuit breaker pattern
```

### Example 3: API Reference Memory

```yaml
---
name: internal-api-reference
type: memory
description: Quick reference for internal API endpoints
version: 3.0.0
author: backend-team
tags:
  - api
  - reference
  - endpoints
retention: permanent
privacyLevel: private
searchable: true
autoLoad: true
priority: 50
---

# Internal API Reference

## Authentication

### POST /api/v1/auth/login
- **Body**: `{ email, password }`
- **Returns**: `{ token, user }`
- **Errors**: 401 (invalid credentials), 429 (rate limit)

### POST /api/v1/auth/refresh
- **Headers**: `Authorization: Bearer <token>`
- **Returns**: `{ token }`

## Users

### GET /api/v1/users/:id
- **Auth**: Required
- **Returns**: User object
- **Errors**: 404 (not found), 403 (forbidden)

### PATCH /api/v1/users/:id
- **Auth**: Required
- **Body**: Partial user object
- **Returns**: Updated user
- **Errors**: 400 (validation), 403 (forbidden)

## Products

### GET /api/v1/products
- **Query**: `?page=1&limit=20&category=coffee`
- **Returns**: Paginated product list

### POST /api/v1/products
- **Auth**: Admin only
- **Body**: Product object
- **Returns**: Created product
- **Errors**: 400 (validation), 403 (forbidden)
```

---

## Related Documentation

- [Element Types](ELEMENT_TYPES.md) - Overview of all element types
- [Configuration Guide](CONFIGURATION.md) - Server configuration options
- [Security Architecture](security/MEMORY_INJECTION_PROTECTION.md) - Memory security details
- [API Reference](API_REFERENCE.md) - Complete MCP tool reference

---

**Last Updated**: October 30, 2025
**Version**: 1.9.25+

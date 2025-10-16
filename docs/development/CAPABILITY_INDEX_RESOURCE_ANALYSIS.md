# CapabilityIndexResource Implementation Analysis

**Date**: October 16, 2025
**Branch**: feature/capability-index-mcp-resources
**Status**: Implementation complete, not yet integrated into server

---

## Executive Summary

The `CapabilityIndexResource` class implements MCP (Model Context Protocol) Resources to expose DollhouseMCP's capability index as injectable LLM context. This implementation is unique in the codebase - it's the **first and only MCP Resources implementation**, whereas the rest of the server focuses on MCP Tools.

**Key Distinction**:
- **Tools** (47 in codebase): Require explicit LLM invocation, consume tokens only when called
- **Resources** (this implementation): Designed for automatic context injection, consume tokens continuously when enabled

---

## Critical Implementation Details

### Location
- **TypeScript Source**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/src/server/resources/CapabilityIndexResource.ts`
- **Compiled Output**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/dist/server/resources/CapabilityIndexResource.js`

### Current Status
**DORMANT** - Code exists but is not integrated:
- ❌ Not imported in ServerSetup.ts
- ❌ No resource handlers registered
- ❌ Resources capability not advertised to clients
- ❌ No configuration system implemented yet

### Token Impact (Measured, Not Estimated)
| Variant | Actual Tokens | Context % (200K) | Context % (1M) |
|---------|---------------|------------------|----------------|
| Summary | 1,254 | 0.63% | 0.125% |
| Full | 48,306 | 24.15% | 4.83% |
| Stats | ~50 | <0.01% | <0.01% |

**Original estimates were too high**: Summary is 1,254 tokens, not 2,500-3,500 as estimated.

---

## How CapabilityIndexResource Differs from Tools

### 1. Protocol Layer: Resources vs Tools

**MCP Tools Implementation** (existing, 47 tools):
```typescript
// In ServerSetup.ts
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = this.toolRegistry.getAllTools();
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = this.toolRegistry.getHandler(name);
  return await handler(args);
});
```

**MCP Resources Implementation** (CapabilityIndexResource):
```typescript
// Would need to be added to ServerSetup.ts
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resourceHandler = new CapabilityIndexResource();
  return await resourceHandler.listResources();
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const resourceHandler = new CapabilityIndexResource();
  return await resourceHandler.readResource(uri);
});
```

**Key Difference**:
- Tools: Pull model (LLM requests → server responds)
- Resources: Push model (server advertises → client decides what to inject)

### 2. Capability Advertisement

**Tools** (from index.ts):
```typescript
const server = new Server({
  name: 'dollhousemcp-capability-index',
  version: '1.9.16'
}, {
  capabilities: {
    tools: {}  // Advertises tool support
  }
});
```

**Resources** (would need to be added):
```typescript
const server = new Server({
  name: 'dollhousemcp-capability-index',
  version: '1.9.16'
}, {
  capabilities: {
    tools: {},
    resources: {}  // Would advertise resource support
  }
});
```

### 3. Registration Pattern

**Tools Pattern**:
```typescript
// ToolRegistry maintains a Map<string, ToolHandler>
export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  register(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, handler);
  }
}
```

**Resources Pattern** (no registry, direct instantiation):
```typescript
// No ResourceRegistry - handlers create instances directly
export class CapabilityIndexResource {
  async listResources(): Promise<MCPResourceListResponse> { ... }
  async readResource(uri: string): Promise<MCPResourceReadResponse> { ... }
}
```

**Why Different**:
- Tools: Many handlers (47), need registry for management
- Resources: Single handler (for now), instantiated per request

### 4. URI Scheme

**Tools** (identified by name):
```typescript
{
  name: "list_elements",
  description: "...",
  inputSchema: { ... }
}
```

**Resources** (identified by URI):
```typescript
{
  uri: "dollhouse://capability-index/summary",
  name: "Capability Index Summary",
  description: "...",
  mimeType: "text/yaml"
}
```

**Custom URI Scheme**: `dollhouse://capability-index/{variant}`
- `summary` - Lightweight index (1,254 tokens)
- `full` - Complete index (48,306 tokens)
- `stats` - Metrics (JSON, ~50 tokens)

### 5. Caching Strategy

**Tools** (cache discovery only):
```typescript
// ServerSetup.ts - caches tool list, not execution results
server.setRequestHandler(ListToolsRequestSchema, async () => {
  let tools = this.toolCache.getToolList();
  if (!tools) {
    tools = this.toolRegistry.getAllTools();
    this.toolCache.setToolList(tools);
  }
  return { tools };
});
```

**Resources** (cache file content):
```typescript
// CapabilityIndexResource.ts - caches parsed YAML
private cachedIndex: CapabilityIndex | null = null;
private cacheTimestamp: number = 0;
private readonly CACHE_TTL = 60000; // 60 seconds

async loadCapabilityIndex() {
  const now = Date.now();
  if (this.cachedIndex && (now - this.cacheTimestamp) < this.CACHE_TTL) {
    return this.cachedIndex; // Return cached
  }
  // Otherwise, read and parse file
}
```

**Why Different**:
- Tools: Execution varies by arguments, can't cache results
- Resources: Content changes infrequently, benefits from caching

---

## Three Resource Variants

### 1. Summary (`dollhouse://capability-index/summary`)

**Content**: Metadata + action_triggers only
```yaml
# Capability Index Summary
# This is a lightweight summary of the capability index for LLM context injection.
# Contains action verb → element mappings for quick tool selection guidance.
# Full index available at: dollhouse://capability-index/full
# Total elements: 42

metadata:
  version: "1.0.0"
  created: "2025-10-15"
  last_updated: "2025-10-16"
  total_elements: 42

action_triggers:
  analyze: [analyzer-persona, code-reviewer]
  create: [creative-writer, code-generator]
  debug: [debugger-persona, troubleshooter]
  # ... more verb mappings
```

**Use Case**: Automatic injection for models with 200K+ context
**Token Cost**: 1,254 tokens (0.6% of 200K context)
**Benefit**: Helps LLM select appropriate tools based on action verbs

### 2. Full (`dollhouse://capability-index/full`)

**Content**: Complete index with all element details
```yaml
# Capability Index (Full)
# Complete capability index including all element details, relationships, and semantic data.
# This is a large resource (~35-45K tokens) - use only with large context models.
# Summary version available at: dollhouse://capability-index/summary
# Total elements: 42

metadata: { ... }
action_triggers: { ... }
elements:
  personas:
    - name: "Creative Writer"
      description: "..."
      triggers: [...]
      relationships: [...]
      semantic_data: { ... }
  skills: { ... }
  # ... complete element data
```

**Use Case**: Large context models (500K-4M tokens)
**Token Cost**: 48,306 tokens (24% of 200K, 5% of 1M, 1.2% of 4M)
**Benefit**: Complete context about all available elements and relationships

### 3. Stats (`dollhouse://capability-index/stats`)

**Content**: JSON metrics
```json
{
  "summarySize": 6675,
  "summaryWords": 646,
  "summaryLines": 265,
  "fullSize": 280832,
  "fullWords": 20311,
  "fullLines": 9363,
  "estimatedSummaryTokens": 1254,
  "estimatedFullTokens": 48306
}
```

**Use Case**: Debugging, monitoring, decision-making
**Token Cost**: ~50 tokens
**Benefit**: Helps LLM decide which variant to request

---

## MCP Resources Protocol Implementation

### Standard MCP Resources Interface

```typescript
// From @modelcontextprotocol/sdk

interface Resource {
  uri: string;           // Unique identifier (custom scheme allowed)
  name: string;          // Human-readable name
  description: string;   // What this resource contains
  mimeType: string;      // Content type (text/yaml, application/json, etc)
}

interface ListResourcesResponse {
  resources: Resource[];
}

interface ResourceContent {
  uri: string;           // Must match requested URI
  mimeType: string;      // Content type
  text: string;          // Actual content
}

interface ReadResourceResponse {
  contents: ResourceContent[];
}
```

### CapabilityIndexResource Implementation

```typescript
export class CapabilityIndexResource {
  // List all available resources (called during client connection)
  async listResources(): Promise<MCPResourceListResponse> {
    return {
      resources: [
        {
          uri: 'dollhouse://capability-index/summary',
          name: 'Capability Index Summary',
          description: 'Lightweight capability index with action verb → element mappings. Estimated ~2.5-3.5K tokens. Recommended for models with 200K+ context.',
          mimeType: 'text/yaml'
        },
        {
          uri: 'dollhouse://capability-index/full',
          name: 'Capability Index (Full)',
          description: 'Complete capability index with all element details, relationships, and semantic data. Estimated ~35-45K tokens. Recommended for models with 500K+ context.',
          mimeType: 'text/yaml'
        },
        {
          uri: 'dollhouse://capability-index/stats',
          name: 'Capability Index Statistics',
          description: 'Measurement data about capability index size and token estimates.',
          mimeType: 'application/json'
        }
      ]
    };
  }

  // Read a specific resource (called when client/LLM requests content)
  async readResource(uri: string): Promise<MCPResourceReadResponse> {
    let content: string;
    let mimeType: string;

    switch (uri) {
      case 'dollhouse://capability-index/summary':
        content = await this.generateSummary();
        mimeType = 'text/yaml';
        break;

      case 'dollhouse://capability-index/full':
        content = await this.generateFull();
        mimeType = 'text/yaml';
        break;

      case 'dollhouse://capability-index/stats':
        const stats = await this.getStatistics();
        content = JSON.stringify(stats, null, 2);
        mimeType = 'application/json';
        break;

      default:
        throw new Error(`Unknown capability index resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType,
          text: content
        }
      ]
    };
  }
}
```

**Protocol Compliance**: Verified via logs from October 3, 2025 testing:
```
Message from server: {"capabilities":{"tools":{},"resources":{}}}
Message from client: {"method":"resources/list","params":{}}
Message from server: {"result":{"resources":[...]}} # All 3 resources returned
```

---

## Token Cost Implications

### Comparison with Existing Tool Overhead

**Current DollhouseMCP Token Usage** (measured October 15, 2025):
- Base Claude Code: 36,695 tokens
- Claude Code + DollhouseMCP: ~60,000 tokens
- **DollhouseMCP tool overhead**: ~24,000 tokens (47 tools)

**If Resources Were Enabled**:
| Configuration | Additional Tokens | Total Overhead | % of 200K Context |
|---------------|-------------------|----------------|-------------------|
| None (default) | 0 | 24,000 | 12% |
| Summary only | 1,254 | 25,254 | 12.6% |
| Full only | 48,306 | 72,306 | 36.2% |
| Both (naive) | 49,560 | 73,560 | 36.8% |

**Context Window Economics**:
- 200K models: Summary viable (0.6%), Full heavy (24%)
- 500K models: Summary negligible, Full acceptable (9.7%)
- 1M models: Both lightweight (Summary 0.1%, Full 4.8%)
- 4M models (Gemini): Both essentially free (Summary 0.03%, Full 1.2%)

### Risk Assessment

**Current Risk**: ZERO
- Resources code exists but dormant (not hooked up)
- Even if hooked up, MCP clients don't support `resources/read` yet

**Future Risk**: HIGH (if naively implemented)
- Client updates to support resources
- Naively auto-injects ALL discovered resources
- Users experience 49K token overhead without opting in

**Mitigation Strategy**: Configuration-controlled resource advertising (see Integration Requirements below)

---

## Client Support Status (as of October 2025)

### Tested Clients

**Claude Desktop** (tested October 3, 2025):
- ✅ Calls `resources/list` successfully
- ❌ Never calls `resources/read`
- ❌ No UI to browse or enable resources
- **Status**: Resources discovered but not used

**Claude Code 2.0.5** (tested October 3, 2025):
- ✅ Calls `resources/list` successfully
- ❌ Never calls `resources/read`
- ❌ Manually calls multiple tools instead
- **Status**: Resources discovered but not used

**Gemini CLI** (GitHub Issue #3816, filed July 2025):
- ❌ Resources not supported
- ✅ Only tools supported
- **Status**: "Acknowledged as feature request, no timeline"

### Current MCP Ecosystem State

**Phase 1: Tools** (Mature)
- Widely supported by all MCP clients
- Standard implementation pattern
- Proven at scale

**Phase 2: Resources** (Specification exists, adoption lagging)
- Servers implementing (including this one)
- Clients discovering but not using
- Gap between protocol support and client implementation

**Phase 3: Prompts** (Similar state to Resources)
- Part of MCP spec
- Not yet adopted by clients

**Pattern Observed**:
```
Client connects → Server advertises resources
Client calls resources/list → Server returns resources
[CLIENTS STOP HERE]
Client should call resources/read → NEVER HAPPENS
Client should inject into context → NEVER HAPPENS
```

**Why This Matters**: This implementation is **future-proof** but not immediately useful until clients add support.

---

## Integration Requirements

### 1. Server Capability Advertisement

**File**: `src/index.ts`

**Current**:
```typescript
const server = new Server({
  name: 'dollhousemcp-capability-index',
  version: VERSION
}, {
  capabilities: {
    tools: {}
  }
});
```

**Needs**:
```typescript
const server = new Server({
  name: 'dollhousemcp-capability-index',
  version: VERSION
}, {
  capabilities: {
    tools: {},
    resources: {}  // Add this conditionally
  }
});
```

**Conditional Logic** (based on configuration):
```typescript
import { ConfigManager } from './config/ConfigManager.js';

const config = ConfigManager.getInstance().getConfig();
const capabilities: any = { tools: {} };

// Only advertise resources if explicitly enabled
if (config.resources?.advertise_resources) {
  capabilities.resources = {};
}

const server = new Server(
  { name: 'dollhousemcp-capability-index', version: VERSION },
  { capabilities }
);
```

### 2. Request Handler Registration

**File**: `src/server/ServerSetup.ts`

**Add after tool handlers**:
```typescript
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CapabilityIndexResource } from './resources/CapabilityIndexResource.js';
import { ConfigManager } from '../config/ConfigManager.js';

export class ServerSetup {
  // ... existing code ...

  setupServer(server: Server, instance: IToolHandler): void {
    // Register all tools
    this.registerTools(instance);

    // Setup request handlers
    this.setupListToolsHandler(server);
    this.setupCallToolHandler(server);

    // Setup resource handlers (conditionally)
    this.setupResourceHandlers(server);
  }

  /**
   * Setup MCP resource handlers (conditional on configuration)
   */
  private setupResourceHandlers(server: Server): void {
    const config = ConfigManager.getInstance().getConfig();

    // Only register handlers if resources are enabled
    if (!config.resources?.advertise_resources) {
      logger.debug('MCP resources disabled by configuration');
      return;
    }

    const resourceHandler = new CapabilityIndexResource();

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return await resourceHandler.listResources();
    });

    // Read specific resource
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return await resourceHandler.readResource(uri);
    });

    logger.info('MCP resource handlers registered');
  }
}
```

### 3. Configuration Schema

**File**: `src/config/ConfigManager.ts`

**Already exists** (from October 15 investigation):
```typescript
export interface CapabilityIndexResourcesConfig {
  advertise_resources: boolean; // Default: false - safe, don't advertise
  variants?: {
    summary?: boolean;  // Enable summary variant
    full?: boolean;     // Enable full variant
  };
}

export interface DollhouseConfig {
  // ... other config ...
  resources?: CapabilityIndexResourcesConfig;
}

// Default configuration
const DEFAULT_CONFIG: DollhouseConfig = {
  // ... other defaults ...
  resources: {
    advertise_resources: false, // Default: safe, disabled
    variants: {
      summary: false,
      full: false
    }
  }
};
```

**Enhancement Needed**: Conditional resource list based on enabled variants
```typescript
// In CapabilityIndexResource.ts
async listResources(): Promise<MCPResourceListResponse> {
  const config = ConfigManager.getInstance().getConfig();
  const resources: MCPResource[] = [];

  // Always include stats (minimal overhead)
  resources.push({
    uri: 'dollhouse://capability-index/stats',
    name: 'Capability Index Statistics',
    description: 'Measurement data about capability index size and token estimates.',
    mimeType: 'application/json'
  });

  // Conditionally add summary
  if (config.resources?.variants?.summary !== false) {
    resources.push({
      uri: 'dollhouse://capability-index/summary',
      name: 'Capability Index Summary',
      description: 'Lightweight capability index with action verb → element mappings. Measured 1,254 tokens. Recommended for models with 200K+ context.',
      mimeType: 'text/yaml'
    });
  }

  // Conditionally add full
  if (config.resources?.variants?.full) {
    resources.push({
      uri: 'dollhouse://capability-index/full',
      name: 'Capability Index (Full)',
      description: 'Complete capability index with all element details, relationships, and semantic data. Measured 48,306 tokens. Recommended for models with 500K+ context.',
      mimeType: 'text/yaml'
    });
  }

  return { resources };
}
```

### 4. Testing Requirements

**Unit Tests** (`test/__tests__/unit/server/resources/CapabilityIndexResource.test.ts`):
```typescript
describe('CapabilityIndexResource', () => {
  it('should list resources based on configuration');
  it('should cache capability index for 60 seconds');
  it('should generate summary with correct structure');
  it('should generate full index with correct structure');
  it('should generate statistics with accurate measurements');
  it('should handle missing capability-index.yaml gracefully');
  it('should throw error for unknown resource URI');
});
```

**Integration Tests** (`test/__tests__/integration/resources/CapabilityIndexResource.test.ts`):
```typescript
describe('CapabilityIndexResource Integration', () => {
  it('should not advertise resources when disabled');
  it('should advertise resources when enabled');
  it('should respect variant configuration');
  it('should handle resource read requests');
  it('should return proper MCP protocol responses');
});
```

**Protocol Compliance Tests**:
```typescript
describe('MCP Resources Protocol Compliance', () => {
  it('should implement ListResourcesRequestSchema correctly');
  it('should implement ReadResourceRequestSchema correctly');
  it('should return valid resource URIs');
  it('should return valid MIME types');
  it('should handle errors per MCP spec');
});
```

### 5. Documentation Requirements

**Configuration Guide** (`docs/CONFIGURATION.md`):
```markdown
### Capability Index Resources

Control whether DollhouseMCP advertises its capability index as MCP resources.

**Default**: Disabled (safe, no token overhead)

**Configuration**:
```json
{
  "resources": {
    "advertise_resources": false,  // Master switch
    "variants": {
      "summary": false,  // 1,254 token summary
      "full": false      // 48,306 token full index
    }
  }
}
```

**Use Cases**:
- **Summary**: Enable for 200K+ context models to improve tool selection
- **Full**: Enable for 500K+ context models (or 1M+ for negligible overhead)
- **Both disabled**: Default, safe for all contexts

**Token Impact**: See token cost tables in CAPABILITY_INDEX_RESOURCE_ANALYSIS.md
```

**User Guide** (`docs/guides/MCP_RESOURCES_GUIDE.md`):
- What are MCP resources vs tools
- When to enable capability index resources
- How to configure based on model context size
- How to verify resources are working
- Client support status

---

## Alternative Approaches (Historical Context)

From October 3, 2025 session notes, four alternatives were considered:

### Option A: Tool-Based Injection
Create a tool that returns the capability index:
```typescript
{
  name: "get_capability_index",
  description: "Returns the complete capability index for context",
  handler: async () => {
    const resource = new CapabilityIndexResource();
    return await resource.generateFull();
  }
}
```
**Pros**: Works with all current clients today
**Cons**: Requires explicit tool call, not automatic
**Status**: Could be implemented alongside resources

### Option B: Memory-Based Injection
Create a DollhouseMCP memory containing the capability index summary:
- Mark as "always active" or "auto-load"
- Point to it in CLAUDE.md for automatic loading
**Pros**: Works today, integrates with existing memory system
**Cons**: Another memory to manage, may not be as discoverable
**Status**: Could be implemented alongside resources

### Option C: Enhanced Tool Descriptions
Implement Serena-style guidance in tool descriptions:
- Add "when to use" / "when NOT to use" sections
- Include implicit scenario handling
- ~10K token overhead
**Pros**: Works with all clients, improves tool selection directly
**Cons**: Requires updating all 47 tool descriptions
**Status**: Separate initiative

### Option D: Wait for Client Support (Chosen)
Keep the resource implementation as-is and wait for clients to catch up.
**Pros**: Future-proof, already implemented
**Cons**: Unknown timeline for client support
**Status**: **CURRENT APPROACH** with configuration safety

---

## Security Considerations

### Input Validation
```typescript
async readResource(uri: string): Promise<MCPResourceReadResponse> {
  // Validate URI matches known resources
  switch (uri) {
    case 'dollhouse://capability-index/summary':
    case 'dollhouse://capability-index/full':
    case 'dollhouse://capability-index/stats':
      // Valid URIs
      break;
    default:
      throw new Error(`Unknown capability index resource: ${uri}`);
  }
}
```

**No user input in resource generation**:
- File path is hardcoded: `~/.dollhouse/portfolio/capability-index.yaml`
- No user-controlled paths or parameters
- YAML parsing uses `js-yaml` (already in use throughout codebase)

### DoS Protection
**60-second cache** prevents excessive file reads:
```typescript
private cachedIndex: CapabilityIndex | null = null;
private cacheTimestamp: number = 0;
private readonly CACHE_TTL = 60000; // 60 seconds
```

**Why this matters**: Malicious client could repeatedly call `resources/read`, but cache limits filesystem impact.

### Configuration Protection
**Default to disabled**:
```typescript
resources: {
  advertise_resources: false,  // Explicit opt-in required
  variants: {
    summary: false,
    full: false
  }
}
```

**Why this matters**: Prevents accidental token consumption if clients update to support resources.

---

## Recommendations

### 1. Immediate: Complete Integration
- Add conditional resource handlers to ServerSetup.ts
- Add conditional capability advertisement to index.ts
- Respect existing configuration schema (already in ConfigManager)
- Write comprehensive tests

### 2. Short-term: Alternative Approaches
- Implement Option A (tool-based) as fallback for current clients
- Document both approaches in user guides
- Let users choose based on their needs

### 3. Long-term: Monitor Client Adoption
- Track MCP client updates for resource support
- Update documentation when clients add support
- Consider submitting feedback to Claude/Gemini teams

### 4. Documentation
- Complete configuration guide
- Write MCP resources user guide
- Update README with resource information
- Document token costs clearly

---

## Related Session Notes

- **October 3, 2025**: `SESSION_NOTES_2025-10-03-CAPABILITY-INDEX-RESOURCE-EXPERIMENT.md`
  - Initial implementation and testing
  - Token measurements
  - Client support investigation

- **October 15, 2025**: `SESSION_NOTES_2025-10-15-EVENING-CAPABILITY-INDEX-RESOURCES-INVESTIGATION.md`
  - Discovery that code was never committed
  - Configuration design
  - Risk assessment

---

## Conclusion

The CapabilityIndexResource implementation is **architecturally sound** and **protocol-compliant**, but represents a significant departure from the rest of the DollhouseMCP codebase:

**What Makes It Unique**:
1. First and only MCP Resources implementation (vs 47 Tools)
2. Content caching (60s TTL) vs tool discovery caching
3. Custom URI scheme (`dollhouse://`) vs name-based identification
4. Multiple content variants (3) from single handler
5. Designed for automatic context injection vs explicit invocation

**Integration Requirements**:
1. Conditional handler registration based on configuration
2. Conditional capability advertisement
3. Variant-aware resource listing
4. Comprehensive testing
5. Clear documentation about token costs

**Current Status**:
- Implementation complete ✅
- Configuration schema exists ✅
- Integration pending ⏸️
- Client support pending ⏸️

**Recommendation**: Complete integration with **strict configuration controls** to prevent accidental token overhead, then wait for client support while offering alternative approaches (tool-based, memory-based) for immediate use.

---

**Document Version**: 1.0
**Last Updated**: October 16, 2025
**Author**: Claude (Sonnet 4.5) via DollhouseMCP Analysis

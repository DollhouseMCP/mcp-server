# MCP Resources Support

## Overview

DollhouseMCP implements **MCP Resources** as a future-proof feature for intelligent element discovery. Resources provide machine-readable context about DollhouseMCP's capabilities that can be automatically injected into LLM conversations.

## Current Status: Non-Functional (October 2025)

**IMPORTANT: MCP Resources are currently non-functional in Claude Code and most MCP clients.**

As of October 2025, MCP Resources are:
- ✅ **Fully implemented** in DollhouseMCP server
- ✅ **MCP specification compliant**
- ❌ **NOT working** in Claude Code (discovery only, never read)
- ⚠️ **Manual attachment only** in Claude Desktop/VS Code (users must explicitly attach)

This is a **future-proof implementation** - the feature is ready for when MCP clients fully support automatic resource reading and injection.

### Why Implement Now?

- **Early adopter advantage**: Be ready when clients add full support
- **Manual attachment works**: Claude Desktop and VS Code support manual resource attachment
- **Specification compliance**: Follow MCP best practices for resource exposure
- **Zero overhead when disabled**: Default configuration has no performance impact

## What Are MCP Resources?

MCP Resources are **read-only, addressable content entities** that provide structured context to LLMs. Unlike tools (which are model-controlled), resources are application-controlled - the MCP client decides when to read and inject them.

Think of resources as "files" that can be attached to conversations:
- **Tools**: The LLM decides when to call them based on user queries
- **Resources**: The user/application decides when to attach them as context

## DollhouseMCP Resources

DollhouseMCP exposes three resources via the Capability Index:

### 1. Summary Resource (dollhouse://capability-index/summary)
- **Size**: ~2,500-3,500 tokens
- **Content**: Metadata + action verb mappings
- **Use Case**: Lightweight context for most conversations
- **Recommended**: Models with 200K+ context window

Contains:
```yaml
metadata:
  version: "1.0.0"
  total_elements: 42
  last_updated: "2025-10-16T12:00:00Z"

action_triggers:
  analyze: [code-reviewer, data-analyst]
  write: [creative-writer, technical-writer]
  # ... more mappings
```

### 2. Full Resource (dollhouse://capability-index/full)
- **Size**: ~35,000-45,000 tokens
- **Content**: Complete index with all element details
- **Use Case**: Deep element discovery and relationship mapping
- **Recommended**: Models with 500K+ context window

Contains:
- All metadata
- Complete action trigger mappings
- Element relationships and similarities
- Semantic analysis data
- Full element descriptions

### 3. Statistics Resource (dollhouse://capability-index/stats)
- **Size**: Minimal (JSON)
- **Content**: Size metrics and token estimates
- **Use Case**: Monitoring and measurement

Contains:
```json
{
  "summarySize": 12450,
  "summaryWords": 2100,
  "estimatedSummaryTokens": 2800,
  "fullSize": 145600,
  "fullWords": 24300,
  "estimatedFullTokens": 38500
}
```

## Token Cost Analysis

Resources consume LLM context tokens when injected. Consider your model's context window:

| Model | Context Window | Recommended Resource | Overhead % |
|-------|----------------|----------------------|------------|
| Claude Sonnet | 200K tokens | Summary (~3K) | 1.5% |
| Claude Opus | 200K tokens | Summary (~3K) | 1.5% |
| GPT-4 Turbo | 128K tokens | Summary (~3K) | 2.3% |
| Claude 3.5 | 500K tokens | Full (~40K) | 8% |
| Gemini 1.5 Pro | 2M tokens | Full (~40K) | 2% |

**Recommendation**: Use summary resource for most use cases. Only use full resource with large-context models when deep element discovery is needed.

## Configuration

### Default Configuration (Disabled)

By default, MCP Resources are **disabled** to:
1. Avoid token overhead in current non-functional clients
2. Provide opt-in behavior for future functionality
3. Ensure no surprises for users with limited context models

### Enabling Resources

Add to your DollhouseMCP configuration:

```yaml
resources:
  enabled: true
  expose:
    - summary  # Lightweight (~3K tokens)
    # - full   # Heavy (~40K tokens) - uncomment if needed
    # - stats  # Minimal (JSON)
```

Or use environment variables:

```bash
export DOLLHOUSE_RESOURCES_ENABLED=true
export DOLLHOUSE_RESOURCES_EXPOSE=summary
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `resources.enabled` | boolean | `false` | Master switch for resource exposure |
| `resources.expose` | string[] | `[]` | Which resources to expose: `summary`, `full`, `stats` |
| `resources.cache_ttl` | number | `60000` | Cache TTL in milliseconds (60 seconds) |

## Current Client Support

### Claude Code (Most Common Client)

**Status**: ❌ Discovery only, does NOT read or inject

Claude Code will:
- ✅ Call `resources/list` (shows resources in autocomplete)
- ❌ Never call `resources/read` (content not fetched)
- ❌ Never inject into LLM context

**Evidence**:
- Token usage shows ~24K overhead (tools only), not ~72K (tools + 48K resource)
- Protocol logs show `resources/list` called, `resources/read` never called
- GitHub Issues #1461, #8239 confirm non-functional status

**Why the docs say it works**: The official documentation is aspirational, not factual. The v1.0.27 announcement about "MCP resources support" added discovery UI, not content fetching.

### Claude Desktop

**Status**: ⚠️ Manual attachment only

To use resources in Claude Desktop:
1. Click the "+" button in conversation
2. Select "MCP Server"
3. Choose "References" (resources)
4. Select the specific resource to attach
5. **Then** `resources/read` is called and content is injected

**Limitations**:
- Requires manual user action (not automatic)
- Most users won't discover this feature
- No way to auto-inject based on conversation context

### VS Code with MCP Support

**Status**: ⚠️ Manual attachment only

Similar to Claude Desktop:
1. Use "Add Context" menu
2. Select "MCP Resources"
3. Choose resource to attach

### Other Clients

Most MCP clients either:
- ❌ Don't support resources at all
- ⚠️ Support discovery only (like Claude Code)

## Manual Attachment Process

If you're using Claude Desktop or VS Code and want to manually attach resources:

### In Claude Desktop:

1. **Start conversation normally**
2. **Click the "+" button** (bottom of chat input)
3. **Select "MCP Server" → "References"**
4. **Choose resource**:
   - "Capability Index Summary" for lightweight context (~3K tokens)
   - "Capability Index (Full)" for comprehensive context (~40K tokens)
   - "Capability Index Statistics" for size metrics
5. **Resource is now attached** to conversation

### In VS Code:

1. **Open chat panel**
2. **Click "Add Context" button**
3. **Select "MCP Resources"**
4. **Choose "DollhouseMCP" server**
5. **Select resource to attach**

## When Will This Be Useful?

MCP Resources will become useful when:

1. **Claude Code adds resource reading** - Anthropic implements the missing `resources/read` functionality
2. **Automatic injection support** - Clients add heuristics for when to auto-inject resources
3. **Context-aware selection** - LLMs can request specific resources based on conversation needs

**Expected timeline**: Unknown. The MCP specification is mature (June 2025), but client implementation is lagging.

## Technical Details

### Resource URIs

DollhouseMCP uses custom URI scheme:

- `dollhouse://capability-index/summary`
- `dollhouse://capability-index/full`
- `dollhouse://capability-index/stats`

### MIME Types

- Summary/Full: `text/yaml` (human-readable YAML format)
- Stats: `application/json` (machine-readable JSON)

### Caching

Resources are cached for 60 seconds to avoid excessive file I/O:
- Capability index is read from `~/.dollhouse/portfolio/capability-index.yaml`
- Cache refreshes automatically after TTL expires
- Ensures consistent data across multiple resource requests

### Performance

When enabled, resources have minimal overhead:
- **Startup**: No impact (resources generated on-demand)
- **Memory**: ~150KB for cached capability index
- **CPU**: Negligible (60-second cache reduces file reads)

When disabled (default):
- **Startup**: No overhead
- **Memory**: 0 bytes
- **CPU**: 0 cycles

## Troubleshooting

### Resources Don't Appear in Claude Code

**This is expected behavior.** Claude Code only supports resource discovery, not reading. Resources will appear in @-mention autocomplete but won't be injected into conversations.

**Solution**: Either:
1. Wait for Claude Code to add resource reading support
2. Switch to Claude Desktop and use manual attachment
3. Continue using tools for all functionality (recommended)

### Resources Show in List But Content Never Loads

**This is the current state of all MCP clients.** The `resources/list` call succeeds but `resources/read` is never called.

**Verify**:
```bash
# Check token usage in Claude Code
# Should show ~24K (tools only), not ~72K (tools + resources)
```

### Manual Attachment Doesn't Work

**Symptoms**: Resource attached but no content appears

**Solutions**:
1. Verify resources are enabled in config
2. Check capability index exists: `~/.dollhouse/portfolio/capability-index.yaml`
3. Verify file permissions (readable by MCP server)
4. Check MCP server logs for errors

### Token Limit Exceeded

**Symptoms**: Model refuses to process due to context size

**Solution**: Use smaller resource variant:
- Switch from `full` to `summary` resource
- Or disable resources entirely: `resources.enabled: false`

## Security Considerations

### Data Exposure

Resources expose information about your portfolio:
- Element names and descriptions
- Action verb mappings
- Relationship data

**Risk**: Low. Resources contain only metadata, not actual element content.

### Token Costs

Large resources can consume significant context:
- Full resource: ~40K tokens
- May impact API costs for paid models

**Mitigation**: Default to disabled. Users must explicitly enable.

### Cache Poisoning

Resources are cached for performance:
- 60-second TTL limits exposure window
- Cache only includes data from trusted local files
- No network data included in resources

**Risk**: Minimal. All data sourced from user's own portfolio.

## Development Information

### Implementation

Resources are implemented in:
- `src/server/resources/CapabilityIndexResource.ts` - Resource handler
- Three resource variants: summary, full, stats
- Integrated with Enhanced Capability Index system

### Testing

Resources are currently:
- ✅ Implemented and specification-compliant
- ✅ Tested in development environment
- ❌ Non-functional in production MCP clients

### Research

For detailed research on MCP client support, see:
- [MCP_RESOURCES_SUPPORT_RESEARCH_2025-10-16.md](../development/MCP_RESOURCES_SUPPORT_RESEARCH_2025-10-16.md)

## Frequently Asked Questions

### Q: Why implement a feature that doesn't work?

**A**: Future-proofing. When Claude Code adds full resource support (likely soon), DollhouseMCP will be ready immediately. The implementation has zero overhead when disabled.

### Q: Should I enable resources now?

**A**: No, unless you're using Claude Desktop/VS Code and willing to manually attach resources. Default disabled configuration is recommended for most users.

### Q: Will this feature ever work automatically?

**A**: Likely yes. The MCP specification is mature and the protocol supports automatic resource injection. Client implementation is the bottleneck.

### Q: What's the difference between tools and resources?

**A**: Control model:
- **Tools**: LLM decides when to call based on user query (model-controlled)
- **Resources**: User/application decides when to inject (application-controlled)

### Q: Can I use resources with other MCP servers?

**A**: Yes! MCP Resources are a standard protocol feature. Any MCP-compatible client that supports resources can access them from any MCP server.

## Related Documentation

- [MCP Resources Research](../development/MCP_RESOURCES_SUPPORT_RESEARCH_2025-10-16.md) - Detailed investigation
- [Enhanced Capability Index](../features/ENHANCED_CAPABILITY_INDEX.md) - Source data system
- [Configuration Guide](../guides/CONFIGURATION.md) - General configuration
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18) - Official protocol docs

## Support

If you have questions about MCP Resources:
- **GitHub Issues**: Report bugs or request enhancements
- **GitHub Discussions**: Ask questions or share ideas
- **Documentation**: Check the links above for more details

---

**Last Updated**: October 16, 2025
**Status**: Non-functional in Claude Code, manual attachment only in Claude Desktop/VS Code
**Default Configuration**: Disabled for safety and zero overhead

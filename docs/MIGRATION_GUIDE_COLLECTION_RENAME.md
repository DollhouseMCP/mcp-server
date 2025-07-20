# Migration Guide: Marketplace → Collection Rename

## Overview

As of v1.2.5, DollhouseMCP has renamed all "marketplace" terminology to "collection" to better reflect the collaborative nature of the persona sharing platform. This is a **breaking change** that requires updates to any scripts or configurations using the old tool names.

## Tool Name Changes

The following MCP tools have been renamed:

| Old Tool Name | New Tool Name | Status |
|--------------|---------------|---------|
| `browse_marketplace` | `browse_collection` | ⚠️ Deprecated |
| `search_marketplace` | `search_collection` | ⚠️ Deprecated |
| `get_marketplace_persona` | `get_collection_persona` | ⚠️ Deprecated |
| `install_persona` | `install_persona` | ✅ Unchanged |
| `submit_persona` | `submit_persona` | ✅ Unchanged |

## Backward Compatibility

**Important**: The old tool names are still supported in v1.2.5 but are deprecated and will be removed in v2.0.0 (estimated Q1 2026).

### Deprecation Timeline
- **v1.2.5**: Both old and new tool names work (current)
- **v2.0.0 (Q1 2026)**: Old tool names will be removed
- **Advance Notice**: We'll provide at least 3 months warning before removal

## Migration Steps

### 1. Update Your Scripts

Search for any usage of the old tool names and update them:

```bash
# Find usage in your scripts
grep -r "browse_marketplace\|search_marketplace\|get_marketplace_persona" your-scripts/

# Update the tool names
# browse_marketplace → browse_collection
# search_marketplace → search_collection
# get_marketplace_persona → get_collection_persona
```

### 2. Update Claude Desktop Configuration

If you have custom shortcuts or scripts in Claude Desktop that use these tools, update them to use the new names.

### 3. Update Any Automation

If you have GitHub Actions, CI/CD pipelines, or other automation using these tools, update the tool names.

## Examples

### Before (Old)
```javascript
// Browse the marketplace
await mcp.call_tool("browse_marketplace", { category: "creative" });

// Search for personas
await mcp.call_tool("search_marketplace", { query: "writing assistant" });

// Get persona details
await mcp.call_tool("get_marketplace_persona", { path: "creative/writer.md" });
```

### After (New)
```javascript
// Browse the collection
await mcp.call_tool("browse_collection", { category: "creative" });

// Search for personas
await mcp.call_tool("search_collection", { query: "writing assistant" });

// Get persona details
await mcp.call_tool("get_collection_persona", { path: "creative/writer.md" });
```

## Repository Changes

The GitHub repository for shared personas has also moved:
- **Old**: `https://github.com/DollhouseMCP/personas`
- **New**: `https://github.com/DollhouseMCP/collection`

## Need Help?

If you encounter any issues during migration:
1. Check the [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues) for known problems
2. Create a new issue if you need assistance
3. The old tool names will continue working until v2.0.0, so there's no immediate urgency

## Why This Change?

The term "collection" better represents:
- The collaborative nature of persona sharing
- The curated aspect of the persona repository
- The community-driven approach to building personas

Thank you for your patience during this transition!
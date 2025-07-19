# Migration Guide: Marketplace to Collection Terminology Change

## Overview

As of version 1.2.5, DollhouseMCP has updated its terminology from "marketplace" to "collection" to better reflect the nature of the content repository. This guide will help you migrate your existing integrations to use the new tool names.

## What Changed?

The following MCP tools have been renamed:

| Old Tool Name (Deprecated) | New Tool Name | Purpose |
|---------------------------|---------------|---------|
| `browse_marketplace` | `browse_collection` | Browse content by section and category |
| `search_marketplace` | `search_collection` | Search for content by keywords |
| `get_marketplace_persona` | `get_collection_content` | Get detailed information about content |
| `install_persona` | `install_content` | Install content to your local collection |
| `submit_persona` | `submit_content` | Submit content for community review |

## Backward Compatibility

**Good news!** The old tool names continue to work in version 1.2.5 to ensure your existing integrations don't break. However, they are marked as deprecated and will show `[DEPRECATED]` in their descriptions.

## Migration Steps

### 1. Update Your Tool Calls

Replace the old tool names with the new ones in your code:

#### Before:
```javascript
// Old way (deprecated)
await mcp.call('browse_marketplace', { section: 'library', category: 'personas' });
await mcp.call('search_marketplace', { query: 'creative writer' });
await mcp.call('get_marketplace_persona', { path: 'library/personas/creative/writer.md' });
await mcp.call('install_persona', { path: 'library/personas/creative/writer.md' });
await mcp.call('submit_persona', { content: 'My Custom Persona' });
```

#### After:
```javascript
// New way (recommended)
await mcp.call('browse_collection', { section: 'library', category: 'personas' });
await mcp.call('search_collection', { query: 'creative writer' });
await mcp.call('get_collection_content', { path: 'library/personas/creative/writer.md' });
await mcp.call('install_content', { path: 'library/personas/creative/writer.md' });
await mcp.call('submit_content', { content: 'My Custom Persona' });
```

### 2. Update Your Documentation

If you have documentation or scripts that reference the old tool names, update them to use the new terminology:

- "marketplace" → "collection"
- "marketplace persona" → "collection content"
- "persona" (in tool names) → "content"

### 3. Test Your Integration

After updating, test your integration to ensure everything works correctly with the new tool names.

## Why This Change?

The term "collection" better represents what DollhouseMCP provides:
- A curated collection of AI behavioral profiles, skills, agents, and more
- Not limited to commercial transactions (which "marketplace" implies)
- More inclusive of all content types, not just personas

## Timeline

- **Version 1.2.5**: Both old and new tool names work (current)
- **Version 2.0.0 (Q2 2025)**: Deprecated tools will be removed
- **Advance Notice**: At least 3 months warning before removal

## Need Help?

If you encounter any issues during migration:

1. Check that you're using the correct new tool names
2. Verify the parameters haven't changed (they haven't in this update)
3. Create an issue at https://github.com/DollhouseMCP/mcp-server/issues

## Quick Reference Card

```
Old → New Tool Mapping:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
browse_marketplace      → browse_collection
search_marketplace      → search_collection  
get_marketplace_persona → get_collection_content
install_persona         → install_content
submit_persona          → submit_content
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Remember: The functionality remains exactly the same - only the names have changed!
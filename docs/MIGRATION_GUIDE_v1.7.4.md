# Migration Guide - v1.7.4 Tool Clarity Update

## Overview

DollhouseMCP v1.7.4 introduces breaking changes to improve tool clarity and eliminate confusion caused by duplicate tool names. This guide will help you migrate your scripts and workflows.

## Breaking Changes

### Tool Renames

The following tools have been renamed for clarity:

| Old Name | New Name | Purpose |
|----------|----------|---------|
| `install_content` | `install_collection_content` | Install elements FROM the DollhouseMCP collection TO your local portfolio |
| `submit_content` | `submit_collection_content` | Submit elements TO the DollhouseMCP collection (via your GitHub portfolio) |
| `sync_portfolio` (ConfigToolsV2) | `portfolio_element_manager` | Manage INDIVIDUAL elements between local and GitHub portfolio |

### Clear Tool Separation

- **`sync_portfolio`** - Now exclusively for BULK operations on ALL elements
- **`portfolio_element_manager`** - For INDIVIDUAL element operations

## Migration Examples

### Before (Old Tool Names)
```javascript
// Installing from collection
await mcp.call('install_content', {
  path: 'library/personas/creative-writer.md'
});

// Submitting to collection
await mcp.call('submit_content', {
  content: 'My Custom Persona'
});

// Downloading individual element from GitHub
await mcp.call('sync_portfolio', {
  operation: 'download',
  element_name: 'Victorian Scholar',
  element_type: 'personas'
});
```

### After (New Tool Names)
```javascript
// Installing from collection - MORE CLEAR
await mcp.call('install_collection_content', {
  path: 'library/personas/creative-writer.md'
});

// Submitting to collection - MORE CLEAR
await mcp.call('submit_collection_content', {
  content: 'My Custom Persona'
});

// Downloading individual element from GitHub - NO CONFUSION
await mcp.call('portfolio_element_manager', {
  operation: 'download',
  element_name: 'Victorian Scholar',
  element_type: 'personas'
});
```

## New Safety Features for sync_portfolio

The `sync_portfolio` tool now includes safety modes:

### Sync Modes
```javascript
// Safe default - only adds, never deletes
await mcp.call('sync_portfolio', {
  direction: 'push',
  mode: 'additive'  // DEFAULT
});

// Exact mirror with confirmations
await mcp.call('sync_portfolio', {
  direction: 'both',
  mode: 'mirror',
  confirm_deletions: true  // DEFAULT
});

// GitHub as backup
await mcp.call('sync_portfolio', {
  direction: 'pull',
  mode: 'backup'
});
```

### Always Preview First
```javascript
// RECOMMENDED: Always do a dry run first
await mcp.call('sync_portfolio', {
  direction: 'push',
  dry_run: true  // See what would happen
});
```

## Quick Reference

### Collection Operations
- **FROM collection TO local**: `install_collection_content`
- **FROM local TO collection**: `submit_collection_content`

### Portfolio Operations (Local ↔ GitHub)
- **Individual elements**: `portfolio_element_manager`
  - Operations: `download`, `upload`, `list-remote`, `compare`
- **Bulk all elements**: `sync_portfolio`
  - Modes: `additive` (safe), `mirror`, `backup`

## Common Scenarios

### Scenario 1: Get a persona from the collection
```javascript
// Use install_collection_content
await mcp.call('install_collection_content', {
  path: 'library/personas/creative-writer.md'
});
```

### Scenario 2: Share your custom element with the community
```javascript
// Use submit_collection_content
await mcp.call('submit_collection_content', {
  content: 'My Awesome Element'
});
```

### Scenario 3: Download one element from your GitHub portfolio
```javascript
// Use portfolio_element_manager
await mcp.call('portfolio_element_manager', {
  operation: 'download',
  element_name: 'My Private Persona',
  element_type: 'personas',
  options: { force: true }
});
```

### Scenario 4: Backup everything to GitHub
```javascript
// Use sync_portfolio with additive mode
await mcp.call('sync_portfolio', {
  direction: 'push',
  mode: 'additive',  // Won't delete anything
  dry_run: true      // Preview first!
});
```

## Troubleshooting

### Error: Tool not found
If you get a "tool not found" error, you're likely using the old tool name. Check the rename table above.

### Confusion about which tool to use
- **Working with the collection?** Use tools with `collection` in the name
- **Managing individual elements?** Use `portfolio_element_manager`
- **Syncing everything?** Use `sync_portfolio`

### Fuzzy Matching Still Works
The `portfolio_element_manager` tool still supports fuzzy matching:
- `"Victorian Scholar"` will find `"Verbose-Victorian-Scholar"`
- `"verbose victorian"` will also work

## Benefits of These Changes

1. **No More Confusion**: Tool names clearly indicate their purpose
2. **Safer Defaults**: `sync_portfolio` won't accidentally delete your work
3. **Better AI Understanding**: AI assistants can now easily distinguish between tools
4. **Clearer Mental Model**: Collection vs Portfolio operations are distinct

## Need Help?

If you encounter issues migrating:
1. Check the tool descriptions - they're now more detailed
2. Use `dry_run: true` to preview operations
3. Report issues at: https://github.com/DollhouseMCP/mcp-server/issues

## Version Requirements

These changes are available in DollhouseMCP v1.7.4 and later.

---

*This guide will be updated based on user feedback and common questions.*
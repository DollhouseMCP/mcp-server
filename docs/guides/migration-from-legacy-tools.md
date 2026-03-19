# Migration Guide: Legacy Tools to dollhouse_config

**Last Updated:** November 7, 2025
**Deprecation Version:** v1.9.x
**Removal Version:** v2.0.0 (planned)

## Overview

Several legacy MCP tools have been deprecated in favor of the unified `dollhouse_config` tool, which provides a consistent interface for all configuration operations. This guide helps you migrate from the old tools to the new ones.

## Why the Migration?

The legacy tools were scattered across different modules and lacked consistency:
- User identity tools (`set_user_identity`, `get_user_identity`, `clear_user_identity`)
- Display configuration tools (`configure_indicator`, `get_indicator_config`)
- Collection submission tools (`configure_collection_submission`, `get_collection_submission_config`)

The new `dollhouse_config` tool consolidates all configuration into a single, powerful interface with:
- Consistent API across all configuration types
- Support for nested configuration paths (dot notation)
- Export/import capabilities for backups
- Configuration wizard for guided setup
- Better validation and error handling

## Migration Timeline

| Version | Status |
|---------|--------|
| **v1.9.x** (current) | Both old and new tools work. Deprecation warnings shown. |
| **v2.0.0** (future) | Old tools removed. Only `dollhouse_config` available. |

We recommend migrating now to avoid disruption when v2.0.0 is released.

---

## Migration Examples

### User Identity Management

#### Old: `set_user_identity`
```javascript
// Old way (DEPRECATED)
await client.callTool("set_user_identity", {
  username: "octocat",
  email: "octocat@github.com"
});
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
await client.callTool("dollhouse_config", {
  action: "set",
  setting: "user.username",
  value: "octocat"
});

await client.callTool("dollhouse_config", {
  action: "set",
  setting: "user.email",
  value: "octocat@github.com"
});
```

---

#### Old: `get_user_identity`
```javascript
// Old way (DEPRECATED)
const result = await client.callTool("get_user_identity");
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
const result = await client.callTool("dollhouse_config", {
  action: "get",
  setting: "user"  // Get entire user section
});

// Or get specific field
const username = await client.callTool("dollhouse_config", {
  action: "get",
  setting: "user.username"
});
```

---

#### Old: `clear_user_identity`
```javascript
// Old way (DEPRECATED)
await client.callTool("clear_user_identity");
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
await client.callTool("dollhouse_config", {
  action: "reset",
  section: "user"  // Clears entire user section
});
```

---

### Display Indicator Configuration

#### Old: `configure_indicator`
```javascript
// Old way (DEPRECATED)
await client.callTool("configure_indicator", {
  enabled: true,
  style: "compact",
  includeEmoji: true,
  includeVersion: false
});
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
await client.callTool("dollhouse_config", {
  action: "set",
  setting: "display.indicator.enabled",
  value: true
});

await client.callTool("dollhouse_config", {
  action: "set",
  setting: "display.indicator.style",
  value: "compact"
});

await client.callTool("dollhouse_config", {
  action: "set",
  setting: "display.indicator.includeEmoji",
  value: true
});

// Or set multiple at once using object value
await client.callTool("dollhouse_config", {
  action: "set",
  setting: "display.indicator",
  value: {
    enabled: true,
    style: "compact",
    includeEmoji: true,
    includeVersion: false
  }
});
```

---

#### Old: `get_indicator_config`
```javascript
// Old way (DEPRECATED)
const config = await client.callTool("get_indicator_config");
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
const config = await client.callTool("dollhouse_config", {
  action: "get",
  setting: "display.indicator"
});
```

---

### Collection Submission Configuration

#### Old: `configure_collection_submission`
```javascript
// Old way (DEPRECATED)
await client.callTool("configure_collection_submission", {
  autoSubmit: true
});
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
await client.callTool("dollhouse_config", {
  action: "set",
  setting: "collection.auto_submit",
  value: true
});
```

---

#### Old: `get_collection_submission_config`
```javascript
// Old way (DEPRECATED)
const config = await client.callTool("get_collection_submission_config");
```

#### New: `dollhouse_config`
```javascript
// New way (RECOMMENDED)
const config = await client.callTool("dollhouse_config", {
  action: "get",
  setting: "collection"
});
```

---

## Advanced `dollhouse_config` Features

The new tool offers capabilities that weren't available with the legacy tools:

### Export Configuration
```javascript
// Export entire configuration as YAML
const backup = await client.callTool("dollhouse_config", {
  action: "export",
  format: "yaml"  // or "json"
});
```

### Import Configuration
```javascript
// Import configuration from backup
await client.callTool("dollhouse_config", {
  action: "import",
  data: yamlConfigString
});
```

### Reset Specific Sections
```javascript
// Reset just the sync configuration to defaults
await client.callTool("dollhouse_config", {
  action: "reset",
  section: "sync"
});
```

### Configuration Wizard
```javascript
// Run interactive configuration wizard (when available)
await client.callTool("dollhouse_config", {
  action: "wizard"
});
```

### View All Configuration
```javascript
// Get complete configuration
const allConfig = await client.callTool("dollhouse_config", {
  action: "get"
  // No 'setting' parameter = get everything
});
```

---

## Configuration Schema Reference

The `dollhouse_config` tool supports these configuration sections:

### User Configuration
- `user.username` - Your username for attribution
- `user.email` - Your email address
- `user.display_name` - Display name (optional)

### GitHub Authentication
- `github.auth.client_id` - OAuth app client ID
- `github.auth.token` - Access token (managed automatically)

### Display Settings
- `display.indicator.enabled` - Show persona indicator
- `display.indicator.style` - Display style (full, minimal, compact, custom)
- `display.indicator.includeEmoji` - Include emoji
- `display.indicator.includeVersion` - Include version
- `display.indicator.includeAuthor` - Include author
- `display.indicator.customFormat` - Custom format string

### Sync Settings
- `sync.auto_sync` - Auto-sync on changes
- `sync.default_mode` - Default sync mode (additive, mirror, backup)
- `sync.default_direction` - Default direction (push, pull, both)

### Collection Settings
- `collection.auto_submit` - Auto-submit to collection after upload
- `collection.cache_ttl` - Cache time-to-live
- `collection.default_visibility` - Default visibility for submissions

### Portfolio Settings
- `portfolio.repository_name` - GitHub repository name
- `portfolio.default_visibility` - Default repository visibility (public, private)

---

## Migration Checklist

Use this checklist to ensure complete migration:

- [ ] Replace all `set_user_identity` calls with `dollhouse_config action="set"`
- [ ] Replace all `get_user_identity` calls with `dollhouse_config action="get"`
- [ ] Replace all `clear_user_identity` calls with `dollhouse_config action="reset"`
- [ ] Replace all `configure_indicator` calls with `dollhouse_config action="set"`
- [ ] Replace all `get_indicator_config` calls with `dollhouse_config action="get"`
- [ ] Replace all `configure_collection_submission` calls with `dollhouse_config action="set"`
- [ ] Replace all `get_collection_submission_config` calls with `dollhouse_config action="get"`
- [ ] Test all configuration operations with the new tool
- [ ] Update any automation scripts or workflows
- [ ] Update documentation/comments referencing old tools

---

## Troubleshooting

### "Unknown tool" error with legacy tools

If you receive an error that a legacy tool doesn't exist, you're likely using v2.0.0 or later. Update your code to use `dollhouse_config` instead.

### Configuration not persisting

The new `dollhouse_config` tool uses the same configuration backend as the legacy tools. If settings aren't persisting:

1. Check file permissions on `~/.dollhouse/config.yaml`
2. Ensure the directory exists and is writable
3. Check logs for configuration write errors

### Migration of existing configuration

Existing configuration set via legacy tools is automatically available via `dollhouse_config`. No manual migration needed - just change your tool calls.

---

## Getting Help

If you encounter issues during migration:

1. Check the [Configuration Schema Reference](../reference/config-schema.md) for valid settings
2. Review [API Reference](../reference/api-reference.md) for `dollhouse_config` examples
3. Run `dollhouse_config action="get"` to see current configuration state
4. Check the [Troubleshooting Guide](./troubleshooting.md) for common issues
5. Open an issue on GitHub with configuration export output

---

## Summary

| Legacy Tool | New Approach | Action |
|-------------|--------------|--------|
| `set_user_identity` | `dollhouse_config` | `action="set"` with `setting="user.username"` |
| `get_user_identity` | `dollhouse_config` | `action="get"` with `setting="user"` |
| `clear_user_identity` | `dollhouse_config` | `action="reset"` with `section="user"` |
| `configure_indicator` | `dollhouse_config` | `action="set"` with `setting="display.indicator.*"` |
| `get_indicator_config` | `dollhouse_config` | `action="get"` with `setting="display.indicator"` |
| `configure_collection_submission` | `dollhouse_config` | `action="set"` with `setting="collection.auto_submit"` |
| `get_collection_submission_config` | `dollhouse_config` | `action="get"` with `setting="collection"` |

**Migration is straightforward:** Replace tool name with `dollhouse_config`, add appropriate `action` parameter, use dot notation for settings.

The new tool provides more power, consistency, and flexibility. We recommend migrating today to avoid disruption when v2.0.0 is released.

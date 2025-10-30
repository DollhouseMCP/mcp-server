# DollhouseMCP Configuration Guide

## Overview

DollhouseMCP uses a YAML-based configuration system that provides fine-grained control over server behavior, feature enablement, and operational parameters. Configuration can be managed through the `dollhouse_config` MCP tool or by editing the YAML file directly.

**Configuration File**: `~/.dollhouse/config.yml`

---

## Table of Contents

- [Configuration Structure](#configuration-structure)
- [Auto-Load Configuration](#auto-load-configuration)
- [User Configuration](#user-configuration)
- [Sync Configuration](#sync-configuration)
- [Security Configuration](#security-configuration)
- [Telemetry Configuration](#telemetry-configuration)
- [Resources Configuration](#resources-configuration)
- [Management Tools](#management-tools)
- [Examples](#examples)
- [Environment Variables](#environment-variables)

---

## Configuration Structure

The configuration file is organized into logical sections:

```yaml
# User Identity
user:
  username: "your-github-username"
  email: "your@email.com"
  name: "Your Full Name"

# Auto-Load Memories (v1.9.25+)
autoLoad:
  enabled: true
  maxTokenBudget: 5000
  memories: []

# Portfolio Synchronization
sync:
  enabled: true
  auto_sync: false
  default_visibility: "public"
  repository_name: "dollhouse-portfolio"

# Security Settings
security:
  validation_enabled: true
  background_validation: true
  max_file_size: 10485760  # 10MB
  trusted_sources: []

# Telemetry
telemetry:
  enabled: true
  optin: false
  no_remote: false

# MCP Resources
resources:
  enabled: false
  expose: ["summary", "full", "stats"]
  cache_ttl: 300
```

---

## Auto-Load Configuration

**New in v1.9.25**: Automatically load memories on server startup.

### Overview

Auto-load memories provide baseline knowledge to the AI system immediately upon server startup, eliminating the need for expensive searches or manual context injection. This is similar to how CLAUDE.md provides automatic project context.

### Configuration Options

```yaml
autoLoad:
  enabled: true              # Enable/disable auto-load feature
  maxTokenBudget: 5000      # Maximum tokens for auto-load memories
  memories: []              # Specific memories to load (empty = use flags)
```

#### `enabled: boolean`

Controls whether the auto-load feature is active.

**Default**: `true`

**Values**:
- `true`: Auto-load memories marked with `autoLoad: true` on startup
- `false`: Disable auto-load entirely, no memories loaded automatically

**Example**:
```yaml
autoLoad:
  enabled: false  # Disable auto-load
```

**Use Cases**:
- **Enable**: Production deployments, agent swarms, team environments
- **Disable**: Testing with minimal context, debugging, resource-constrained environments

#### `maxTokenBudget: number`

Maximum number of tokens that can be consumed by all auto-load memories combined.

**Default**: `5000`

**Range**: `1000` - `50000` (recommended)

**Example**:
```yaml
autoLoad:
  maxTokenBudget: 10000  # Allow up to 10k tokens
```

**Note**: Token budget enforcement is planned for a future release. Currently, this value is stored but not enforced.

**Best Practices**:
- **5000 tokens**: Baseline knowledge only (~2-3 memories)
- **10000 tokens**: Baseline + project context (~5-8 memories)
- **20000 tokens**: Comprehensive context (~15-20 memories)
- **50000 tokens**: Maximum recommended (risk of context overflow)

#### `memories: string[]`

Explicitly specify which memories to load, overriding `autoLoad` flags in memory files.

**Default**: `[]` (empty array = use memory file flags)

**Example**:
```yaml
# Load only specific memories
autoLoad:
  memories:
    - dollhousemcp-baseline-knowledge
    - project-context
    - team-guidelines
```

**Behavior**:
- **Empty array `[]`**: Use `autoLoad: true` flags in memory files (default)
- **Non-empty array**: Load only specified memories, ignore `autoLoad` flags

**Use Cases**:
- **Default behavior**: Let memory files control auto-loading
- **Explicit list**: Testing, deployment-specific configurations
- **Override**: Temporarily enable/disable specific memories

### Auto-Load Priority System

Memories are loaded in priority order (lower numbers first). Configure priority in memory metadata:

```yaml
# In memory file
---
name: baseline-knowledge
autoLoad: true
priority: 1      # Loads first
---
```

**Priority Guidelines**:
- `1-10`: Critical baseline knowledge
- `11-99`: Project context and team information
- `100-500`: Domain-specific knowledge
- `501-998`: Nice-to-have context
- `999`: Default priority (if not specified)

### Example Configurations

#### Minimal Configuration (Baseline Only)

```yaml
autoLoad:
  enabled: true
  maxTokenBudget: 3000
  memories: []  # Use flags in memory files
```

This loads only memories with `autoLoad: true`, limited to ~3000 tokens.

#### Development Configuration (Comprehensive Context)

```yaml
autoLoad:
  enabled: true
  maxTokenBudget: 15000
  memories: []
```

Allows more context for development work where understanding is critical.

#### Testing Configuration (Disabled)

```yaml
autoLoad:
  enabled: false
  maxTokenBudget: 5000
  memories: []
```

Disables auto-load entirely for isolated testing.

#### Production Configuration (Explicit List)

```yaml
autoLoad:
  enabled: true
  maxTokenBudget: 8000
  memories:
    - dollhousemcp-baseline-knowledge
    - production-runbook
    - incident-response-procedures
```

Loads only specific memories needed for production support.

---

## User Configuration

Identifies the user for attribution and portfolio management.

```yaml
user:
  username: "mickdarling"
  email: "mick@example.com"
  name: "Mick Darling"
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | GitHub username for portfolio sync |
| `email` | string | No | User's email address |
| `name` | string | No | User's full name for attribution |

### Usage

User identity is used for:
- Element attribution (author field)
- GitHub portfolio synchronization
- Community collection submissions
- Analytics (if telemetry enabled)

---

## Sync Configuration

Controls portfolio synchronization with GitHub.

```yaml
sync:
  enabled: true
  auto_sync: false
  default_visibility: "public"
  repository_name: "dollhouse-portfolio"
  auto_submit: false
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable GitHub sync feature |
| `auto_sync` | boolean | `false` | Automatically sync changes to GitHub |
| `default_visibility` | string | `"public"` | Default repo visibility ("public" or "private") |
| `repository_name` | string | `"dollhouse-portfolio"` | GitHub repository name |
| `auto_submit` | boolean | `false` | Auto-submit to community collection |

### Auto-Sync Behavior

When `auto_sync: true`:
- Changes to local portfolio trigger immediate GitHub push
- New elements are automatically committed
- Edits and deletions are synced in real-time

**Warning**: Auto-sync can create many small commits. Consider using manual sync for cleaner history.

---

## Security Configuration

Controls security validation and file access restrictions.

```yaml
security:
  validation_enabled: true
  background_validation: true
  max_file_size: 10485760  # 10MB in bytes
  trusted_sources: []
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `validation_enabled` | boolean | `true` | Enable security validation |
| `background_validation` | boolean | `true` | Run background validation service |
| `max_file_size` | number | `10485760` | Maximum file size in bytes (10MB) |
| `trusted_sources` | array | `[]` | List of trusted element sources |

### Background Validation

When enabled, the background validator:
- Runs every 5 minutes
- Scans UNTRUSTED memories
- Updates trust levels (VALIDATED, FLAGGED, QUARANTINED)
- No token cost (runs server-side)

---

## Telemetry Configuration

Controls operational telemetry and analytics.

```yaml
telemetry:
  enabled: true
  optin: false
  no_remote: false
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable telemetry system |
| `optin` | boolean | `false` | Opt-in to remote telemetry (PostHog) |
| `no_remote` | boolean | `false` | Local-only telemetry, no remote |

### Control Levels

1. **Fully Disabled**: `enabled: false`
   - No telemetry collected at all
   - Zero overhead

2. **Local Only** (Default): `enabled: true, optin: false`
   - Local logging to `~/.dollhouse/telemetry.log`
   - No remote transmission
   - Privacy-first

3. **Remote Opt-In**: `enabled: true, optin: true`
   - Local logging + PostHog analytics
   - Helps improve DollhouseMCP
   - GDPR compliant

4. **Local Forced**: `enabled: true, no_remote: true`
   - Overrides optin, forces local-only
   - Useful for corporate environments

---

## Resources Configuration

Controls MCP Resources protocol support.

```yaml
resources:
  enabled: false
  expose: ["summary", "full", "stats"]
  cache_ttl: 300
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable MCP Resources |
| `expose` | array | `["summary", "full", "stats"]` | Resource variants to expose |
| `cache_ttl` | number | `300` | Cache TTL in seconds |

### Resource Variants

- `summary`: ~3K tokens, overview of capabilities
- `full`: ~40K tokens, complete capability index
- `stats`: JSON format, machine-readable statistics

**Note**: MCP Resources are currently non-functional in most MCP clients (as of October 2025). This is future-proofing for protocol evolution.

---

## Management Tools

### Using MCP Tools

The `dollhouse_config` MCP tool provides comprehensive configuration management.

#### Get Configuration

```bash
# Get all configuration
dollhouse_config action="get"

# Get specific section
dollhouse_config action="get" section="autoLoad"

# Get specific setting
dollhouse_config action="get" setting="autoLoad.enabled"
```

#### Set Configuration

```bash
# Set a value
dollhouse_config action="set" setting="autoLoad.enabled" value="true"

# Set nested value
dollhouse_config action="set" setting="autoLoad.maxTokenBudget" value="10000"

# Set complex value (JSON)
dollhouse_config action="set" setting="autoLoad.memories" \
  value='["baseline-knowledge", "project-context"]'
```

#### Reset Configuration

```bash
# Reset all configuration to defaults
dollhouse_config action="reset"

# Reset specific section
dollhouse_config action="reset" section="autoLoad"
```

#### Export/Import Configuration

```bash
# Export configuration (YAML format)
dollhouse_config action="export" format="yaml"

# Export as JSON
dollhouse_config action="export" format="json"

# Import configuration
dollhouse_config action="import" data="<yaml-string>"
```

#### Configuration Wizard

```bash
# Interactive configuration wizard
dollhouse_config action="wizard"
```

The wizard guides you through:
1. User identity setup
2. Auto-load memory configuration
3. Portfolio sync settings
4. Security preferences
5. Telemetry choices

### Direct File Editing

You can also edit `~/.dollhouse/config.yml` directly:

```bash
# Open in default editor
code ~/.dollhouse/config.yml

# Or use any text editor
nano ~/.dollhouse/config.yml
vim ~/.dollhouse/config.yml
```

**Important**: After editing, restart the MCP server for changes to take effect.

---

## Examples

### Example 1: Developer Setup

**Scenario**: Local development with comprehensive context, GitHub sync enabled.

```yaml
user:
  username: "developer123"
  email: "dev@example.com"
  name: "Developer Name"

autoLoad:
  enabled: true
  maxTokenBudget: 15000
  memories: []

sync:
  enabled: true
  auto_sync: false
  default_visibility: "public"
  repository_name: "my-dollhouse-portfolio"

security:
  validation_enabled: true
  background_validation: true

telemetry:
  enabled: true
  optin: false  # Local only
```

### Example 2: Production Deployment

**Scenario**: Production system with minimal context, no sync, telemetry enabled.

```yaml
user:
  username: "production-bot"
  email: "ops@company.com"

autoLoad:
  enabled: true
  maxTokenBudget: 5000
  memories:
    - dollhousemcp-baseline-knowledge
    - production-runbook

sync:
  enabled: false

security:
  validation_enabled: true
  background_validation: true
  max_file_size: 5242880  # 5MB limit

telemetry:
  enabled: true
  optin: true  # Help improve the system
```

### Example 3: Testing Environment

**Scenario**: Isolated testing with no auto-load, no sync, local telemetry.

```yaml
user:
  username: "test-user"

autoLoad:
  enabled: false

sync:
  enabled: false

security:
  validation_enabled: true
  background_validation: false  # Faster tests

telemetry:
  enabled: true
  no_remote: true  # Local only
```

### Example 4: Agent Swarm

**Scenario**: Multiple agents with shared baseline knowledge.

```yaml
user:
  username: "agent-controller"

autoLoad:
  enabled: true
  maxTokenBudget: 8000
  memories:
    - dollhousemcp-baseline-knowledge
    - agent-coordination-protocol
    - swarm-architecture

sync:
  enabled: false  # Agents don't sync

security:
  validation_enabled: true
  background_validation: true

telemetry:
  enabled: true
  optin: true
```

---

## Environment Variables

Configuration can also be controlled via environment variables, which take precedence over the YAML file.

### User Identity

```bash
export DOLLHOUSE_USERNAME="your-username"
export DOLLHOUSE_EMAIL="your@email.com"
export DOLLHOUSE_NAME="Your Name"
```

### Portfolio Location

```bash
export DOLLHOUSE_PORTFOLIO_DIR="$HOME/custom-portfolio"
```

### GitHub Authentication

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

### Telemetry Control

```bash
export DOLLHOUSE_TELEMETRY="false"           # Disable all telemetry
export DOLLHOUSE_TELEMETRY_OPTIN="true"      # Enable remote telemetry
export DOLLHOUSE_TELEMETRY_NO_REMOTE="true"  # Force local-only
```

### OAuth Configuration

```bash
export GITHUB_OAUTH_CLIENT_ID="your_client_id"
```

### Auto-Load Control

```bash
# Note: Auto-load is controlled via config.yml, not environment variables
# Use dollhouse_config tool or edit config.yml directly
```

---

## Configuration Validation

The configuration system validates all settings and provides helpful error messages.

### Common Validation Errors

#### Invalid Boolean

```
Error: autoLoad.enabled must be a boolean (true/false)
```

**Fix**: Use `true` or `false` (not `"true"` or `1`)

#### Invalid Number

```
Error: autoLoad.maxTokenBudget must be a number
```

**Fix**: Use numeric value without quotes: `5000` (not `"5000"`)

#### Invalid Array

```
Error: autoLoad.memories must be an array
```

**Fix**: Use array syntax: `["item1", "item2"]`

#### Unknown Field

```
Warning: Unknown configuration field: autoLoad.invalidField
```

**Fix**: Remove the field or check documentation for correct name

---

## Migration Guide

### From v1.9.24 to v1.9.25

**New Field**: `autoLoad` configuration section

```yaml
# Add to existing config.yml
autoLoad:
  enabled: true
  maxTokenBudget: 5000
  memories: []
```

The auto-load feature is **opt-out** (enabled by default). To disable:

```yaml
autoLoad:
  enabled: false
```

### Backward Compatibility

Configuration files from earlier versions remain compatible. Missing sections use default values.

---

## Troubleshooting

### Configuration Not Loading

**Symptoms**: Changes to config.yml don't take effect

**Solutions**:
1. Restart MCP server after editing file
2. Check YAML syntax: `yamllint ~/.dollhouse/config.yml`
3. Verify file permissions: `chmod 644 ~/.dollhouse/config.yml`
4. Check server logs for parse errors

### Auto-Load Not Working

**Symptoms**: Memories with `autoLoad: true` not loading

**Solutions**:
1. Verify `autoLoad.enabled: true` in config
2. Check memory files have `autoLoad: true` in metadata
3. Review server startup logs for loading messages
4. Ensure memories are in portfolio directory
5. Check memory YAML syntax

### Sync Failures

**Symptoms**: Portfolio sync to GitHub fails

**Solutions**:
1. Verify `sync.enabled: true`
2. Check GitHub authentication (token or OAuth)
3. Verify repository exists: `repository_name` setting
4. Check network connectivity
5. Review error messages in logs

### Performance Issues

**Symptoms**: Slow server startup

**Solutions**:
1. Reduce `autoLoad.maxTokenBudget`
2. Disable auto-load for non-critical memories
3. Lower priority (higher numbers) for large memories
4. Split large memories into smaller files

---

## Best Practices

### Configuration Management

1. **Version Control**: Store config.yml in git (exclude secrets)
2. **Documentation**: Comment your configuration choices
3. **Testing**: Test changes in development before production
4. **Backup**: Keep backup of working configuration
5. **Validation**: Always validate after editing

### Auto-Load Configuration

1. **Start Small**: Begin with baseline knowledge only
2. **Monitor Tokens**: Track token usage and adjust budget
3. **Use Priorities**: Order memories by importance
4. **Review Regularly**: Audit auto-load memories quarterly
5. **Test Impact**: Measure startup time and context quality

### Security

1. **Enable Validation**: Keep validation_enabled: true
2. **Background Checks**: Run background_validation: true
3. **File Size Limits**: Don't increase max_file_size unnecessarily
4. **Trusted Sources**: Only add verified sources
5. **Regular Audits**: Review security settings periodically

---

## Related Documentation

- [Memory System](MEMORY_SYSTEM.md) - Complete memory system documentation
- [Quick Start](QUICK_START.md) - Getting started guide
- [API Reference](API_REFERENCE.md) - MCP tool documentation
- [Security](../SECURITY.md) - Security best practices

---

**Last Updated**: October 30, 2025
**Version**: 1.9.25+

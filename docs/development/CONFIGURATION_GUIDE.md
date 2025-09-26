# DollhouseMCP Configuration Guide

## Overview

DollhouseMCP uses a centralized configuration system that provides:
- YAML-based configuration files for human readability
- Default values with user overrides
- Environment variable migration
- Type safety and validation
- Atomic updates with backup
- Privacy-first defaults

## Configuration Location

Configuration is stored in: `~/.dollhouse/config.yml`

## Configuration Structure

### Main Config File

The configuration file is a YAML document with the following structure:

```yaml
version: 1.0.0

user:
  username: null
  email: null
  display_name: null

github:
  portfolio:
    repository_url: null
    repository_name: dollhouse-portfolio
    default_branch: main
    auto_create: true
  auth:
    use_oauth: true
    token_source: environment
    client_id: null  # OAuth client ID

sync:
  enabled: false  # Privacy-first default
  individual:
    require_confirmation: true
    show_diff_before_sync: true
    track_versions: true
    keep_history: 10
  bulk:
    upload_enabled: false
    download_enabled: false
    require_preview: true
    respect_local_only: true
  privacy:
    scan_for_secrets: true
    scan_for_pii: true
    warn_on_sensitive: true
    excluded_patterns:
      - "*.secret"
      - "*-private.*"
      - "credentials/**"
      - "personal/**"

collection:
  auto_submit: false
  require_review: true
  add_attribution: true

elements:
  auto_activate: {}
  default_element_dir: ~/.dollhouse/portfolio
  enhanced_index:
    enabled: true
    limits:
      maxTriggersPerElement: 50
      maxTriggerLength: 50
      maxKeywordsToCheck: 100
    telemetry:
      enabled: false  # Opt-in only
      sampleRate: 0.1
      metricsInterval: 60000
    verbPatterns:
      customPrefixes: []  # Add your own verb prefixes
      customSuffixes: []  # Add your own verb suffixes
      excludedNouns: []   # Add nouns to exclude
    backgroundAnalysis:
      enabled: false
      scanInterval: 300000  # 5 minutes
      maxConcurrentScans: 2

display:
  persona_indicators:
    enabled: true
    style: minimal
    include_emoji: true
  verbose_logging: false
  show_progress: true

wizard:
  completed: false
  dismissed: false
  completedAt: null
  lastSeenVersion: null
  skippedSections: []
```

## Adding New Configuration

When adding new configuration options:

### 1. Update TypeScript Interfaces

Edit `src/config/ConfigManager.ts`:

```typescript
export interface MyFeatureConfig {
  enabled: boolean;
  setting1: string;
  setting2: number;
  // Add your config properties
}

export interface ElementsConfig {
  // ... existing config ...
  my_feature?: MyFeatureConfig;
}
```

### 2. Add Default Values

In `ConfigManager.getDefaultConfig()`:

```typescript
private getDefaultConfig(): DollhouseConfig {
  return {
    // ... existing defaults ...
    elements: {
      // ... existing elements config ...
      my_feature: {
        enabled: false,  // Privacy-first defaults
        setting1: 'default-value',
        setting2: 100
      }
    }
  };
}
```

### 3. Access Configuration

In your code:

```typescript
import { ConfigManager } from '../config/ConfigManager.js';

class MyFeature {
  private config: ConfigManager;

  constructor() {
    this.config = ConfigManager.getInstance();
    this.loadConfiguration();
  }

  private loadConfiguration(): void {
    const config = this.config.getConfig();
    if (config.elements?.my_feature) {
      // Apply configuration
      this.applySettings(config.elements.my_feature);
    }
  }

  // Or use dot notation for specific settings
  private getSetting(): string {
    return this.config.getSetting('elements.my_feature.setting1', 'default');
  }
}
```

## Environment Variables

The system automatically migrates from these environment variables on first run:

- `DOLLHOUSE_USER` → `user.username`
- `DOLLHOUSE_EMAIL` → `user.email`
- `DOLLHOUSE_PORTFOLIO_URL` → `github.portfolio.repository_url`
- `DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION` → `collection.auto_submit`
- `GITHUB_TOKEN` → Used for authentication (not stored in config)
- `DOLLHOUSE_TELEMETRY_ENABLED` → `elements.enhanced_index.telemetry.enabled`

## Command Line Configuration

Users can manage configuration via MCP tools:

```bash
# View current configuration
dollhouse_config --action get

# Set a specific value
dollhouse_config --action set --setting "user.username" --value "myusername"

# Reset to defaults
dollhouse_config --action reset

# Reset specific section
dollhouse_config --action reset --section "sync"

# Export configuration
dollhouse_config --action export

# Import configuration
dollhouse_config --action import --data "<yaml-content>"

# Run configuration wizard
dollhouse_config --action wizard
```

## External Configuration Files

For complex configurations like verb patterns, you can use external files:

### Verb Patterns File

Create `~/.dollhouse/verb-patterns.yml`:

```yaml
customPrefixes:
  - innovate
  - synthesize
  - orchestrate
  - automate

customSuffixes:
  - ify
  - ize
  - ate

excludedNouns:
  - innovation
  - automation
  - configuration
```

Then reference it in the main config:

```yaml
elements:
  enhanced_index:
    verbPatterns: !include verb-patterns.yml
```

## Security Considerations

1. **Validation**: All configuration input is validated to prevent injection attacks
2. **Backup**: Changes create automatic backups at `config.yml.backup`
3. **Permissions**: Config files are created with user-only read/write permissions
4. **Secrets**: Never store secrets in configuration files - use environment variables
5. **Privacy**: Default to privacy-preserving settings (features off by default)

## Testing Configuration

For testing, set `NODE_ENV=test` and `TEST_CONFIG_DIR=/path/to/test/config`:

```bash
NODE_ENV=test TEST_CONFIG_DIR=/tmp/test-config npm test
```

## Best Practices

1. **Privacy First**: Always default new features to disabled/private
2. **Backward Compatibility**: Support old config formats with migration
3. **Type Safety**: Use TypeScript interfaces for all config structures
4. **Documentation**: Document all new configuration options
5. **Validation**: Validate configuration on load and provide clear error messages
6. **Atomic Updates**: Use ConfigManager's update methods for thread-safe changes

## Configuration Schema

A JSON Schema is available at `docs/schemas/config.schema.json` for validation and IDE support.

## Telemetry Configuration

Telemetry is opt-in only. To enable:

1. Set environment variable: `export DOLLHOUSE_TELEMETRY_ENABLED=true`
2. Or update config: `elements.enhanced_index.telemetry.enabled: true`

Telemetry data helps improve verb extraction patterns and is never shared without consent.

## Troubleshooting

### Config Not Loading

Check file permissions:
```bash
ls -la ~/.dollhouse/config.yml
# Should be: -rw------- (600)
```

### Invalid Configuration

The system will use defaults if config is invalid. Check logs:
```bash
tail -f ~/.dollhouse/logs/dollhouse.log | grep "configuration"
```

### Reset Configuration

To start fresh:
```bash
mv ~/.dollhouse/config.yml ~/.dollhouse/config.yml.old
# Restart the application
```

## Future Enhancements

- Web-based configuration UI
- Configuration profiles for different use cases
- Cloud sync for configuration (opt-in)
- Configuration validation CLI tool
- Hot-reload of configuration changes
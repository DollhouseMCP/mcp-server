# Auto-Update Configuration Guide

## Environment Variables

The auto-update system can be configured using environment variables. These can be set in your shell, `.env` file, or system environment.

### Core Settings

#### DOLLHOUSE_DISABLE_UPDATES
Completely disables the auto-update system.

- **Type:** Boolean
- **Default:** `false`
- **Example:** `DOLLHOUSE_DISABLE_UPDATES=true`

Use this in production environments where updates should be managed manually or through CI/CD.

#### DOLLHOUSE_UPDATE_CHANNEL
Selects which release channel to use for updates.

- **Type:** String
- **Default:** `stable`
- **Options:** `stable`, `beta`, `alpha`, `canary`
- **Example:** `DOLLHOUSE_UPDATE_CHANNEL=beta`

#### DOLLHOUSE_AUTO_UPDATE
Enables automatic background update checks.

- **Type:** Boolean
- **Default:** `false`
- **Example:** `DOLLHOUSE_AUTO_UPDATE=true`

### Backup Configuration

#### DOLLHOUSE_BACKUP_DIR
Custom backup directory location.

- **Type:** String
- **Default:** `.backup`
- **Example:** `DOLLHOUSE_BACKUP_DIR=/var/backups/dollhousemcp`

#### DOLLHOUSE_BACKUP_COUNT
Number of backups to retain.

- **Type:** Number
- **Default:** `5`
- **Range:** 1-50
- **Example:** `DOLLHOUSE_BACKUP_COUNT=10`

#### DOLLHOUSE_SKIP_BACKUP
Skip backup creation during updates (not recommended).

- **Type:** Boolean
- **Default:** `false`
- **Example:** `DOLLHOUSE_SKIP_BACKUP=true`

### Security Settings

#### DOLLHOUSE_SKIP_SIGNATURE
Skip GPG signature verification on releases.

- **Type:** Boolean
- **Default:** `false`
- **Example:** `DOLLHOUSE_SKIP_SIGNATURE=true`

#### DOLLHOUSE_GPG_KEYSERVER
Custom GPG keyserver for signature verification.

- **Type:** String
- **Default:** `keyserver.ubuntu.com`
- **Example:** `DOLLHOUSE_GPG_KEYSERVER=pgp.mit.edu`

#### DOLLHOUSE_TRUSTED_SIGNERS
Comma-separated list of trusted GPG key IDs.

- **Type:** String
- **Default:** (DollhouseMCP official keys)
- **Example:** `DOLLHOUSE_TRUSTED_SIGNERS=ABC123,DEF456`

### Rate Limiting

#### DOLLHOUSE_RATE_LIMIT_MAX
Maximum API requests per minute.

- **Type:** Number
- **Default:** `10`
- **Range:** 1-60
- **Example:** `DOLLHOUSE_RATE_LIMIT_MAX=20`

#### DOLLHOUSE_RATE_LIMIT_BURST
Burst capacity for rate limiting.

- **Type:** Number
- **Default:** `5`
- **Range:** 1-20
- **Example:** `DOLLHOUSE_RATE_LIMIT_BURST=10`

### Network Configuration

#### DOLLHOUSE_API_TIMEOUT
API request timeout in milliseconds.

- **Type:** Number
- **Default:** `30000` (30 seconds)
- **Example:** `DOLLHOUSE_API_TIMEOUT=60000`

#### DOLLHOUSE_UPDATE_PROXY
HTTP proxy for update downloads.

- **Type:** String
- **Format:** `http://proxy:port`
- **Example:** `DOLLHOUSE_UPDATE_PROXY=http://corporate-proxy:8080`

#### DOLLHOUSE_SKIP_SSL_VERIFY
Skip SSL certificate verification (not recommended).

- **Type:** Boolean
- **Default:** `false`
- **Example:** `DOLLHOUSE_SKIP_SSL_VERIFY=true`

### Update Behavior

#### DOLLHOUSE_UPDATE_CHECK_INTERVAL
Hours between automatic update checks.

- **Type:** Number
- **Default:** `24`
- **Range:** 1-168 (1 week)
- **Example:** `DOLLHOUSE_UPDATE_CHECK_INTERVAL=12`

#### DOLLHOUSE_UPDATE_NOTIFICATION
How to notify about available updates.

- **Type:** String
- **Default:** `console`
- **Options:** `console`, `none`, `desktop`
- **Example:** `DOLLHOUSE_UPDATE_NOTIFICATION=desktop`

#### DOLLHOUSE_PRE_UPDATE_HOOK
Script to run before updates.

- **Type:** String
- **Example:** `DOLLHOUSE_PRE_UPDATE_HOOK=/path/to/pre-update.sh`

#### DOLLHOUSE_POST_UPDATE_HOOK
Script to run after updates.

- **Type:** String
- **Example:** `DOLLHOUSE_POST_UPDATE_HOOK=/path/to/post-update.sh`

## Configuration Files

### .dollhouserc.json
Project-level configuration file (in project root).

```json
{
  "update": {
    "channel": "stable",
    "autoCheck": true,
    "checkInterval": 24,
    "backup": {
      "enabled": true,
      "count": 5,
      "directory": ".backup"
    },
    "security": {
      "verifySignatures": true,
      "trustedSigners": ["ABC123"]
    },
    "hooks": {
      "preUpdate": "./scripts/pre-update.js",
      "postUpdate": "./scripts/post-update.js"
    }
  }
}
```

### ~/.dollhouse/config.json
User-level configuration file.

```json
{
  "update": {
    "channel": "beta",
    "notifications": "desktop",
    "proxy": "http://proxy:8080"
  }
}
```

## Configuration Priority

Configuration is loaded in the following order (later overrides earlier):

1. Default values
2. System-wide config (`/etc/dollhouse/config.json`)
3. User config (`~/.dollhouse/config.json`)
4. Project config (`.dollhouserc.json`)
5. Environment variables
6. Command-line arguments

## Profile Examples

### Development Profile
```bash
export DOLLHOUSE_UPDATE_CHANNEL=beta
export DOLLHOUSE_BACKUP_COUNT=10
export DOLLHOUSE_SKIP_SIGNATURE=true
export DOLLHOUSE_UPDATE_NOTIFICATION=desktop
```

### Production Profile
```bash
export DOLLHOUSE_DISABLE_UPDATES=true
export DOLLHOUSE_BACKUP_COUNT=20
export DOLLHOUSE_BACKUP_DIR=/var/backups/dollhousemcp
export DOLLHOUSE_PRE_UPDATE_HOOK=/opt/scripts/maintenance-mode.sh
export DOLLHOUSE_POST_UPDATE_HOOK=/opt/scripts/health-check.sh
```

### CI/CD Profile
```bash
export DOLLHOUSE_DISABLE_UPDATES=true
export DOLLHOUSE_SKIP_BACKUP=true
export DOLLHOUSE_API_TIMEOUT=60000
```

### Corporate Environment
```bash
export DOLLHOUSE_UPDATE_PROXY=http://corporate-proxy:8080
export DOLLHOUSE_GPG_KEYSERVER=internal-keyserver.corp.com
export DOLLHOUSE_TRUSTED_SIGNERS=CORP123,CORP456
export DOLLHOUSE_UPDATE_CHECK_INTERVAL=168  # Weekly
```

## Advanced Configuration

### Custom Update Sources

Configure alternative update sources:

```json
{
  "update": {
    "sources": [
      {
        "name": "github",
        "url": "https://api.github.com/repos/mickdarling/DollhouseMCP",
        "priority": 1
      },
      {
        "name": "mirror",
        "url": "https://updates.internal.com/dollhousemcp",
        "priority": 2
      }
    ]
  }
}
```

### Dependency Overrides

Override dependency version requirements:

```json
{
  "update": {
    "dependencies": {
      "git": {
        "min": "2.20.0",
        "max": "3.0.0"
      },
      "npm": {
        "min": "8.0.0",
        "max": "10.0.0"
      }
    }
  }
}
```

### Update Policies

Define update policies:

```json
{
  "update": {
    "policies": {
      "allowMajor": false,
      "allowMinor": true,
      "allowPatch": true,
      "allowPrerelease": false,
      "requireSignature": true,
      "requireTests": true
    }
  }
}
```

## Troubleshooting Configuration

### View Current Configuration
```javascript
// In MCP interface
get_server_status

// Will show active configuration
```

### Test Configuration
```bash
# Test with dry run
DOLLHOUSE_DRY_RUN=true dollhousemcp update_server

# Verbose logging
DOLLHOUSE_LOG_LEVEL=debug dollhousemcp check_for_updates
```

### Reset Configuration
```bash
# Remove user config
rm ~/.dollhouse/config.json

# Remove project config
rm .dollhouserc.json

# Clear environment
unset $(env | grep ^DOLLHOUSE_ | cut -d= -f1)
```

## Best Practices

1. **Use configuration files** for permanent settings
2. **Use environment variables** for deployment-specific settings
3. **Document your configuration** in your deployment guides
4. **Test configuration changes** in development first
5. **Keep backups enabled** in production
6. **Use signature verification** for security
7. **Set appropriate rate limits** for your usage
8. **Configure hooks** for integration with your systems
# DollhouseMCP Auto-Update System

The DollhouseMCP auto-update system provides a secure, reliable way to update the server to the latest version directly from within the MCP interface. This documentation covers the architecture, configuration, usage, and security aspects of the system.

## Table of Contents

1. [Architecture Overview](./architecture.md)
2. [User Guide](./user-guide.md)
3. [API Reference](./api-reference.md)
4. [Configuration Guide](./configuration.md)
5. [Security Considerations](./security.md)
6. [Troubleshooting](./troubleshooting.md)

## Quick Start

The auto-update system provides four main MCP tools:

- **check_for_updates** - Check if a newer version is available
- **get_server_status** - View current version and system information
- **update_server** - Perform an automated update with backup
- **rollback_update** - Revert to a previous version if needed

### Example Usage

1. **Check for updates:**
   ```
   check_for_updates
   ```

2. **View current status:**
   ```
   get_server_status
   ```

3. **Perform update:**
   ```
   update_server true  # true = auto-confirm
   ```

4. **Rollback if needed:**
   ```
   rollback_update true  # true = auto-confirm
   ```

## Key Features

- **Automatic Backups** - Creates timestamped backups before updates
- **Signature Verification** - Validates GitHub release signatures
- **Rate Limiting** - Prevents API abuse (10 requests per minute)
- **Dependency Validation** - Ensures Git and npm meet version requirements
- **Rollback Support** - Easy recovery from failed updates
- **Security Hardened** - Protection against injection attacks

## Components

The auto-update system consists of several modules:

- **UpdateManager** - Orchestrates the update process
- **UpdateChecker** - Checks GitHub for new releases
- **BackupManager** - Handles backup creation and restoration
- **VersionManager** - Manages version comparisons and validation
- **RateLimiter** - Implements token bucket rate limiting
- **SignatureVerifier** - Validates GPG signatures on releases
- **DependencyChecker** - Validates system dependencies

## Requirements

- Node.js 18.0.0 or higher
- Git 2.20.0 - 2.50.0
- npm 8.0.0 - 12.0.0
- Network access to GitHub API
- Write permissions to project directory

## Security

The auto-update system includes multiple security layers:

- **Input Sanitization** - DOMPurify for XSS protection
- **Command Injection Prevention** - Uses spawn() instead of exec()
- **URL Validation** - Whitelist approach for GitHub URLs
- **Rate Limiting** - Prevents DoS attacks
- **Signature Verification** - Optional GPG signature validation

See the [Security Guide](./security.md) for detailed information.

## Monitoring

Updates are logged to the console with detailed progress information. The system maintains update history in the backup directory for audit purposes.

## Support

For issues or questions:
- Check the [Troubleshooting Guide](./troubleshooting.md)
- Review [GitHub Issues](https://github.com/mickdarling/DollhouseMCP/issues)
- Contact support at mick@mickdarling.com
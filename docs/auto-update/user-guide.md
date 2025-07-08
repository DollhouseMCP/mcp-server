# Auto-Update User Guide

This guide explains how to use the DollhouseMCP auto-update system to keep your server up to date.

## Available MCP Tools

### 1. check_for_updates

Checks if a newer version is available on GitHub.

**Usage:**
```
check_for_updates
```

**Example Response:**
```
🔍 Checking for updates...
✅ Update available!
Current version: 1.2.0
Latest version: 1.2.1
Release date: 2025-01-09T12:00:00Z

Release Notes:
- Fixed critical bug in persona loading
- Improved performance by 20%
- Added new security features

To update, use: update_server
```

### 2. get_server_status

Displays current server version and system information.

**Usage:**
```
get_server_status
```

**Example Response:**
```
📊 DollhouseMCP Server Status
Version: 1.2.0
Node.js: v20.11.0
Platform: darwin (macOS)
Architecture: arm64
Uptime: 2h 15m
Memory Usage: 45.2 MB / 512 MB
Last Check: 2025-01-08T15:30:00Z
Auto-Updates: Enabled
Rate Limit: 8/10 requests remaining
```

### 3. update_server

Performs an automated update with backup.

**Usage:**
```
update_server [autoConfirm]
```

**Parameters:**
- `autoConfirm` (optional): Set to `true` to skip confirmation prompts

**Interactive Example:**
```
User: update_server

🔄 Starting update process...
Current version: 1.2.0
Target version: 1.2.1

This will:
1. Create a backup of your current installation
2. Download and install version 1.2.1
3. Run npm install and rebuild the project
4. Restart the server

Do you want to proceed? (yes/no): yes

📦 Creating backup...
✅ Backup created: .backup-2025-01-08-1600

📥 Downloading update...
✅ Update downloaded successfully

🔧 Installing dependencies...
✅ Dependencies installed

🏗️ Building project...
✅ Build successful

✅ Update complete! Server is now running version 1.2.1
To rollback if needed, use: rollback_update
```

**Auto-confirm Example:**
```
User: update_server true

🔄 Auto-update initiated...
[Update proceeds automatically without prompts]
✅ Update complete! Server is now running version 1.2.1
```

### 4. rollback_update

Reverts to a previous version from backup.

**Usage:**
```
rollback_update [autoConfirm]
```

**Parameters:**
- `autoConfirm` (optional): Set to `true` to skip confirmation prompts

**Example:**
```
User: rollback_update

🔄 Available backups:
1. .backup-2025-01-08-1600 (30 minutes ago)
2. .backup-2025-01-07-1200 (1 day ago)
3. .backup-2025-01-06-0900 (2 days ago)

Select backup to restore (1-3): 1

This will restore your installation to the backup from 2025-01-08-1600.
Current data will be backed up first.

Do you want to proceed? (yes/no): yes

📦 Creating safety backup...
✅ Safety backup created

🔄 Restoring from backup...
✅ Files restored

🔧 Installing dependencies...
✅ Dependencies installed

🏗️ Building project...
✅ Build successful

✅ Rollback complete! Server restored to previous version.
```

## Best Practices

### 1. Regular Update Checks
- Check for updates weekly
- Enable notifications for critical updates
- Review release notes before updating

### 2. Backup Management
- The system automatically manages backups
- Keeps 5 most recent backups
- Manual backups: `npm run update:backup`

### 3. Testing Updates
- Test updates in development first
- Have a rollback plan ready
- Monitor logs after updates

### 4. Production Updates
- Schedule updates during low-traffic periods
- Notify users of planned maintenance
- Test rollback procedure periodically

## Update Scenarios

### Scenario 1: Simple Update
```
1. check_for_updates      # Check if update available
2. get_server_status      # Verify current state
3. update_server true     # Perform update
```

### Scenario 2: Cautious Update
```
1. check_for_updates      # Check and review notes
2. npm run update:backup  # Extra manual backup
3. update_server          # Interactive update
4. [Test application]
5. rollback_update        # If issues found
```

### Scenario 3: Scheduled Update
```
# In a cron job or scheduler
dollhousemcp << EOF
check_for_updates
update_server true
EOF
```

## Configuration

### Environment Variables

- `DOLLHOUSE_DISABLE_UPDATES=true` - Disable update system
- `DOLLHOUSE_UPDATE_CHANNEL=beta` - Use beta releases
- `DOLLHOUSE_BACKUP_COUNT=10` - Keep more backups
- `DOLLHOUSE_SKIP_SIGNATURE=true` - Skip GPG verification

### Rate Limits

Default: 10 requests per minute
- check_for_updates: 1 request
- update_server: 3-4 requests
- get_server_status: 0 requests (local only)

## Troubleshooting Quick Guide

### Update Fails
1. Check error message for details
2. Verify network connectivity
3. Check disk space
4. Try manual update: `npm run update:pull`

### Can't Find Updates
1. Check current version: `get_server_status`
2. Verify GitHub connectivity
3. Check rate limit status
4. Clear cache and retry

### Rollback Issues
1. List backups: `ls -la .backup-*`
2. Check backup integrity
3. Manual restore if needed
4. Contact support

## Security Notes

- Updates are downloaded over HTTPS
- Optional GPG signature verification
- Backups are local only (not uploaded)
- No telemetry or tracking
- All operations logged locally

## Getting Help

- Check [Troubleshooting Guide](./troubleshooting.md)
- Review [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- Community Discord: [Coming Soon]
- Email support: mick@mickdarling.com
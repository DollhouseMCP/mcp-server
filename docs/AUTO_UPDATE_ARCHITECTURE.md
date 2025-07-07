# Auto-Update System Architecture

## Overview

The DollhouseMCP auto-update system provides a secure, reliable mechanism for users to update their server installation directly through MCP tools. It includes safety features like automatic backups, rollback capabilities, and comprehensive dependency checking.

## Architecture Components

### 1. UpdateManager (Core Orchestrator)
**Location**: `src/update/UpdateManager.ts`

The UpdateManager serves as the central coordinator for all update operations. It:
- Accepts custom `rootDir` parameter for CI/testing safety
- Orchestrates the update workflow
- Manages progress reporting
- Handles error conditions gracefully

**Key Methods**:
- `checkForUpdates()`: Checks GitHub for new releases
- `updateServer()`: Performs the actual update with backup option
- `rollbackUpdate()`: Reverts to a previous backup
- `getServerStatus()`: Returns current version and system information

### 2. VersionManager (Version Control)
**Location**: `src/update/VersionManager.ts`

Handles version detection and comparison:
- Searches upward from `process.cwd()` to find package.json
- Supports semantic versioning including pre-release versions
- Compares versions to determine if updates are available

**Key Features**:
- Searches up to 5 directory levels for package.json
- Handles versions like `1.0.0`, `2.1.0-beta.1`, `3.0.0-rc.2`
- Normalizes version strings (removes 'v' prefix)

### 3. UpdateChecker (Release Detection)
**Location**: `src/update/UpdateChecker.ts`

Interfaces with GitHub API to check for new releases:
- Queries GitHub releases API with retry logic
- Implements comprehensive security measures
- Formats update information for user display

**Security Features**:
- XSS protection via DOMPurify
- Command injection prevention
- URL validation (http/https only)
- Content length limits
- Sanitized logging

### 4. BackupManager (Safety Net)
**Location**: `src/update/BackupManager.ts`

Creates and manages backups before updates:
- **Critical Fix**: Accepts `rootDir` parameter instead of using `process.cwd()`
- Validates paths to prevent traversal attacks
- Creates timestamped backups
- Manages backup retention (keeps 5 most recent)

**Safety Mechanisms**:
- Path traversal prevention
- Production directory detection
- Safe test directory recognition
- Docker environment support

### 5. DependencyChecker (Prerequisites)
**Location**: `src/update/DependencyChecker.ts`

Validates system dependencies before updates:
- Checks git version (2.20.0 - 2.50.0)
- Checks npm version (8.0.0 - 12.0.0)
- Reports detailed version information

## Update Workflow

### 1. Check for Updates
```
User: check_for_updates
  ↓
UpdateManager.checkForUpdates()
  ↓
UpdateChecker.checkForUpdates()
  ↓
GitHub API Request (with retry)
  ↓
Security sanitization
  ↓
Formatted response to user
```

### 2. Perform Update
```
User: update_server true
  ↓
UpdateManager.updateServer(createBackup: true)
  ↓
Step 1: DependencyChecker.checkDependencies()
  ↓
Step 2: BackupManager.createBackup()
  ↓
Step 3: Git fetch origin
  ↓
Step 4: Check for uncommitted changes
  ↓
Step 5: Git pull --ff-only
  ↓
Step 6: npm install
  ↓
Step 7: npm run build
  ↓
Step 8: Restart notification
```

### 3. Rollback Update
```
User: rollback_update true
  ↓
UpdateManager.rollbackUpdate(backupId, performRollback: true)
  ↓
BackupManager.listBackups()
  ↓
User selects backup or uses latest
  ↓
Restore files from backup
  ↓
npm install (restore dependencies)
  ↓
npm run build (rebuild)
  ↓
Restart notification
```

## Security Implementation

### UpdateChecker Security
The UpdateChecker implements multiple layers of security:

1. **XSS Protection**:
   - DOMPurify with JSDOM for server-side sanitization
   - Strict configuration: no HTML tags or attributes allowed
   - All user-facing content is sanitized

2. **Command Injection Prevention**:
   - Regex patterns remove dangerous sequences:
     - Backticks: `` `command` ``
     - Command substitution: `$(command)`
     - Variable expansion: `${var}`
     - Escape sequences: `\x3c`, `\u003c`, `\077`

3. **URL Security**:
   - Whitelist approach: only http:// and https://
   - Maximum URL length: 2048 characters
   - Invalid URLs return empty string

4. **DoS Prevention**:
   - Release notes limited to 5000 characters
   - Content truncated with "..." if exceeded
   - Security events logged for monitoring

### BackupManager Security
Critical security improvements implemented:

1. **Path Validation**:
   - Absolute paths required
   - Path traversal sequences blocked (`../`, `..\\`)
   - Production directory detection

2. **Safe Directory Detection**:
   - Recognizes test/temp directories
   - Docker environment support
   - Prevents operations on production code

3. **Custom Root Directory**:
   - Accepts `rootDir` parameter for testing
   - Prevents hardcoded `process.cwd()` issues
   - Enables safe CI/CD testing

## MCP Tool Integration

### Tool: check_for_updates
```typescript
async handleCheckForUpdates(): Promise<{ text: string }> {
  return await this.updateManager.checkForUpdates();
}
```

### Tool: update_server
```typescript
async handleUpdateServer(args: { create_backup?: boolean }): Promise<{ text: string }> {
  const createBackup = args.create_backup !== false;
  return await this.updateManager.updateServer(createBackup, this.personaIndicator);
}
```

### Tool: rollback_update
```typescript
async handleRollbackUpdate(args: { backup_id?: string, perform_rollback?: boolean }): Promise<{ text: string }> {
  const performRollback = args.perform_rollback !== false;
  return await this.updateManager.rollbackUpdate(args.backup_id, performRollback, this.personaIndicator);
}
```

### Tool: get_server_status
```typescript
async handleGetServerStatus(): Promise<{ text: string }> {
  return await this.updateManager.getServerStatus(this.personaIndicator);
}
```

## Error Handling

The system implements comprehensive error handling:

1. **Network Errors**: Retry with exponential backoff (1s, 2s, 4s)
2. **Git Errors**: Clear user messages about uncommitted changes
3. **Permission Errors**: Guidance on fixing permissions
4. **Missing Dependencies**: Specific installation instructions
5. **Build Failures**: Detailed error logs and recovery steps

## Testing Strategy

### Unit Tests
- `UpdateChecker.test.ts`: Core functionality
- `UpdateChecker.security.test.ts`: Security measures
- `UpdateChecker.performance.test.ts`: Performance limits
- `BackupManager.simple.test.ts`: Basic operations
- `BackupManager.safety.test.ts`: Security validations

### CI Verification Tests
- `ci-environment.test.ts`: Environment validation
- `workflow-validation.test.ts`: GitHub Actions verification
- `ci-safety-verification.test.ts`: Path safety and regression prevention

## Future Enhancements

### High Priority
1. **Rate Limiting** (#72): Prevent API abuse
2. **Signature Verification** (#73): Verify release authenticity
3. **Enhanced Audit Logging** (#74): Detailed security events

### Medium Priority
1. **Incremental Updates**: Only download changed files
2. **Parallel Downloads**: Speed up large updates
3. **Update Scheduling**: Allow scheduled updates

### Low Priority
1. **Update Channels**: Stable/Beta/Nightly
2. **Custom Update Sources**: Enterprise mirrors
3. **Update Policies**: Admin-controlled update rules

## Configuration

### Environment Variables
- `DOLLHOUSE_DISABLE_UPDATES`: Set to 'true' to disable updates (Docker)
- `GITHUB_TOKEN`: Optional, for higher API rate limits

### Security Configuration
```typescript
new UpdateChecker(versionManager, {
  releaseNotesMaxLength: 10000,  // Custom limit
  urlMaxLength: 4096,             // Custom limit
  securityLogger: customLogger    // Custom security logging
});
```

## Best Practices

1. **Always Create Backups**: Default behavior, but can be disabled
2. **Commit Changes First**: Updates fail with uncommitted changes
3. **Test Updates**: Use staging environment first
4. **Monitor Logs**: Check security events regularly
5. **Keep Dependencies Updated**: git and npm versions

## Troubleshooting

### Common Issues

1. **"Git is not installed"**
   - Install git 2.20.0 or higher
   - Ensure git is in PATH

2. **"Uncommitted changes detected"**
   - Run `git status` to see changes
   - Commit or stash changes before updating

3. **"npm install failed"**
   - Check npm version (8.0.0+)
   - Clear npm cache: `npm cache clean --force`
   - Delete node_modules and try again

4. **"Build failed"**
   - Check TypeScript errors
   - Ensure all dependencies installed
   - Run `npm run build` manually for details

### Recovery Procedures

1. **Failed Update Recovery**:
   ```bash
   # List available backups
   claude "Please list available backups"
   
   # Rollback to specific backup
   claude "Rollback to backup from [timestamp]"
   ```

2. **Manual Recovery**:
   ```bash
   # Navigate to backup directory
   cd ../dollhousemcp-backups/backup-[timestamp]
   
   # Copy files back
   cp -r * ../../DollhouseMCP/
   
   # Reinstall and build
   cd ../../DollhouseMCP
   npm install
   npm run build
   ```

## Security Considerations

1. **Never Run as Root**: Use proper user permissions
2. **Verify HTTPS**: Ensure GitHub API uses HTTPS
3. **Check Logs**: Monitor for security events
4. **Update Regularly**: Security fixes in new versions
5. **Backup Retention**: Clean old backups periodically

---

This architecture provides a secure, reliable auto-update system with comprehensive safety features and clear recovery paths.
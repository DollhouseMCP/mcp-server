# Fix Docker testing failures caused by BackupManager production directory check

## Summary
All Docker tests are failing because BackupManager throws an error when detecting production files in the container's `/app/` directory. This was introduced in PR #86 to prevent tests from deleting production files, but it now blocks Docker containers from starting.

## Problem Details

### Error Message
```
Error: BackupManager cannot operate on production directory. Pass a safe test directory to the constructor.
```

### Root Cause
1. Docker container runs the MCP server from `/app/` directory
2. `/app/` contains production files (dist/, package.json, etc.)
3. `DollhouseMCPServer` creates `UpdateManager` without parameters
4. `UpdateManager` creates `BackupManager(this.rootDir)` where rootDir = `/app/`
5. `BackupManager` detects production files and throws error

### Impact
- ❌ All Docker tests failing (linux/amd64, linux/arm64, compose)
- ❌ Cannot achieve 100% CI reliability
- ❌ Docker badge shows failing status on homepage

## Historical Context
- **July 3**: Docker tests were fully working after comprehensive fixes
- **PR #80**: Changed from `__dirname` to `process.cwd()` causing file deletion issues
- **PR #86**: Added safety checks that fixed deletion but broke Docker

## Proposed Solutions

### Solution 1: Environment Variable for Update Directory (Recommended)
```typescript
// In UpdateManager constructor
constructor(rootDir?: string) {
  // Use environment variable for Docker/production environments
  this.rootDir = rootDir || process.env.DOLLHOUSE_UPDATE_DIR || process.cwd();
  
  // Only initialize BackupManager if updates are enabled
  if (process.env.DOLLHOUSE_DISABLE_UPDATES !== 'true') {
    this.backupManager = new BackupManager(
      process.env.DOLLHOUSE_BACKUP_DIR || path.join(this.rootDir, '.backups')
    );
  }
}
```

Then in Dockerfile:
```dockerfile
ENV DOLLHOUSE_DISABLE_UPDATES=true
# OR
ENV DOLLHOUSE_UPDATE_DIR=/tmp/dollhouse-updates
ENV DOLLHOUSE_BACKUP_DIR=/tmp/dollhouse-backups
```

### Solution 2: Detect Docker Environment
```typescript
// In UpdateManager or BackupManager
private isDockerEnvironment(): boolean {
  return fs.existsSync('/.dockerenv') || 
         process.env.RUNNING_IN_DOCKER === 'true' ||
         this.rootDir === '/app';
}

constructor(rootDir?: string) {
  this.rootDir = rootDir || process.cwd();
  
  if (this.isDockerEnvironment()) {
    // Use safe temporary directory in Docker
    this.backupDir = '/tmp/dollhouse-backups';
  } else {
    this.backupDir = path.join(this.rootDir, '.backups');
  }
}
```

### Solution 3: Skip Update Features in Production
```typescript
// In DollhouseMCPServer constructor
constructor() {
  // ... other initialization ...
  
  // Only initialize update features in development
  if (process.env.NODE_ENV !== 'production') {
    this.updateManager = new UpdateManager();
  }
}
```

## Recommended Approach
Use **Solution 1** with environment variables because:
- Most flexible and explicit
- Allows different configurations for different environments
- Doesn't rely on Docker detection heuristics
- Can be documented clearly

## Implementation Steps
1. Modify UpdateManager to respect environment variables
2. Update BackupManager to accept custom directories
3. Add environment variables to Dockerfile
4. Update Docker documentation
5. Test all Docker configurations

## Testing Requirements
- [ ] Docker build succeeds for linux/amd64
- [ ] Docker build succeeds for linux/arm64
- [ ] Docker compose tests pass
- [ ] MCP server initializes without errors
- [ ] No production files are at risk

## Priority
**HIGH** - This is blocking 100% CI reliability and affects the project's perceived stability

## Related Issues
- Caused by PR #86 (safety checks)
- Blocks CI reliability milestone
- Related to Issue #102 (Docker dependencies)

## Acceptance Criteria
- [ ] All Docker tests pass in CI
- [ ] No BackupManager errors in container logs
- [ ] Solution is documented in Docker setup guide
- [ ] Environment variables are clearly explained
- [ ] No regression in file safety protections
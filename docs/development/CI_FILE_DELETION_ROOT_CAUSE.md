# CI File Deletion Root Cause Analysis

## Discovery Process

1. **Initial Symptom**: tsconfig.test.json not found in CI after npm test runs
2. **Git Status Revealed**: Many files deleted including .dockerignore, jest.integration.config.cjs
3. **Investigation Found**: Integration test cleanup code using `process.cwd()`
4. **Root Cause**: BackupManager and UpdateManager using `process.cwd()` without safeguards

## The Problem

When PR #80 changed from `__dirname` to `process.cwd()`:
- BackupManager constructor set `this.rootDir = process.cwd()`
- Tests instantiating BackupManager got the actual project directory
- Any file operations would affect real project files
- The `restoreBackup` method moves files from rootDir to temp

## The Fix (PR #86)

1. Made constructors accept optional `rootDir` parameter
2. Added safety warnings for production directory usage
3. Tests can now pass test-specific directories

## Key Learning

When changing path resolution in production code, always consider:
- How tests instantiate the classes
- Whether file operations need safeguards
- The difference between test and production environments

## Next Steps

1. Update tests to pass appropriate test directories
2. Add integration tests that verify safe operation
3. Consider adding more safety checks to prevent accidental file operations
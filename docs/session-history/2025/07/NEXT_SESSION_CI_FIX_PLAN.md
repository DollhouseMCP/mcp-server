# Next Session CI Fix Plan

## Priority 1: Fix PR #86
1. Change BackupManager safety check from warning to error
2. Add path validation to prevent path traversal
3. Update tests to use safe directories:
   ```typescript
   backupManager = new BackupManager(path.join(os.tmpdir(), 'test-backup'));
   updateManager = new UpdateManager(path.join(os.tmpdir(), 'test-update'));
   ```

## Priority 2: Verify Fix
1. Push updates to PR #86
2. Confirm no files deleted after tests
3. Ensure all tests pass with safe directories

## Priority 3: Clean Up
1. Merge PR #86 once tests pass
2. Close related issues (#83, #79, #81)
3. Re-enable TypeScript cache in CI
4. Remove diagnostic code from workflows

## Key Code Locations
- `src/update/BackupManager.ts:25-27` - Change to throw error
- `src/update/UpdateManager.ts:25` - Ensure passes rootDir to BackupManager
- `__tests__/unit/auto-update/*.test.ts` - Update all test constructors

## Expected Outcome
- No more file deletion in CI
- All tests pass
- tsconfig.test.json remains after tests
- CI fully functional
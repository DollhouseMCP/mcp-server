# DollhouseMCP Development Context - July 7, 2025

This document provides context for the next Claude instance to continue development work on DollhouseMCP.

## Current Status Summary

### CI/CD Status
- ✅ **Core Build & Test**: PASSING (Fixed PowerShell syntax issues)
- ✅ **Build Artifacts**: PASSING 
- ✅ **Extended Node Compatibility**: PASSING
- ✅ **Cross-Platform Simple**: PASSING
- ✅ **Performance Testing**: PASSING
- ❌ **Docker Testing**: FAILING (Issue #115 - BackupManager production check)

### Recent Achievements (This Session)
1. **PR #106**: Fixed PowerShell syntax errors in core workflows
2. **PR #108**: Fixed additional shell compatibility issues (7 fixes in docker-testing.yml, 3 in verify-badges.yml)
3. **PR #110**: Added environment validation and fixed cross-platform path handling
4. **Created Issues #107-115**: Systematic tracking of all review suggestions and CI problems

### Key Problems Blocking 100% CI

#### 1. Docker Testing Failures (Issue #115) - HIGHEST PRIORITY
- **Problem**: BackupManager throws error when detecting production files in Docker's `/app/` directory
- **Error**: `BackupManager cannot operate on production directory`
- **Solution**: Add environment variables to disable updates in Docker or use safe directories
- **File**: `src/update/UpdateManager.ts` and `src/update/BackupManager.ts`

#### 2. Jest ESM Module Resolution (Issue #101) - HIGH PRIORITY
- **Problem**: Jest cannot resolve TypeScript modules with `.js` extensions in CI
- **Error**: `Cannot find module '../../../src/update/BackupManager.js'`
- **Details**: Tests pass locally but fail in GitHub Actions
- **File**: `jest.config.cjs` - moduleNameMapper not working in CI

#### 3. Remaining Windows Issues - MEDIUM PRIORITY
- Some `2>/dev/null` usage may still exist
- Check all workflows for Unix-specific commands

#### 4. TEST_PERSONAS_DIR Setup - MEDIUM PRIORITY
- Environment validation is in place (PR #110)
- Just need to ensure variable is set in all workflows

## Code Patterns Established

### Shell Compatibility Pattern
```yaml
- name: Step name
  # Use bash for cross-platform compatibility (Windows/macOS/Linux)
  shell: bash
  run: |
    # Your commands here
```

### Environment Validation Pattern
```yaml
- name: Validate environment
  shell: bash
  run: |
    echo "🔍 Validating CI environment..."
    echo "TEST_PERSONAS_DIR: $TEST_PERSONAS_DIR"
    if [ -z "$TEST_PERSONAS_DIR" ]; then
      echo "❌ TEST_PERSONAS_DIR is not set!"
      exit 1
    fi
    echo "✅ Environment validation passed"
```

### Cross-Platform Path Handling
```bash
# Instead of: ls dir/ 2>/dev/null || echo "not found"
# Use: 
if [ -d "dir/" ]; then ls dir/; else echo "not found"; fi

# Instead of: rm -rf dir/ 2>/dev/null || true
# Use:
rm -rf dir/ || true
```

## Development Workflow

1. **Always create feature branches**: `git checkout -b fix-<description>`
2. **Use comprehensive commits**: Include problem, solution, testing, and related issues
3. **Create detailed PRs**: Follow format in `docs/development/PR_BEST_PRACTICES.md`
4. **Monitor reviews**: `gh pr view <number> --comments`
5. **Create issues for suggestions**: Document all review feedback as actionable issues

## Next Steps Priority Order

1. **Fix Docker Testing (Issue #115)**
   - Modify UpdateManager to handle Docker environment
   - Add DOLLHOUSE_DISABLE_UPDATES or DOLLHOUSE_UPDATE_DIR environment variable
   - Update Dockerfile with appropriate settings

2. **Fix Jest ESM Resolution (Issue #101)**
   - Research Jest + TypeScript + ESM in CI environments
   - Consider alternative module resolution strategies
   - May need to update to newer Jest or try different configuration

3. **Complete CI Reliability**
   - Fix any remaining shell syntax issues
   - Ensure all environment variables are set
   - Achieve 100% pass rate on all workflows

4. **Implement Review Suggestions**
   - Issue #111: Secure environment variable logging
   - Issue #112: Improve error messages
   - Issue #113: Workflow testing framework
   - Issue #114: Silent failure monitoring

## Important Files and Locations

### CI Workflows
- `.github/workflows/core-build-test.yml` - Main test workflow
- `.github/workflows/docker-testing.yml` - Docker multi-platform tests
- `.github/workflows/extended-node-compatibility.yml` - Node version matrix
- `.github/workflows/performance-testing.yml` - Performance benchmarks

### Key Source Files
- `src/update/UpdateManager.ts` - Needs Docker environment handling
- `src/update/BackupManager.ts` - Has production directory safety check
- `jest.config.cjs` - ESM module resolution configuration

### Documentation
- `docs/development/PR_BEST_PRACTICES.md` - PR creation guide
- `docs/session-history/2025/07/REMAINING_CI_ISSUES.md` - Historical CI problems
- `docs/session-history/2025/07/CI_FIX_PR86_SUMMARY.md` - File deletion fix context

## Testing Commands

```bash
# Run tests locally
npm test

# Test specific file
npm test -- --testPathPatterns=BackupManager.simple.test.ts

# Run Docker build locally
docker build -t test-build .

# Check PR status
gh pr list
gh pr view <number> --comments

# Create new issue
gh issue create --title "Title" --body "Body" --label "bug"
```

## Context for Success

The project has made significant progress on CI reliability. The main blocking issue is the Docker testing failure caused by BackupManager's safety check. Once this is fixed, and the Jest ESM issue is resolved, the project should achieve 100% CI reliability and can enable branch protection.

The PR process established in this session has resulted in high-quality, well-documented changes with excellent review feedback. Continue following these patterns for best results.
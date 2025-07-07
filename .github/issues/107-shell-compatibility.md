# Additional Shell Compatibility Issues in CI Workflows

## Summary
Following the successful fix in PR #106, the review bot identified additional workflow files with similar bash-specific syntax that need `shell: bash` declarations for Windows compatibility.

## Problem
Multiple workflow files contain bash-specific syntax without explicit shell declarations, causing potential failures on Windows runners where PowerShell is the default.

## Affected Files and Lines

### 1. `docker-testing.yml`
Multiple steps are missing `shell: bash` declaration:
- **Line 52**: "Set up Docker Buildx" step
- **Line 66**: "Build Docker image for x86_64" step  
- **Line 89**: "Run Docker smoke test for x86_64" step
- **Line 131**: "Build Docker image for ARM64" step
- **Line 202**: "Build and test multi-platform production image" step
- **Line 238**: "Run production Docker tests" step

These steps use:
- `$(command)` substitution syntax
- Bash conditional statements `[ -f "file" ]`
- Unix-specific commands

### 2. `verify-badges.yml.example`
Missing `shell: bash` declaration:
- **Line 27**: "Verify badge statuses" step
- **Line 55**: "Update README with badge status" step

These steps use:
- Bash arrays: `("item1" "item2")`
- Bash array expansion: `"${array[@]}"`

## Impact
- Potential CI failures on Windows runners
- Inconsistent behavior across platforms
- Reduced CI reliability

## Solution
Add `shell: bash` directive to all affected steps, similar to the approach in PR #106.

## Priority
**Medium** - These workflows may not run as frequently as core-build-test, but fixing them ensures complete cross-platform compatibility.

## Related Issues
- Follows up on PR #106
- Part of Issue #88: Windows shell syntax and integration test environment
- Contributes to v1.1.0 milestone for CI reliability

## Acceptance Criteria
- [ ] All identified steps have `shell: bash` added
- [ ] No bash-specific syntax remains without shell declaration
- [ ] All workflows pass on Windows runners
- [ ] Contribution guidelines updated to require shell specification
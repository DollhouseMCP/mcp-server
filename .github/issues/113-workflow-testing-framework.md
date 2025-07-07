# Create workflow testing framework for CI validation logic

## Summary
The review of PR #110 identified that we have no automated tests for our workflow validation logic. We need a testing framework to verify that our CI validation catches missing variables and handles errors correctly.

## Problem
- No way to verify validation logic works correctly
- Cannot test error conditions without breaking actual workflows
- Difficult to ensure cross-platform compatibility without manual testing

## Proposed Solution

### 1. Dedicated Test Workflow
Create `.github/workflows/test-ci-validation.yml`:
```yaml
name: Test CI Validation Logic

on:
  push:
    paths:
      - '.github/workflows/**'
  workflow_dispatch:

jobs:
  test-validation:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    
    steps:
      - name: Test missing environment variable
        shell: bash
        run: |
          # Unset required variable
          unset TEST_PERSONAS_DIR
          
          # Run validation (should fail)
          if bash -c 'source .github/scripts/validate-env.sh'; then
            echo "❌ Validation should have failed!"
            exit 1
          else
            echo "✅ Validation correctly detected missing variable"
          fi
      
      - name: Test valid environment
        shell: bash
        env:
          TEST_PERSONAS_DIR: /tmp/test
        run: |
          # Run validation (should pass)
          if bash -c 'source .github/scripts/validate-env.sh'; then
            echo "✅ Validation passed as expected"
          else
            echo "❌ Validation failed unexpectedly!"
            exit 1
          fi
```

### 2. Validation Script Library
Create `.github/scripts/validate-env.sh`:
```bash
#!/bin/bash
# Reusable validation functions for CI workflows

validate_required_env() {
  local var_name="$1"
  local var_description="$2"
  local example_value="$3"
  
  if [ -z "${!var_name}" ]; then
    echo "❌ Missing: $var_name"
    echo "   Description: $var_description"
    echo "   Example: $example_value"
    return 1
  fi
  
  return 0
}

validate_ci_environment() {
  local errors=0
  
  validate_required_env "TEST_PERSONAS_DIR" \
    "Directory for test personas" \
    "\${{ github.workspace }}/test-personas" || ((errors++))
  
  validate_required_env "NODE_OPTIONS" \
    "Node.js runtime options" \
    "--experimental-vm-modules" || ((errors++))
  
  if [ $errors -gt 0 ]; then
    return 1
  fi
  
  echo "✅ Environment validation passed"
  return 0
}
```

### 3. Path Handling Tests
```bash
test_cross_platform_paths() {
  echo "Testing cross-platform path handling..."
  
  # Test directory checks
  local test_dir="/tmp/test-$$"
  mkdir -p "$test_dir"
  
  if [ -d "$test_dir" ]; then
    echo "✅ Directory check works"
  else
    echo "❌ Directory check failed"
    return 1
  fi
  
  # Test error suppression
  if rm -rf "$test_dir" || true; then
    echo "✅ Error suppression works"
  else
    echo "❌ Error suppression failed"
    return 1
  fi
}
```

## Benefits
- Automated verification of validation logic
- Catches regressions in CI configuration
- Tests work across all platforms
- Documents expected behavior through tests

## Implementation Details
1. Create test workflow that deliberately triggers failures
2. Extract validation logic to reusable scripts
3. Test both success and failure paths
4. Include cross-platform compatibility tests

## Priority
**Low-Medium** - Important for long-term maintainability but not blocking current work

## Related Work
- Follows PR #110: Environment validation
- Supports Issue #93: Shared reusable GitHub Action
- Enables confident refactoring of CI logic

## Acceptance Criteria
- [ ] Test workflow runs on all platforms
- [ ] Validation failures are properly detected
- [ ] Success conditions pass as expected
- [ ] Cross-platform path handling is verified
- [ ] Tests are documented and maintainable
# Improve CI error messages with actionable guidance

## Summary
The review of PR #110 suggested enhancing our error messages to include expected values, formats, and links to documentation for fixing common configuration issues.

## Current State
Current error messages are basic:
```bash
if [ -z "$TEST_PERSONAS_DIR" ]; then
  echo "❌ TEST_PERSONAS_DIR is not set!"
  exit 1
fi
```

## Proposed Improvements

### 1. Enhanced Error Messages
```bash
if [ -z "$TEST_PERSONAS_DIR" ]; then
  echo "❌ ERROR: TEST_PERSONAS_DIR is not set!"
  echo ""
  echo "This environment variable is required for running tests."
  echo "Expected format: /path/to/test-personas"
  echo "Example: export TEST_PERSONAS_DIR=\${{ github.workspace }}/test-personas"
  echo ""
  echo "For more information, see:"
  echo "https://github.com/mickdarling/DollhouseMCP/blob/main/docs/ci-configuration.md"
  exit 1
fi
```

### 2. Directory Not Found Errors
```bash
if [ -d "dir/" ]; then 
  ls dir/ || echo "⚠️ Warning: Could not list directory contents (permissions issue?)"
else 
  echo "❌ Directory not found: dir/"
  echo "Expected location: $(pwd)/dir/"
  echo "Current directory contents:"
  ls -la | head -5
fi
```

### 3. Validation Function with Better Output
```bash
validate_environment() {
  local errors=0
  
  # Check each required variable with specific guidance
  if [ -z "$TEST_PERSONAS_DIR" ]; then
    echo "❌ Missing: TEST_PERSONAS_DIR"
    echo "   Set this to the test personas directory path"
    echo "   Example: /home/runner/work/DollhouseMCP/test-personas"
    ((errors++))
  fi
  
  if [ -z "$NODE_OPTIONS" ]; then
    echo "❌ Missing: NODE_OPTIONS"
    echo "   Set this to Node.js runtime options"
    echo "   Example: --max-old-space-size=4096 --experimental-vm-modules"
    ((errors++))
  fi
  
  if [ $errors -gt 0 ]; then
    echo ""
    echo "📚 Configuration Guide: https://github.com/mickdarling/DollhouseMCP/wiki/CI-Setup"
    return 1
  fi
  
  echo "✅ All required environment variables are set"
}
```

## Benefits
- Reduces debugging time by providing immediate solutions
- Helps new contributors understand CI requirements
- Provides context about why variables are needed
- Links to comprehensive documentation

## Implementation Plan
1. Create standardized error message templates
2. Update all validation steps in workflows
3. Create CI configuration documentation
4. Add examples for common scenarios

## Priority
**Medium** - Improves developer experience and reduces support burden

## Related Work
- Builds on PR #110: Environment validation
- Part of developer experience improvements
- Supports onboarding new contributors

## Acceptance Criteria
- [ ] All error messages include context and solutions
- [ ] Documentation links are provided for complex issues
- [ ] Examples show correct format/values
- [ ] Error messages are consistent across workflows
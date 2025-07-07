# Monitor and improve error handling for silent failures

## Summary
The review of PR #110 identified that the `|| true` pattern might hide legitimate errors that should be caught. We need to improve error handling to distinguish between expected and unexpected failures.

## Problem
Current pattern masks all errors:
```bash
rm -rf dist/ || true
kill $PID || true
```

This could hide:
- Permission errors
- File system issues
- Process management failures
- Unexpected error conditions

## Proposed Solution

### 1. Capture and Log Error Codes
```bash
# Instead of silently ignoring errors
rm -rf dist/ || true

# Capture and evaluate errors
if ! rm -rf dist/ 2>&1; then
  exit_code=$?
  case $exit_code in
    1) echo "⚠️ Directory not found (expected)" ;;
    *) echo "❌ Unexpected error (code: $exit_code)" 
       echo "This might indicate permission issues or file system problems"
       # Optionally fail for unexpected errors
       # exit 1
       ;;
  esac
fi
```

### 2. Enhanced Process Management
```bash
# Current approach
kill $SERVER_PID || true

# Better approach
if [ -n "$SERVER_PID" ]; then
  if kill -0 $SERVER_PID 2>/dev/null; then
    echo "Stopping process $SERVER_PID..."
    kill $SERVER_PID || {
      echo "⚠️ Failed to stop process gracefully, trying SIGKILL..."
      kill -9 $SERVER_PID || echo "❌ Could not stop process $SERVER_PID"
    }
  else
    echo "Process $SERVER_PID already stopped"
  fi
fi
```

### 3. Directory Operations with Context
```bash
# Function to safely remove directory with logging
safe_remove_dir() {
  local dir="$1"
  local purpose="$2"
  
  if [ -d "$dir" ]; then
    if rm -rf "$dir" 2>&1; then
      echo "✅ Cleaned up $purpose: $dir"
    else
      echo "⚠️ Could not remove $purpose: $dir (may need manual cleanup)"
      # Log but don't fail
    fi
  else
    echo "ℹ️ $purpose not found (already clean): $dir"
  fi
}

# Usage
safe_remove_dir "dist/" "build directory"
safe_remove_dir "node_modules/.cache" "cache directory"
```

### 4. Command Execution with Fallbacks
```bash
# Execute with fallback behavior
execute_with_fallback() {
  local primary_cmd="$1"
  local fallback_cmd="$2"
  local description="$3"
  
  echo "Executing: $description"
  if eval "$primary_cmd" 2>&1; then
    echo "✅ Success: $description"
  else
    echo "⚠️ Primary command failed, trying fallback..."
    if eval "$fallback_cmd" 2>&1; then
      echo "✅ Fallback succeeded"
    else
      echo "❌ Both primary and fallback failed for: $description"
      return 1
    fi
  fi
}
```

## Benefits
- Distinguishes between expected and unexpected failures
- Provides visibility into error conditions
- Maintains workflow stability while improving debugging
- Helps identify systemic issues in CI

## Implementation Plan
1. Audit all uses of `|| true` pattern
2. Categorize operations by criticality
3. Implement appropriate error handling for each category
4. Add logging for error conditions
5. Consider metrics/monitoring for repeated failures

## Priority
**Medium** - Improves CI reliability and debugging capabilities

## Related Work
- Follows PR #110: Cross-platform path fixes
- Related to Issue #112: Improve error messages
- Supports long-term CI stability

## Acceptance Criteria
- [ ] All `|| true` patterns are evaluated for appropriateness
- [ ] Critical errors are distinguished from expected failures
- [ ] Error conditions are logged with context
- [ ] Unexpected errors can trigger workflow failures when appropriate
- [ ] Documentation explains error handling strategy
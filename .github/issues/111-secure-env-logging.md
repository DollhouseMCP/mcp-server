# Implement secure environment variable logging in CI workflows

## Summary
The review of PR #110 identified that our environment validation logs all environment variables in plain text, which could expose sensitive information. We need to implement secure logging that redacts sensitive values.

## Problem
Current implementation logs environment variables directly:
```bash
echo "TEST_PERSONAS_DIR: $TEST_PERSONAS_DIR"
echo "NODE_OPTIONS: $NODE_OPTIONS"
```

This could expose sensitive values if we add environment variables like API keys or tokens in the future.

## Proposed Solution
Implement a secure logging function that:
1. Detects sensitive variable names (containing TOKEN, SECRET, KEY, PASSWORD, etc.)
2. Shows redacted values for sensitive variables
3. Shows full values only for non-sensitive variables

### Example Implementation
```bash
# Safe environment variable logging
log_env_var() {
  local var_name="$1"
  local var_value="${!var_name}"
  if [[ "$var_name" =~ (TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH) ]]; then
    echo "$var_name: [REDACTED]"
  else
    echo "$var_name: $var_value"
  fi
}

# Alternative approach for simple presence check
echo "API_TOKEN: ${API_TOKEN:+[SET]}"  # Shows [SET] if variable exists
```

## Benefits
- Prevents accidental exposure of sensitive information in CI logs
- Maintains debugging capabilities for non-sensitive variables
- Follows security best practices for CI/CD

## Implementation Details
1. Create a reusable bash function in workflows
2. Update all environment validation steps to use secure logging
3. Add patterns for common sensitive variable names
4. Consider making this part of a shared workflow action

## Priority
**Medium** - While we don't currently use sensitive environment variables in these workflows, this is important for future-proofing.

## Related Work
- Follows PR #110: Environment validation
- Part of security best practices
- Could be included in Issue #93: Shared reusable GitHub Action

## Acceptance Criteria
- [ ] Sensitive variable patterns are comprehensive
- [ ] All environment logging uses the secure function
- [ ] Non-sensitive variables still show full values
- [ ] Documentation updated with variable naming conventions
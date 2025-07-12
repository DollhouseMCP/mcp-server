# Security Testing Infrastructure

## Overview

DollhouseMCP implements a comprehensive security testing infrastructure that provides rapid validation of security patches and prevents shipping vulnerabilities to production. This system tests for OWASP Top 10 vulnerabilities relevant to the project.

## Architecture

```
__tests__/security/
├── framework/
│   ├── SecurityTestFramework.ts    # Core testing utilities
│   └── RapidSecurityTesting.ts     # Fast CI/CD tests
├── tests/
│   ├── command-injection.test.ts   # Command injection tests
│   ├── path-traversal.test.ts      # Path traversal tests
│   ├── yaml-deserialization.test.ts # YAML safety tests
│   └── mcp-tools-security.test.ts  # Comprehensive MCP tool tests
├── regression/                      # Regression test suite
└── index.ts                        # Main export file
```

## Test Categories

### CRITICAL (Must pass - <30s)
- **Command Injection**: Tests all MCP tools for shell command injection
- **Path Traversal**: Validates file system access controls
- **YAML Deserialization**: Prevents code execution via YAML
- **Authentication Bypass**: Ensures proper access controls

### HIGH (Should pass - <60s)
- **Input Validation**: Size limits, special characters, encoding
- **Token Security**: Prevents token exposure in logs/errors
- **Rate Limiting**: API abuse prevention
- **SSRF Protection**: Blocks internal network access

### MEDIUM (Good to have - <120s)
- **Error Handling**: No sensitive data in error messages
- **Logging Security**: Sanitized log outputs
- **Session Management**: Proper session handling

## Usage

### Running Security Tests

```bash
# Run critical tests only (for pre-commit hooks)
npm run security:critical

# Run rapid security check (<30s)
npm run security:rapid

# Run all security tests with coverage
npm run security:all

# Generate security report
npm run security:report

# Run regression tests
npm run security:regression
```

### Pre-commit Hook

The security tests are automatically run before commits:

```bash
# .git/hooks/pre-commit
npm run pre-commit
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Security Tests
  run: |
    npm run security:rapid
    npm run security:report
  timeout-minutes: 5
```

## Writing Security Tests

### Using the Framework

```typescript
import { SecurityTestFramework } from '../framework/SecurityTestFramework.js';

// Test for injection vulnerabilities
await SecurityTestFramework.testPayloadRejection(
  myFunction,
  'commandInjection',
  0 // argument position
);

// Test file sandboxing
await SecurityTestFramework.testFileSandbox(
  fileOperation,
  ['/allowed/path']
);

// Test rate limiting
await SecurityTestFramework.testRateLimit(
  apiOperation,
  10, // limit
  60000 // window (1 minute)
);
```

### Generating Tests for New Tools

```bash
# Generate security test template
npm run security:generate -- new-tool-name

# This creates: __tests__/security/tests/new-tool-name-security.test.ts
```

## Test Payloads

The framework includes comprehensive payload sets:

### Command Injection
- Shell metacharacters: `; | & $ \` ( )`
- Command substitution: `` `cmd` ``, `$(cmd)`
- Newline injection: `\n`, `\r\n`
- Unicode bypasses: Various encodings

### Path Traversal
- Directory traversal: `../../../etc/passwd`
- Windows paths: `..\\..\\windows\\system32`
- URL encoding: `%2e%2e%2f`
- Double encoding: `....//`

### YAML Injection
- Code execution: `!!js/function`, `!!python/object`
- YAML bombs: Exponential expansion attacks
- Prototype pollution: `__proto__` manipulation

## Performance Requirements

- **Critical tests**: Must complete in <30 seconds
- **All tests**: Must complete in <2 minutes
- **Memory usage**: <500MB during testing
- **Parallel execution**: 4 workers maximum

## Security Metrics

The framework tracks:
- Test execution time
- Vulnerability detection rate
- False positive rate
- Coverage of OWASP Top 10

## Best Practices

1. **Test Early**: Run `security:rapid` during development
2. **Test Comprehensively**: Use `security:all` before releases
3. **Fix Immediately**: Security tests block deployment
4. **Document Fixes**: Link fixes to test cases
5. **No Skipping**: Never skip security tests

## Troubleshooting

### Test Timeout
- Increase timeout: `--testTimeout=60000`
- Check for infinite loops in test payloads

### False Positives
- Review sanitization logic
- Ensure proper error handling
- Check regex patterns

### Performance Issues
- Run with `--maxWorkers=2` for less parallelism
- Profile with `--detectOpenHandles`

## Future Enhancements

- [ ] Fuzzing integration
- [ ] Mutation testing
- [ ] Security benchmarking
- [ ] Automated penetration testing
- [ ] Compliance reporting (SOC2, ISO27001)
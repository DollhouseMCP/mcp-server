# Security Code Reference - July 11, 2025

## Key Security Components

### 1. CommandValidator (`src/security/commandValidator.ts`)
```typescript
const ALLOWED_COMMANDS: Record<string, string[]> = {
  git: ['pull', 'status', 'log', 'rev-parse', 'branch', 'checkout', 'fetch', '--abbrev-ref', 'HEAD', '--porcelain'],
  npm: ['install', 'run', 'audit', 'ci', '--version', 'build'],
  node: ['--version'],
  npx: ['--version']
};

// Safe argument pattern
/^[a-zA-Z0-9\-_.\/]+$/

// Usage
const result = await CommandValidator.secureExec(command, args, {
  cwd: options.cwd,
  timeout: options.timeout || 30000
});
```

### 2. PathValidator (`src/security/pathValidator.ts`)
```typescript
// Initialize with allowed extensions
PathValidator.initialize(personasDir, ['.md', '.markdown', '.txt', '.yml', '.yaml']);

// Validate and read safely
const content = await PathValidator.safeReadFile(filePath);

// Validate and write safely
await PathValidator.safeWriteFile(filePath, content);

// Key features:
// - 500KB size limit
// - Path traversal protection
// - Configurable extensions
// - Atomic writes
```

### 3. YamlValidator (`src/security/yamlValidator.ts`)
```typescript
// Parse safely with all protections
const metadata = YamlValidator.parsePersonaMetadataSafely(yamlContent);

// Features:
// - 50KB size limit
// - YAML bomb protection (max 10 anchors, 20 aliases)
// - Dangerous tag blocking (!!js/*, !!python/*)
// - XSS sanitization with bounded patterns
// - Zod schema validation
```

### 4. Integration in git.ts
```typescript
import { CommandValidator } from '../security/commandValidator.js';

export async function safeExec(
  command: string, 
  args: string[], 
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await CommandValidator.secureExec(command, args, {
      cwd: options.cwd,
      timeout: options.timeout || 30000
    });
    return { stdout: result, stderr: '' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage);
  }
}
```

### 5. Integration in index.ts
```typescript
// Initialize PathValidator
PathValidator.initialize(this.personasDir);

// Use for all file operations
const content = await PathValidator.safeReadFile(personaPath);
await PathValidator.safeWriteFile(personaPath, updatedContent);
```

## Security Patterns

### ReDoS Prevention
```typescript
// Before (vulnerable)
.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')

// After (safe with bounds)
.replace(/<script[^>]{0,100}>[\s\S]{0,1000}?<\/script>/gi, '')
```

### Promise Safety
```typescript
let isCompleted = false;
const complete = (fn: () => void) => {
  if (!isCompleted) {
    isCompleted = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    fn();
  }
};
```

### XSS Protection
```typescript
// Comprehensive sanitization
input
  .replace(/<script[^>]{0,100}>[\s\S]{0,1000}?<\/script>/gi, '')
  .replace(/<iframe[^>]{0,100}>[\s\S]{0,1000}?<\/iframe>/gi, '')
  .replace(/<[^>]{0,100}>/g, '') // All HTML tags
  .replace(/\bon\w{1,20}\s*=\s*["'][^"']{0,100}["']/gi, '') // Event handlers
  .replace(/javascript\s*:/gi, '')
  .replace(/vbscript\s*:/gi, '');
```

## Testing Commands
```bash
# Run security tests
npm run security:rapid

# Run specific security test
npm test __tests__/security/tests/command-injection.test.ts

# Check for vulnerabilities
npm audit

# Run all tests with coverage
npm run security:all
```

## Security Checklist
- ✅ Command whitelisting
- ✅ Argument validation  
- ✅ Path traversal protection
- ✅ YAML bomb protection
- ✅ XSS sanitization
- ✅ SSRF protection
- ✅ Size limits
- ✅ Timeout handling
- ✅ Atomic file operations
- ✅ Error sanitization

## Common Security Functions
```typescript
// Validate URL
InputValidator.validateUrl(url); // Throws on invalid/private URLs

// Validate persona name
InputValidator.validatePersonaName(name); // Safe characters only

// Validate base64
InputValidator.validateBase64(data); // Size limits, valid encoding

// Safe YAML parsing
SecureYamlParser.parse(content); // All protections enabled
```

## Important Notes
1. Always use validators for user input
2. Never bypass security checks
3. Log security events
4. Fail securely (deny by default)
5. Keep validation patterns updated
6. Test with malicious inputs
7. Monitor for new attack vectors
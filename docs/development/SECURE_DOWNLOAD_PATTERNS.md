# Secure Download Patterns - Issue #591 Fix Documentation

## Overview

This document describes the critical security vulnerability discovered in Issue #591 and the comprehensive fix implemented to prevent malicious content from persisting on disk despite validation failures.

## The Vulnerability: Download-Then-Validate Pattern

### What Was Wrong

The MCP server was using a dangerous "download-then-validate" pattern where content was written to disk BEFORE security validation completed. This meant that even when validation failed and an error was shown to the user, malicious content remained on the filesystem.

### Attack Scenario

```
1. User requests: install_collection_element "skills/malicious-skill.md"
2. Server downloads to: ~/.dollhouse/portfolio/skills/malicious-skill.md
3. Server validates content
4. Validation FAILS with security error
5. ERROR shown to user: "Critical security threat detected"
6. ⚠️ BUT file remains at: ~/.dollhouse/portfolio/skills/malicious-skill.md
7. Next check shows: "Already installed in your local skills collection"
```

### Security Impact

- **HIGH SEVERITY**: Malicious content persists despite security blocks
- **False Security**: Users believe content was blocked when it wasn't
- **Attack Persistence**: Attackers can accumulate malicious files
- **Privilege Escalation Risk**: Malicious files could be executed later

## The Fix: Validate-Before-Write Pattern

### Core Principle

**NEVER write content to disk until ALL validation is complete and successful.**

### Implementation Pattern

```typescript
// ✅ CORRECT: Validate-Before-Write Pattern
async installContent(path: string) {
  // 1. Fetch content into memory FIRST
  const content = await this.fetchContent(path);
  
  // 2. Perform ALL validation BEFORE any disk operation
  const validation = await this.validateContent(content);
  if (!validation.isValid) {
    // No file written, no cleanup needed
    throw new SecurityError(`Security validation failed: ${validation.error}`);
  }
  
  // 3. Only write if completely validated
  const destination = this.getDestinationPath(validation.metadata);
  await this.atomicWrite(destination, content);
  
  return { success: true, ...validation.metadata };
}

// ❌ WRONG: Download-Then-Validate Pattern
async installContentWRONG(path: string) {
  const content = await this.fetchContent(path);
  const destination = this.getDestinationPath(metadata);
  
  // DANGER: Writing before validation!
  await fs.writeFile(destination, content);
  
  // Too late! File already on disk
  if (!validate(content)) {
    throw new Error("Validation failed");
    // File remains on disk!
  }
}
```

## Security Patterns to Follow

### 1. Atomic File Operations

Always use atomic writes to prevent partial file corruption:

```typescript
import { FileLockManager } from '../security/fileLockManager.js';

// Use atomic write with temp file + rename
async atomicWrite(destination: string, content: string) {
  const tempFile = `${destination}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Write to temp file first
    await fs.writeFile(tempFile, content, 'utf-8');
    
    // Atomic rename (on most filesystems)
    await fs.rename(tempFile, destination);
  } catch (error) {
    // Guaranteed cleanup on ANY error
    await fs.unlink(tempFile).catch(() => {});
    throw error;
  }
}

// Or use the built-in FileLockManager
await FileLockManager.atomicWriteFile(destination, content, { encoding: 'utf-8' });
```

### 2. Comprehensive Validation Chain

Validate ALL aspects before writing:

```typescript
async validateContent(content: string): Promise<ValidationResult> {
  // 1. Size validation
  if (content.length > MAX_CONTENT_SIZE) {
    return { isValid: false, error: 'Content exceeds size limit' };
  }
  
  // 2. Security threat scanning
  const securityResult = await ContentValidator.validateAndSanitize(content);
  if (!securityResult.isValid && securityResult.severity === 'critical') {
    return { 
      isValid: false, 
      error: `Critical security threat: ${securityResult.detectedPatterns?.join(', ')}` 
    };
  }
  
  // 3. Format validation (YAML, JSON, etc.)
  const yamlResult = await SecureYamlParser.safeMatter(content);
  if (!yamlResult.isValid) {
    return { isValid: false, error: yamlResult.error };
  }
  
  // 4. Metadata validation
  const metadataResult = ContentValidator.validateMetadata(yamlResult.data);
  if (!metadataResult.isValid) {
    return { isValid: false, error: 'Invalid metadata structure' };
  }
  
  // All validation passed
  return { isValid: true, metadata: yamlResult.data };
}
```

### 3. Path Validation

Always validate paths before any filesystem operations:

```typescript
import { PathValidator } from '../security/pathValidator.js';

// Validate path BEFORE any operations
const validPath = PathValidator.validatePath(userProvidedPath);
if (!validPath.isValid) {
  throw new SecurityError(`Invalid path: ${validPath.error}`);
}

// Check for directory traversal
if (userProvidedPath.includes('..')) {
  throw new SecurityError('Directory traversal detected');
}
```

### 4. Error Handling with Cleanup

Ensure cleanup happens on ANY error:

```typescript
async downloadWithCleanup(url: string, destination: string) {
  const tempFile = `${destination}.tmp`;
  
  try {
    // Download to temp location
    await downloadTo(url, tempFile);
    
    // Validate temp file
    const content = await fs.readFile(tempFile, 'utf-8');
    const validation = await validateContent(content);
    
    if (!validation.isValid) {
      // Clean up BEFORE throwing
      await fs.unlink(tempFile).catch(() => {});
      throw new SecurityError(validation.error);
    }
    
    // Atomic move only if valid
    await fs.rename(tempFile, destination);
  } catch (error) {
    // Ensure cleanup on ANY error
    await fs.unlink(tempFile).catch(() => {});
    throw error;
  }
}
```

## Using the SecureDownloader Utility

For new download operations, use the `SecureDownloader` utility class:

```typescript
import { SecureDownloader } from '../utils/SecureDownloader.js';

const downloader = new SecureDownloader();

// Download with built-in validation
await downloader.downloadToFile(
  'https://example.com/content.md',
  './portfolio/content.md',
  {
    validator: async (content) => {
      // Custom validation logic
      const result = await ContentValidator.validateAndSanitize(content);
      return {
        isValid: result.isValid,
        errorMessage: result.error
      };
    },
    maxSize: 1024 * 1024, // 1MB limit
    timeout: 30000 // 30 second timeout
  }
);

// Download to memory for processing
const content = await downloader.downloadToMemory(
  'https://example.com/data.json',
  {
    validator: SecureDownloader.jsonValidator()
  }
);
```

## Security Checklist for File Operations

When working with file operations that involve external or user-provided content:

- [ ] **Validate BEFORE Write**: All validation must complete before any disk operations
- [ ] **Use Atomic Operations**: Use `FileLockManager.atomicWriteFile()` or temp file + rename
- [ ] **Path Validation**: Validate paths to prevent directory traversal
- [ ] **Size Limits**: Enforce size limits to prevent DoS attacks
- [ ] **Content Validation**: Use `ContentValidator.validateAndSanitize()` for security scanning
- [ ] **Error Cleanup**: Ensure temporary files are cleaned up on errors
- [ ] **Security Logging**: Log security events with `SecurityMonitor.logSecurityEvent()`
- [ ] **Timeout Protection**: Set timeouts for network operations
- [ ] **Format Validation**: Validate JSON/YAML/XML formats before processing

## Files Fixed in Issue #591

The following files were updated to implement the secure patterns:

1. **ElementInstaller.ts** - Primary fix with complete validate-before-write implementation
2. **PersonaSharer.ts** - Added validation before import operations
3. **MigrationManager.ts** - Added content validation during migration
4. **PersonaLoader.ts** - Replaced direct writes with atomic operations
5. **index.ts** - Added JSON validation for helper state writes

## Testing Security Fixes

Always include security tests for file operations:

```typescript
describe('Security: Download Validation', () => {
  it('should NOT persist malicious content when validation fails', async () => {
    const maliciousContent = '$(rm -rf /)';
    const destination = './test-file.md';
    
    // Attempt to install malicious content
    await expect(
      installer.installContent(maliciousContent, destination)
    ).rejects.toThrow('Critical security threat');
    
    // Verify file does NOT exist
    expect(fs.existsSync(destination)).toBe(false);
  });
  
  it('should clean up temporary files on validation failure', async () => {
    // Test cleanup logic
  });
  
  it('should use atomic operations for writes', async () => {
    // Test atomic write behavior
  });
});
```

## Common Mistakes to Avoid

### ❌ Writing Then Validating
```typescript
// WRONG: File persists even on validation failure
fs.writeFileSync(path, content);
if (!validate(content)) {
  throw new Error('Invalid content');
}
```

### ❌ Missing Cleanup
```typescript
// WRONG: Temp file not cleaned up on error
const tempFile = `${path}.tmp`;
fs.writeFileSync(tempFile, content);
validate(content); // If this throws, temp file remains
fs.renameSync(tempFile, path);
```

### ❌ Non-Atomic Operations
```typescript
// WRONG: Partial write possible
const stream = fs.createWriteStream(path);
stream.write(content);
// Process crash here = partial file
stream.end();
```

### ❌ Validating After Network Operations
```typescript
// WRONG: Downloads before validation
const localPath = await download(url);
if (!validate(localPath)) {
  // Too late, file already downloaded
  fs.unlinkSync(localPath);
}
```

## Summary

The validate-before-write pattern is **critical** for security. Always:

1. **Fetch content into memory first**
2. **Validate completely before any disk operations**
3. **Use atomic writes with cleanup guarantees**
4. **Test that malicious content never persists**

Following these patterns prevents malicious content from persisting on user systems and maintains the integrity of the security validation system.

## References

- Issue #591: Original vulnerability report
- PR #[TBD]: Security fix implementation
- `SECURITY_FIX_DOCUMENTATION_PROCEDURE.md`: Documentation standards
- `src/utils/SecureDownloader.ts`: Reusable secure download utility
- `test/__tests__/security/download-validation.test.ts`: Security test suite
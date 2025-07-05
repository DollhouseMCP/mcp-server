# PR #46 Critical Issues Reference

## Overview
PR #46 "Post-refactor fixes and unit test foundation" is blocked due to test compilation failures and interface mismatches. This document contains all necessary reference information to fix these issues after context compaction.

## Critical Blocking Issues

### 1. PersonaManager.test.ts Compilation Errors

#### Issue: Mock type mismatch (Line 148, 172)
```typescript
// Current (WRONG):
mockValidator.validatePersona = jest.fn().mockReturnValue({ 
  isValid: true, 
  errors: [],
  warnings: []
});

// Need to check actual PersonaValidator.validatePersona signature in:
// src/persona/PersonaValidator.ts
```

#### Issue: Wrong argument count (Line 161)
```typescript
// Current (WRONG):
await personaManager.createPersona(
  newPersona.name,
  newPersona.description,
  newPersona.category,
  newPersona.instructions,
  newPersona.triggers  // <- This 5th parameter doesn't exist
);

// Actual signature (from src/persona/PersonaManager.ts):
async createPersona(
  name: string,
  description: string,
  category: string,
  instructions: string
): Promise<{ success: boolean; message: string; filename?: string }>
```

#### Issue: fs.readdir mock type (Line 328)
```typescript
// Current (WRONG):
(fs.readdir as jest.MockedFunction<typeof fs.readdir>).mockResolvedValue(['corrupted.md'] as any);

// Should return Dirent[] or use proper type casting
// Check Node.js fs.promises.readdir return type
```

### 2. GitHubClient.test.ts Type Issues

#### Issue: global.fetch mock (Line 9)
```typescript
// Current (WRONG):
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Should properly type the mock:
const mockFetch = jest.fn<Promise<any>, [RequestInfo | URL, RequestInit?]>();
global.fetch = mockFetch as typeof fetch;
```

#### Issue: Mock return values expecting 'never' type
```typescript
// All mockFetch.mockResolvedValue() calls need proper typing
// Example fix:
mockFetch.mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue(mockData)
} as unknown as Response);
```

### 3. InputValidator.test.ts Assertion Failures

#### Issue: Wrong error message (Line 145)
```typescript
// Current test expects:
expect(() => validatePath(path)).toThrow('Path traversal not allowed');

// But actual error from src/security/InputValidator.ts is:
'Invalid path format. Use alphanumeric characters, hyphens, underscores, dots, and forward slashes only.'

// Need to check the actual validation flow in validatePath()
```

## Key Implementation Details to Check

### PersonaManager Methods
- `getAllPersonas()`: Returns `Map<string, Persona>`
- `setUserIdentity(username: string | null, email?: string)`: Returns `void`
- `getUserIdentity()`: Returns `{ username: string | null; email: string | null }`
- `clearUserIdentity()`: Returns `void`

### PersonaValidator Methods
Check exact signature and return type:
- `validatePersona(persona: Persona): ValidationResult`
- `validateMetadata(metadata: PersonaMetadata): ValidationResult`

### ValidationResult Type
Need to verify the exact shape of ValidationResult in types files.

### Persona Type Structure
```typescript
interface Persona {
  metadata: PersonaMetadata;
  content: string;
  filename: string;
  unique_id: string;
}
```

## Missing Test Coverage to Add

### GitHubClient
- Malformed JSON response handling
- Partial network failures during response streaming
- Cache eviction scenarios
- Concurrent request handling

### PersonaManager
- Concurrent persona operations
- File system race conditions
- Corrupted YAML handling
- Directory permission errors

### Security Tests
- Unicode normalization attacks
- Path traversal with encoded characters
- Timing attack prevention verification
- Log injection prevention

## Quick Fix Checklist

1. [ ] Fix all TypeScript compilation errors first
2. [ ] Update all mock types to match actual implementations
3. [ ] Fix error message assertions to match actual errors
4. [ ] Add missing test scenarios
5. [ ] Strengthen security test assertions
6. [ ] Verify all tests pass locally before pushing

## File Locations for Reference

- **PersonaManager**: `src/persona/PersonaManager.ts`
- **PersonaValidator**: `src/persona/PersonaValidator.ts`
- **InputValidator**: `src/security/InputValidator.ts`
- **GitHubClient**: `src/marketplace/GitHubClient.ts`
- **Type Definitions**: `src/types/*.ts`

## Commands to Run

```bash
# Check TypeScript compilation
npx tsc --noEmit

# Run specific test file
npm test -- __tests__/unit/PersonaManager.test.ts

# Run all unit tests
npm test -- __tests__/unit/

# Run with coverage
npm test -- __tests__/unit/ --coverage
```

## CI/CD Status
- All Node.js test suites failing (Ubuntu, macOS, Windows)
- Docker builds passing
- Need all tests passing for merge

## Next Steps After Fixes
1. Ensure all TypeScript compilation passes
2. Verify all unit tests pass locally
3. Push fixes and wait for CI/CD
4. Address any remaining review feedback
5. Request re-review once all checks pass
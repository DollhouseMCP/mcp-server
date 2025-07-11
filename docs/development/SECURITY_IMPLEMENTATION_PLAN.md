# Security Implementation Plan - DollhouseMCP

## Phase A: Critical Security Infrastructure (Day 1)

### 1. Security Testing Framework
**Issue**: #205  
**Time**: 2-3 hours  
**Files to Create**:
- `__tests__/security/framework/SecurityTestFramework.ts`
- `__tests__/security/framework/RapidSecurityTesting.ts`
- `__tests__/security/setup.ts`

### 2. Critical Security Tests
**Time**: 2 hours  
**Test Files**:
- `__tests__/security/tests/command-injection.test.ts`
- `__tests__/security/tests/path-traversal.test.ts`
- `__tests__/security/tests/yaml-deserialization.test.ts`

### 3. Package.json Updates
```json
{
  "scripts": {
    "security:critical": "jest __tests__/security/critical --maxWorkers=4",
    "security:rapid": "npm run security:critical && npm audit",
    "security:all": "jest __tests__/security --coverage",
    "pre-commit": "npm run security:rapid"
  }
}
```

## Phase B: Critical Vulnerability Fixes (Day 1-2)

### 1. Command Injection Fix
**Issue**: #199  
**Files to Create**:
- `src/security/commandValidator.ts`
- `src/security/safeExec.ts`

**Files to Update**:
- `src/update/UpdateManager.ts`
- `src/update/BackupManager.ts`
- Any file using exec/execSync

### 2. Path Traversal Fix
**Issue**: #200  
**Files to Create**:
- `src/security/pathValidator.ts`
- `src/security/safeFileOperations.ts`

**Files to Update**:
- `src/index.ts` (all persona operations)
- `src/persona/export-import/PersonaImporter.ts`
- `src/persona/export-import/PersonaExporter.ts`

### 3. YAML Deserialization Fix
**Issue**: #201  
**Files to Create**:
- `src/security/yamlValidator.ts`
- `src/security/schemaValidators.ts`

**Files to Update**:
- PersonaLoader usage of gray-matter
- ContentValidator integration

## Phase C: High Priority Security (Day 2-3)

### 1. Input Validation Framework
**Issue**: #203  
**Files to Create**:
- `src/security/inputValidator.ts`
- `src/security/validators/personaValidator.ts`
- `src/security/validators/urlValidator.ts`

### 2. File Locking System
**Issue**: #204  
**Files to Create**:
- `src/security/fileLockManager.ts`
- `src/security/atomicFileOperations.ts`

### 3. Token Security
**Issue**: #202  
**Files to Create**:
- `src/security/tokenManager.ts`
- `src/security/credentialValidator.ts`

## Phase D: Security Utilities (Day 3)

### Central Security Module
**File**: `src/security/index.ts`
```typescript
export { CommandValidator } from './commandValidator';
export { PathValidator } from './pathValidator';
export { YamlValidator } from './yamlValidator';
export { InputValidator } from './inputValidator';
export { FileLockManager } from './fileLockManager';
export { TokenManager } from './tokenManager';
export { SecureErrorHandler } from './errorHandler';
export { RateLimiter } from './rateLimiter';
export { SessionManager } from './sessionManager';
```

## Implementation Order

### Day 1 (Critical):
1. ✅ Create issues (DONE)
2. Security test framework
3. Critical security tests
4. Command injection fix
5. Run tests, verify fixes

### Day 2 (High Priority):
1. Path traversal fix
2. YAML deserialization fix
3. Input validation framework
4. Update all MCP tools

### Day 3 (Integration):
1. File locking implementation
2. Token security
3. Central security module
4. Integration testing

### Day 4 (Medium Priority):
1. Error handler implementation
2. Enhanced rate limiting
3. Session management
4. Documentation

## Testing Strategy

### For Each Fix:
1. Write security test first (TDD)
2. Implement fix
3. Verify test passes
4. Add edge case tests
5. Performance test
6. Integration test

### Security Test Categories:
- **Unit**: Individual validators
- **Integration**: Full operation flow
- **Penetration**: Attack scenarios
- **Regression**: Previous vulnerabilities

## Success Criteria
- [ ] All critical vulnerabilities have tests
- [ ] Security tests run in <30 seconds
- [ ] No security regressions
- [ ] All user inputs validated
- [ ] File operations are atomic
- [ ] Tokens never logged
- [ ] YAML parsing is safe

## Commands for Next Session
```bash
# Start security work
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP
git checkout -b security-implementation

# Create security directories
mkdir -p __tests__/security/framework
mkdir -p __tests__/security/tests
mkdir -p src/security/validators

# Run tests as we implement
npm run security:rapid
```
# Issue #202 Next Steps - GitHub Token Security Implementation

## 🎯 Current Status
**TokenManager Class**: ✅ COMPLETE and ready for integration  
**Location**: `/src/security/tokenManager.ts`  
**Testing**: Ready for comprehensive unit tests  
**Integration**: Ready to apply to GitHubClient and marketplace tools  

## 🔧 **Immediate Implementation Tasks**

### **1. GitHubClient Integration (HIGH PRIORITY)**

#### **File**: `/src/marketplace/GitHubClient.ts`
**Current vulnerable pattern**:
```typescript
// BEFORE (vulnerable):
constructor() {
  this.token = process.env.GITHUB_TOKEN; // No validation
}

private getHeaders() {
  return {
    'Authorization': `token ${this.token}`, // Potential exposure
    'User-Agent': 'DollhouseMCP/1.0'
  };
}
```

**Secure replacement**:
```typescript
// AFTER (secure):
import { TokenManager } from '../security/tokenManager.js';

constructor() {
  this.token = TokenManager.getGitHubToken(); // Validated token
}

private getHeaders() {
  if (!this.token) {
    throw new Error('No valid GitHub token available');
  }
  return {
    'Authorization': `token ${this.token}`,
    'User-Agent': 'DollhouseMCP/1.0'
  };
}

async validatePermissions(operation: 'read' | 'marketplace') {
  const validation = await TokenManager.ensureTokenPermissions(operation);
  if (!validation.isValid) {
    throw new Error(TokenManager.createSafeErrorMessage(validation.error!, this.token));
  }
  return validation;
}
```

### **2. PersonaSharer Integration**

#### **File**: `/src/persona/export-import/PersonaSharer.ts`
**Add gist scope validation**:
```typescript
async sharePersona(persona: Persona, expiryDays: number) {
  // Add scope validation for gist operations
  const validation = await TokenManager.ensureTokenPermissions('gist');
  if (!validation.isValid) {
    throw new Error(`Cannot share persona: ${validation.error}`);
  }
  
  // Existing implementation with safe error handling
  try {
    // ... gist creation logic
  } catch (error) {
    const safeMessage = TokenManager.createSafeErrorMessage(
      error.message, 
      this.token
    );
    throw new Error(safeMessage);
  }
}
```

### **3. Enhanced Error Handling**

#### **Pattern to apply throughout codebase**:
```typescript
// Replace all GitHub API error handling:
catch (error) {
  // OLD (vulnerable):
  logger.error('GitHub API error', { error: error.message, token: this.token });
  
  // NEW (secure):
  const safeMessage = TokenManager.createSafeErrorMessage(
    error.message, 
    this.token
  );
  logger.error('GitHub API error', { error: safeMessage });
  throw new Error(safeMessage);
}
```

## 🧪 **Testing Implementation**

### **Create**: `/tests/unit/TokenManager.test.ts`
```typescript
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { TokenManager } from '../../src/security/tokenManager.js';

describe('TokenManager - GitHub Token Security', () => {
  describe('validateTokenFormat', () => {
    test('should validate GitHub Personal Access Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghp_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should validate GitHub Installation Tokens', () => {
      expect(TokenManager.validateTokenFormat('ghs_1234567890123456789012345678901234567890')).toBe(true);
    });
    
    test('should reject invalid token formats', () => {
      expect(TokenManager.validateTokenFormat('invalid_token')).toBe(false);
      expect(TokenManager.validateTokenFormat('ghp_short')).toBe(false);
    });
  });

  describe('redactToken', () => {
    test('should safely redact tokens for logging', () => {
      const token = 'ghp_1234567890123456789012345678901234567890';
      const redacted = TokenManager.redactToken(token);
      expect(redacted).toBe('ghp_...7890');
      expect(redacted).not.toContain('1234567890123456789012345678901234');
    });
  });

  describe('getGitHubToken', () => {
    beforeEach(() => {
      delete process.env.GITHUB_TOKEN;
    });

    test('should return null when no token is set', () => {
      expect(TokenManager.getGitHubToken()).toBe(null);
    });

    test('should return valid token when format is correct', () => {
      process.env.GITHUB_TOKEN = 'ghp_1234567890123456789012345678901234567890';
      expect(TokenManager.getGitHubToken()).toBe('ghp_1234567890123456789012345678901234567890');
    });

    test('should return null for invalid token format', () => {
      process.env.GITHUB_TOKEN = 'invalid_token';
      expect(TokenManager.getGitHubToken()).toBe(null);
    });
  });

  describe('createSafeErrorMessage', () => {
    test('should remove tokens from error messages', () => {
      const errorWithToken = 'API failed with token ghp_1234567890123456789012345678901234567890';
      const safeMessage = TokenManager.createSafeErrorMessage(errorWithToken);
      expect(safeMessage).toContain('[REDACTED_PAT]');
      expect(safeMessage).not.toContain('ghp_1234567890123456789012345678901234567890');
    });
  });
});
```

## 📍 **Integration Points**

### **Files to Update**
1. **`/src/marketplace/GitHubClient.ts`** - Core token usage
2. **`/src/persona/export-import/PersonaSharer.ts`** - Gist operations  
3. **`/src/marketplace/MarketplaceBrowser.ts`** - Add permission validation
4. **`/src/marketplace/MarketplaceSearch.ts`** - Add permission validation
5. **`/src/marketplace/PersonaInstaller.ts`** - Add permission validation

### **Search Patterns to Replace**
```bash
# Find direct token usage:
grep -r "process.env.GITHUB_TOKEN" src/
grep -r "this.token" src/marketplace/
grep -r "Authorization.*token" src/

# Find error handling to enhance:
grep -r "catch.*error" src/marketplace/
grep -r "logger.error" src/marketplace/
```

## 🎯 **Success Criteria**

### **Security Objectives**
- [ ] No direct `process.env.GITHUB_TOKEN` usage
- [ ] All GitHub API calls use TokenManager
- [ ] Token validation on GitHub operations
- [ ] Safe error handling without token exposure
- [ ] Comprehensive test coverage (>90%)

### **Functional Objectives**  
- [ ] All marketplace operations continue working
- [ ] Persona sharing continues working
- [ ] Error messages remain user-friendly
- [ ] No performance regressions

### **Testing Objectives**
- [ ] TokenManager unit tests (>20 tests)
- [ ] Integration tests with mocked GitHub API
- [ ] Error handling tests with token scenarios
- [ ] Security tests for token exposure prevention

## ⚡ **Commands for Next Session**

### **Start Implementation**
```bash
# 1. Check current status
git status
npm test

# 2. Start TokenManager integration
code src/marketplace/GitHubClient.ts

# 3. Create tests
code __tests__/unit/TokenManager.test.ts

# 4. Test integration
npm test -- __tests__/unit/TokenManager.test.ts
```

### **Verify Integration**
```bash
# Check for token exposure patterns
grep -r "ghp_\|ghs_\|ghu_\|ghr_" src/ --exclude-dir=security
grep -r "process.env.GITHUB_TOKEN" src/

# Run security tests
npm test -- __tests__/security/
```

## 🛡️ **Security Impact After Completion**

### **Before** (Current State)
- ❌ Direct environment variable usage
- ❌ No token format validation  
- ❌ Potential token exposure in logs
- ❌ No scope validation
- ❌ Inconsistent error handling

### **After** (Target State)
- ✅ Validated token management
- ✅ Format validation for all token types
- ✅ Safe logging with token redaction
- ✅ Scope validation per operation
- ✅ Consistent, secure error handling

**Risk Reduction**: HIGH → LOW for GitHub token security vulnerabilities

---

*Ready for next session to complete comprehensive GitHub token security implementation and fully resolve Issue #202!*
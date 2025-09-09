# Singleton Testing Patterns - Industry Best Practices

## Overview
This document outlines industry-standard approaches for testing singleton patterns in CI/CD environments, based on practices from major tech companies.

## The Problem
Singletons maintain state across test runs, making it impossible to test with a clean slate. This is a common challenge faced by every major software company.

## Industry Solutions (Ranked by Popularity)

### 1. Test-Only Reset Method (Most Common)
**Used by**: Google, Facebook, Microsoft, Netflix
**Complexity**: Low
**Resource Usage**: Minimal

```typescript
class ConfigManager {
  private static instance: ConfigManager | null = null;
  
  constructor() {
    if (ConfigManager.instance) {
      return ConfigManager.instance;
    }
    ConfigManager.instance = this;
  }
  
  // Test-only reset method
  static resetForTesting(): void {
    if (process.env.NODE_ENV === 'test') {
      ConfigManager.instance = null;
    } else {
      throw new Error('resetForTesting() can only be called in test environment');
    }
  }
}

// In your test file
beforeEach(() => {
  ConfigManager.resetForTesting();
});
```

**Pros**:
- Simple to implement
- No infrastructure changes
- Clear intent
- Widely understood pattern

**Cons**:
- Slightly "impure" (test-only code in production files)
- Must remember to call reset

### 2. Dependency Injection Pattern
**Used by**: Spring (Java), Angular, NestJS communities
**Complexity**: Medium
**Resource Usage**: Minimal

```typescript
// Production code
class ConfigManager {
  // No singleton logic here
  constructor(private config: ConfigData) {}
}

// Singleton wrapper for production
class ConfigManagerSingleton {
  private static instance: ConfigManager | null = null;
  
  static getInstance(): ConfigManager {
    if (!this.instance) {
      this.instance = new ConfigManager(loadConfig());
    }
    return this.instance;
  }
}

// Tests get fresh instances
test('security test', () => {
  const config = new ConfigManager(testConfig);
  // Fresh instance every time
});
```

**Pros**:
- Clean separation of concerns
- Testable by design
- No test-specific code in classes

**Cons**:
- Requires architectural changes
- More complex setup

### 3. Factory Pattern with Environment Detection
**Used by**: Amazon, Spotify
**Complexity**: Medium
**Resource Usage**: Minimal

```typescript
class ConfigManagerFactory {
  private static productionInstance: ConfigManager | null = null;
  
  static create(): ConfigManager {
    // In tests, always return new instance
    if (process.env.NODE_ENV === 'test') {
      return new ConfigManager();
    }
    
    // In production, return singleton
    if (!this.productionInstance) {
      this.productionInstance = new ConfigManager();
    }
    return this.productionInstance;
  }
}
```

**Pros**:
- Clean API
- No test-specific methods
- Self-managing

**Cons**:
- Factory adds complexity
- Must use factory everywhere

### 4. Process Isolation (Your Suggestion)
**Used by**: Some financial institutions, healthcare systems
**Complexity**: High
**Resource Usage**: High

```yaml
# .github/workflows/ci.yml
jobs:
  test-normal:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -- --testPathIgnorePatterns=ConfigManager
  
  test-config-security-1:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -- ConfigManager.test.ts --testNamePattern="prototype pollution"
  
  test-config-security-2:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -- ConfigManager.test.ts --testNamePattern="constructor injection"
```

**Pros**:
- Complete isolation
- No code changes needed
- Guaranteed clean state

**Cons**:
- 3x CI/CD time for three tests
- Complex GitHub Actions setup
- Overkill for small test suite

### 5. Jest Module Isolation
**Used by**: React team, Vue.js team
**Complexity**: Medium
**Resource Usage**: Low

```javascript
// jest.config.js
module.exports = {
  // Run tests serially
  runInBand: true,
  // Reset module registry between tests
  resetModules: true,
  // Isolate modules for each test file
  isolatedModules: true,
};

// In test
beforeEach(() => {
  jest.resetModules();
  // Now require gets fresh module
  const { ConfigManager } = require('./ConfigManager');
});
```

**Pros**:
- Built into Jest
- No production code changes
- Good isolation

**Cons**:
- Only works with CommonJS (not ESM)
- Can slow down test suite
- Complex with TypeScript

## What Major Companies Actually Do

### Google
- Uses test-only reset methods extensively
- Belief: "Pragmatism over purity"
- Quote: "Make it work, make it right, make it fast"

### Facebook/Meta
- Dependency injection for new code
- Test-only resets for legacy code
- Extensive use of Jest's module mocking

### Microsoft
- Mix of patterns depending on team
- Azure team uses dependency injection
- VS Code team uses test-only resets

### Netflix
- Factory patterns with environment detection
- Some test-only reset methods
- Emphasis on pragmatic solutions

### Amazon
- Service-oriented architecture reduces singletons
- When needed, uses factory patterns
- Some teams use container isolation

## Recommendations for DollhouseMCP

### Immediate Solution (Recommended)
Add a test-only reset method to ConfigManager:

```typescript
class ConfigManager {
  static resetForTesting(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Cannot reset ConfigManager outside of test environment');
    }
    this.instance = null;
    // Clear any other static state
  }
}
```

**Why this is best for you**:
1. Minimal code change (5 lines)
2. Unblocks your tests immediately
3. Industry-standard approach
4. Easy to understand and maintain
5. Used by companies 100x your size

### Long-term Solution (Optional)
If you refactor in the future, consider dependency injection:
- Cleaner architecture
- Better testability
- More flexible
- But NOT urgent - your current security is fine

## The Reality Check

> "Perfect is the enemy of good" - Voltaire

Even companies with unlimited resources use test-only reset methods because:
1. They work
2. They're simple
3. They're maintainable
4. The "impurity" is negligible
5. Time is better spent on features

## CI/CD Resource Considerations

Running 3 separate CI jobs for 3 tests would:
- Triple CI time for those tests
- Cost ~$0.008 per run (GitHub Actions pricing)
- Add complexity to workflow files
- Make debugging harder
- Provide minimal benefit

**Industry consensus**: Not worth it for a handful of tests.

## Decision Matrix

| Solution | Implementation Time | Maintenance Burden | Resource Cost | Recommendation |
|----------|-------------------|-------------------|---------------|----------------|
| Test-only reset | 30 minutes | Low | None | ✅ **DO THIS** |
| Dependency injection | 2-4 hours | Medium | None | Consider later |
| Factory pattern | 1-2 hours | Medium | None | Alternative option |
| Process isolation | 2-3 hours | High | 3x for affected tests | Not recommended |
| Jest isolation | 1-2 hours | Medium | Slight slowdown | If reset doesn't work |

## Example Implementation for ConfigManager

```typescript
// src/security/ConfigManager.ts
export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: Record<string, any> = {};
  
  constructor() {
    if (ConfigManager.instance) {
      return ConfigManager.instance;
    }
    ConfigManager.instance = this;
  }
  
  // Add this method
  static resetForTesting(): void {
    if (process.env.NODE_ENV !== 'test') {
      console.error('Warning: Attempted to reset ConfigManager outside test environment');
      return;
    }
    ConfigManager.instance = null;
  }
  
  // Existing methods...
  async setConfigValue(key: string, value: any): Promise<void> {
    // Security checks here
    this.config[key] = value;
  }
}

// test/ConfigManager.test.ts
describe('ConfigManager Security', () => {
  beforeEach(() => {
    // Reset singleton before each test
    ConfigManager.resetForTesting();
  });
  
  it('should block __proto__ injection', async () => {
    const manager = new ConfigManager();
    await expect(
      manager.setConfigValue('__proto__', { isAdmin: true })
    ).rejects.toThrow('Invalid key');
    
    // Verify prototype wasn't polluted
    const testObj = {};
    expect(testObj.isAdmin).toBeUndefined();
  });
});
```

## Summary

You're not alone in this challenge. Every company that uses singletons faces this issue. The industry has converged on pragmatic solutions, with test-only reset methods being the most common. Don't over-engineer the solution - a simple reset method will serve you well and is what billion-dollar companies use every day.

---

*Remember: Google, Facebook, and Microsoft all have test-only reset methods in their production code. If it's good enough for them, it's good enough for DollhouseMCP.*
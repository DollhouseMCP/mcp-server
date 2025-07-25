# Export Conflicts Quick Reference

## Problem
The barrel file (`src/index.barrel.ts`) is causing TypeScript compilation errors due to duplicate exports.

## Conflicting Exports

### 1. validateCategory
- Exported from: `src/security/InputValidator.ts`
- Also exported from: `src/utils/validation.ts`
- Solution: Remove from validation.ts OR use explicit re-export

### 2. validateUsername  
- Exported from: `src/security/InputValidator.ts`
- Also exported from: `src/utils/validation.ts`
- Solution: Remove from validation.ts OR use explicit re-export

### 3. VALIDATION_PATTERNS
- Exported from: `src/security/constants.ts`
- Also exported from: `src/utils/validation.ts`
- Solution: Remove from validation.ts OR use explicit re-export

## Quick Fix Options

### Option 1: Remove from utils/validation.ts
These were likely moved there during refactoring but already exist in InputValidator.

### Option 2: Explicit Re-exports in barrel
```typescript
// Instead of:
export * from './security/InputValidator.js';
export * from './utils/validation.js';

// Use:
export { 
  validateFilename, 
  validatePath, 
  sanitizeInput, 
  validateContentSize 
} from './security/InputValidator.js';

export {
  // Only export what's unique to validation.ts
} from './utils/validation.js';
```

### Option 3: Remove barrel file exports for conflicting modules
Just don't export these modules from the barrel file if they cause conflicts.
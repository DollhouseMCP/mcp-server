# CI Test Failures to Fix - PR #839

## Issue Summary
PR #839 (README workflow integration) has failing TypeScript compilation in tests.
These errors are NOT related to our changes but need to be fixed.

## Specific TypeScript Errors Found

### 1. ToolCache.test.ts
**Lines 38, 126**: Missing Promise type argument
```typescript
// Error: Expected 1 arguments, but got 0. Did you forget to include 'void' in your type argument to 'Promise'?
// Fix: Change Promise<> to Promise<void>
```

### 2. submitToPortfolioTool.test.ts  
**Line 45**: Using class as type instead of typeof
```typescript
// Error: 'SubmitToPortfolioTool' refers to a value, but is being used as a type here
// Fix: Change to 'typeof SubmitToPortfolioTool'
```

**Line 82**: Type mismatch in mock
```typescript
// Error: Argument of type '"test-token"' is not assignable to parameter of type 'never'
// Fix: Properly type the mock function
```

**Line 278**: Undefined type reference
```typescript
// Error: Cannot find name 'MockedTokenManager'. Did you mean 'TokenManager'?
// Fix: Either import MockedTokenManager or use correct type
```

### 3. CollectionIndexManager.test.ts
**Lines 389, 409, 427**: Incomplete Response mock
```typescript
// Error: Missing properties from type 'Response': redirected, statusText, type, url, and 8 more
// Fix: Use proper Response mock or add missing properties
```

### 4. upload-ziggy-demo.test.ts
**Lines 89, 209**: Function type incompatibility
```typescript
// Error: Types of parameters 'url' and 'args' are incompatible
// Fix: Properly type the mock function parameters
```

## Quick Fix Commands for Next Session

```bash
# Get on the branch
git checkout feature/integrate-readme-build-workflow

# Type check to see current errors
npx tsc --project test/tsconfig.test.json --noEmit

# Fix each file
code test/__tests__/unit/utils/ToolCache.test.ts
code test/__tests__/unit/tools/portfolio/submitToPortfolioTool.test.ts
code test/__tests__/unit/collection/CollectionIndexManager.test.ts
code test/__tests__/qa/upload-ziggy-demo.test.ts

# Re-run type check
npx tsc --project test/tsconfig.test.json --noEmit

# Run tests
npm test
```

## Root Cause
These appear to be TypeScript strictness issues that may have been introduced by:
1. TypeScript version updates
2. Jest type definition changes
3. Stricter type checking in CI vs local

## Priority
HIGH - These block PR #839 from merging, which blocks the README automation from being deployed.

## Estimated Fix Time
~30 minutes - These are all straightforward type annotation fixes.
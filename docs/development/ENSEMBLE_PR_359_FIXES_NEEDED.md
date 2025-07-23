# PR #359 Ensemble Element - Fixes Needed

## 🔴 CRITICAL - Must Fix Before Merge

### 1. Security Scanner False Positive
**File**: `src/elements/ensembles/EnsembleManager.ts:206`
```typescript
// CURRENT (triggers scanner):
// Previously: const metadata = yaml.load(match[1]);

// FIX TO:
// Previously: Used unsafe YAML parsing without validation
```

### 2. Implement activateElement()
**File**: `src/elements/ensembles/Ensemble.ts:688-703`
```typescript
// CURRENT:
private async activateElement(elementId: string): Promise<ElementActivationResult> {
  // Just simulates with timeout
  await new Promise(resolve => setTimeout(resolve, 100));
}

// NEEDS:
// 1. Load element from portfolio using elementType
// 2. Call element's activate() method if it exists
// 3. Handle errors properly
// 4. Track activation state
```

### 3. Implement evaluateCondition()
**File**: `src/elements/ensembles/Ensemble.ts:714-718`
```typescript
// CURRENT:
private evaluateCondition(condition: string): boolean {
  return true; // Always true!
}

// NEEDS:
// 1. Parse simple conditions like "element.property == value"
// 2. Access element states/properties
// 3. Return actual evaluation result
// 4. Handle parse errors gracefully
```

### 4. Fix Type Safety
**File**: `src/elements/ensembles/Ensemble.ts:394`
```typescript
// CURRENT:
tempGraph.set(elementId, { dependencies } as any);

// FIX TO:
tempGraph.set(elementId, { 
  elementId, 
  elementType: 'unknown',
  role: 'support',
  dependencies 
} as EnsembleElement);
```

## 🟡 HIGH PRIORITY - Should Fix

### 5. Context Synchronization
Add mutex or locking for shared context updates to prevent race conditions in parallel activation.

### 6. Error Handling in Parallel Activation
Wrap individual promises to handle errors without failing entire activation.

### 7. Clarify Activation Strategies
Document difference between 'all' and 'parallel' or merge them.

## 📝 Quick Fix Commands

```bash
# Fix security scanner comment
sed -i '' 's/const metadata = yaml.load/Used unsafe YAML parsing/g' src/elements/ensembles/EnsembleManager.ts

# Run security audit locally
npm run security:audit

# Test the specific files
npm test -- test/__tests__/unit/elements/ensembles/Ensemble.test.ts --no-coverage
```

## Implementation Hints

### For activateElement():
- Use `PortfolioManager.getInstance()` to get element directory
- Load element based on type (persona, skill, agent, etc.)
- Check if element implements activation lifecycle methods
- Store element instance in `elementInstances` map

### For evaluateCondition():
- Start with simple equality checks
- Parse pattern: `elementId.property operator value`
- Access element from `elementInstances` map
- Support operators: ==, !=, >, <, >=, <=
- Return false on any parse/access error

---
*Use this as a checklist when fixing the issues*
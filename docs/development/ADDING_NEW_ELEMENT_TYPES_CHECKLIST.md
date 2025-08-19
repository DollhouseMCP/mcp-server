# Adding New Element Types - Complete Checklist

## ⚠️ CRITICAL WARNING ⚠️

**Before adding a new element type, you MUST update ALL locations listed below. Missing even one location can cause type validation errors, runtime failures, or inconsistent behavior.**

This checklist was created after discovering the `validTypes` array in `src/index.ts` was missing during element type additions, causing validation failures. Use this guide religiously to prevent future issues.

---

## 📋 Complete Checklist

### 1. Core Type Definition
- [ ] **Add to ElementType enum** in `src/portfolio/types.ts`
  ```typescript
  export enum ElementType {
    PERSONA = 'personas',
    SKILL = 'skills',
    TEMPLATE = 'templates',
    AGENT = 'agents',
    MEMORY = 'memories',
    ENSEMBLE = 'ensembles',
    YOUR_NEW_TYPE = 'your-new-types'  // ← ADD HERE
  }
  ```

### 2. ⚠️ CRITICAL: MCP Type Arrays
- [ ] **Add to validTypes array** in `src/index.ts` (line ~1808)
  ```typescript
  const validTypes = ['personas', 'skills', 'agents', 'templates', 'your-new-types'];  // ← ADD HERE
  ```
  **THIS IS THE MOST COMMONLY MISSED LOCATION!**

- [ ] **Add to MCP_SUPPORTED_TYPES** in `src/collection/CollectionBrowser.ts` (line ~13)
  ```typescript
  const MCP_SUPPORTED_TYPES = [
    ElementType.PERSONA,
    ElementType.SKILL,
    ElementType.AGENT,
    ElementType.TEMPLATE,
    ElementType.YOUR_NEW_TYPE  // ← ADD HERE
  ];
  ```

### 3. Type Normalization Maps
- [ ] **Add to pluralToSingularMap** in `src/index.ts` (line ~262)
  ```typescript
  const pluralToSingularMap: Record<string, string> = {
    'personas': ElementType.PERSONA,
    'skills': ElementType.SKILL,
    'templates': ElementType.TEMPLATE,
    'agents': ElementType.AGENT,
    'memories': ElementType.MEMORY,
    'ensembles': ElementType.ENSEMBLE,
    'your-new-types': ElementType.YOUR_NEW_TYPE  // ← ADD HERE
  };
  ```

- [ ] **Add to pluralToDirMap** in `src/portfolio/PortfolioManager.ts` (line ~321)
  ```typescript
  const pluralToDirMap: Record<string, string> = {
    'persona': 'personas',
    'skill': 'skills', 
    'template': 'templates',
    'agent': 'agents',
    'memory': 'memories',
    'ensemble': 'ensembles',
    'your-new-type': 'your-new-types'  // ← ADD HERE
  };
  ```

### 4. Element Implementation
- [ ] **Create element class** in `src/elements/your-new-types/YourNewType.ts`
  - Implement `IElement` interface
  - Define type-specific metadata interface
  - Add validation logic
  - Implement serialization/deserialization

- [ ] **Create manager class** in `src/elements/your-new-types/YourNewTypeManager.ts`
  - Implement `IElementManager<T>` interface
  - Add type-specific operations

- [ ] **Create index file** in `src/elements/your-new-types/index.ts`
  - Export element and manager classes

### 5. Main Server Integration
- [ ] **Import manager** in `src/index.ts` (top of file)
  ```typescript
  import { YourNewTypeManager } from './elements/your-new-types/YourNewTypeManager.js';
  ```

- [ ] **Add manager property** in `src/index.ts` (class properties)
  ```typescript
  private yourNewTypeManager: YourNewTypeManager;
  ```

- [ ] **Initialize manager** in constructor in `src/index.ts`
  ```typescript
  this.yourNewTypeManager = new YourNewTypeManager();
  ```

- [ ] **Add to switch statements** in all relevant methods:
  - `listElements()` method
  - `activateElement()` method  
  - `deactivateElement()` method
  - `getElementDetails()` method
  - `deleteElement()` method
  - Any other element-type switch statements

### 6. Tool Updates (if needed)
- [ ] **Update ElementTools** in `src/server/tools/ElementTools.ts` if type-specific operations needed
- [ ] **Add specific tools** only if generic tools aren't sufficient

### 7. Collection Integration
- [ ] **Update directory scanning** in relevant collection classes if needed
- [ ] **Test collection browsing** works with new type

### 8. Testing Requirements
- [ ] **Unit tests** for new element class
- [ ] **Unit tests** for new manager class
- [ ] **Integration tests** with MCP tools
- [ ] **Collection browsing tests**
- [ ] **Type validation tests**

### 9. Documentation
- [ ] **Update ELEMENT_IMPLEMENTATION_GUIDE.md** with type-specific requirements
- [ ] **Update API documentation** if exposing new tools
- [ ] **Update README** if user-facing changes

---

## 🗂️ File Locations Quick Reference

| **Purpose** | **File Path** | **Line (approx)** | **What to Update** |
|-------------|---------------|-------------------|-------------------|
| **Core Enum** | `src/portfolio/types.ts` | 5-12 | ElementType enum |
| **⚠️ MCP Validation** | `src/index.ts` | 1808 | validTypes array |
| **⚠️ Collection Support** | `src/collection/CollectionBrowser.ts` | 13-18 | MCP_SUPPORTED_TYPES |
| **Plural Mapping** | `src/index.ts` | 262-268 | pluralToSingularMap |
| **Directory Mapping** | `src/portfolio/PortfolioManager.ts` | 321-326 | pluralToDirMap |
| **Manager Imports** | `src/index.ts` | Top of file | Import statements |
| **Manager Properties** | `src/index.ts` | ~86-88 | Class properties |
| **Manager Initialization** | `src/index.ts` | ~113-115 | Constructor |

---

## 💡 Pro Tips

### Most Common Mistakes
1. **Forgetting `validTypes` array** - This causes MCP validation failures
2. **Forgetting `MCP_SUPPORTED_TYPES`** - This causes collection browsing issues
3. **Missing plural mappings** - This causes lookup failures
4. **Inconsistent naming** - Use kebab-case for plurals, PascalCase for classes

### Quick Testing Commands
```bash
# Test type validation
npm test -- --testNamePattern="element.*type"

# Test MCP tools
npm run test:integration

# Test collection browsing
npm test -- CollectionBrowser
```

### Debugging Type Issues
If you're getting type validation errors:
1. Check `validTypes` array first
2. Verify `MCP_SUPPORTED_TYPES` includes your type
3. Ensure all mapping objects are updated
4. Check console logs for missing manager errors

---

## 🔍 Central Config Recommendation

**Consider creating `src/config/element-types.ts` to centralize all type definitions:**

```typescript
import { ElementType } from '../portfolio/types.js';

// Central source of truth for all element type configurations
export const ELEMENT_TYPE_CONFIG = {
  [ElementType.PERSONA]: {
    plural: 'personas',
    directory: 'personas',
    mcpSupported: true,
    hasManager: true,
    icon: '👤'
  },
  [ElementType.SKILL]: {
    plural: 'skills', 
    directory: 'skills',
    mcpSupported: true,
    hasManager: true,
    icon: '🛠️'
  },
  // ... etc
} as const;

// Derived arrays for use in validation
export const MCP_SUPPORTED_TYPES = Object.keys(ELEMENT_TYPE_CONFIG)
  .filter(type => ELEMENT_TYPE_CONFIG[type as ElementType].mcpSupported)
  .map(type => type as ElementType);

export const VALID_TYPES_ARRAY = MCP_SUPPORTED_TYPES.map(
  type => ELEMENT_TYPE_CONFIG[type].plural
);
```

This would eliminate the need to update multiple arrays manually.

---

## ✅ Final Verification

Before committing your new element type:

- [ ] All tests pass
- [ ] Collection browsing works for new type  
- [ ] MCP tools work with new type
- [ ] No TypeScript errors
- [ ] Documentation updated
- [ ] All locations in checklist updated

**Remember: It's better to spend 10 extra minutes following this checklist than hours debugging missing configurations later!**
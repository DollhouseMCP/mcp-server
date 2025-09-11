# Session Notes - August 4, 2025 Evening - v1.4.4 Emergency Fix Plan

## Critical Context: v1.4.3 is COMPLETELY BROKEN

**Testing by amateur user revealed v1.4.3 fails 100% of the time**. The "fix" for directory names actually made things worse.

## Root Causes Discovered

### 1. Initialization Order Bug (Directory Issue)

In `src/index.ts` constructor:
```typescript
// Line 80 - THIS CREATES DIRECTORIES TOO EARLY!
this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);

// Migration happens LATER in initializePortfolio() - TOO LATE!
```

**Problem**: `getElementDir()` creates directories if they don't exist. By the time migration runs, singular directories already exist, so migration never fixes them.

### 2. Heavy Dependencies Crash (The Real Killer)

In `src/index.ts` constructor:
```typescript
// Line 112 - This triggers the crash chain
this.updateManager = new UpdateManager(safeDir);
```

Chain of doom:
1. UpdateManager constructor creates `new UpdateChecker()`
2. UpdateChecker imports jsdom and DOMPurify at module level
3. In UpdateChecker constructor (lines 107-110):
   ```typescript
   const dom = new JSDOM('');  // THIS CRASHES!
   UpdateChecker.purifyWindow = dom.window;
   UpdateChecker.purify = DOMPurify(UpdateChecker.purifyWindow);
   ```
4. Server crashes during MCP initialization

**Evidence from Claude logs**:
```
[info] Server started and connected successfully
[info] Message from client: {"method":"initialize"...}
[info] Server transport closed unexpectedly  // CRASH HERE!
[error] Server disconnected
```

## v1.4.4 Emergency Fix Plan

### Fix 1: Initialization Order (CRITICAL)

**In src/index.ts constructor**:
```typescript
constructor() {
    // ... server setup ...
    
    // Initialize portfolio system
    this.portfolioManager = PortfolioManager.getInstance();
    this.migrationManager = new MigrationManager(this.portfolioManager);
    
    // RUN MIGRATION BEFORE ACCESSING DIRECTORIES!
    await this.runMigrationIfNeeded();  // NEW - Move this here
    
    // NOW safe to get directories
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
```

**Alternative**: Make `getElementDir()` NOT create directories:
```typescript
getElementDir(type: ElementType, createIfMissing = false): string {
    // Only create if explicitly requested
}
```

### Fix 2: Lazy Load jsdom/DOMPurify

**In src/update/UpdateChecker.ts**:
```typescript
// DON'T import at module level!
// import DOMPurify from 'dompurify';
// import { JSDOM } from 'jsdom';

export class UpdateChecker {
    private initializeDOMPurify(): void {
        if (UpdateChecker.purify) return;
        
        try {
            // Lazy load only when needed
            const { JSDOM } = require('jsdom');
            const DOMPurify = require('dompurify');
            
            const dom = new JSDOM('');
            UpdateChecker.purifyWindow = dom.window;
            UpdateChecker.purify = DOMPurify(UpdateChecker.purifyWindow);
        } catch (error) {
            console.error('Failed to initialize DOMPurify:', error);
            // Continue without HTML sanitization
        }
    }
```

### Fix 3: Add Error Visibility

**Throughout initialization**:
```typescript
try {
    this.updateManager = new UpdateManager(safeDir);
} catch (error) {
    console.error('[DollhouseMCP] Failed to initialize UpdateManager:', error);
    // Continue without update functionality
}
```

## User Testing Results

Amateur user testing revealed these failures:
1. ✗ npm update to v1.4.3
2. ✗ Delete portfolio directory
3. ✗ Manually create correct plural directories
4. ✗ Remove and re-add to Claude
5. ✗ Fresh install

**No workaround exists** - users would give up and uninstall.

## Implementation Steps for Next Session

1. **Switch to main branch and pull latest**
2. **Create hotfix/v1.4.4-critical-fixes branch**
3. **Fix initialization order** - Migration MUST run before directory access
4. **Fix jsdom crash** - Lazy load with error handling
5. **Add console.error() throughout** - Make failures visible in Claude logs
6. **Test thoroughly**:
   - Upgrade from v1.4.2 (with singular directories)
   - Fresh install
   - Limited resources (jsdom failure scenario)
7. **Update version to 1.4.4**
8. **Create PR with clear explanation**
9. **Merge and release ASAP**

## Key Insights

1. **Directory issue was a red herring** - The real killer was jsdom initialization
2. **Silent failures are the worst** - No error output made debugging impossible
3. **Amateur user testing is invaluable** - Developers wouldn't have caught this
4. **v1.4.3 should be yanked from NPM** - It's completely broken

## Commands to Start Next Session

```bash
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout main
git pull
git checkout -b hotfix/v1.4.4-critical-fixes

# Check current state
npm list -g @dollhousemcp/mcp-server  # Should show 1.4.3
ls -la ~/.dollhouse/portfolio/        # May have singular directories
```

## Priority

This is **CRITICAL** - v1.4.3 is completely unusable and users are stuck. v1.4.4 must ship immediately with these fixes.

## IMPORTANT: Don't Get Sidetracked!

### Focus ONLY on these two fixes:
1. **Migration timing** - Must run BEFORE directory access
2. **jsdom crash** - Must lazy load with error handling

### DO NOT:
- Try to refactor the entire initialization system
- Add new features
- Fix unrelated issues
- Optimize performance
- Clean up code style

### The goal is a MINIMAL fix that:
- Makes v1.4.3 users able to use the product again
- Prevents the jsdom crash
- Ships TODAY

## Testing Checklist

After implementing fixes, test these EXACT scenarios:

1. **User with broken v1.4.2 installation**:
   ```bash
   # They have singular directories from v1.4.2
   ls ~/.dollhouse/portfolio/
   # Should show: agent/ ensemble/ memory/ persona/ skill/ template/
   
   # After updating to v1.4.4
   npm update -g @dollhousemcp/mcp-server
   
   # Should migrate to plural directories automatically
   ```

2. **Fresh install test**:
   ```bash
   # Remove everything
   npm uninstall -g @dollhousemcp/mcp-server
   rm -rf ~/.dollhouse
   
   # Fresh install
   npm install -g @dollhousemcp/mcp-server
   
   # Should create plural directories from the start
   ```

3. **Claude Desktop test**:
   - Open Claude Desktop
   - DollhouseMCP should connect without errors
   - Should be able to list personas

## Code Locations Reference

**File: src/index.ts**
- Line 80: Where directories are created too early
- Line 112: Where UpdateManager triggers jsdom crash
- Line 125-157: initializePortfolio() method that needs to move up

**File: src/update/UpdateChecker.ts**
- Lines 22-23: Module-level imports that need to be removed
- Lines 107-111: jsdom initialization that crashes

**File: src/portfolio/PortfolioManager.ts**
- getElementDir() method: Consider adding createIfMissing parameter

## Remember

This is an EMERGENCY HOTFIX. Keep it simple, focused, and ship it fast. Users are completely blocked and every hour counts.

---
*Session ended with clear understanding of the problems and solutions. Next session: implement the fixes!*
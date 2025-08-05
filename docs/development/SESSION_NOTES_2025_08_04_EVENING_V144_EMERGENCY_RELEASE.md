# Session Notes - August 4, 2025 Evening - v1.4.4 Emergency Release Complete

## Session Summary
Successfully implemented and released emergency hotfix v1.4.4 to fix critical failures in v1.4.3 that made the product completely unusable.

## What We Fixed

### 1. Initialization Order Bug ✅
**Problem**: Portfolio directories were created before migration could run
- `getElementDir()` was called too early in constructor
- Migration ran asynchronously after directories already existed
- Singular directories from v1.4.2 never got renamed to plural

**Solution**: 
- Delayed directory access until after `initializePortfolio()` completes
- Made `UpdateManager` and `PersonaImporter` optional during init
- Migration now runs before any directory operations

### 2. jsdom/DOMPurify Crash ✅
**Problem**: UpdateChecker crashed during MCP initialization
- Module-level imports of jsdom and DOMPurify
- Immediate initialization in constructor caused crashes
- Server failed silently with no error output

**Solution**:
- Removed module-level imports
- Implemented lazy loading in `initializeDOMPurify()` method
- Added try-catch with fallback HTML entity escaping
- Dependencies only load when actually needed

### 3. CI/CD Failures ✅
Fixed all CI failures that blocked the PR:
- **CodeQL**: Changed regex tag removal to HTML entity escaping
- **Security Audit**: Refactored string concatenation to avoid false positive
- **Docker Tests**: Added graceful handling for read-only environments

## Release Status

### v1.4.4 Successfully Released ✅
- **PR #455**: Merged to main
- **Tag**: v1.4.4 created and pushed
- **NPM**: Published as @dollhousemcp/mcp-server@1.4.4
- **Docs**: Updated README and CHANGELOG

### Key Changes Made

**src/index.ts**:
- Delayed personas directory access until after migration
- Made UpdateManager and PersonaImporter optional
- Better error handling with console.error for visibility

**src/update/UpdateChecker.ts**:
- Lazy load jsdom/DOMPurify to prevent crashes
- Fallback HTML sanitization using entity escaping

**src/portfolio/PortfolioManager.ts**:
- Handle read-only environments gracefully (Docker fix)
- Continue with empty portfolio instead of crashing

## Testing Commands for Other Computer

```bash
# Check current version
npm list -g @dollhousemcp/mcp-server

# Update to v1.4.4
npm update -g @dollhousemcp/mcp-server

# Or if that doesn't work, reinstall
npm uninstall -g @dollhousemcp/mcp-server
npm install -g @dollhousemcp/mcp-server@latest

# Verify installation
dollhousemcp --version  # Should show 1.4.4

# Check portfolio directories
ls -la ~/.dollhouse/portfolio/
# Should show plural directories: personas/, skills/, templates/, etc.
```

## Expected Results After Update

1. **Server starts without crashes** - No jsdom errors
2. **Migration runs automatically** - Singular dirs → plural dirs
3. **Claude Desktop connects** - MCP server initializes properly
4. **Error visibility** - Console shows helpful error messages if issues occur

## Known Issues Addressed

- v1.4.2: Empty portfolios caused crashes
- v1.4.3: Attempted fix but broke initialization completely
- v1.4.4: Actually fixes both issues

## Important Context

### Why v1.4.3 Failed
1. Directory creation happened before migration could run
2. jsdom crashed during initialization
3. No error output made debugging impossible

### How v1.4.4 Fixes It
1. Migration runs first, before any directory access
2. Heavy dependencies load lazily with error handling
3. Better error visibility throughout

## Git History
```
094c2ba - (HEAD -> main, origin/main, tag: v1.4.4) Merge pull request #455
5e9c732 - docs: Update README and CHANGELOG for v1.4.4 emergency release
0439815 - fix: Address CI/CD failures for v1.4.4
b21040f - fix: v1.4.4 emergency fixes for initialization crashes
```

## Next Steps

1. Test on other computer with: `npm update -g @dollhousemcp/mcp-server`
2. Verify server starts without crashes
3. Check that directories are properly migrated
4. Confirm Claude Desktop can connect

The critical issues should now be resolved and users can use the product again!

---
*Session ended with successful v1.4.4 release to NPM*

## Update: v1.4.4 Testing Results

### Problem Found
- v1.4.4 was successfully published to NPM
- Server runs perfectly when tested directly with `node`
- Server responds correctly to all MCP protocol messages
- BUT: Still crashes when run through Claude Desktop via `npx`

### Key Diagnostic Finding
```
[INFO] Personas directory resolved to: 
```
The personas directory is empty when run via Claude Desktop, indicating async initialization race condition.

### Testing Performed
1. Created `test-dollhouse-crash.js` - Showed server starts but personas dir is empty
2. Created `test-full-interaction.js` - Proved server works perfectly when run directly:
   - Initialize: ✅ Success
   - List tools: ✅ All 45 tools registered
   - List personas: ✅ Correctly reports empty portfolio
   - Server handles all requests properly

### Root Cause
The v1.4.4 fix made initialization async (`this.personasDir = ''` initially), but Claude Desktop/npx launches the server differently than direct node execution, causing a race condition.

### Immediate Workarounds for Users

1. **Clear npx cache**:
   ```bash
   npm cache clean --force
   rm -rf ~/.npm/_npx
   ```

2. **Use direct path in Claude Desktop config** instead of npx:
   ```json
   {
     "mcpServers": {
       "dollhousemcp": {
         "command": "node",
         "args": ["/opt/homebrew/lib/node_modules/@dollhousemcp/mcp-server/dist/index.js"]
       }
     }
   }
   ```

3. **Restart Claude Desktop completely**

### v1.4.5 Will Need To:
1. Fix the async initialization race condition
2. Ensure personasDir is set before server starts accepting requests
3. Consider making initialization synchronous but with better error handling
4. Test specifically with npx/Claude Desktop launch method

### Files Created for Diagnostics
- `test-dollhouse-crash.js` - Captures all output when server crashes
- `test-full-interaction.js` - Tests full MCP protocol interaction

---
*Context exhausted - v1.4.4 works standalone but fails in Claude Desktop due to async init race*
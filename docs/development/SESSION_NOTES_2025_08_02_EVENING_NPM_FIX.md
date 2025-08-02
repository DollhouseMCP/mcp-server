# Session Notes - August 2, 2025 Evening - NPM Installation Fix v1.4.1

## Session Overview
**Date**: August 2, 2025 (Evening - 6:00 PM)  
**Branch**: `hotfix/v1.4.1-npm-installation-fix`  
**Focus**: Fixing npm installation failures discovered after v1.4.0 release  
**Issue**: #437  

## Problem Discovered

User reported that after installing v1.4.0 from npm (`npm install -g @dollhousemcp/mcp-server`), the server fails in Claude Desktop with errors:

1. **Update Check Error**:
```
❌ **Update Check Failed**
Error: Could not find package.json in current directory or any parent directory
```

2. **Server Crash**:
```
Server transport closed unexpectedly, this is likely due to the process exiting early.
```

## Root Causes Identified

1. **VersionManager uses `process.cwd()`** - Looks for package.json starting from current working directory instead of the installed module location
2. **Update system assumes git installation** - Tries to run git commands on npm-installed packages
3. **No way to detect installation type** - System doesn't know if it's running from npm or git

## Work Completed This Session

### 1. Created Comprehensive GitHub Issue ✅
- Issue #437 with full implementation plan
- All technical details preserved for continuing work
- Checklist of all tasks needed

### 2. GitFlow Setup ✅
- Synced main and develop branches
- Pushed develop updates to origin
- Created hotfix branch: `hotfix/v1.4.1-npm-installation-fix`
- Committed as: 86c36b0

### 3. Version Generation Script ✅
Created `scripts/generate-version.js`:
- Generates `src/generated/version.ts` at build time
- Embeds version, timestamp, and build type
- Added to `.gitignore` to exclude generated files
- Updated `package.json` with `prebuild` and `prepublishOnly` scripts

### 4. Installation Detector ✅
Created `src/utils/installation.ts`:
- `InstallationDetector` class to identify npm vs git installations
- Checks for node_modules path (npm) or .git directory (git)
- Provides helper methods to get installation paths
- Caches result for performance

### 5. Version Manager Fix ✅
Updated `src/update/VersionManager.ts`:
- First tries embedded version from generated file
- Then uses InstallationDetector to find package.json appropriately
- For npm: looks relative to module location using import.meta.url
- For git: searches from current file location
- Falls back to original behavior as last resort

### 6. Update Manager (Started) 🔄
Started updating `src/update/UpdateManager.ts`:
- Added installation type detection
- Started implementing separate npm update flow
- **NEEDS COMPLETION**: `updateNpmInstallation()` method

## What Still Needs to Be Done

### 1. Complete UpdateManager Implementation
- Finish `updateNpmInstallation()` method
- Use `npm view @dollhousemcp/mcp-server version` for latest version
- Run `npm update -g @dollhousemcp/mcp-server` for updates
- Handle npm-specific error messages

### 2. NPM Backup System
- Implement backup for npm installations in `~/.dollhouse/backups/npm/`
- Create manifest to track installed versions
- Allow rollback by restoring from backup

### 3. Migration Tool
- Create new MCP tool: `convert_to_git_installation`
- Clone repo to `~/.dollhouse/mcp-server-git/`
- Migrate portfolio and settings
- Provide instructions for updating Claude config

### 4. Testing
- Test with `npm link` to simulate global install
- Verify all MCP tools work
- Test update flows for both installation types
- Test migration from npm to git

### 5. Documentation
- Create `docs/INSTALLATION_METHODS.md`
- Update README.md
- Add troubleshooting section

### 6. Complete Release
- Finish all implementation
- Test thoroughly
- Create PR to develop
- Merge to main
- Tag v1.4.1
- Publish to npm

## Key Code References

### Version Generation (package.json)
```json
"scripts": {
  "prebuild": "node scripts/generate-version.js",
  "build": "tsc",
  "prepublishOnly": "BUILD_TYPE=npm npm run build"
}
```

### Installation Detection Pattern
```typescript
if (currentDir.includes('node_modules/@dollhousemcp/mcp-server')) {
  return 'npm';
}
```

### Version Manager Pattern
```typescript
// Try embedded version first
const { PACKAGE_VERSION } = await import('../generated/version.js');
// Then use installation-specific search
```

## Next Session Quick Start

1. **Get on branch**:
```bash
git checkout hotfix/v1.4.1-npm-installation-fix
git pull
```

2. **Check Issue #437** for full plan

3. **Continue with UpdateManager**:
- Implement `updateNpmInstallation()` method
- Add npm-specific update logic

4. **Key files to work on**:
- `src/update/UpdateManager.ts` - Complete npm update logic
- `src/update/BackupManager.ts` - Add npm backup support
- `src/server/tools/UpdateTools.ts` - Add migration tool

## Important Context

- User prefers seamless experience between npm and git installations
- Both should support updates through MCP tools in Claude
- Migration path from npm to git is important
- Clear documentation needed for both installation types

## Session ended due to context limits

---
*Continue from Issue #437 which has complete implementation details*
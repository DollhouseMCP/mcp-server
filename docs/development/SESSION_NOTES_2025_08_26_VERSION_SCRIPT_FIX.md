# Session Notes - August 26, 2025 - Version Script Fix Required

**Time**: Evening session after release 1.6.6 issues  
**Branch**: `fix/version-update-script`  
**Context**: Version update script (PR #760) has critical bugs preventing releases  
**Remaining Context**: ~5%

## Executive Summary

The intelligent version update script introduced in PR #760 has both security vulnerabilities (identified but ignored in review) and functional bugs (not caught in review) that make it unusable for releases. It created incorrect files during the 1.6.7 release attempt, causing immediate CI failures.

## Critical Issues Found

### 1. Wrong Version File Path ❌ BLOCKING
**Location**: `scripts/update-version.mjs` lines 114-124
```javascript
{
  name: 'src/constants/version.ts',  // WRONG PATH
  createIfMissing: true,              // CREATES WRONG FILE
  ...
}
```
**Problem**: 
- Creates `src/constants/version.ts` which doesn't exist in project structure
- Actual version file is `src/generated/version.ts` created by `scripts/generate-version.js` at build time
- The `createIfMissing: true` causes it to create this incorrect file
- **Impact**: Immediate CI failures, blocks all releases

### 2. package-lock.json Pattern Too Broad ❌ CRITICAL  
**Location**: lines 74-80
```javascript
{
  name: 'package-lock.json',
  pattern: /"version":\s*"[^"]+"/,
  multiple: true, // Updates ALL version fields!
}
```
**Problem**:
- Replaces ALL `"version": "x.x.x"` occurrences in package-lock.json
- package-lock.json contains version fields for EVERY dependency (hundreds)
- Would corrupt the entire dependency tree
- **Impact**: Broken dependencies, security vulnerabilities

### 3. Security: Path Traversal Vulnerability ⚠️ HIGH
**Location**: lines 148, 242-244
```javascript
const fullPath = path.join(path.dirname(__dirname), filePath);
```
**Problem**: No validation that paths stay within project boundary
**Already Identified**: In PR #760 review but ignored

### 4. Security: No Input Sanitization ⚠️ MEDIUM
**Location**: line 31
```javascript
const releaseNotes = notesIndex !== -1 && args[notesIndex + 1] ? args[notesIndex + 1] : '';
```
**Problem**: No length limit or content validation
**Already Identified**: In PR #760 review but ignored

### 5. README Pattern Too Aggressive 🔄 MEDIUM
**Location**: lines 89-95  
**Problem**: Matches version numbers in code examples, URLs, etc.
**Impact**: Could break documentation examples

### 6. CHANGELOG Duplicate Entry Risk 🔄 LOW
**Location**: lines 106-111
**Problem**: Doesn't check if version already exists
**Impact**: Duplicate entries if run multiple times

## Required Fixes

### Fix 1: Remove or Fix Version File Entry
```javascript
// REMOVE THIS ENTIRE BLOCK (lines 114-124)
{
  name: 'src/constants/version.ts',
  ...
}
// The version file is auto-generated at build time
```

### Fix 2: Fix package-lock.json Pattern
```javascript
{
  name: 'package-lock.json',
  updates: [
    {
      // Only update the root package version, not dependencies
      pattern: /("name":\s*"@dollhousemcp\/mcp-server",[\s\S]*?"version":\s*")[^"]+"/,
      replacement: `$1${newVersion}"`,
      once: true  // Only first occurrence
    }
  ],
  required: true
}
```

### Fix 3: Add Path Validation
```javascript
function validateFilePath(filePath, basePath) {
  const normalizedPath = path.normalize(filePath);
  
  // Check for path traversal attempts
  if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  
  const resolved = path.resolve(basePath, normalizedPath);
  const resolvedBase = path.resolve(basePath);
  
  // Ensure the resolved path is within the base path
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  
  return resolved;
}
```

### Fix 4: Add Input Validation
```javascript
// Add after line 31
if (releaseNotes.length > 1000) {
  console.error('❌ Release notes too long (max 1000 characters)');
  process.exit(1);
}
```

### Fix 5: Check for Existing Version in CHANGELOG
```javascript
{
  name: 'CHANGELOG.md',
  updates: [
    {
      pattern: /(# Changelog\n+)/,
      replacement: (match, p1) => {
        // Check if version already exists
        const changelogContent = fs.readFileSync(
          path.join(path.dirname(__dirname), 'CHANGELOG.md'), 
          'utf-8'
        );
        if (changelogContent.includes(`## [${newVersion}]`)) {
          return match; // Don't add duplicate
        }
        return `${p1}## [${newVersion}] - ${new Date().toISOString().split('T')[0]}...`;
      },
      once: true
    }
  ]
}
```

## Testing Requirements

After fixes, test with:
```bash
# Test dry run first
npm run version:bump -- 1.6.7 --dry-run

# Check what would be changed
git status
git diff

# Verify no src/constants/version.ts created
ls -la src/constants/  # Should not exist

# Verify package-lock.json only updates main package
grep -A2 "@dollhousemcp/mcp-server" package-lock.json
```

## Historical Context

### PR #760 Review Issues
- Claude identified security issues and requested changes
- Security issues were documented but PR was merged anyway
- Functional bugs weren't caught because reviewer lacked project context
- No tests were added with the script

### Release 1.6.7 Failure
1. Script created `src/constants/version.ts`
2. CI immediately failed
3. PR #775 had to be closed
4. Release branch deleted and reverted

## Lessons Learned

1. **Always test version scripts with --dry-run first**
2. **Check created/modified files match project structure**
3. **Don't ignore security review feedback**
4. **Add tests for build/release scripts**
5. **Version scripts need deep knowledge of project structure**

## Next Steps

1. Apply all fixes listed above in `fix/version-update-script` branch
2. Test thoroughly with --dry-run
3. Add unit tests for the script
4. Create PR with fixes
5. Only then attempt release 1.6.7

## Files to Modify

- `scripts/update-version.mjs` - Apply all fixes above
- Consider adding `scripts/update-version.test.js` for testing

---

*Session ended at ~5% context due to multiple failed release attempts*
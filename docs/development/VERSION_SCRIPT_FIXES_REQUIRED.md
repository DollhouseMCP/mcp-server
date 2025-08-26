# Version Script Critical Fixes Required

## ⚠️ BLOCKING ISSUES - Must Fix Before Any Release

### Issue 1: Wrong Version File Path
**File**: `scripts/update-version.mjs`  
**Lines**: 114-124  
**Current Code**:
```javascript
{
  name: 'src/constants/version.ts',
  pattern: /export const VERSION = "[^"]+"/,
  replacement: `export const VERSION = "${newVersion}"`,
  createIfMissing: true,
  defaultContent: `// Auto-generated version constant...`,
  optional: true
}
```

**FIX**: Remove this entire configuration block. The project uses `src/generated/version.ts` which is auto-generated at build time by `scripts/generate-version.js`.

---

### Issue 2: package-lock.json Corrupts All Dependencies
**Lines**: 74-80  
**Current Code**:
```javascript
{
  name: 'package-lock.json',
  pattern: /"version":\s*"[^"]+"/,
  replacement: `"version": "${newVersion}"`,
  multiple: true, // THIS IS THE PROBLEM
  required: true
}
```

**THE BUG**: This replaces EVERY version field in package-lock.json, including all dependencies!

**FIX**:
```javascript
{
  name: 'package-lock.json',
  updates: [
    {
      // Only update root package version in first occurrence after package name
      pattern: /("name":\s*"@dollhousemcp\/mcp-server",[\s\S]*?"version":\s*")[^"]+"/,
      replacement: `$1${newVersion}"`,
      once: true
    },
    {
      // Update packages section
      pattern: /("packages":\s*{[\s\S]*?"@dollhousemcp\/mcp-server":\s*{[\s\S]*?"version":\s*")[^"]+"/,
      replacement: `$1${newVersion}"`,
      once: true
    }
  ],
  required: true
}
```

---

### Issue 3: Path Traversal Security Vulnerability
**Lines**: Missing validation throughout  
**FIX**: Add this function and use it:
```javascript
function validateFilePath(filePath, basePath) {
  const normalizedPath = path.normalize(filePath);
  
  if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  
  const resolved = path.resolve(basePath, normalizedPath);
  const resolvedBase = path.resolve(basePath);
  
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  
  return resolved;
}
```

Then update line 182:
```javascript
// OLD: const fullPath = path.join(path.dirname(__dirname), filePath);
// NEW:
const basePath = path.dirname(__dirname);
const fullPath = validateFilePath(filePath, basePath);
```

---

### Issue 4: No Release Notes Validation
**Line**: 31  
**Current Code**:
```javascript
const releaseNotes = notesIndex !== -1 && args[notesIndex + 1] ? args[notesIndex + 1] : '';
```

**FIX**: Add after line 31:
```javascript
// Security: Validate release notes length to prevent injection attacks
if (releaseNotes.length > 1000) {
  console.error('❌ Release notes too long (max 1000 characters)');
  process.exit(1);
}
```

---

### Issue 5: CHANGELOG Can Create Duplicates
**Lines**: 106-111  
**FIX**: Check if version exists before adding:
```javascript
{
  name: 'CHANGELOG.md',
  updates: [
    {
      pattern: /(# Changelog\n+)/,
      replacement: (match, p1, offset, string) => {
        // Check if version already exists
        if (string.includes(`## [${newVersion}]`)) {
          console.log('  ⏭️  Version already exists in CHANGELOG.md');
          return match; // Don't add duplicate
        }
        return `${p1}## [${newVersion}] - ${new Date().toISOString().split('T')[0]}${releaseNotes ? `\n\n${releaseNotes}` : '\n\n- Version bump'}\n\n`;
      },
      once: true
    }
  ]
}
```

---

## Quick Test Commands

After making fixes, test with:

```bash
# Dry run test
npm run version:bump -- 1.6.7 --dry-run --notes "Test release"

# Check for bad file creation
ls -la src/constants/  # Should NOT exist

# Check package-lock.json would be correct
git diff package-lock.json | head -50  # Should only show root package version

# Verify no path traversal
npm run version:bump -- ../../etc/passwd --dry-run  # Should error
```

## Why These Bugs Happened

1. **src/constants/version.ts** - Script author didn't know project uses `src/generated/`
2. **package-lock.json** - Didn't understand npm lockfile structure
3. **Security issues** - Were identified in PR #760 review but ignored
4. **No tests** - Script has zero test coverage

## DO NOT USE SCRIPT UNTIL FIXED

The script in its current state will:
- ❌ Create wrong files that break CI
- ❌ Corrupt package-lock.json 
- ❌ Potentially allow path traversal attacks
- ❌ Create duplicate CHANGELOG entries

---

*Document created: August 26, 2025*  
*Branch for fixes: `fix/version-update-script`*
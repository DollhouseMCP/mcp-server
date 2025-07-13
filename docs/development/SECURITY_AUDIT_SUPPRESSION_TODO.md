# Security Audit Suppression - TODO for Next Session

## Current Status
- **Branch**: `fix-security-audit-suppressions`
- **Problem**: Security audit showing 68 false positive findings
- **Solution Started**: Created suppressions.ts but it's NOT working yet

## What Needs to Be Done

### 1. Fix the Suppression Implementation
The suppression file was created but isn't being loaded properly. Need to:

1. **Build and check for errors**:
   ```bash
   npm run build
   ```

2. **Debug why suppressions aren't working**:
   - Check if `shouldSuppress` is being called
   - Verify import path is correct
   - Test the pattern matching logic

3. **Possible issues**:
   - Import path might be wrong
   - Pattern matching might not work with actual file paths
   - Need to handle relative vs absolute paths

### 2. Test Suppression Patterns
Current patterns that need testing:
- `src/types/*.ts` - Should match type files
- `**/*.test.ts` - Should match test files
- `src/update/UpdateManager.ts` - Should match specific file

### 3. Files That Need Attention
- `src/security/audit/SecurityAuditor.ts` - Already modified to use suppressions
- `src/security/audit/config/suppressions.ts` - Main suppression config (created)
- `scripts/run-security-audit.ts` - May need to update how it loads config

### 4. Expected Outcome
After fixes, running `npm run security:audit` should show:
- 0 Critical (down from 2)
- 2-3 High (down from 6) 
- 5-10 Medium (down from 31)
- 5-10 Low (down from 29)

### 5. Create PR Once Fixed
```bash
git add -A
git commit -m "fix: Add comprehensive security audit suppressions

- Suppress false positive SQL injection findings
- Suppress Unicode warnings on type definition files
- Suppress audit logging warnings on non-security files
- Reduce findings from 68 to ~15 legitimate issues"

git push -u origin fix-security-audit-suppressions
gh pr create --title "Fix security audit false positives" \
  --body "Implements comprehensive suppression configuration to eliminate false positives while keeping legitimate security findings visible."
```

## Key False Positives to Suppress

1. **SQL Injection (CWE-89-001)**:
   - UpdateManager.ts:61,69 - "Update Failed" messages

2. **Unicode (DMCP-SEC-004)**:
   - All files in src/types/
   - All files in src/errors/
   - All files in src/config/
   - Test files

3. **YAML (DMCP-SEC-005)**:
   - yamlValidator.ts
   - secureYamlParser.ts

4. **Audit Logging (DMCP-SEC-006)**:
   - Type definitions
   - Configuration files
   - Build scripts

## Debug Commands
```bash
# See all findings
npm run security:audit -- --verbose

# Check specific file
npm run security:audit 2>&1 | grep "UpdateManager"

# Count by rule
npm run security:audit 2>&1 | grep -E "^  🔴|^  🟠|^  🟡|^  🔵" | cut -d: -f1 | sort | uniq -c
```
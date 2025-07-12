# Security Audit Quick Start - Next Session

## 🎯 Immediate Actions (First 30 Minutes)

### 1. Check PR Status
```bash
gh pr view 250
gh pr checks 250
```

### 2. Switch to Branch
```bash
git checkout implement-security-audit-automation-53
git pull
```

### 3. Fix Regex Patterns
These patterns need fixing in `src/security/audit/rules/SecurityRules.ts`:

#### Hardcoded Secrets (Line ~19)
Current: `/(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'][a-zA-Z0-9+/=]{16,}["']/gi`
Issue: Not matching test case `const apiKey = "sk-1234567890abcdef1234567890abcdef";`

#### SQL Injection (Line ~29)
Current: `/(?:query|execute)\s*\(\s*['"`].*\$\{[^}]+\}.*['"`]|['"`].*\+\s*[a-zA-Z_]\w*\s*\+.*['"`]\s*\)/g`
Issue: Not matching `const query = "SELECT * FROM users WHERE id = " + userId;`

#### Command Injection (Line ~38)
Current: `/(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\$\{[^}]+\}|(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\+\s*[a-zA-Z_]\w*/g`
Issue: Not matching `exec('ls ' + userInput);`

### 4. Run Tests
```bash
npm test -- __tests__/unit/security/audit/SecurityAuditor.test.ts
```

### 5. Debug Specific Failing Tests
Focus on these test cases:
- "should detect hardcoded secrets"
- "should detect SQL injection"
- "should detect command injection"
- "should detect missing rate limiting"
- "should detect missing Unicode validation"

## 🔧 Technical Fixes Needed

### Fix 1: Regex Pattern Adjustments
The patterns are too specific. Simplify them:

```typescript
// Hardcoded secrets - make it catch the test case
pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][a-zA-Z0-9+/=_-]{10,}["']/gi

// SQL injection - catch string concatenation
pattern: /(?:SELECT|INSERT|UPDATE|DELETE).*["']\s*\+\s*\w+/gi

// Command injection - simpler pattern
pattern: /(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\+\s*\w+/g
```

### Fix 2: File Counting
In `SecurityAuditor.ts` around line 98, improve file counting:
```typescript
// Track unique files scanned
const scannedFilesSet = new Set<string>();
// In scanner loop, add: scannedFilesSet.add(finding.file);
// After loop: scannedFiles = scannedFilesSet.size;
```

### Fix 3: DollhouseMCP Rule Improvements
The custom rules use complex checks. Simplify or fix:
- Rate limiting detection
- Unicode validation detection

## 📝 Test Verification Checklist

After fixes, these should all pass:
- [ ] Basic functionality tests (2/2)
- [ ] Vulnerability detection tests (4/4)
- [ ] DollhouseMCP specific tests (2/2)
- [ ] Suppression rules test (1/1)
- [ ] Build failure logic tests (2/2)
- [ ] Performance test (1/1)

## 🚀 Once Tests Pass

### 1. Commit Fixes
```bash
git add -A
git commit -m "Fix regex patterns and test failures in Security Audit implementation

- Fixed hardcoded secrets detection pattern
- Fixed SQL injection detection pattern  
- Fixed command injection detection pattern
- Improved file counting logic
- All 12 tests now passing"
git push
```

### 2. Check PR CI
```bash
gh pr checks 250 --watch
```

### 3. If CI Passes
The PR should be ready for review and merge!

## 🎯 Success Criteria
- ✅ All 12 tests passing locally
- ✅ CI/CD checks passing
- ✅ Claude review completes successfully
- ✅ No TypeScript errors
- ✅ Security audit actually detects vulnerabilities

## 💡 Quick Debug Tips

### If a test fails:
1. Run just that test: `npm test -- -t "should detect hardcoded secrets"`
2. Add console.log in the rule to see if pattern matches
3. Test the regex in a tool like regex101.com
4. Check the actual file content being scanned

### If CI fails:
1. Check the logs: `gh run view <run-id>`
2. Look for TypeScript errors first
3. Check if all imports are correct
4. Ensure no missing dependencies

## 🏁 End Goal
**PR #250 merged = 100% security coverage achieved!**

This completes our security journey:
- ✅ Input validation
- ✅ Processing security  
- ✅ Access control
- ✅ Monitoring & audit ← This PR

---

**Estimated Time**: 1-2 hours to complete everything and get PR #250 ready for merge.
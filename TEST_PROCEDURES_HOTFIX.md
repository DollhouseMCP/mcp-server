# Hotfix Test Procedures - v1.7.3 Fixes

## Pre-Test Setup

### 1. Enable dollhousemcp-sync-test in Claude Desktop
### 2. Restart Claude Desktop
### 3. Verify Build Info

```
Get build info for DollhouseMCP
```

---

## Test 1: Template Variable Interpolation (Issue #914)

### Step 1.1 - List Templates

```
List all templates
```

### Step 1.2 - Render Test Template

```
Render the template "test-template" with these variables:
- test_name: "Hotfix Verification"
- test_date: "2025-09-10"
- tester_name: "Mick Darling"
```

**Expected Output:**
```
# Hotfix Verification - Test Report

Test Date: 2025-09-10
Tester: Mick Darling

This template verifies that variable interpolation is working correctly.
```

**Bug if NOT Fixed:** Shows literal `{{test_name}}`, `{{test_date}}`, `{{tester_name}}`

---

## Test 2: sync_portfolio Upload (Issue #913)

### Step 2.1 - Check GitHub Auth

```
Check my GitHub authentication status
```

### Step 2.2 - Create Test Skill

```
Create a skill called "hotfix-test-skill" with description "A test skill to verify sync_portfolio upload works"
```

### Step 2.3 - Test sync_portfolio Upload

```
Use sync_portfolio to upload element "hotfix-test-skill" of type "skills" with operation "upload" and force option true
```

**Expected Output:** GitHub commit URL like `https://github.com/mickdarling/dollhouse-portfolio/commit/...`

**Bug if NOT Fixed:** Error `[PORTFOLIO_SYNC_004] GitHub API returned null response`

---

## Test 3: Verify submit_content Still Works

### Step 3.1 - Test submit_content

```
Submit content "test-template" to my portfolio
```

**Expected:** Should work as before (returns GitHub URL)

---

## Test 4: Error Handling Verification

### Step 4.1 - Non-existent Template

```
Render template "this-does-not-exist" with variables test: "value"
```

**Expected:** Clean error message "Template 'this-does-not-exist' not found"

### Step 4.2 - Non-existent Element Upload

```
Use sync_portfolio to upload element "non-existent-element" of type "personas" with operation "upload"
```

**Expected:** Error "Element 'non-existent-element' (personas) not found locally"

---

## Success Checklist

- [ ] Template variables are replaced with actual values
- [ ] sync_portfolio returns GitHub URL without null error
- [ ] submit_content still works 
- [ ] Clean error messages for invalid inputs
- [ ] Verbose logging visible in console

---

## Results Recording

### Test 1 Result:
```
[ ] PASS / [ ] FAIL
Notes: 
```

### Test 2 Result:
```
[ ] PASS / [ ] FAIL
Notes:
```

### Test 3 Result:
```
[ ] PASS / [ ] FAIL
Notes:
```

### Test 4 Result:
```
[ ] PASS / [ ] FAIL
Notes:
```

---

**Testing Date:** September 10, 2025  
**Branch:** hotfix/portfolio-sync-template-fixes  
**Version:** 1.7.3 (with fixes)
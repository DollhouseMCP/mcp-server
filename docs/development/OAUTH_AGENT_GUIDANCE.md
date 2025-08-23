# OAuth Fix Agent Guidance - Critical Instructions

**Created**: August 23, 2025  
**Purpose**: Prevent agents from getting stuck and ensure efficient problem-solving

## 🚨 CRITICAL: Avoid Getting Stuck

### The 15-Minute Rule
If you've been trying the same approach for 15 minutes without progress:
1. **STOP** and document what's not working
2. **SEARCH** for existing solutions in:
   - Session notes (especially SESSION_NOTES_2025_08_22_OAUTH_TOKEN_FIX_517.md)
   - Existing test files (test/qa/oauth-auth-test.mjs)
   - PR history (especially PR #701)
3. **TRY** a different approach or workaround
4. **ESCALATE** if still blocked after 30 minutes total

### Signs You're Stuck in a Loop
- Running the same test repeatedly with same failure
- Making tiny tweaks without understanding root cause
- Trying to "force" something that clearly isn't working
- Seeing the same error message more than 5 times

## 🔄 Known Working Solutions

### OAuth Token Storage (Issue #704)
**Known Working Approach**:
```javascript
// From test/qa/oauth-auth-test.mjs - this WORKS
const tokenManager = new TokenManager();
await tokenManager.storeToken(token, 'oauth');
const retrieved = await tokenManager.getStoredToken();
```

**Common Mistake**: Trying to store in background process
**Workaround**: Store synchronously in main process after polling completes

### Parameter Parsing (Issue #705)
**Known Working Approach**:
```javascript
// Properly serialize complex objects
const params = JSON.stringify(complexObject);
const parsed = JSON.parse(params);
```

**Common Mistake**: Passing objects directly to MCP tools
**Workaround**: Always stringify/parse at tool boundaries

### Unicode Validation (Issue #706)
**Known Working Approach**:
```javascript
// From existing code that works
if (validator.isValid) {
  // Use the normalized content, not original
  return validator.normalizedContent;
}
```

**Common Mistake**: Using original string after validation
**Workaround**: Always use the normalized output

## 🖱️ Human Interaction Required - CRITICAL

### OAuth Device Flow Process (Issue #704)

**THIS REQUIRES HUMAN INTERACTION - DO NOT AUTOMATE**

The GitHub OAuth device flow works like this:
1. System requests device code from GitHub
2. GitHub returns:
   - `user_code`: 8-character code (like `F6F7-37B6`)
   - `verification_uri`: https://github.com/login/device
3. **HUMAN MUST**:
   - Open browser to verification_uri
   - Enter the 8-character code
   - Click authorize
4. System polls for completion

### When to Break Out of Agent Mode

**STOP AGENT WORK and return to orchestrator when**:
- You need to test OAuth device flow authorization
- You see "Please visit https://github.com/login/device"
- You see "Enter code: XXXX-XXXX"
- Any browser interaction is required

**Tell the orchestrator**:
```
HUMAN INTERACTION REQUIRED:
- Need to test OAuth device flow
- User must visit: https://github.com/login/device
- User must enter code: [8-char code]
- Cannot be automated in agent mode
```

## 📋 Testing Guidelines

### 1. Test in Isolation First
```bash
# Test individual components before integration
npm test -- --testNamePattern="token storage" --no-coverage
npm test -- --testNamePattern="parameter parsing" --no-coverage
```

### 2. Use Existing QA Tests
```bash
# These are known to work (94% pass rate)
npm run test:qa:oauth
```

### 3. Mock External Dependencies
```javascript
// Don't make real GitHub API calls in unit tests
jest.mock('src/auth/GitHubAuthManager');
const mockAuth = {
  deviceFlow: jest.fn().mockResolvedValue({
    device_code: 'test_device',
    user_code: 'TEST-CODE',
    verification_uri: 'https://github.com/login/device'
  })
};
```

### 4. Check Session Notes for Context
The session notes contain WORKING examples:
- How OAuth was successfully tested
- What errors were encountered and fixed
- Specific workarounds that worked

## 🔍 Where to Look for Solutions

### For Token Persistence (#704)
1. `test/qa/oauth-auth-test.mjs` - Working token storage
2. `src/security/tokenManager.ts` - Current implementation
3. PR #701 - How token validation was fixed

### For Parameter Parsing (#705)
1. `src/server/tools/AuthTools.ts` - Working parameter handling
2. Look for `JSON.stringify` usage in existing tools
3. Check how `setup_github_auth` handles parameters

### For Unicode Issues (#706)
1. `src/utils/UnicodeValidator.ts` - Current validator
2. Search for `normalize` in codebase
3. Check PersonaElement.ts for working examples

## ⚠️ Common Pitfalls to Avoid

### 1. Token Storage
❌ **DON'T**: Try to fix the background helper process
✅ **DO**: Store tokens in main process after device flow completes

### 2. Testing OAuth Flow
❌ **DON'T**: Try to automate browser interaction
✅ **DO**: Mock the GitHub API responses for testing

### 3. Parameter Handling
❌ **DON'T**: Pass raw objects to MCP tools
✅ **DO**: Serialize to JSON strings at boundaries

### 4. Unicode Validation
❌ **DON'T**: Bypass validation to "make it work"
✅ **DO**: Use the normalized content from validator

## 🚦 Escalation Protocol

### When to Escalate
1. Blocked for >30 minutes on same issue
2. Need human interaction for testing
3. Discovered issue affects multiple components
4. Found that issue might already be fixed

### How to Escalate
```markdown
## ESCALATION NEEDED

**Issue**: #[number]
**Blocked on**: [specific problem]
**Tried**: 
- Approach 1: [result]
- Approach 2: [result]
**Need**: [human interaction/different approach/clarification]
**Suggestion**: [your recommendation]
```

## 📊 Progress Indicators

### Good Progress
- Tests start passing that were failing
- Error messages become clearer
- Can demonstrate partial functionality
- Found and using existing working code

### Stuck/Need Help
- Same error after 5+ attempts
- Tests failing in unexpected ways
- Need browser/human interaction
- Circular dependency discovered

## 🎯 Success Criteria Reminders

### Don't Over-Engineer
- Fix YOUR specific issue only
- Don't refactor unrelated code
- Use existing patterns where possible
- Prefer workarounds over perfect solutions

### Definition of Done
- Core issue resolved (not perfect)
- Tests pass (or good reason why not)
- No regression in existing features
- PR created with clear description

---

**Remember**: The goal is working OAuth for users, not perfect code. Practical workarounds are better than elegant solutions that don't work. When in doubt, check what already works in the codebase and reuse it!
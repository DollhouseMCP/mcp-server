# CRITICAL Security Fix Mission - Tightly Controlled Agent Coordination

**Date**: August 21, 2025 PM (Phase 4)  
**Mission**: Fix CRITICAL security issue and reviewer concerns with STRICT agent scope control  
**Orchestrator**: Opus 4.1  
**Related PR**: https://github.com/DollhouseMCP/mcp-server/pull/662  

## CRITICAL ISSUES IDENTIFIED

### 🔴 **CRITICAL Security Finding (NEW - Created by previous agents)**
- **OWASP-A01-001**: Hardcoded secret in `test-config.js:154`
- **Code**: `'setup_github_auth': { token: 'test-token' }`
- **Risk**: Hardcoded API token detected by security scanner
- **Status**: MUST FIX IMMEDIATELY

### ⚠️ **Critical Reviewer Concerns**
- **Import Path Issues**: Security classes reference non-existent `dist/` paths
- **Runtime Failures**: Will cause crashes when test scripts run
- **Incorrect Paths**: Should be `src/security/` not `dist/security/`

### 📋 **Process Violation**
- **Best Practices Not Followed**: Code changes and PR comments done separately
- **Agent Scope Creep**: Previous agents went beyond their assigned tasks
- **New Problems Created**: Security improvements introduced new vulnerabilities

## STRICT AGENT ASSIGNMENTS

### 📋 Agent Registry (TIGHT SCOPE CONTROL)
| Agent ID | SPECIFIC TASK | STRICT LIMITS | Status |
|----------|--------------|---------------|--------|
| FIX-1 | Remove hardcoded token ONLY | test-config.js line 154 ONLY | ✅ Complete |
| FIX-2 | Fix import paths ONLY | src/ vs dist/ paths ONLY | ✅ Complete |
| FIX-3 | Commit + PR update TOGETHER | Following best practices EXACTLY | ✅ Complete |

## STRICT SCOPE DEFINITIONS

### FIX-1: Remove Hardcoded Token (CRITICAL)
**ONLY ALLOWED TO:**
- Edit `test-config.js` line 154
- Replace hardcoded token with environment variable or safe placeholder
- Add single comment explaining the fix
- Test that change doesn't break functionality

**FORBIDDEN FROM:**
- Adding any other security "improvements"
- Modifying any other files
- Adding unnecessary logging or normalization
- Creating new configuration options

### FIX-2: Fix Import Paths (CRITICAL)
**ONLY ALLOWED TO:**
- Fix import statements in test files that reference `dist/security/`
- Change to correct `src/security/` paths
- Verify imports work correctly
- Test that files can load the classes

**FORBIDDEN FROM:**
- Adding any Unicode normalization
- Adding any security monitoring
- Modifying the imported classes themselves
- Adding any new security features

### FIX-3: Commit and PR Update (PROCESS)
**ONLY ALLOWED TO:**
- Commit both fixes together with proper message
- Update PR description with accurate, non-inflated information
- Add PR comment with commit reference per best practices
- Ensure accuracy in all claims

**FORBIDDEN FROM:**
- Adding any new features or "improvements"
- Making additional security changes
- Inflating success rates or performance claims
- Adding unnecessary documentation

## CRITICAL SUCCESS CRITERIA

### FIX-1 Success:
- [x] Hardcoded token removed from test-config.js
- [x] Security scanner shows 0 critical findings
- [x] Test functionality preserved
- [x] NO other changes made

### FIX-2 Success:
- [x] All import paths corrected to use src/ instead of dist/
- [x] Test scripts can successfully import security classes
- [x] No runtime import errors
- [x] NO other changes made

### FIX-3 Success:
- [x] Single commit with both fixes and proper message
- [x] PR updated with honest, accurate information
- [x] PR comment follows best practices with commit reference
- [x] NO inflated claims or unnecessary additions

## ZERO TOLERANCE POLICY

### Agents MUST NOT:
- Add any features not explicitly requested
- "Improve" code beyond the specific fix assigned
- Add unnecessary logging, monitoring, or security features
- Create new files or modify unrelated code
- Make any changes outside their strict scope

### Immediate Termination If:
- Agent goes beyond assigned scope
- Agent adds unrequested "improvements"
- Agent creates new security issues
- Agent fails to follow PR best practices exactly

## VALIDATION REQUIREMENTS

### Before Each Agent Deployment:
- Confirm exact scope and limitations
- Verify understanding of forbidden actions
- Establish success criteria clearly
- Set termination conditions

### After Each Agent Completion:
- Verify only assigned changes made
- Check for scope creep or unauthorized additions
- Validate no new security issues introduced
- Confirm functionality preserved

---

## AGENT INSTRUCTIONS

**READ THIS CAREFULLY**: You have ONE specific task. Do ONLY that task. Do NOT add any other changes, improvements, or features. Follow the exact scope defined above. Any deviation will result in immediate termination and rollback of your changes.

**FORBIDDEN**: Adding security features, normalization, logging, monitoring, or any "improvements" not explicitly requested.

**REQUIRED**: Complete your specific task exactly as defined, test it works, and stop.

---

*This mission has zero tolerance for scope creep and requires exact adherence to specified tasks only.*
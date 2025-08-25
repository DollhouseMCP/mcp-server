# OAuth Fix Coordination Document

**Created**: August 23, 2025  
**Purpose**: Track and coordinate the OAuth system fixes identified in SESSION_NOTES_2025_08_22_OAUTH_TOKEN_FIX_517.md  
**Goal**: Make OAuth authentication production-ready for end users

## Overview

The OAuth authentication system is technically working (PR #701 merged) but has critical UX issues that make it unusable for end users. This document coordinates the fix efforts across multiple parallel workstreams.

## Issue Breakdown

### Critical Path (Priority 1 - Sequential Dependencies)

| Issue | Title | Status | PR | Agent | Notes |
|-------|-------|--------|----|----|-------|
| #704 | Fix OAuth Token Persistence After Device Flow | 🔴 Not Started | - | - | Background helper dies without saving |
| #705 | Fix MCP Tool Parameter Parsing | 🔴 Not Started | - | - | [object Object] errors |
| #706 | Fix Unicode Validation Blocking Search | 🔴 Not Started | - | - | Portfolio search broken |

### Integration Layer (Priority 2 - Can Parallelize)

| Issue | Title | Status | PR | Agent | Notes |
|-------|-------|--------|----|----|-------|
| #707 | Add OAuth Token Status Tool | 🔴 Not Started | - | - | Check auth state |
| #708 | Fix Collection Browser Filtering | 🔴 Not Started | - | - | Returns 0 items |
| #709 | Implement Session State Management | 🔴 Not Started | - | - | Depends on #704 |

### UX Enhancements (Priority 3 - After Critical)

| Issue | Title | Status | PR | Agent | Notes |
|-------|-------|--------|----|----|-------|
| #710 | Add Clear Error Messages for Auth Failures | 🔴 Not Started | - | - | Depends on #704-706 |
| #711 | Add Workflow Prerequisites Validation | 🔴 Not Started | - | - | Depends on #707 |
| #712 | Implement Token Refresh Logic | 🔴 Not Started | - | - | Depends on #704 |

### Testing Infrastructure (Can Start Immediately)

| Issue | Title | Status | PR | Agent | Notes |
|-------|-------|--------|----|----|-------|
| #714 | Create End-to-End OAuth Workflow Test | 🔴 Not Started | - | - | Full roundtrip |
| #715 | Add MCP Inspector Integration Tests | 🔴 Not Started | - | - | External client |
| #716 | Create OAuth Debug Dashboard | 🔴 Not Started | - | - | Depends on #707 |

## Status Legend
- 🔴 Not Started
- 🟡 In Progress
- 🟢 Complete
- 🔵 In Review
- ⚫ Blocked

## Critical Evidence from Session Notes

### What's Working ✅
- OAuth device flow initiates correctly
- GitHub returns valid tokens
- Token validation patterns are flexible (PR #701)
- Authentication technically succeeds

### What's Broken ❌
1. **Token Persistence**: Background process fails to store token
2. **Parameter Parsing**: MCP tools can't handle complex objects
3. **Search System**: Unicode validation false positives
4. **Session Management**: No state between MCP calls
5. **Error Messages**: Cryptic, non-actionable feedback

## Agent Assignment Guidelines

### For Orchestrator
- Assign agents based on expertise areas
- Priority 1 issues should be done first or with dedicated agents
- Priority 2 & Testing can be parallelized
- Use this document to track progress

### For Agents
1. Pick up an unassigned issue
2. Update status to 🟡 In Progress
3. Create feature branch: `fix/oauth-{issue-number}`
4. Focus only on your specific issue
5. Create PR when complete
6. Update this doc with PR number

## Success Metrics

### Minimum Viable Fix
- [ ] User can authenticate once and token persists
- [ ] User can browse collection without errors
- [ ] User can submit content without parameter errors
- [ ] Clear error messages when things fail

### Production Ready
- [ ] All 12 issues resolved
- [ ] End-to-end test passing
- [ ] MCP Inspector validation passing
- [ ] No `[object Object]` errors
- [ ] Token refresh working

## File Reference

### Core OAuth Files
- `src/auth/GitHubAuthManager.ts` - Device flow implementation
- `src/security/tokenManager.ts` - Token storage/validation
- `src/server/tools/AuthTools.ts` - MCP authentication tools
- `src/server/tools/SubmitTools.ts` - Submission tools with auth

### Test Files
- `test/qa/oauth-auth-test.mjs` - Current QA tests
- `test/__tests__/unit/auth/` - Unit tests
- `test/e2e/` - (To be created)

## Testing Commands

```bash
# Run OAuth QA tests
npm run test:qa:oauth

# Test with MCP Inspector
npx @modelcontextprotocol/inspector dist/index.js

# Check auth status
echo '{"method":"tools/call","params":{"name":"get_github_auth_status"}}' | node dist/index.js

# Test device flow
echo '{"method":"tools/call","params":{"name":"setup_github_auth"}}' | node dist/index.js
```

## Communication

- Update this document when taking an issue
- Add PR numbers when created
- Note any blockers or dependencies discovered
- Mark complete when merged

## Rollout Plan

1. **Phase 1**: Fix critical blockers (#1-3)
2. **Phase 2**: Deploy and test basic flow
3. **Phase 3**: Add integration improvements (#4-6)
4. **Phase 4**: Polish UX (#7-9)
5. **Phase 5**: Full testing suite (#10-12)

---

*Last Updated: August 23, 2025 - All issues created (#704-#716)*  
*Session Reference: SESSION_NOTES_2025_08_22_OAUTH_TOKEN_FIX_517.md*
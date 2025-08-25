# OAuth Fix Orchestration Plan

**Created**: August 23, 2025  
**Orchestrator**: Opus 4.1  
**Purpose**: Coordinate parallel agent work on OAuth system fixes

## Execution Strategy

### Wave 1: Critical Foundation + Testing Setup (Start Immediately)
These can be worked on in parallel as they don't interfere with each other.

#### Agent 1: Token Persistence Expert
**Issue**: #704 - Fix OAuth Token Persistence  
**Branch**: `fix/oauth-token-persistence-704`  
**Priority**: CRITICAL - Blocks multiple other fixes  
**Focus**: 
- Debug why background helper process dies
- Implement reliable token storage mechanism
- Ensure tokens persist across MCP calls
**Files**: 
- `src/auth/GitHubAuthManager.ts`
- `src/security/tokenManager.ts`

#### Agent 2: Parameter Parsing Specialist  
**Issue**: #705 - Fix MCP Parameter Parsing  
**Branch**: `fix/mcp-parameter-parsing-705`  
**Priority**: CRITICAL - Blocks submission workflow  
**Focus**:
- Fix `[object Object]` serialization issues
- Ensure complex objects properly handled
- Test with real submission scenarios
**Files**:
- `src/server/tools/SubmitTools.ts`
- `src/server/tools/AuthTools.ts`

#### Agent 3: Search & Unicode Expert
**Issue**: #706 - Fix Unicode Validation  
**Branch**: `fix/unicode-validation-search-706`  
**Priority**: CRITICAL - Blocks element discovery  
**Focus**:
- Debug false positive Unicode validation
- Fix element search functionality
- Ensure all valid names searchable
**Files**:
- `src/collection/CollectionIndexManager.ts`
- `src/utils/UnicodeValidator.ts`

#### Agent 4: Test Infrastructure Builder
**Issue**: #714 - End-to-End OAuth Test  
**Branch**: `test/oauth-e2e-workflow-714`  
**Priority**: HIGH - Validates all fixes  
**Focus**:
- Create comprehensive test suite
- Mock where needed for isolation
- Document test scenarios
**Files**:
- Create `test/e2e/oauth-workflow.test.ts`
- Update test configuration

### Wave 2: Integration Layer (After Wave 1 PRs Created)
Start these once Wave 1 agents have their PRs up (don't need to wait for merge).

#### Agent 5: Auth Tools Developer
**Issue**: #707 - OAuth Status Tool  
**Branch**: `feature/oauth-status-tool-707`  
**Priority**: HIGH - Enables debugging  
**Focus**:
- Create new MCP tool for auth status
- Include token type, expiry, validity
- Add to existing AuthTools
**Files**:
- `src/server/tools/AuthTools.ts`
- Update tool registration

#### Agent 6: Collection Browser Fixer
**Issue**: #708 - Fix Collection Filtering  
**Branch**: `fix/collection-browser-filtering-708`  
**Priority**: HIGH - Independent fix  
**Focus**:
- Debug why 44 cached items return 0
- Fix filtering logic
- Test with various filter combinations
**Files**:
- `src/collection/CollectionBrowser.ts`
- Related cache/filter code

#### Agent 7: MCP Inspector Tester
**Issue**: #715 - MCP Inspector Tests  
**Branch**: `test/mcp-inspector-integration-715`  
**Priority**: MEDIUM - External validation  
**Focus**:
- Document testing procedures
- Create test scripts for Inspector
- Validate with real external client
**Files**:
- Create `test/external/mcp-inspector-tests.md`
- Create test scripts

### Wave 3: Session & UX (After #704 is in PR)
These depend on Wave 1 fixes being at least in progress.

#### Agent 8: Session Manager
**Issue**: #709 - Session State Management  
**Branch**: `feature/session-state-management-709`  
**Priority**: HIGH - Depends on #704  
**Wait For**: PR #704 to be created  
**Focus**:
- Implement session persistence
- Maintain auth across MCP calls
- Handle session lifecycle
**Files**:
- `src/server/MCPServer.ts`
- Create `src/auth/SessionManager.ts`

#### Agent 9: Error Message Improver
**Issue**: #710 - Clear Error Messages  
**Branch**: `feature/clear-error-messages-710`  
**Priority**: MEDIUM - Depends on #704-706  
**Wait For**: Wave 1 PRs created  
**Focus**:
- Replace cryptic errors with actionable messages
- Add user guidance for common issues
- Include next steps in error output
**Files**:
- All auth-related tools
- Error handling utilities

### Wave 4: Advanced Features (After Wave 1 Merged)
These should wait until critical fixes are merged.

#### Agent 10: Workflow Validator
**Issue**: #711 - Prerequisites Validation  
**Branch**: `feature/workflow-prerequisites-711`  
**Priority**: MEDIUM - Depends on #707  
**Wait For**: PR #707 created  
**Focus**:
- Check requirements before operations
- Provide clear pre-flight feedback
- Prevent doomed operations
**Files**:
- Submit and upload tools
- Workflow validation logic

#### Agent 11: Token Refresh Developer
**Issue**: #712 - Token Refresh Logic  
**Branch**: `feature/token-refresh-712`  
**Priority**: MEDIUM - Depends on #704  
**Wait For**: PR #704 merged  
**Focus**:
- Implement automatic refresh
- Handle expiration gracefully
- Maintain user session continuity
**Files**:
- `src/auth/GitHubAuthManager.ts`
- Token lifecycle management

#### Agent 12: Debug Dashboard Creator
**Issue**: #716 - OAuth Debug Dashboard  
**Branch**: `feature/oauth-debug-dashboard-716`  
**Priority**: LOW - Nice to have  
**Wait For**: PR #707 created  
**Focus**:
- Visual debugging interface
- Token state display
- Auth history tracking
**Files**:
- Create `src/debug/oauth-dashboard.ts`
- Dashboard UI components

## ⚠️ CRITICAL: Human Interaction Points

### OAuth Device Flow Testing (Issue #704)
**REQUIRES HUMAN - CANNOT BE AUTOMATED IN AGENT**

When testing OAuth device flow:
1. Agent initiates device flow request
2. **STOP AGENT** - Return to orchestrator
3. **HUMAN MUST**:
   - Visit https://github.com/login/device
   - Enter 8-character code (like `F6F7-37B6`)
   - Click authorize
4. Resume agent work after authorization

**Agent Should Report**:
```
HUMAN INTERACTION REQUIRED:
Device flow initiated
User code: XXXX-XXXX
Verification URL: https://github.com/login/device
Pausing for human authorization...
```

## Coordination Protocol

### For Each Agent:
1. **Read OAUTH_AGENT_GUIDANCE.md FIRST** - Critical instructions
2. **Claim Issue**: Comment on GitHub issue "Starting work on this"
3. **Create Branch**: Use naming convention above
4. **Update Coordination Doc**: Mark issue as 🟡 In Progress
5. **Apply 15-Minute Rule**: Don't get stuck - escalate if blocked
6. **Check Existing Solutions**: Reuse working code from session notes
7. **Focus Narrowly**: Only fix your specific issue
8. **Test Thoroughly**: Include unit tests where possible
9. **Create PR**: Reference issue number in PR title
10. **Update Status**: Mark as 🔵 In Review

### PR Naming Convention:
```
fix: [Brief description] (#issue-number)
Example: fix: OAuth token persistence after device flow (#704)
```

### Communication Points:
- **Blockers**: Report immediately to orchestrator
- **Dependencies**: Note if waiting on another PR
- **Discoveries**: Share findings that affect other issues
- **Progress**: Update coordination doc daily

## Success Metrics

### Wave 1 Success (Critical):
- [ ] Token persists after authorization
- [ ] No more `[object Object]` errors
- [ ] Element search returns results
- [ ] E2E test framework in place

### Wave 2 Success (Integration):
- [ ] Can check auth status via tool
- [ ] Collection browser returns correct items
- [ ] External client validation documented

### Wave 3 Success (Session/UX):
- [ ] Auth state maintained across calls
- [ ] Clear, actionable error messages

### Wave 4 Success (Advanced):
- [ ] Prerequisites checked before operations
- [ ] Tokens refresh automatically
- [ ] Debug dashboard available

## Risk Management

### High Risk Areas:
1. **Token Persistence (#704)**: Multiple issues depend on this
2. **Parameter Parsing (#705)**: Could affect many tools
3. **Session Management (#709)**: Architecture change needed

### Mitigation:
- Start high-risk issues first (Wave 1)
- Create comprehensive tests early
- Document discoveries for other agents
- Have backup approaches ready

## Daily Sync Points

### Morning Check-in:
- Review overnight progress
- Identify blockers
- Reassign if needed

### Evening Summary:
- PRs created today
- Issues completed
- Plan for next day

## Emergency Procedures

### If Critical Issue Blocked:
1. Alert orchestrator immediately
2. Document blocker in issue
3. Switch to next priority item
4. Consider pair debugging

### If Dependencies Change:
1. Update this plan
2. Notify affected agents
3. Adjust wave assignments

---

**Ready to Execute**: Agents can now pick up their assigned issues and begin work immediately for Wave 1.
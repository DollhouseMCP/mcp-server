# QA Framework v1.6.0 Implementation Coordination

**Date**: August 21, 2025 Evening  
**Branch**: `feature/qa-framework-v1.6.0-improvements`  
**Orchestrator**: Opus 4.1  
**Objective**: Implement critical QA improvements for v1.6.0 release  

## Mission Overview

Implement the must-have and should-have QA improvements identified from PR #662 review to establish a solid QA process for the v1.6.0 release.

## Implementation Priority Order

1. **#663** - CI/CD Integration (develop branch only)
2. **#667** - Tool validation before testing  
3. **#666** - Use centralized config file
4. **#669** - Complete deprecated tool removal
5. **#665** - Test data cleanup mechanism

## Agent Assignments

### 📋 Agent Registry
| Agent ID | Task | Issue | Status | Files to Modify |
|----------|------|-------|--------|-----------------|
| CI-1 | Add QA to CI workflows | #663 | 🔴 Not Started | `.github/workflows/core-build-test.yml` |
| TOOL-1 | Implement tool validation | #667 | 🔴 Not Started | `scripts/qa-*.js`, tool discovery |
| CONFIG-1 | Wire up config file | #666 | 🔴 Not Started | `scripts/qa-*.js` to use `test-config.js` |
| CLEANUP-1 | Remove deprecated tools | #669 | 🔴 Not Started | All QA scripts |
| DATA-1 | Test data cleanup | #665 | 🔴 Not Started | `scripts/qa-github-integration-test.js` |

Legend: 🔴 Not Started | 🟡 In Progress | 🟢 Complete | 🔵 Blocked

## Technical Context

### Current State
- QA scripts exist but have issues:
  - Hardcoded timeouts instead of using config
  - No tool validation before testing
  - Some deprecated tool references remain
  - No cleanup of test data created
- CI/CD doesn't run QA tests yet
- `test-config.js` exists but isn't used

### CI/CD Strategy (Issue #663)
Add to existing workflows with develop-only condition:
```yaml
- name: Run QA Automation Tests
  if: github.base_ref == 'develop' || github.ref == 'refs/heads/develop'
  run: |
    node scripts/qa-direct-test.js
    node scripts/qa-github-integration-test.js
  continue-on-error: true  # Non-blocking initially
```

### Tool Validation Strategy (Issue #667)
- Add tool discovery at start of each QA script
- Filter out deprecated/non-existent tools
- Only test tools that actually exist
- Calculate success rates based on valid tools only

### Config Integration Strategy (Issue #666)
- Import CONFIG from test-config.js
- Replace all hardcoded timeouts (5000, 10000, 15000)
- Use CONFIG.timeouts.tool_call, etc.

### Deprecated Tool Cleanup (Issue #669)
Tools to remove references to:
- `browse_marketplace`
- `get_marketplace_persona`
- `activate_persona`
- `get_active_persona`
- `deactivate_persona`

### Test Data Cleanup (Issue #665)
- Track test personas/elements created
- Add cleanup function at end of tests
- Delete test artifacts after validation

## Agent Instructions

### For All Agents
1. **Scope Control**: Only modify files related to your specific task
2. **Test Your Changes**: Ensure changes don't break existing functionality
3. **Document Changes**: Add comments explaining what was changed and why
4. **Update This Document**: Mark your status when starting and completing

### Agent CI-1: CI/CD Integration
**Objective**: Add QA tests to CI workflows for develop branch only

**Tasks**:
1. Modify `.github/workflows/core-build-test.yml`
2. Add QA test step with develop-only condition
3. Make it non-blocking with `continue-on-error: true`
4. Test that it only runs on develop PRs

**Success Criteria**:
- QA tests run on develop branch PRs
- Tests don't block merges (non-blocking)
- Tests don't run on main branch

### Agent TOOL-1: Tool Validation
**Objective**: Add tool discovery and validation to QA scripts

**Tasks**:
1. Create a tool discovery function
2. Add to beginning of each QA script
3. Filter out non-existent tools before testing
4. Update success rate calculation

**Success Criteria**:
- Only existing tools are tested
- Success rates reflect actual tool availability
- Clear logging of skipped tools

### Agent CONFIG-1: Config Integration
**Objective**: Wire up test-config.js to all QA scripts

**Tasks**:
1. Import CONFIG from test-config.js in each script
2. Replace hardcoded timeout values
3. Use configuration constants throughout
4. Test that timeouts still work correctly

**Success Criteria**:
- No hardcoded timeouts remain
- All scripts use centralized config
- Tests still function properly

### Agent CLEANUP-1: Deprecated Tool Removal
**Objective**: Remove all references to deprecated tools

**Tasks**:
1. Search for deprecated tool names in all QA scripts
2. Remove or comment out deprecated tool tests
3. Update to use new element-based tools where applicable
4. Verify no deprecated tools remain

**Success Criteria**:
- No references to deprecated tools
- Scripts only test current tools
- Documentation updated

### Agent DATA-1: Test Data Cleanup
**Objective**: Add cleanup for test artifacts

**Tasks**:
1. Track all test data created (personas, elements)
2. Add cleanup function to delete test data
3. Ensure cleanup runs even on test failure
4. Test that cleanup works properly

**Success Criteria**:
- Test data is cleaned up after runs
- No accumulation of test artifacts
- Cleanup works even if tests fail

## Coordination Protocol

### Status Updates
Agents should update their status in the registry when:
- Starting work (🟡 In Progress)
- Completing work (🟢 Complete)
- Encountering blockers (🔵 Blocked)

### Communication
- Document any dependencies between tasks
- Note any issues discovered
- Record what was changed and why

### Testing
Each agent should:
1. Test their changes locally if possible
2. Ensure no regressions
3. Document test results

## Success Metrics

### Must Have for v1.6.0
- ✅ QA tests run automatically on develop PRs
- ✅ Only valid tools are tested
- ✅ Accurate success rate reporting
- ✅ No test pollution between runs

### Quality Metrics
- All hardcoded values removed
- Clean, maintainable code
- Clear documentation of changes
- No breaking changes to existing functionality

## Risk Mitigation

### Potential Issues
1. **CI/CD changes break workflows** - Use continue-on-error
2. **Tool validation too strict** - Log skipped tools clearly
3. **Config changes break tests** - Test thoroughly
4. **Cleanup deletes wrong data** - Use specific test prefixes

### Rollback Plan
- All changes on feature branch
- Can revert individual commits if needed
- Non-blocking CI changes won't affect main

---

**Note**: This coordination document should be updated by each agent as they work. Opus will monitor progress but agents should work independently on their assigned tasks.
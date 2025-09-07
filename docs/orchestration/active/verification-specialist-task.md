# Active Task: Code Verification and Quality Assurance

**Task ID**: VERIFY-001  
**Agent**: verification-specialist  
**Status**: Ready for Assignment  
**Priority**: High (Post-Implementation)  
**Created**: 2025-09-01  

## Task Objective

Perform comprehensive verification of completed implementation work to ensure quality, correctness, and adherence to requirements.

## Activation Context

### When to Launch This Task
- ✅ After feature implementation is complete
- ✅ After bug fixes are applied
- ✅ Before creating pull requests
- ✅ After refactoring work
- ✅ When security changes are made

### Prerequisites
- Implementation work is claimed complete
- Code is committed (at least locally)
- Tests are written (if applicable)
- Documentation is updated (if applicable)

## Task Parameters

```yaml
agent: verification-specialist
launch_via: Task tool
context_needed:
  - Branch name or PR number
  - Files changed list
  - Original requirements/issue
  - Test results if available
```

## Verification Scope

### 1. Code Quality Verification
- [ ] Code follows project conventions
- [ ] No commented-out code blocks
- [ ] Appropriate error handling
- [ ] Logging at correct levels
- [ ] No obvious security issues
- [ ] Performance considerations addressed

### 2. Functionality Verification
- [ ] Requirements are fully met
- [ ] Edge cases are handled
- [ ] No regressions introduced
- [ ] Integration points work correctly
- [ ] User-facing features work as expected

### 3. Test Coverage Verification
- [ ] Unit tests cover main logic paths
- [ ] Integration tests verify connections
- [ ] Edge cases have test coverage
- [ ] Tests actually execute and pass
- [ ] No test shortcuts or mock-only tests
- [ ] Coverage meets project standards

### 4. Documentation Verification
- [ ] Code comments where needed
- [ ] README updated if required
- [ ] API documentation current
- [ ] Changelog entry added
- [ ] User documentation updated

### 5. Security Verification
- [ ] No hardcoded secrets or keys
- [ ] Input validation implemented
- [ ] Output encoding proper
- [ ] Authentication/authorization correct
- [ ] No SQL injection vulnerabilities
- [ ] No XSS vulnerabilities

## Evidence Requirements

### For Each Verification Point
Provide concrete evidence:
- **Git diffs**: Show actual code changes
- **File paths**: Exact locations with line numbers
- **Test output**: Actual test execution results
- **Screenshots**: For UI changes (if applicable)
- **Performance metrics**: For optimization work
- **Security scan results**: For security changes

## Task Execution

### Launch Command Example
```javascript
Task({
  description: "Verify orchestration framework implementation",
  prompt: `Please verify the orchestration framework implementation in PR #[number].
  
  Focus on:
  1. Code quality and conventions
  2. Test coverage and effectiveness
  3. Documentation completeness
  4. Security considerations
  5. Performance impact
  
  Check these specific files:
  - docs/orchestration/templates/*
  - docs/orchestration/active/*
  - docs/orchestration/guides/*
  
  Provide evidence-based verification with specific examples.`,
  subagent_type: "general-purpose"
})
```

## Output Format

### Verification Report Structure
```markdown
## Verification Report - [Component/Feature]

### Summary
- **Overall Status**: ✅ PASS | ⚠️ PASS WITH ISSUES | ❌ FAIL
- **Critical Issues**: [Count]
- **Recommendations**: [Count]

### ✅ Verified Requirements
1. [Requirement]: Met - Evidence: [specific proof]
2. [Requirement]: Met - Evidence: [specific proof]

### ⚠️ Issues Found

#### Critical (Must Fix)
- **Issue**: [Description]
  - **Location**: [File:Line]
  - **Evidence**: [What was observed]
  - **Impact**: [What this affects]
  - **Fix**: [How to resolve]

#### Important (Should Fix)
- [Issue with same format]

#### Minor (Consider Fixing)
- [Issue with same format]

### 📊 Metrics
- **Test Coverage**: [X]%
- **Code Quality Score**: [X/10]
- **Documentation**: [Complete/Partial/Missing]
- **Security**: [No issues/Issues found]

### 📝 Recommendations
1. [Improvement suggestion]
2. [Enhancement idea]

### ✅ What Works Well
- [Positive finding]
- [Good practice observed]
```

## Success Criteria

The verification is complete when:
1. All code changes are reviewed
2. All tests are verified as passing
3. Documentation is confirmed accurate
4. Security considerations are checked
5. Report is generated with evidence

## Common Issues to Check

### Code Smells
- Large functions (>50 lines)
- Deep nesting (>3 levels)
- Duplicate code blocks
- Magic numbers/strings
- Poor variable naming

### Testing Gaps
- Missing error case tests
- No integration tests
- Mocked tests only
- Low coverage areas
- Flaky tests

### Documentation Issues
- Outdated examples
- Missing parameters
- Incorrect return types
- No usage examples
- Missing error descriptions

### Security Concerns
- User input not validated
- Output not encoded
- Permissions too broad
- Sensitive data logged
- Missing rate limiting

## Task Completion

### When Complete
1. Update task status to "Completed"
2. File verification report in `reports/` directory
3. Update coordination document with findings
4. Notify orchestrator of results
5. Create issues for any problems found

### Handoff Information
- Verification report location
- Critical issues that block progress
- Recommendations for improvement
- Areas needing follow-up

## Task Metrics

### Time Estimates
- Small change (1-5 files): 15-30 minutes
- Medium change (6-20 files): 30-60 minutes
- Large change (20+ files): 60-120 minutes

### Quality Indicators
- Issues found per 100 lines of code
- Test coverage percentage
- Documentation completeness score
- Security vulnerabilities count

---

**Note**: This task should be launched via the Task tool, not by activating the verification-specialist persona directly. The agent will operate independently and report back with findings.
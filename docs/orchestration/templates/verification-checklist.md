# Verification Checklist

**Mission**: [Name]  
**Verifier**: [Agent Name]  
**Date**: [YYYY-MM-DD]  
**Status**: ⬜ Not Started | 🔄 In Progress | ✅ Complete | ❌ Failed  

## Executive Summary

| Category | Pass | Fail | N/A | Score |
|----------|------|------|-----|-------|
| Requirements | 0 | 0 | 0 | 0% |
| Code Quality | 0 | 0 | 0 | 0% |
| Testing | 0 | 0 | 0 | 0% |
| Documentation | 0 | 0 | 0 | 0% |
| Security | 0 | 0 | 0 | 0% |
| **Overall** | **0** | **0** | **0** | **0%** |

## Requirements Verification

### Functional Requirements
| Requirement | Status | Evidence | Notes |
|-------------|--------|----------|-------|
| [Requirement 1] | ⬜ | [Where to verify] | [Observations] |
| [Requirement 2] | ⬜ | [Where to verify] | [Observations] |
| [Requirement 3] | ⬜ | [Where to verify] | [Observations] |

### Acceptance Criteria
| Criterion | Met? | Evidence | Command/Output |
|-----------|------|----------|----------------|
| [User can do X] | ⬜ | - | `command to test` |
| [System performs Y] | ⬜ | - | `command to verify` |
| [Performance < Z ms] | ⬜ | - | `performance test` |

### Out of Scope Verification
- [ ] Confirmed no scope creep
- [ ] Boundaries maintained
- [ ] No unauthorized additions

## Code Quality Verification

### Code Review Checklist
- [ ] **Style**: Follows project conventions
- [ ] **Naming**: Clear, consistent variable/function names
- [ ] **Structure**: Logical organization and flow
- [ ] **DRY**: No unnecessary duplication
- [ ] **Comments**: Appropriate level of documentation

### Error Handling
- [ ] All error cases handled
- [ ] Appropriate error messages
- [ ] Graceful degradation
- [ ] No silent failures
- [ ] Logging at correct levels

### Code Metrics
| Metric | Target | Actual | Pass? |
|--------|--------|--------|-------|
| Complexity | < 10 | - | ⬜ |
| Line Length | < 100 | - | ⬜ |
| Function Length | < 50 | - | ⬜ |
| File Size | < 500 | - | ⬜ |

## Testing Verification

### Test Coverage
| Component | Target | Actual | Evidence |
|-----------|--------|--------|----------|
| Unit Tests | ≥90% | - | `npm test -- --coverage` |
| Integration | ≥80% | - | `npm run test:integration` |
| E2E | Critical paths | - | `npm run test:e2e` |

### Test Quality Assessment
- [ ] **Real Tests**: Not just mocks
- [ ] **API Testing**: Actual endpoints tested
- [ ] **Edge Cases**: Boundary conditions covered
- [ ] **Error Cases**: Failure scenarios tested
- [ ] **Performance**: Load/stress tests if needed

### Test Execution Results
```bash
# Paste actual test output here
$ npm test
...
```

### Specific Test Scenarios
| Scenario | Command | Expected | Actual | Pass? |
|----------|---------|----------|--------|-------|
| Happy path | `test cmd` | Success | - | ⬜ |
| Edge case 1 | `test cmd` | Handled | - | ⬜ |
| Error case 1 | `test cmd` | Error msg | - | ⬜ |

## Documentation Verification

### Code Documentation
- [ ] **Inline Comments**: Complex logic explained
- [ ] **Function Docs**: Parameters and returns documented
- [ ] **Type Definitions**: TypeScript types clear
- [ ] **Examples**: Usage examples provided

### User Documentation
- [ ] **README Updated**: New features documented
- [ ] **API Docs**: Endpoints documented
- [ ] **Changelog**: Entry added
- [ ] **Migration Guide**: If breaking changes

### Documentation Accuracy
| Document | Section | Accurate? | Issues |
|----------|---------|-----------|--------|
| README | [Section] | ⬜ | - |
| API Docs | [Endpoint] | ⬜ | - |
| Code Comments | [File] | ⬜ | - |

## Security Verification

### Security Checklist
- [ ] **No Hardcoded Secrets**: Checked all files
- [ ] **Input Validation**: All inputs sanitized
- [ ] **SQL Injection**: Parameterized queries
- [ ] **XSS Prevention**: Output encoding
- [ ] **CSRF Protection**: Tokens implemented
- [ ] **Authentication**: Properly implemented
- [ ] **Authorization**: Access controls work

### Security Scan Results
```bash
# Security scan output
$ npm audit
...
```

### Dependency Check
- [ ] No high/critical vulnerabilities
- [ ] Dependencies up to date
- [ ] License compliance checked

## Performance Verification

### Performance Metrics
| Metric | Baseline | Target | Actual | Pass? |
|--------|----------|--------|--------|-------|
| Response Time | X ms | < Y ms | - | ⬜ |
| Memory Usage | X MB | < Y MB | - | ⬜ |
| CPU Usage | X% | < Y% | - | ⬜ |
| Throughput | X/sec | > Y/sec | - | ⬜ |

### Load Test Results
```bash
# Load test output
$ npm run test:performance
...
```

## Integration Verification

### System Integration
- [ ] **Database**: Connections work
- [ ] **APIs**: External calls successful
- [ ] **Services**: Microservices communicate
- [ ] **Queue**: Message processing works
- [ ] **Cache**: Caching layer functional

### Compatibility
- [ ] **Browsers**: Works in target browsers
- [ ] **Node Versions**: Runs on supported versions
- [ ] **OS**: Works on target platforms
- [ ] **Dependencies**: Compatible versions

## Deployment Readiness

### Pre-Deployment Checklist
- [ ] **Build**: Production build successful
- [ ] **Environment**: Config variables set
- [ ] **Migration**: Database migrations ready
- [ ] **Rollback**: Plan documented
- [ ] **Monitoring**: Alerts configured

### Deployment Verification
```bash
# Build and verify
$ npm run build
$ npm run start:prod
```

## Issues Found

### Critical Issues (Must Fix)
| ID | Issue | Impact | Evidence | Recommendation |
|----|-------|--------|----------|----------------|
| C1 | [Issue] | [Impact] | [Proof] | [Fix suggestion] |

### Important Issues (Should Fix)
| ID | Issue | Impact | Evidence | Recommendation |
|----|-------|--------|----------|----------------|
| I1 | [Issue] | [Impact] | [Proof] | [Fix suggestion] |

### Minor Issues (Could Fix)
| ID | Issue | Impact | Evidence | Recommendation |
|----|-------|--------|----------|----------------|
| M1 | [Issue] | [Impact] | [Proof] | [Fix suggestion] |

## Verification Evidence

### Files Reviewed
- [ ] `path/to/file1.ts` - [What was checked]
- [ ] `path/to/file2.ts` - [What was checked]
- [ ] `path/to/test.spec.ts` - [Test coverage verified]

### Commands Executed
```bash
# List all verification commands run
git diff develop..feature/branch
npm test
npm run lint
npm audit
```

### Screenshots/Outputs
[Attach or link any visual evidence]

## Final Assessment

### Verification Decision
- [ ] **PASS** - Ready for merge
- [ ] **CONDITIONAL PASS** - Minor fixes needed
- [ ] **FAIL** - Major issues require resolution

### Conditions for Approval
If conditional pass, list requirements:
1. [Specific fix needed]
2. [Specific fix needed]

### Sign-off
**Verified By**: [Agent Name]  
**Date/Time**: [Timestamp]  
**Confidence Level**: High | Medium | Low  
**Recommendation**: Approve | Approve with conditions | Reject  

## Follow-up Actions

### Immediate Actions
1. [Critical fix if needed]
2. [Important fix if needed]

### Future Improvements
1. [Suggestion for next iteration]
2. [Technical debt to address]

---

**Note**: This checklist emphasizes evidence-based verification. Fill in actual commands, outputs, and specific observations rather than generic confirmations.
# Coordination Document: [Mission Name]

**Date**: [YYYY-MM-DD]  
**Orchestrator**: [Name] ([Model])  
**Status**: Planning | In Progress | Verification | Complete  
**Priority**: Critical | High | Medium | Low  

## Mission Objective

[Clear, specific description of what needs to be accomplished]

## Success Criteria

- [ ] [Specific, measurable outcome 1]
- [ ] [Specific, measurable outcome 2]
- [ ] [Specific, measurable outcome 3]

## Context

### Repository Information
- **Repository**: [Repository name]
- **Current Branch**: [Branch name]
- **Base Branch**: [Where this will merge to]
- **GitFlow Status**: [Feature/Fix/Hotfix/Release]

### Technical Context
- **Language/Framework**: [e.g., TypeScript/Node.js]
- **Key Files/Directories**: [List relevant paths]
- **Dependencies**: [External dependencies or requirements]

### CI/CD Requirements
- [ ] All tests passing
- [ ] Code coverage >= [X]%
- [ ] No linting errors
- [ ] Security scan clean
- [ ] Build artifacts valid

## Agent Roster

| Role | Agent Name | Model | Specialization | Status |
|------|------------|-------|----------------|--------|
| Orchestrator | [Name] | Opus | Mission coordination | Active |
| Code Implementer | [Name] | Sonnet | [Specific expertise] | Assigned |
| Test Engineer | [Name] | Sonnet | [Testing focus] | Assigned |
| Documentation Specialist | [Name] | Sonnet | [Doc type] | Pending |
| Verification Specialist | [Name] | Opus | Quality assurance | Pending |

## Task Breakdown

### Phase 1: Preparation
| Task | Owner | Status | Evidence | Dependencies |
|------|-------|--------|----------|--------------|
| Research existing patterns | [Agent] | ⬜ Not Started | - | None |
| Review related issues | [Agent] | ⬜ Not Started | - | None |
| Set up development environment | [Agent] | ⬜ Not Started | - | None |

### Phase 2: Implementation
| Task | Owner | Status | Evidence | Dependencies |
|------|-------|--------|----------|--------------|
| [Specific implementation task] | [Agent] | ⬜ Not Started | - | Phase 1 complete |
| [Another implementation task] | [Agent] | ⬜ Not Started | - | Previous task |

### Phase 3: Testing
| Task | Owner | Status | Evidence | Dependencies |
|------|-------|--------|----------|--------------|
| Write unit tests | [Agent] | ⬜ Not Started | - | Implementation complete |
| Write integration tests | [Agent] | ⬜ Not Started | - | Unit tests pass |
| Performance testing | [Agent] | ⬜ Not Started | - | All tests pass |

### Phase 4: Verification
| Task | Owner | Status | Evidence | Dependencies |
|------|-------|--------|----------|--------------|
| Code review | Verification Specialist | ⬜ Not Started | - | Testing complete |
| Security review | Security Auditor | ⬜ Not Started | - | Code review done |
| Documentation review | [Agent] | ⬜ Not Started | - | All reviews pass |

## Status Legend
- ⬜ Not Started
- 🔄 In Progress
- ⚠️ Blocked
- ✅ Complete (with evidence)
- ❌ Failed (needs rework)

## Evidence Requirements

### For Code Changes
- Git diff output showing changes
- File paths and line numbers
- Commit SHA after changes

### For Testing
- Test execution output
- Coverage report
- Performance metrics
- Actual API responses (not mocks)

### For Documentation
- Links to updated files
- Diff of documentation changes
- Screenshots if UI-related

## Progress Tracking

### Metrics
- **Tasks Total**: [X]
- **Tasks Completed**: [Y]
- **Completion Rate**: [Y/X]%
- **Blockers**: [Count]
- **Time Elapsed**: [Duration]
- **Estimated Remaining**: [Duration]

### Current Activity
[Real-time update of what's happening now]

### Recent Completions
- [Timestamp] - [Task] - [Agent] - [Evidence link]
- [Timestamp] - [Task] - [Agent] - [Evidence link]

## Risk Register

| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| [Potential issue] | Low/Med/High | Low/Med/High | [Mitigation strategy] | [Agent] |

## Blockers and Issues

### Active Blockers
| Issue | Description | Impact | Owner | Resolution Strategy |
|-------|-------------|--------|-------|-------------------|
| [Issue ID] | [Description] | [What's blocked] | [Agent] | [How to resolve] |

### Resolved Issues
| Issue | Resolution | Time to Resolve | Lessons Learned |
|-------|------------|-----------------|-----------------|
| [Issue] | [How resolved] | [Duration] | [What we learned] |

## Communication Log

### Key Decisions
- [Timestamp] - [Decision] - [Rationale] - [Decided by]

### Important Updates
- [Timestamp] - [Update] - [Impact] - [Reported by]

### Handoffs
- [Timestamp] - [From Agent] → [To Agent] - [What was handed off]

## Verification Checklist

### Code Quality
- [ ] Follows project coding standards
- [ ] No commented-out code
- [ ] Appropriate error handling
- [ ] Logging at appropriate levels

### Testing
- [ ] Unit test coverage >= required threshold
- [ ] Integration tests pass
- [ ] No flaky tests
- [ ] Performance within requirements

### Documentation
- [ ] Code comments where needed
- [ ] README updated if required
- [ ] API documentation current
- [ ] Changelog entry added

### Security
- [ ] No hardcoded secrets
- [ ] Input validation implemented
- [ ] Security scan passed
- [ ] No new vulnerabilities introduced

## Completion Criteria

Before marking complete:
1. All success criteria met with evidence
2. All tests passing
3. Documentation updated
4. Code reviewed and approved
5. No unresolved blockers
6. Verification specialist approval

## Lessons Learned

### What Worked Well
- [Positive outcome or practice]

### Areas for Improvement
- [What could be better]

### Recommendations for Future
- [Suggestions for similar missions]

## Session Archive

Upon completion, move this document to `completed/` with filename:
`YYYY-MM-DD-[mission-name]-coordination.md`

---

**Document Version**: 1.0  
**Template Version**: 1.0  
**Last Updated**: [Timestamp]  
**Next Review**: [When to check progress]
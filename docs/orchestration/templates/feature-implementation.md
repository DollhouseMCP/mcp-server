# Feature Implementation Orchestration: [Feature Name]

**Feature**: [Brief feature description]  
**Issue/PR**: #[Number]  
**Date Started**: [YYYY-MM-DD]  
**Target Completion**: [YYYY-MM-DD]  
**Orchestrator**: [Name]  

## Feature Requirements

### User Story
As a [user type], I want to [action] so that [benefit].

### Acceptance Criteria
- [ ] [Specific measurable criterion 1]
- [ ] [Specific measurable criterion 2]
- [ ] [Users can do X and see Y]
- [ ] [Performance requirement met]

### Out of Scope
- [What this feature does NOT include]
- [Boundaries to maintain focus]

## Technical Specification

### Architecture Overview
```
[Component A] → [Component B] → [Component C]
     ↓              ↓              ↓
  [Data Flow]   [Processing]   [Output]
```

### Components to Modify
| Component | File(s) | Changes Required | Risk Level |
|-----------|---------|------------------|------------|
| [Component] | [Path] | [What changes] | Low/Med/High |

### New Components
| Component | Location | Purpose | Interfaces With |
|-----------|----------|---------|-----------------|
| [New module] | [Path] | [Why needed] | [Other components] |

## Implementation Plan

### Phase 1: Foundation (Day 1)
**Assigned**: [Code Implementer Name - "Backend Specialist"]

Tasks:
- [ ] Create base structure and interfaces
- [ ] Set up configuration schema
- [ ] Implement core data models
- [ ] Create placeholder for business logic

Evidence Required:
- New files created with paths
- Interface definitions
- Initial commit SHA

### Phase 2: Core Logic (Day 1-2)
**Assigned**: [Code Implementer Name - "Logic Specialist"]

Tasks:
- [ ] Implement primary feature logic
- [ ] Add error handling
- [ ] Integrate with existing systems
- [ ] Add logging and monitoring

Evidence Required:
- Git diff of implementation
- Error scenarios handled (list them)
- Integration points tested
- Log output samples

### Phase 3: Testing (Day 2)
**Assigned**: [Test Engineer Name - "Quality Specialist"]

Tasks:
- [ ] Write unit tests (>90% coverage)
- [ ] Create integration tests
- [ ] Add end-to-end test scenarios
- [ ] Performance benchmarking

Evidence Required:
- Test file paths
- Coverage report
- Test execution output
- Performance metrics (actual numbers)

### Phase 4: UI/API Updates (Day 2-3)
**Assigned**: [Frontend/API Developer Name - "Interface Specialist"]

Tasks:
- [ ] Update API endpoints if needed
- [ ] Modify UI components
- [ ] Update API documentation
- [ ] Add user-facing error messages

Evidence Required:
- API endpoint changes (before/after)
- UI screenshots if applicable
- API docs diff
- Error message examples

### Phase 5: Documentation (Day 3)
**Assigned**: [Documentation Specialist Name - "Docs Expert"]

Tasks:
- [ ] Update README if needed
- [ ] Add inline code documentation
- [ ] Create user guide section
- [ ] Update changelog

Evidence Required:
- Documentation file diffs
- README sections added
- Changelog entry

### Phase 6: Verification (Day 3)
**Assigned**: [Verification Specialist Name - "Quality Guardian"]

Tasks:
- [ ] Code review for standards compliance
- [ ] Security review
- [ ] Performance validation
- [ ] User acceptance testing

Evidence Required:
- Review comments addressed
- Security scan results
- Performance test results
- UAT scenarios passed

## Risk Mitigation

### Identified Risks
| Risk | Mitigation Strategy | Contingency Plan |
|------|-------------------|------------------|
| Breaking existing functionality | Comprehensive test coverage | Feature flag for rollback |
| Performance degradation | Benchmark before/after | Optimization phase if needed |
| Complex integration | Incremental integration | Simplified initial version |

## Dependencies

### External Dependencies
- [ ] [Library/Service] version [X.Y.Z] available
- [ ] [API/Service] accessible and stable
- [ ] [Team/Person] approval for [aspect]

### Internal Dependencies
- [ ] [Other feature] completed
- [ ] [Refactoring] merged
- [ ] [Documentation] updated

## Testing Strategy

### Test Coverage Requirements
- Unit Tests: >= 90%
- Integration Tests: All API endpoints
- E2E Tests: Critical user paths

### Test Scenarios
1. **Happy Path**: [Description]
   - Input: [Specific data]
   - Expected: [Specific output]
   
2. **Edge Case 1**: [Description]
   - Input: [Boundary condition]
   - Expected: [Handling behavior]
   
3. **Error Case 1**: [Description]
   - Input: [Invalid data]
   - Expected: [Error message and recovery]

### Performance Benchmarks
| Metric | Current | Target | Actual |
|--------|---------|--------|--------|
| Response time | X ms | < Y ms | - |
| Memory usage | X MB | < Y MB | - |
| Throughput | X/sec | > Y/sec | - |

## Progress Tracking

### Daily Standup Format
```markdown
**[Date] - Day [N] Update**
- Completed: [What was finished with evidence]
- In Progress: [Current work]
- Blockers: [Any issues]
- Next: [What's planned]
```

### Milestone Checkpoints
- [ ] Day 1 EOD: Foundation complete
- [ ] Day 2 EOD: Core logic and testing complete
- [ ] Day 3 Noon: Documentation complete
- [ ] Day 3 EOD: Verification complete

## Communication Protocol

### Update Frequency
- Progress updates: Every 2 hours
- Blocker alerts: Immediately
- Completion notices: Upon task finish with evidence

### Escalation Path
1. Try to resolve independently (15 min)
2. Check documentation and existing code
3. Alert orchestrator with specific question
4. If critical: Immediate escalation to user

## Definition of Done

Feature is complete when:
- [ ] All acceptance criteria met with evidence
- [ ] All tests passing (show test output)
- [ ] Code reviewed and approved
- [ ] Documentation complete and reviewed
- [ ] No critical or high bugs
- [ ] Performance benchmarks met
- [ ] Merged to develop branch
- [ ] Deployment guide updated if needed

## Post-Implementation

### Monitoring Plan
- [ ] Set up alerts for errors
- [ ] Monitor performance metrics
- [ ] Track usage analytics
- [ ] Gather user feedback

### Success Metrics (After Launch)
- Error rate < X%
- Performance within targets
- User adoption rate
- Support ticket volume

## Lessons Learned Section

To be completed post-implementation:
- What went well:
- What was challenging:
- What would we do differently:
- Knowledge to share with team:

---

**Note**: This template emphasizes evidence-based completion and clear agent roles. Adjust phases and timelines based on feature complexity.
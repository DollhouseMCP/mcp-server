# Task Tracker: [Mission Name]

**Last Updated**: [Timestamp]  
**Auto-Refresh**: Every task completion  
**Format**: Markdown table for easy scanning  

## Quick Status

| Metric | Value |
|--------|-------|
| Total Tasks | 0 |
| Completed | 0 |
| In Progress | 0 |
| Blocked | 0 |
| Not Started | 0 |
| **Progress** | **0%** |

## Active Tasks (Currently Being Worked On)

| Task | Agent | Started | Duration | Status |
|------|-------|---------|----------|--------|
| [Task description] | [Agent name] | [Time] | [Elapsed] | 🔄 Working... |

## Task Queue (Prioritized)

| Priority | Task | Assigned To | Dependencies | Ready? |
|----------|------|-------------|--------------|--------|
| 1 | [Task] | [Agent] | None | ✅ Yes |
| 2 | [Task] | [Agent] | Task 1 | ⏸️ Waiting |
| 3 | [Task] | [Agent] | Task 1, 2 | ⏸️ Waiting |

## Completed Tasks (With Evidence)

| # | Task | Agent | Duration | Evidence | Verified |
|---|------|-------|----------|----------|----------|
| 1 | [Completed task] | [Agent] | [Time taken] | [Link/SHA/Output] | ✅ |

## Blocked Tasks (Requiring Attention)

| Task | Agent | Blocked Since | Issue | Action Needed |
|------|-------|---------------|-------|---------------|
| [Task] | [Agent] | [Time] | [Specific blocker] | [What's needed to unblock] |

## Task Details

### Task Template
```markdown
### Task: [Name]
**ID**: T-[Number]
**Owner**: [Agent Name - Role Description]
**Priority**: Critical | High | Medium | Low
**Status**: ⬜ Not Started | 🔄 In Progress | ⚠️ Blocked | ✅ Complete

**Description**:
[What needs to be done]

**Acceptance Criteria**:
- [ ] [Specific measurable outcome]
- [ ] [Evidence requirement]

**Dependencies**:
- Requires: [Previous task IDs]
- Blocks: [Dependent task IDs]

**Evidence**:
- Type: [Code/Test/Doc/Output]
- Location: [Where to find proof]
- Verification: [How to verify]

**Time Tracking**:
- Estimated: [Duration]
- Started: [Timestamp]
- Completed: [Timestamp]
- Actual: [Duration]

**Notes**:
[Any relevant information]
```

## Agent Workload

| Agent | Role | Current Task | Completed | Queue |
|-------|------|--------------|-----------|-------|
| [Name] | [Role] | [Current work] | [Count] | [Count] |

## Timeline View

```
Hour 1: ████████░░ Task 1 (Agent A)
Hour 2: ████████░░ Task 2 (Agent B), Task 3 (Agent C)
Hour 3: ████░░░░░░ Task 4 (Agent A)
Hour 4: ░░░░░░░░░░ Verification (Quality Guardian)
```

## Dependency Graph

```
Task 1 ──→ Task 2 ──→ Task 4
       └→ Task 3 ──┘
             ↓
          Task 5 ──→ Verification
```

## Critical Path

Tasks that directly affect completion time:
1. Task 1 → Task 2 → Task 4 → Verification
   
**Current Critical Path Duration**: [Time]  
**Estimated Completion**: [Timestamp]

## Risk Items

| Risk | Tasks Affected | Probability | Impact | Mitigation |
|------|---------------|-------------|--------|------------|
| [Risk] | T-1, T-2 | High | High | [Action] |

## Performance Metrics

### By Agent
| Agent | Tasks | Completed | Success Rate | Avg Duration |
|-------|-------|-----------|--------------|--------------|
| [Name] | [Total] | [Done] | [%] | [Time] |

### By Task Type
| Type | Count | Avg Duration | Success Rate |
|------|-------|--------------|--------------|
| Implementation | [N] | [Time] | [%] |
| Testing | [N] | [Time] | [%] |
| Documentation | [N] | [Time] | [%] |

## Evidence Links

### Code Changes
- Commit [SHA]: [Description]
- PR #[Number]: [Title]
- Diff: [Link to specific changes]

### Test Results
- Test Run [ID]: [Pass/Fail ratio]
- Coverage Report: [Link]
- Performance Results: [Link]

### Documentation
- File: [Path] - [What was added/changed]
- README Section: [Link]
- API Docs: [Link]

## Next Actions

### Immediate (Next 30 min)
1. [Specific action]
2. [Specific action]

### Short-term (Next 2 hours)
1. [Planned work]
2. [Planned work]

### Blockers to Resolve
1. [Blocker]: [Resolution plan]

## Update Log

Keep latest 5 updates visible:
- [Timestamp]: [What changed] - [By whom]
- [Timestamp]: [What changed] - [By whom]
- [Timestamp]: [What changed] - [By whom]
- [Timestamp]: [What changed] - [By whom]
- [Timestamp]: [What changed] - [By whom]

---

**Auto-generated section** (Updated by agents):
```markdown
LAST_UPDATE: [ISO timestamp]
TOTAL_DURATION: [Elapsed time]
EFFICIENCY_SCORE: [Actual vs Estimated]
```
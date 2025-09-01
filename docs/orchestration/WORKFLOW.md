# Agent Orchestration Workflow

## Quick Start

1. **Choose a Template** from `templates/`
2. **Copy to Active** directory with mission name
3. **Fill in Mission Details** and assign agents
4. **Execute** following the workflow below
5. **Verify** using checklist
6. **Archive** to `completed/` when done

## Standard Workflow

### 1. Planning Phase (30 min)
**Owner**: Orchestrator (Opus)

- [ ] Define clear mission objective
- [ ] Break down into specific tasks
- [ ] Identify dependencies
- [ ] Assign descriptive agent roles
- [ ] Set success criteria
- [ ] Create coordination document

### 2. Initialization Phase (15 min)
**Owner**: Orchestrator

- [ ] Deploy agents with role-specific names
- [ ] Provide GitFlow context
- [ ] Share CI/CD requirements
- [ ] Distribute coordination document
- [ ] Confirm agent understanding

### 3. Execution Phase (Variable)
**Owner**: Assigned Agents

- [ ] Agents work on assigned tasks
- [ ] Regular progress updates (every 2 hours)
- [ ] Evidence collection for each task
- [ ] Immediate blocker escalation
- [ ] Task handoffs documented

### 4. Verification Phase (1 hour)
**Owner**: Verification Specialist

- [ ] Review against requirements
- [ ] Check evidence for each task
- [ ] Run actual tests
- [ ] Validate documentation
- [ ] Complete verification checklist

### 5. Integration Phase (30 min)
**Owner**: Orchestrator

- [ ] Combine agent outputs
- [ ] Resolve any conflicts
- [ ] Final quality check
- [ ] Prepare deliverables
- [ ] Update documentation

### 6. Completion Phase (15 min)
**Owner**: Orchestrator

- [ ] Confirm all criteria met
- [ ] Document lessons learned
- [ ] Archive coordination document
- [ ] Update templates if needed
- [ ] Close related issues/PRs

## Communication Protocol

### Update Frequency
- **Planning**: Once complete
- **Execution**: Every 2 hours or at milestones
- **Blockers**: Immediately
- **Completion**: Upon task finish with evidence

### Status Indicators
- ⬜ Not Started
- 🔄 In Progress
- ⚠️ Blocked (needs attention)
- ✅ Complete (with evidence)
- ❌ Failed (needs rework)

### Evidence Standards
Every completed task requires:
1. **What**: Specific description of what was done
2. **Where**: File paths, line numbers, or URLs
3. **Proof**: Command output, test results, or screenshots
4. **Verification**: How to independently verify

## Agent Naming Convention

### Format
`[Function] + [Specialization]`

### Examples
- **Code Implementer - Backend Specialist**
- **Test Engineer - Integration Expert**
- **Documentation Writer - API Specialist**
- **Security Auditor - Authentication Expert**
- **Performance Analyst - Database Optimizer**
- **Verification Specialist - Quality Guardian**

### Benefits
- Clear accountability
- Easy progress tracking
- Reduced confusion
- Better handoffs

## Quality Gates

### Before Starting Execution
- [ ] All agents understand their roles
- [ ] Dependencies are clear
- [ ] Success criteria defined
- [ ] GitFlow context provided
- [ ] Tools and access verified

### Before Verification
- [ ] All tasks show evidence
- [ ] Tests are passing
- [ ] Documentation updated
- [ ] No critical blockers
- [ ] Code committed to branch

### Before Completion
- [ ] Verification passed
- [ ] All criteria met
- [ ] Stakeholder approval
- [ ] Lessons documented
- [ ] Ready for merge/deploy

## Common Patterns

### Pattern: Feature Implementation
1. Research existing code (30 min)
2. Implement core logic (2 hours)
3. Write tests (1 hour)
4. Update documentation (30 min)
5. Verification (1 hour)
**Total**: ~5 hours

### Pattern: Bug Investigation
1. Reproduce issue (30 min)
2. Root cause analysis (1 hour)
3. Implement fix (1 hour)
4. Add regression tests (30 min)
5. Verification (30 min)
**Total**: ~3.5 hours

### Pattern: Refactoring
1. Analyze current code (1 hour)
2. Plan refactoring approach (30 min)
3. Implement changes (2 hours)
4. Ensure tests still pass (30 min)
5. Performance comparison (30 min)
6. Verification (1 hour)
**Total**: ~5.5 hours

## Escalation Path

### Level 1: Agent Resolution (15 min)
- Agent attempts to resolve independently
- Checks documentation and code
- Tries alternative approaches

### Level 2: Orchestrator Support (30 min)
- Escalate to orchestrator with specifics
- Orchestrator provides guidance
- May reassign or adjust approach

### Level 3: Human Intervention (Immediate)
- Critical blockers
- Scope questions
- Security concerns
- Major architecture decisions

## Tools Integration

### With GitFlow
- Agents know current branch
- Understand merge targets
- Follow commit conventions
- Create appropriate branches

### With CI/CD
- Monitor pipeline status
- Ensure tests pass
- Check coverage requirements
- Validate build artifacts

### With DollhouseMCP
- Use portfolio templates
- Activate specialized personas
- Leverage existing skills
- Share improvements back

## Performance Metrics

Track for continuous improvement:

### Efficiency Metrics
- Tasks per hour
- Actual vs estimated time
- Rework percentage
- Blocker frequency

### Quality Metrics
- First-time pass rate
- Issues found in verification
- Documentation completeness
- Test coverage achieved

### Agent Metrics
- Task completion rate
- Evidence quality
- Communication clarity
- Independence level

## Best Practices

### DO
- ✅ Use descriptive agent names
- ✅ Require evidence for everything
- ✅ Update progress frequently
- ✅ Escalate blockers quickly
- ✅ Document lessons learned
- ✅ Test against real systems

### DON'T
- ❌ Accept work without evidence
- ❌ Use generic agent numbers
- ❌ Skip verification phase
- ❌ Ignore failing tests
- ❌ Hide problems
- ❌ Use only mock tests

## Continuous Improvement

After each orchestration:
1. **Review** what worked and what didn't
2. **Update** templates with improvements
3. **Share** lessons with team
4. **Refine** agent personas
5. **Optimize** workflow steps

---

*This workflow is a living document. Update it based on experience and lessons learned.*
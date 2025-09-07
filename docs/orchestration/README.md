# Agent Orchestration Framework

## Overview

This framework provides a structured approach for managing complex multi-agent workflows in the DollhouseMCP project. It ensures proper coordination, verification, and tracking of agent activities.

## Directory Structure

```
orchestration/
├── active/           # Currently running orchestration sessions
├── completed/        # Archived completed sessions
├── templates/        # Reusable templates for common workflows
└── reports/          # Verification and completion reports
```

## Core Components

### 1. Coordination Documents
Central documents that track the entire workflow, including:
- Mission objectives
- Task breakdown and dependencies
- Agent assignments with descriptive roles
- Progress tracking with evidence
- Verification checkpoints

### 2. Agent Roles

#### Orchestrator (Opus) - "Mission Commander"
- Creates and maintains coordination documents
- Assigns tasks to specialized agents
- Monitors progress and handles dependencies
- Synthesizes results from multiple agents
- Aware of GitFlow workflow and current branch context

#### Specialized Worker Agents (Sonnet)
Named by their function:
- **Code Implementer** - Writes and modifies code
- **Test Engineer** - Creates real tests against actual APIs
- **Documentation Specialist** - Updates docs and READMEs
- **Security Auditor** - Reviews for vulnerabilities
- **Performance Analyst** - Optimizes and benchmarks
- **Integration Specialist** - Handles cross-component work

Each agent receives:
- Current GitFlow branch and workflow rules
- CI/CD pipeline status and requirements
- Specific role-based instructions
- Success criteria with measurable outcomes

#### Verification Specialist (Opus) - "Quality Guardian"
- Reviews completed work against requirements
- Validates with actual code execution
- Tests real APIs, not mocks
- Provides evidence-based assessment
- Identifies gaps requiring attention

### 3. Workflow States

1. **Planning**: Define objectives and break down tasks
2. **Assignment**: Allocate tasks to appropriately named agents
3. **Execution**: Agents work on assigned tasks with clear identity
4. **Verification**: Review and validate completed work with evidence
5. **Integration**: Combine results into final deliverable
6. **Completion**: Archive and document lessons learned

## Usage Patterns

### For DollhouseMCP Projects
1. Copy templates from `templates/` directory
2. Templates also available in DollhouseMCP portfolio for reuse across projects
3. Agents receive project-specific context including GitFlow status

### For General Projects
1. Use portable templates from DollhouseMCP portfolio
2. Adapt workflow to project's branching strategy
3. Maintain same verification standards

### Starting a New Orchestration

1. Select appropriate template (local or from portfolio)
2. Create new coordination document in `active/`
3. Define mission objectives with measurable success criteria
4. Assign descriptive agent roles (not generic numbers)
5. Include GitFlow context and CI/CD requirements
6. Begin deployment with clear agent identities

### Example Workflow

```markdown
# Mission: Implement OAuth Enhancement Feature

## Context
- Current Branch: feature/oauth-enhancement (from develop)
- GitFlow Status: Feature branch, PRs go to develop
- CI Requirements: All tests must pass, coverage >96%

## Assigned Agents
- Orchestrator: Alex Sterling (Opus) - Mission Commander
- Backend Developer: Morgan (Sonnet) - OAuth Implementation Specialist  
- Test Engineer: Quinn (Sonnet) - API Test Specialist
- Security Auditor: Blake (Sonnet) - Authentication Security Expert
- Reviewer: Jordan (Opus) - Quality Guardian

## Tasks with Owners
- [ ] [Morgan] Research existing OAuth patterns in codebase
- [ ] [Morgan] Implement OAuth token refresh mechanism
- [ ] [Quinn] Write integration tests against real OAuth endpoints
- [ ] [Blake] Perform security review of token handling
- [ ] [Morgan] Update API documentation
```

## Best Practices

### Agent Initialization
- Provide descriptive role names reflecting actual function
- Include GitFlow branch context in initial instructions
- Specify CI/CD requirements upfront
- Define success metrics clearly

### Task Definition
- Make tasks specific, measurable, and assigned
- Include clear acceptance criteria with evidence requirements
- Define concrete deliverables (files, test results, metrics)
- Set realistic time estimates with buffer

### Quality Assurance Measures
**To Ensure Accurate Completion:**
- Require file paths and line numbers for all changes
- Demand actual command output, not descriptions
- Verify changes with real git diffs
- Run tests against actual APIs, not mocks
- Execute code to confirm functionality

**To Maintain Focus:**
- Provide clear role boundaries for each agent
- Include specific "do not" instructions where needed
- Regular checkpoints with evidence requirements
- Immediate escalation for blockers

### Testing Standards
- Tests must execute against real implementations
- No mock-only test suites
- API tests should hit actual endpoints
- Include performance benchmarks where relevant
- Capture actual output and metrics

### Progress Tracking
- Update status in real-time with evidence
- Mark tasks complete only with proof of execution
- Document blockers with specific details
- Create follow-up tasks for discovered issues
- Include git commit SHAs for traceability

## Templates Available

### In Repository (`templates/`)
1. **feature-implementation.md** - New feature development
2. **bug-investigation.md** - Complex debugging workflows
3. **refactoring-project.md** - Code improvement initiatives
4. **documentation-update.md** - Comprehensive doc updates
5. **security-review.md** - Security assessment workflows

### In DollhouseMCP Portfolio
Same templates available as elements for cross-project use:
- Can be activated via `activate_element "template-name" type="templates"`
- Portable across any project
- Continuously improved based on usage

## Monitoring and Metrics

Track in coordination documents:
- Task completion percentage with evidence
- Blocker count and resolution time
- Agent efficiency by role
- Quality scores from verification
- Actual vs estimated time
- Test coverage and pass rates

## Troubleshooting Guide

### Challenge: Maintaining Agent Focus
**Solution**: Provide clear, descriptive role names and boundaries
- Use specific titles like "Database Migration Specialist"
- Include "Your role is limited to X" in instructions
- Regular verification against original scope

### Challenge: Ensuring Real Testing
**Solution**: Specify testing requirements explicitly
- State "Tests must execute against running server"
- Require output from actual test runs
- Include performance metrics from real execution

### Challenge: Preventing Incomplete Work
**Solution**: Evidence-based completion criteria
- Require git diff output for code changes
- Demand test execution logs
- Show actual API responses
- Include screenshot or output of running feature

### Challenge: Managing Dependencies
**Solution**: Clear sequencing and communication
- Visual dependency graph in coordination doc
- Explicit handoff points between agents
- Shared context documents for complex state

## Integration with DollhouseMCP

This framework integrates with:
- **GitFlow Workflow**: Agents aware of branch context
- **CI/CD Pipeline**: Requirements included in agent instructions
- **Issue Tracking**: Tasks linked to GitHub issues
- **Session Notes**: Documented for future reference
- **Portfolio System**: Templates reusable across projects

## Continuous Improvement

After each orchestration:
1. Document what worked well
2. Note areas needing improvement
3. Update templates based on lessons learned
4. Share improvements back to portfolio
5. Refine agent role descriptions

## Next Steps

1. Review and customize templates for your needs
2. Create portfolio versions for cross-project use
3. Start with simple orchestrations to test workflow
4. Scale complexity based on success
5. Contribute improvements back to framework

---

*This framework evolves through usage. Please document lessons learned and contribute improvements.*
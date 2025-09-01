# Session Notes Template - Context-Aware Element Activation

**Date**: [YYYY-MM-DD]  
**Time**: [Start - End]  
**Duration**: [X hours]  
**Primary Branch**: [branch-name]  
**Session Type**: [Development | Planning | Debugging | Documentation | Review]  
**Participants**: [Human user, AI assistants]  

## Session Setup for Continuity

### Critical Context Elements
These should be activated immediately when resuming work:

#### Working Environment
```bash
# Repository and branch context
cd [repository-path]
git checkout [branch-name]
```

#### Essential Documents
```markdown
# Core context files to read for understanding
- Read: /path/to/CLAUDE.md  # Project instructions
- Read: /path/to/previous-session-notes.md  # Where we left off
- Read: /path/to/active-task-document.md  # Current work items
```

### On-Demand DollhouseMCP Elements

#### Primary Development Persona
**When to activate**: Only if doing active development work
```bash
activate_element "alex-sterling" type="personas"
# Use for: Code implementation, problem-solving, technical discussions
# Not needed for: Simple questions, documentation review, planning
```

#### Specialized Agents (Launch via Task tool)
**When to use**: For specific focused tasks

```markdown
## Verification Specialist
- **When**: After completing implementation work
- **How**: Launch via Task tool with specific verification goals
- **Example**: "Verify all security fixes in PR #359"

## Session Notes Writer  
- **When**: At end of significant work session
- **How**: Launch via Task tool to document full session
- **Example**: "Create comprehensive session notes for orchestration work"

## Documentation Specialist
- **When**: Need to create/update documentation
- **How**: Launch as needed for specific docs
```

#### Skills (Activate as needed)
```markdown
## Always Active Skills
[None currently - most skills are task-specific]

## Context-Specific Skills
- code-review: When reviewing PRs or code changes
- test-writer: When creating test suites  
- security-auditor: When checking for vulnerabilities
- performance-analyzer: When optimizing code
```

#### Templates (Reference when needed)
```markdown
## Available Templates
- coordination-template.md: For multi-agent orchestration
- feature-implementation.md: For new feature work
- verification-checklist.md: For quality assurance
- task-tracker.md: For progress tracking
```

## Session Overview

### Starting Context
[What was the state when session began? What problem needed solving?]

### Primary Objectives
1. [Main goal]
2. [Secondary goal]
3. [Tertiary goal]

### Session Type Rationale
[Why this session type? What made these objectives appropriate?]

## Work Completed

### Phase 1: [Phase Name]
**Active Elements**: [Which personas/skills were active and why]

#### Tasks Completed
- [Task 1 with evidence]
- [Task 2 with evidence]

#### Key Decisions
- [Decision with rationale]

### Phase 2: [Phase Name]
**Active Elements**: [Changed? Added? Removed? Why?]

[Continue pattern...]

## Element Activation Log

### Elements Used This Session
| Element Type | Name | When Activated | Purpose | When Deactivated |
|-------------|------|----------------|---------|------------------|
| Persona | alex-sterling | Start | Development work | End of coding phase |
| Skill | code-review | 10:30 AM | Review PR changes | 11:00 AM |
| Agent | verification-specialist | 11:15 AM | Verify implementation | 11:45 AM |

### Elements Available But Not Used
| Element Type | Name | Why Not Used |
|-------------|------|--------------|
| Skill | performance-analyzer | No performance concerns |
| Template | feature-implementation | Working on bug fix, not feature |

## Key Decisions Made

### Technical Decisions
1. **Decision**: [What was decided]
   - **Context**: [Why this came up]
   - **Options Considered**: [Alternatives]
   - **Rationale**: [Why this choice]
   - **Elements Consulted**: [Which personas/skills helped]

### Process Decisions
[Similar structure]

## Issues & Resolutions

### Encountered Issues
| Issue | When | Resolution | Elements Used |
|-------|------|------------|---------------|
| [Issue description] | [Time] | [How resolved] | [Which elements helped] |

## Code Changes

### Files Created
| File | Purpose | Reviewed By |
|------|---------|-------------|
| [path/file.ext] | [Why created] | [Which agent/persona] |

### Files Modified
| File | Changes | Validation |
|------|---------|------------|
| [path/file.ext] | [What changed] | [How verified] |

## Testing & Verification

### Tests Run
- [Test suite]: [Result]
- [Coverage]: [Percentage]

### Verification Performed
- [What was verified]
- [By which specialist]
- [Evidence location]

## Lessons Learned

### What Worked Well
- [Success pattern]
- [Effective element usage]

### What Could Improve
- [Issue to address]
- [Better element selection]

### Element Effectiveness
- **Most Useful**: [Which element and why]
- **Underutilized**: [What wasn't used effectively]
- **Missing**: [What element would have helped]

## Next Session Recommendations

### Immediate Setup Needs
These MUST be activated/read at session start:
1. [Critical context file]
2. [Essential branch/state]

### Likely Element Needs
Based on next tasks, consider activating:
- [Element type]: [Element name] for [purpose]
- [Element type]: [Element name] if [condition]

### Optional Elements
Available if needed:
- [Element]: [When it might be useful]

## Session Metrics

### Quantitative
- **Duration**: [Time]
- **Files Modified**: [Count]
- **Tests Written**: [Count]
- **Elements Activated**: [Count]
- **Context Switches**: [How many times elements changed]

### Qualitative
- **Productivity**: [High/Medium/Low]
- **Element Coordination**: [Smooth/Challenging]
- **Goal Achievement**: [Percentage]

## Handoff Notes

### For Next Human Session
[What the human needs to know]

### For Next AI Session
[What the AI needs to know about context]

### Critical Warnings
[Any gotchas or issues to watch for]

---

## Element Activation Guidelines

### When to Activate Personas
- **Development Work**: Activate development-focused personas
- **Review Work**: Activate verification/review personas
- **Documentation**: Activate documentation specialists
- **Planning**: Usually no special personas needed

### When to Use Skills
- **As Needed**: Most skills are task-specific
- **Not Persistent**: Activate for specific operation, then deactivate
- **Examples**: 
  - Need to review code? Activate code-review skill
  - Writing tests? Activate test-writer skill
  - Then deactivate when done

### When to Launch Agents
- **Via Task Tool**: Agents are launched for specific missions
- **Not Activated**: They run independently and report back
- **Examples**:
  - Verification needed? Launch verification-specialist agent
  - Documentation needed? Launch documentation agent

### When to Use Templates
- **Reference Only**: Templates aren't "activated"
- **Copy and Customize**: Use as starting points
- **Examples**:
  - Starting multi-agent work? Copy coordination-template
  - Tracking progress? Copy task-tracker

---

**Session Status**: [Complete | Partial | Interrupted]  
**Follow-up Required**: [Yes/No - Details]  
**Session Notes Generated By**: [Human | session-notes-writer agent | Manual]
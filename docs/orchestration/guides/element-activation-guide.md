# DollhouseMCP Element Activation Guide

## Understanding Element Types and When to Use Them

This guide explains when and how to activate different DollhouseMCP elements for maximum effectiveness while avoiding unnecessary context bloat.

## Core Principle: Activate Only What You Need

Unlike traditional software where having more tools available is generally better, AI context is a limited resource. Every activated element consumes tokens and adds complexity. The key is strategic activation based on actual needs.

## Element Types Overview

### 🎭 Personas
**What they are**: Behavioral profiles that modify how the AI assistant behaves  
**Activation model**: Persistent (stays active until deactivated)  
**Context cost**: High (full instructions loaded)  

### 🛠️ Skills
**What they are**: Specialized capabilities for specific tasks  
**Activation model**: Task-specific (activate → use → deactivate)  
**Context cost**: Medium (focused functionality)  

### 🤖 Agents
**What they are**: Autonomous entities launched for specific missions  
**Activation model**: Mission-based (launch via Task tool)  
**Context cost**: None (run in separate context)  

### 📄 Templates
**What they are**: Reusable document structures  
**Activation model**: Reference (copy and customize)  
**Context cost**: None (not activated, just referenced)  

### 🧠 Memories
**What they are**: Persistent context storage  
**Activation model**: As needed for continuity  
**Context cost**: Variable (depends on content)  

### 🎼 Ensembles
**What they are**: Coordinated groups of elements  
**Activation model**: Scenario-based  
**Context cost**: High (multiple elements)  

## Activation Decision Tree

```
Start New Session
├── What type of work?
│   ├── Development/Coding
│   │   ├── Activate: Development persona (e.g., alex-sterling)
│   │   ├── As Needed: Specific skills (code-review, test-writer)
│   │   └── After Implementation: Launch verification agent
│   │
│   ├── Planning/Architecture
│   │   ├── No special personas needed
│   │   ├── Reference: Planning templates
│   │   └── End of Session: Launch session-notes-writer agent
│   │
│   ├── Debugging/Troubleshooting
│   │   ├── Maybe: Development persona (if deep code work)
│   │   ├── Activate: Debugging-specific skills
│   │   └── After Fix: Launch verification agent
│   │
│   ├── Documentation
│   │   ├── Launch: Documentation specialist agent
│   │   ├── Reference: Documentation templates
│   │   └── No development personas needed
│   │
│   └── Review/QA
│       ├── Launch: Verification specialist agent
│       ├── Activate: Review skills as needed
│       └── No development personas needed
```

## Detailed Activation Guidelines

### Personas

#### When to Activate
- **Starting development work**: Need consistent coding approach
- **Complex problem-solving**: Need specific expertise
- **Extended sessions**: Need behavioral consistency

#### When NOT to Activate
- **Simple questions**: Default AI is sufficient
- **Documentation review**: No behavior modification needed
- **Planning discussions**: Natural interaction preferred
- **Using agents**: Agents have their own personas

#### Examples
```bash
# Good: Specific development need
activate_element "alex-sterling" type="personas"  # For thorough development work

# Bad: Activating everything "just in case"
activate_element "alex-sterling" type="personas"
activate_element "creative-writer" type="personas"  # Not doing creative writing!
activate_element "teacher" type="personas"  # Not teaching!
```

### Skills

#### When to Activate
- **Specific task ahead**: About to review code → activate code-review
- **Specialized operation**: Need to write tests → activate test-writer
- **Performance work**: Optimizing code → activate performance-analyzer

#### When to Deactivate
- **Task complete**: Finished code review → deactivate skill
- **Switching contexts**: Moving from testing to documentation
- **Session ending**: Clean up active skills

#### Examples
```bash
# Good: Task-specific activation
activate_element "code-review" type="skills"
# ... perform code review ...
deactivate_element "code-review" type="skills"

# Bad: Keeping skills active "for later"
activate_element "code-review" type="skills"
activate_element "test-writer" type="skills"
activate_element "security-auditor" type="skills"
# ... only doing documentation work ...
```

### Agents

#### When to Launch
- **Verification needed**: After completing implementation
- **Documentation required**: After significant changes
- **Session notes**: At end of productive session
- **Specialized analysis**: Security audit, performance review

#### How to Launch
```bash
# Via Task tool, not direct activation
Task(description="Verify PR implementation", 
     prompt="Check all security fixes in PR #359", 
     subagent_type="general-purpose")
```

#### Important: Agents vs Activated Elements
- **Agents**: Run independently, report back, don't persist
- **Activated Elements**: Modify current session, persist until deactivated

### Templates

#### When to Use
- **Starting structured work**: Copy coordination template
- **Tracking progress**: Copy task tracker template
- **Creating documentation**: Copy appropriate doc template

#### How to Use
```bash
# Templates are referenced, not activated
Read "/path/to/templates/coordination-template.md"
# Then create your own file based on it
```

### Memories

#### When to Activate
- **Continuing previous work**: Need context from last session
- **Long-term project**: Need persistent information
- **Cross-session learning**: Need to remember patterns

#### When NOT to Activate
- **Fresh start**: Beginning new, unrelated work
- **Simple tasks**: No historical context needed
- **One-off operations**: No continuity required

### Ensembles

#### When to Activate
- **Complex scenarios**: Need multiple coordinated capabilities
- **Role-playing**: Need comprehensive character
- **Specialized workflow**: Need pre-configured element set

#### When NOT to Activate
- **Simple tasks**: Single element sufficient
- **Exploration**: Still figuring out needs
- **Resource constraints**: Limited context available

## Context Management Best Practices

### 1. Start Minimal
- Begin sessions with minimum required elements
- Add elements as needs become clear
- Remove elements when no longer needed

### 2. Document Activation Rationale
- Always note WHY you activated an element
- Record WHEN you deactivated it
- Note if an element wasn't helpful

### 3. Use Agents for Isolated Tasks
- Agents don't consume main session context
- Perfect for verification, documentation, analysis
- Report back with results

### 4. Regular Cleanup
```bash
# Check what's active
get_active_elements type="personas"
get_active_elements type="skills"

# Deactivate unneeded elements
deactivate_element "unused-skill" type="skills"
```

### 5. Session Type Templates

#### Development Session
```bash
# Start
activate_element "alex-sterling" type="personas"

# As needed during session
activate_element "code-review" type="skills"
# ... use it ...
deactivate_element "code-review" type="skills"

# End of session
Task(description="Create session notes", 
     prompt="Document development work completed today",
     subagent_type="general-purpose")
```

#### Planning Session
```bash
# Start - no special personas needed
Read "planning-template.md"

# Work with natural AI behavior

# End
Task(description="Document planning decisions",
     prompt="Create planning session notes",
     subagent_type="general-purpose")
```

## Common Anti-Patterns

### ❌ The Kitchen Sink
Activating every potentially useful element at session start.
**Problem**: Wastes context, adds confusion, slows responses.

### ❌ The Persistent Skill
Keeping skills active throughout entire session.
**Problem**: Skills are task-specific and should be temporary.

### ❌ The Wrong Tool
Using personas when agents would be better.
**Problem**: Personas modify main session; agents run independently.

### ❌ The Template Activation
Trying to "activate" templates.
**Problem**: Templates are references, not active elements.

## Quick Reference Card

| Task | Persona? | Skills? | Agents? | Templates? |
|------|----------|---------|---------|------------|
| Writing code | Yes (dev) | As needed | No | Maybe |
| Reviewing PR | Maybe | Yes (review) | Yes (verify) | Checklist |
| Planning | No | No | No | Yes |
| Debugging | Maybe | Yes (debug) | No | No |
| Documentation | No | No | Yes (doc) | Yes |
| Testing | Maybe | Yes (test) | Yes (verify) | Yes |
| Session notes | No | No | Yes (notes) | Yes |

## Measurement and Optimization

### Track Your Usage
- Note which elements you actually used
- Identify patterns in your workflow
- Optimize activation strategies

### Signs of Over-Activation
- Slow responses
- Context limit warnings
- Elements never used during session
- Confusion about active capabilities

### Signs of Under-Activation
- Repeatedly needing same capability
- Manual work that could be automated
- Missing specialized knowledge
- Inconsistent approaches

## Conclusion

Effective element activation is about:
1. **Right tool for the job** - Match element to task
2. **Just in time** - Activate when needed, not before
3. **Clean up** - Deactivate when done
4. **Document why** - Record rationale for future

Remember: In AI-assisted development, less is often more. A focused session with the right elements beats an overloaded session every time.

---

*"The art of element activation is knowing not just what you can activate, but what you should activate."*
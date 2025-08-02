# Element Types Reference

This document provides detailed information about each element type in the DollhouseMCP portfolio system.

## Overview

The portfolio system supports six core element types, each serving a specific purpose in AI customization:

| Element Type | Purpose | Status |
|-------------|---------|--------|
| **Personas** | Behavioral profiles that modify AI personality | ✅ Implemented |
| **Skills** | Discrete capabilities for specific tasks | ✅ Implemented |
| **Templates** | Reusable content structures | ✅ Implemented |
| **Agents** | Autonomous goal-oriented actors | ✅ Implemented |
| **Memories** | Persistent context storage | 🔬 Experimental |
| **Ensembles** | Groups of elements working together | 🔬 Experimental |

## Personas

### Purpose
Personas are behavioral profiles that modify how the AI interacts, communicates, and approaches tasks. They're the original element type that DollhouseMCP was built around.

### Use Cases
- Customer service representatives with specific tones
- Creative writers with unique styles
- Technical experts with domain knowledge
- Educational tutors with teaching approaches
- Role-playing characters for games

### Metadata Schema
```yaml
name: Professional Writer
description: A skilled writer focused on clear, engaging content
version: 1.0.0
author: dollhousemcp
created: 2025-07-20T10:00:00Z
updated: 2025-08-02T10:00:00Z
category: creative
tags:
  - writing
  - professional
  - content-creation
triggers:
  - write
  - draft
  - compose
```

### Special Features
- **Activation Triggers**: Keywords that activate the persona
- **Category System**: Organized into creative, technical, educational, etc.
- **Marketplace Integration**: Can be shared via GitHub marketplace
- **Indicator System**: Shows active persona in responses

### Example File
```markdown
---
name: Creative Writer
description: An imaginative storyteller focused on engaging narratives
version: 1.0.0
author: mickdarling
category: creative
triggers:
  - story
  - creative
  - narrative
---

You are a creative writer with a passion for storytelling. Your writing style is:
- Vivid and descriptive
- Character-driven
- Emotionally engaging
- Rich in sensory details

When asked to write, you craft compelling narratives that draw readers in...
```

### MCP Tool Usage
```bash
# List all personas
list_elements --type persona

# Activate a persona
activate_element "Creative Writer" --type persona

# Create new persona
create_element --type persona --name "Data Analyst" --description "Expert in data analysis"

# Edit persona
edit_element "Creative Writer" --type persona --field "description" --value "Master storyteller"
```

## Skills

### Purpose
Skills are discrete capabilities that can be activated to perform specific tasks. Unlike personas that modify behavior, skills add functional abilities.

### Use Cases
- Code review and analysis
- Language translation
- Data formatting and conversion
- Mathematical calculations
- API integration helpers

### Metadata Schema
```yaml
name: Code Reviewer
description: Analyzes code for quality, security, and best practices
version: 1.0.0
author: dollhousemcp
created: 2025-07-20T10:00:00Z
proficiency:
  level: expert
  rating: 4.5
domain: software-development
languages:
  - javascript
  - typescript
  - python
parameters:
  - name: strictness
    type: string
    description: Review strictness level
    default: medium
    enum: [low, medium, high]
  - name: focusAreas
    type: array
    description: Specific areas to focus on
    items:
      type: string
      enum: [security, performance, style, bugs]
```

### Special Features
- **Parameter System**: Configurable behavior through parameters
- **Proficiency Tracking**: Skill level and ratings
- **Domain Categorization**: Organized by area of expertise
- **Language Support**: Programming language specifications

### Example File
```markdown
---
name: Code Reviewer
description: Expert code review with focus on quality and security
version: 2.0.0
author: dollhousemcp
proficiency:
  level: expert
  rating: 4.8
domain: software-development
languages:
  - javascript
  - typescript
parameters:
  - name: strictness
    type: string
    default: medium
---

## Code Review Skill

I perform comprehensive code reviews focusing on:
- Security vulnerabilities
- Performance optimizations
- Code style and readability
- Best practices
- Potential bugs

My review process includes...
```

### MCP Tool Usage
```bash
# List all skills
list_elements --type skill

# Activate a skill
activate_element "Code Reviewer" --type skill

# Create new skill
create_element --type skill --name "API Integrator" --description "Helps integrate external APIs"

# Configure skill parameters
edit_element "Code Reviewer" --type skill --field "parameters.strictness" --value "high"
```

## Templates

### Purpose
Templates are reusable content structures that can be filled with variables to generate consistent outputs.

### Use Cases
- Email templates for various scenarios
- Report generation formats
- Code scaffolding templates
- Documentation structures
- Meeting notes formats

### Metadata Schema
```yaml
name: Sprint Report
description: Weekly sprint progress report template
version: 1.0.0
author: dollhousemcp
created: 2025-07-21T10:00:00Z
variables:
  - name: sprintNumber
    type: number
    required: true
  - name: teamName
    type: string
    required: true
  - name: completedTasks
    type: array
    required: false
  - name: blockers
    type: array
    required: false
outputFormats:
  - markdown
  - html
  - pdf
includes:
  - header-template
  - footer-template
```

### Special Features
- **Variable System**: Dynamic content replacement
- **Output Formats**: Multiple rendering options
- **Template Includes**: Compose from other templates
- **Validation Rules**: Ensure required variables

### Example File
```markdown
---
name: Sprint Report
description: Weekly sprint progress report
version: 1.0.0
variables:
  - name: sprintNumber
    type: number
    required: true
  - name: teamName
    type: string
    required: true
---

# Sprint {{sprintNumber}} Report - Team {{teamName}}

**Date**: {{date}}
**Sprint Duration**: {{startDate}} - {{endDate}}

## Completed Tasks
{{#each completedTasks}}
- {{this.title}} ({{this.points}} points)
{{/each}}

## In Progress
{{#each inProgressTasks}}
- {{this.title}} - {{this.assignee}}
{{/each}}

## Blockers
{{#if blockers}}
{{#each blockers}}
- ⚠️ {{this}}
{{/each}}
{{else}}
No blockers reported.
{{/if}}
```

### MCP Tool Usage
```bash
# List all templates
list_elements --type template

# Render a template
render_template "Sprint Report" --variables '{"sprintNumber": 23, "teamName": "Phoenix"}'

# Create new template
create_element --type template --name "Bug Report" --description "Standardized bug report format"
```

## Agents

### Purpose
Agents are autonomous, goal-oriented actors that can make decisions and take actions to achieve specific objectives.

### Use Cases
- Project management assistants
- Research agents for information gathering
- Testing agents for quality assurance
- Monitoring agents for system health
- Workflow automation agents

### Metadata Schema
```yaml
name: Project Manager
description: Autonomous project management assistant
version: 1.0.0
author: dollhousemcp
created: 2025-07-22T10:00:00Z
capabilities:
  - task-management
  - priority-assessment
  - resource-allocation
  - risk-analysis
goals:
  primary: Ensure project delivery on time
  secondary:
    - Optimize resource utilization
    - Minimize risks
    - Maintain team morale
decisionFramework:
  type: eisenhower-matrix
  config:
    urgentImportant: immediate
    importantNotUrgent: schedule
    urgentNotImportant: delegate
    neitherUrgentNorImportant: eliminate
persistence:
  stateFile: .state/project-manager-state.json
  saveInterval: 300  # seconds
```

### Special Features
- **Goal System**: Primary and secondary objectives
- **Decision Frameworks**: Structured decision-making
- **State Persistence**: Maintains context between sessions
- **Risk Assessment**: Evaluates potential issues
- **Autonomous Actions**: Can initiate tasks

### Example File
```markdown
---
name: QA Test Agent
description: Automated testing and quality assurance
version: 1.0.0
capabilities:
  - test-planning
  - bug-detection
  - regression-testing
goals:
  primary: Ensure software quality
  secondary:
    - Find bugs before production
    - Improve test coverage
---

## QA Test Agent

I am an autonomous QA agent focused on ensuring software quality through:

1. **Test Planning**: Creating comprehensive test strategies
2. **Bug Detection**: Identifying issues before they reach production
3. **Regression Testing**: Ensuring new changes don't break existing features

My decision process follows...
```

### MCP Tool Usage
```bash
# List all agents
list_elements --type agent

# Execute an agent with a goal
execute_agent "Project Manager" --goal "Plan next sprint"

# Create new agent
create_element --type agent --name "Security Monitor" --description "Monitors for security issues"

# Check agent state
get_element_details "Project Manager" --type agent
```

## Memories (Experimental)

### Purpose
Memories provide persistent context storage, allowing the AI to maintain information across sessions and build long-term knowledge.

### Use Cases
- User preference tracking
- Project context retention
- Learning from past interactions
- Knowledge base building
- Relationship management

### Metadata Schema
```yaml
name: Project Context
description: Maintains context about ongoing projects
version: 1.0.0
author: dollhousemcp
created: 2025-07-23T10:00:00Z
storage:
  backend: file  # or 'sqlite', 'redis'
  location: .storage/project-context.json
retention:
  policy: sliding-window
  duration: 30d
  maxEntries: 1000
privacy:
  level: private  # or 'shared', 'public'
  encryption: true
searchable: true
indexes:
  - field: project_name
  - field: timestamp
  - field: tags
```

### Special Features
- **Multiple Backends**: File, database, or cache storage
- **Retention Policies**: Automatic cleanup rules
- **Privacy Levels**: Control access and sharing
- **Search Capability**: Query stored memories
- **Learning Integration**: Improve from stored data

### Example File
```markdown
---
name: User Preferences
description: Remembers user preferences and patterns
version: 1.0.0
storage:
  backend: file
  location: .storage/user-preferences.json
retention:
  policy: permanent
privacy:
  level: private
---

## User Preferences Memory

This memory system tracks:
- Communication style preferences
- Technical skill level
- Project interests
- Timezone and availability
- Preferred tools and frameworks

Memory is automatically updated based on interactions...
```

### MCP Tool Usage
```bash
# Note: Memory tools are still in development
# These are planned interfaces

# Query memories
query_memory "Project Context" --query "current sprint goals"

# Add to memory
add_memory "User Preferences" --data '{"preferredLanguage": "TypeScript"}'

# Clear old memories
cleanup_memory "Project Context" --older-than "30d"
```

## Ensembles (Experimental)

### Purpose
Ensembles combine multiple elements into a unified entity, creating complex behaviors through element composition. Important: Ensembles create ONE entity with layered capabilities, not multiple interacting characters.

### Use Cases
- Full-stack developer (combines multiple skills)
- Project team (persona + skills + memories)
- Complex workflows (templates + agents)
- Specialized assistants (all element types)
- Domain experts (curated combinations)

### Metadata Schema
```yaml
name: Full-Stack Developer
description: Complete development capabilities in one ensemble
version: 1.0.0
author: dollhousemcp
created: 2025-07-23T10:00:00Z
members:
  - type: persona
    ref: professional-developer
    weight: 1.0
  - type: skill
    ref: frontend-development
    weight: 0.8
  - type: skill
    ref: backend-development
    weight: 0.8
  - type: skill
    ref: database-design
    weight: 0.6
  - type: template
    ref: code-documentation
    weight: 0.5
activationStrategy: all  # or 'sequential', 'conditional', 'lazy'
conflictResolution:
  strategy: weighted-average
  tieBreaker: first-member
```

### Special Features
- **Unified Entity**: All elements work as ONE
- **Activation Strategies**: How elements combine
- **Conflict Resolution**: Handle overlapping capabilities
- **Weight System**: Prioritize element influence
- **Dynamic Composition**: Add/remove elements

### Example File
```markdown
---
name: DevOps Engineer
description: Complete DevOps capabilities ensemble
version: 1.0.0
members:
  - type: persona
    ref: technical-expert
  - type: skill
    ref: kubernetes-management
  - type: skill
    ref: ci-cd-pipelines
  - type: agent
    ref: deployment-automator
activationStrategy: all
---

## DevOps Engineer Ensemble

This ensemble combines:
- Technical expertise persona
- Kubernetes management skills
- CI/CD pipeline knowledge
- Automated deployment capabilities

All working together as a unified DevOps expert...
```

### MCP Tool Usage
```bash
# List all ensembles
list_elements --type ensemble

# Activate an ensemble
activate_element "Full-Stack Developer" --type ensemble

# Create new ensemble
create_element --type ensemble --name "Data Science Team" --description "Complete data science capabilities"

# Check ensemble status
get_ensemble_status "Full-Stack Developer"
```

## Element Interactions

### Reference System
Elements can reference each other:
```yaml
references:
  - type: requires
    element: skill/code-reviewer
  - type: includes
    element: template/header-template
  - type: uses
    element: memory/project-context
```

### Dependency Management
- **Hard Dependencies**: Required for operation
- **Soft Dependencies**: Optional enhancements
- **Circular Detection**: Prevents infinite loops
- **Lazy Loading**: Load only when needed

### Conflict Examples
1. **Persona Conflicts**: Formal vs casual communication
2. **Skill Overlaps**: Multiple translation skills
3. **Template Variables**: Same variable names
4. **Agent Goals**: Competing objectives

## Best Practices by Type

### Personas
- Keep instructions clear and focused
- Use specific triggers
- Avoid overlapping behaviors
- Test with various prompts

### Skills
- Define clear parameters
- Document proficiency levels
- Provide usage examples
- Keep skills atomic

### Templates
- Use meaningful variable names
- Provide default values
- Document required variables
- Test with edge cases

### Agents
- Define measurable goals
- Implement safety checks
- Log decision rationale
- Limit autonomous actions

### Memories
- Set appropriate retention
- Consider privacy implications
- Index for performance
- Regular cleanup

### Ensembles
- Keep compositions focused
- Test element interactions
- Document conflicts
- Monitor performance

## Future Element Types

### Under Consideration
- **Workflows**: Multi-step processes
- **Policies**: Behavioral constraints
- **Datasets**: Reference data storage
- **Connectors**: External integrations
- **Monitors**: System observers

### Extension Points
The system is designed for easy extension:
1. Implement `IElement` interface
2. Create manager class
3. Add to `ElementType` enum
4. Update MCP tools
5. Write tests

## Summary

The element system provides a flexible foundation for AI customization. Each element type serves a specific purpose while working together through the unified interface. As the system evolves, new element types can be added without disrupting existing functionality.
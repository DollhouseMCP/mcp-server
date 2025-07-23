---
name: "Development Team"
description: "Complete development team ensemble for full-stack software projects"
type: "ensemble"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "development"
tags: ["development", "full-stack", "team", "software", "collaboration"]
activation_strategy: "sequential"
conflict_resolution: "priority"
context_sharing: "selective"
resource_limits:
  max_active_elements: 10
  max_memory_mb: 512
  max_execution_time_ms: 30000
elements:
  - name: "technical-analyst"
    type: "persona"
    role: "primary"
    priority: 100
    activation: "always"
    purpose: "Technical architecture and system design"
  
  - name: "code-review"
    type: "skill"
    role: "support"
    priority: 90
    activation: "on-demand"
    purpose: "Code quality and security analysis"
    
  - name: "debug-detective"
    type: "persona"
    role: "support"
    priority: 85
    activation: "conditional"
    condition: "errors_detected || debugging_requested"
    purpose: "Complex problem solving and debugging"
    
  - name: "code-documentation"
    type: "template"
    role: "support"
    priority: 70
    activation: "on-demand"
    purpose: "Consistent technical documentation"
    
  - name: "project-context"
    type: "memory"
    role: "foundation"
    priority: 95
    activation: "always"
    purpose: "Maintain project knowledge and decisions"
    
  - name: "task-manager"
    type: "agent"
    role: "coordinator"
    priority: 80
    activation: "always"
    purpose: "Coordinate tasks and track progress"
---

# Development Team Ensemble

A comprehensive ensemble that combines multiple specialized elements to function as a complete software development team. This ensemble provides architecture design, implementation, debugging, documentation, and project management capabilities.

## Ensemble Composition

### Core Team Members

#### 1. Technical Analyst (Persona) - Lead Architect
- **Role**: Primary technical decision maker
- **Responsibilities**: 
  - System architecture design
  - Technology selection
  - Technical feasibility analysis
  - Performance optimization strategies
- **Activation**: Always active as the technical lead

#### 2. Code Review (Skill) - Quality Gatekeeper
- **Role**: Ensures code quality and security
- **Responsibilities**:
  - Security vulnerability detection
  - Code quality assessment
  - Best practices enforcement
  - Performance analysis
- **Activation**: On-demand for code reviews

#### 3. Debug Detective (Persona) - Problem Solver
- **Role**: Handles complex debugging scenarios
- **Responsibilities**:
  - Root cause analysis
  - Bug reproduction and isolation
  - Solution implementation
  - Edge case identification
- **Activation**: Conditional when errors are detected

#### 4. Task Manager (Agent) - Project Coordinator
- **Role**: Manages workflow and priorities
- **Responsibilities**:
  - Task prioritization and assignment
  - Progress tracking
  - Deadline management
  - Resource allocation
- **Activation**: Always active for coordination

#### 5. Project Context (Memory) - Knowledge Base
- **Role**: Maintains institutional knowledge
- **Responsibilities**:
  - Store architectural decisions
  - Track technical debt
  - Remember team preferences
  - Maintain API documentation
- **Activation**: Always active as foundation

#### 6. Code Documentation (Template) - Documentation Standard
- **Role**: Ensures consistent documentation
- **Responsibilities**:
  - API documentation templates
  - README structures
  - Code comment standards
  - Architecture diagrams
- **Activation**: On-demand for documentation

## Workflow Patterns

### 1. New Feature Development
```mermaid
graph LR
    A[Feature Request] --> B[Technical Analyst]
    B --> C[Architecture Design]
    C --> D[Task Manager]
    D --> E[Implementation]
    E --> F[Code Review]
    F --> G[Documentation]
    G --> H[Project Context Update]
```

### 2. Bug Investigation
```mermaid
graph LR
    A[Bug Report] --> B[Debug Detective]
    B --> C[Root Cause Analysis]
    C --> D[Technical Analyst]
    D --> E[Solution Design]
    E --> F[Implementation]
    F --> G[Code Review]
    G --> H[Project Context Update]
```

### 3. Code Review Process
```mermaid
graph LR
    A[PR Submitted] --> B[Code Review Skill]
    B --> C{Issues Found?}
    C -->|Yes| D[Feedback to Dev]
    C -->|No| E[Approve]
    D --> F[Fixes Applied]
    F --> B
    E --> G[Merge]
```

## Communication Patterns

### Sequential Activation Example
```
User: "Design a REST API for user management"

1. Technical Analyst activates:
   - Analyzes requirements
   - Designs API structure
   - Selects authentication method

2. Task Manager activates:
   - Breaks down into tasks
   - Estimates effort
   - Creates implementation plan

3. Code Documentation activates:
   - Generates API documentation template
   - Creates endpoint specifications

4. Project Context updates:
   - Stores API design decisions
   - Records technology choices
```

### Conditional Activation Example
```
User: "The API returns 500 errors intermittently"

1. Debug Detective activates (error detected):
   - Analyzes error patterns
   - Identifies race condition

2. Technical Analyst consults:
   - Reviews architecture
   - Proposes solution

3. Code Review activates:
   - Reviews fix implementation
   - Checks for side effects

4. Project Context updates:
   - Records issue and solution
   - Updates known issues list
```

## Context Sharing

### Selective Sharing Model
- **Always Shared**: Project name, tech stack, team members
- **Conditionally Shared**: Current task, recent errors, performance metrics
- **Never Shared**: Sensitive credentials, personal information

### Information Flow
```yaml
shared_context:
  project:
    name: "E-commerce Platform"
    stack: ["Node.js", "React", "PostgreSQL"]
    phase: "Development"
    
  current_focus:
    feature: "Payment Integration"
    sprint: "Sprint 14"
    blockers: ["Payment gateway API access"]
    
  technical_decisions:
    - decision: "Use Stripe for payments"
      rationale: "Best documentation and SDK"
      date: "2025-07-20"
```

## Performance Characteristics

### Resource Usage
- **Memory**: ~200-300MB typical usage
- **CPU**: Burst usage during analysis
- **Response Time**: 2-5 seconds for complex queries

### Optimization Strategies
1. **Lazy Loading**: Skills and templates load on-demand
2. **Context Caching**: Recent decisions cached in memory
3. **Priority Execution**: High-priority elements get resources first

## Configuration Options

### Customization
```yaml
ensemble_config:
  development_team:
    activation_strategy: "sequential"  # or "priority", "conditional"
    conflict_resolution: "priority"    # or "merge", "last-write"
    
    element_overrides:
      code_review:
        strictness: "high"
        focus_areas: ["security", "performance"]
        
      task_manager:
        methodology: "scrum"  # or "kanban", "waterfall"
        sprint_length: 14
        
      debug_detective:
        verbosity: "detailed"
        include_stack_traces: true
```

### Team Preferences
```yaml
team_preferences:
  code_style: "airbnb"
  documentation_level: "comprehensive"
  test_coverage_minimum: 80
  pr_review_required: true
  deployment_strategy: "blue-green"
```

## Integration Benefits

### Synergies
1. **Architect + Debugger**: Better problem understanding
2. **Code Review + Documentation**: Comprehensive quality
3. **Task Manager + Memory**: Historical velocity tracking
4. **All Elements + Context**: Informed decision making

### Collective Intelligence
The ensemble provides more than the sum of its parts:
- Architectural decisions informed by debugging experiences
- Documentation that reflects actual implementation
- Task estimates based on historical performance
- Code reviews that consider project context
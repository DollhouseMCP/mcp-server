# Element Implementation Reference Guide

## Overview
This guide serves as the definitive reference for implementing the multiple element types system in DollhouseMCP. It captures all design decisions, patterns, and implementation details from our planning session.

## Core Concepts

### Elements
The fundamental units of the portfolio system. Each element represents a distinct capability or resource.

**Element Types:**
- **Personas** - Behavioral profiles that define AI personality and interaction style
- **Skills** - Discrete capabilities for specific tasks (code review, translation, etc.)
- **Templates** - Reusable content structures with variable substitution
- **Agents** - Autonomous goal-oriented actors with decision-making capabilities
- **Memories** - Persistent context storage for continuity and learning
- **Ensembles** - Groups of elements working together as a cohesive unit

### Portfolio
A user's personal collection of elements, organized by type in a structured directory.

### Collection
The community repository of shareable elements (GitHub-based).

## Architecture Patterns

### 1. Base Element Interface
Every element MUST implement:

```typescript
interface IElement {
  // Identity
  id: string;
  type: ElementType;
  version: string;
  
  // Metadata
  metadata: IElementMetadata;
  
  // Features
  references?: Reference[];      // External/internal resources
  extensions?: Record<string, any>; // Future extensibility
  ratings?: ElementRatings;      // AI + user evaluations
  
  // Core operations
  validate(): ValidationResult;
  serialize(): string;
  deserialize(data: string): void;
  receiveFeedback?(feedback: string, context?: FeedbackContext): void;
  
  // Lifecycle (optional)
  beforeActivate?(): Promise<void>;
  activate?(): Promise<void>;
  afterActivate?(): Promise<void>;
  deactivate?(): Promise<void>;
  getStatus(): ElementStatus;
}
```

### 2. Element Manager Pattern
Each element type has a corresponding manager:

```typescript
interface IElementManager<T extends IElement> {
  load(path: string): Promise<T>;
  save(element: T, path: string): Promise<void>;
  list(): Promise<T[]>;
  find(predicate: (element: T) => boolean): Promise<T | undefined>;
  validate(element: T): ValidationResult;
}
```

### 3. Rating System Pattern
All elements support dual ratings:

```typescript
interface ElementRatings {
  aiRating: number;           // 0-5 stars (AI evaluation)
  userRating?: number;        // 0-5 stars (user feedback)
  ratingCount: number;
  lastEvaluated: Date;
  confidence: number;         // 0-1
  breakdown?: RatingBreakdown;
  ratingDelta?: number;       // userRating - aiRating
  trend: 'improving' | 'declining' | 'stable';
  feedbackHistory?: UserFeedback[];
}
```

## Implementation Checklist

### For Each Element Type:

#### 1. Core Implementation
- [ ] Create element class implementing `IElement`
- [ ] Define element-specific metadata interface
- [ ] Implement validation logic
- [ ] Add serialization/deserialization
- [ ] Create element manager class

#### 2. Features
- [ ] Reference resolution
- [ ] Rating system integration
- [ ] Natural language feedback processing
- [ ] Extension field handling
- [ ] Lifecycle methods (if applicable)

#### 3. Integration
- [ ] MCP tool updates (use generic tools)
- [ ] Collection browsing support
- [ ] Import/export functionality
- [ ] Cross-element compatibility

#### 4. Testing
- [ ] Unit tests for element operations
- [ ] Integration tests with other elements
- [ ] Performance tests
- [ ] Migration tests (for personas)

## Element-Specific Requirements

### Personas
- Must maintain existing functionality
- Serve as template for other elements
- Support behavior modification of agents

### Skills
- Parameter system for configuration
- Proficiency tracking with 5-star ratings
- Domain categorization

### Templates
- Variable substitution engine
- Template composition (includes)
- Multiple output formats

### Agents
- Eisenhower matrix (importance × urgency)
- Risk assessment with damage prevention
- Decision frameworks (rule-based, ML, programmatic)
- State persistence between sessions
- Goal management system

### Memories
- Multiple storage backends
- Retention policies
- Privacy levels
- Search capabilities
- Learning from interactions
- **Future**: Intelligent content-based sequencing
- **Future**: RAG system integration (import/export)
- **Future**: Memory collection sharing

### Ensembles
- Activation strategies (sequential, parallel, lazy, conditional)
- Conflict resolution
- Shared context management
- Nested ensemble support

## MCP Tool Strategy

### Generic Tools (work with all elements)
- `list_elements --type [element_type]`
- `activate_element "[name]" --type [element_type]`
- `deactivate_element "[name]" --type [element_type]`
- `get_element_details "[name]" --type [element_type]`
- `create_element --type [element_type] [params]`
- `edit_element "[name]" --type [element_type] [changes]`

### Element-Specific Tools (only where necessary)
- `render_template "[name]" --data '{...}'` (templates only)
- `run_agent "[name]" --goal "[goal]"` (agents only)
- `get_ensemble_status "[name]"` (ensembles only)

## File Structure Patterns

### Element Files
```yaml
# Metadata in YAML frontmatter
name: Element Name
description: What this element does
type: skill  # persona, skill, template, agent, memory, ensemble
version: 1.0.0
author: username
created: 2025-07-20
ratings:
  aiRating: 4.2
  userRating: 3.8
  ratingCount: 47
references:
  - type: external
    uri: https://example.com/docs
    title: Documentation
extensions:
  customField: value
---
# Element-specific content below
```

### Directory Structure
```
~/.dollhouse/portfolio/
├── personas/
│   ├── creative-writer.md
│   └── ...
├── skills/
│   ├── code-review.md
│   └── ...
├── templates/
│   ├── meeting-notes.md
│   └── ...
├── agents/
│   ├── project-manager.md
│   └── .state/          # Agent state files
├── memories/
│   ├── project-context.md
│   └── .storage/        # Memory backends
└── ensembles/
    └── development-team.md
```

## Common Pitfalls to Avoid

1. **Don't hardcode paths** - Use PortfolioManager for all paths
2. **Don't skip validation** - Every element must validate before use
3. **Don't ignore ratings** - Build in feedback loops from the start
4. **Don't forget extensibility** - Use extensions field for future features
5. **Don't mix concerns** - Keep element logic separate from managers

## Decision Rationale

### Why "Element" not "Content Type"?
- Cleaner, more intuitive terminology
- Shorter in code and documentation
- Better represents discrete units of functionality

### Why No Backward Compatibility?
- Very small/zero user base
- Reduces API complexity
- Cleaner implementation
- Avoids tool bloat for AI

### Why Universal Ratings?
- Continuous improvement loop
- Gap between AI and user perception drives insights
- Natural language feedback is user-friendly
- Consistent across all element types

### Why References and Extensions?
- Future-proof design
- Support for RAG and external resources
- Extensibility without refactoring
- Room for organizational customization

## Success Metrics

1. **All elements implement core interface** - 100% compliance
2. **Migration preserves all data** - Zero data loss
3. **Performance maintained** - No regression from current
4. **User satisfaction** - Positive feedback on new capabilities
5. **Developer experience** - Easy to add new element types

---
*This guide will be updated as implementation progresses*
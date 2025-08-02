# Element System Architecture

## Overview

The DollhouseMCP Element System is a flexible, extensible architecture that transforms the project from a simple persona manager into a comprehensive AI portfolio system. This document describes the design philosophy, core components, and relationships between different element types.

## Design Philosophy

### 1. Unified Interface
Every element type implements the same `IElement` interface, ensuring consistency across the system. This allows for:
- Generic tools that work with all element types
- Consistent validation and error handling
- Unified storage and retrieval patterns
- Common rating and feedback systems

### 2. Type Safety First
The entire system is built with TypeScript, providing:
- Compile-time type checking
- IntelliSense support in IDEs
- Self-documenting code through interfaces
- Runtime validation through type guards

### 3. Security by Design
Every element operation includes:
- Input sanitization and validation
- Path traversal prevention
- Memory usage limits
- Audit logging for sensitive operations
- Unicode normalization to prevent homograph attacks

### 4. Extensibility
New element types can be added without modifying core systems:
- Extend `BaseElement` for automatic feature inheritance
- Implement `IElementManager` for CRUD operations
- Register with `ElementType` enum
- Generic MCP tools automatically support new types

## Core Architecture

### Element Type Hierarchy

```
IElement (interface)
    ├── BaseElement (abstract class)
    │   ├── PersonaElement
    │   ├── Skill
    │   ├── Template
    │   ├── Agent
    │   ├── Memory (planned)
    │   └── Ensemble (planned)
    │
    └── IElementManager<T extends IElement> (interface)
        ├── PersonaElementManager
        ├── SkillManager
        ├── TemplateManager
        ├── AgentManager
        ├── MemoryManager (planned)
        └── EnsembleManager (planned)
```

### Directory Structure

```
~/.dollhouse/portfolio/
├── persona/          # Behavioral profiles (formerly ~/.dollhouse/personas/)
├── skill/            # Discrete capabilities
├── template/         # Reusable content structures
├── agent/            # Autonomous goal-oriented actors
│   └── .state/       # Agent state persistence
├── memory/           # Persistent context storage (planned)
│   └── .storage/     # Memory backend data
└── ensemble/         # Element groups (planned)
    └── .configs/     # Ensemble configurations
```

### Key Interfaces

#### IElement
The fundamental interface that all elements must implement:

```typescript
interface IElement {
  // Identity
  id: string;                    // Unique identifier
  type: ElementType;             // Element type enum
  version: string;               // Semantic version
  
  // Core data
  metadata: IElementMetadata;    // Name, description, author, etc.
  
  // Optional features
  references?: Reference[];      // External resources
  extensions?: Record<string, any>; // Future extensibility
  ratings?: ElementRatings;      // AI and user ratings
  
  // Core operations
  validate(): ElementValidationResult;
  serialize(): string;
  deserialize(data: string): void;
  
  // Optional operations
  activate?(): Promise<void>;
  deactivate?(): Promise<void>;
  receiveFeedback?(feedback: string): void;
}
```

#### IElementManager
Manages CRUD operations for a specific element type:

```typescript
interface IElementManager<T extends IElement> {
  create(data: any): Promise<T>;
  load(path: string): Promise<T>;
  save(element: T, path: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<T[]>;
  find(predicate: (element: T) => boolean): Promise<T | undefined>;
  validate(element: T): ValidationResult;
}
```

## Element Lifecycle

### 1. Creation
```
User Input → Validation → Element Creation → Manager.save() → File System
```

### 2. Activation
```
MCP Tool → Manager.find() → Element.activate() → Active Registry → In Use
```

### 3. Modification
```
MCP Tool → Manager.find() → Update Properties → Validation → Manager.save()
```

### 4. Deletion
```
MCP Tool → Check Dependencies → Delete Element → Delete Data Files → Update Registry
```

## Inter-Element Relationships

### References
Elements can reference other elements or external resources:
- Skills can reference documentation
- Templates can include other templates
- Agents can use specific skills
- Ensembles combine multiple elements

### Dependencies
Some elements depend on others:
- Agents may require specific skills
- Ensembles need their member elements
- Templates may include other templates

### Conflicts
The system handles conflicts between elements:
- Personas with conflicting behaviors
- Skills with overlapping capabilities
- Agents with competing goals

## Security Architecture

### Input Validation Pipeline
1. **Length Limits**: Prevent DoS through oversized inputs
2. **Unicode Normalization**: Prevent homograph attacks
3. **Path Validation**: Prevent directory traversal
4. **Content Sanitization**: Remove dangerous patterns
5. **Type Validation**: Ensure correct data types

### File System Security
- All paths resolved relative to portfolio directory
- No access outside portfolio structure
- Atomic file operations prevent corruption
- File locking prevents race conditions

### Audit Logging
Security-relevant operations are logged:
- Element creation/deletion
- Failed validation attempts
- Suspicious input patterns
- Access violations

## MCP Tool Integration

### Generic Element Tools
These tools work with all element types:
- `list_elements --type [type]`
- `create_element` 
- `edit_element`
- `delete_element`
- `validate_element`
- `activate_element`
- `deactivate_element`
- `get_element_details`

### Type-Specific Tools
Some element types have specialized tools:
- `render_template` (templates only)
- `execute_agent` (agents only)
- `query_memory` (memories only, planned)

### Tool Handler Architecture
```
MCP Client → Tool Definition → Handler → Manager → Element → Response
```

## Performance Considerations

### Memory Management
- Elements loaded on-demand
- Automatic cleanup of deactivated elements
- Limits on active element count
- Parameter storage limits per element

### File System Optimization
- Cached directory listings
- Lazy loading of element content
- Batch operations where possible
- Efficient file watching for changes

### Scalability
- Designed for 100s of elements per type
- Async operations prevent blocking
- Pagination support planned for large collections
- Indexed search capabilities planned

## Future Architecture Plans

### 1. Cloud Synchronization
- Optional cloud backup
- Cross-device synchronization
- Collaborative element sharing
- Version control integration

### 2. Plugin System
- Third-party element types
- Custom validation rules
- External storage backends
- Integration adapters

### 3. Advanced Features
- Element composition/inheritance
- Dynamic element generation
- Machine learning integration
- Real-time collaboration

## Architecture Decisions

### Why "Element" Not "Component"?
- Clearer terminology
- Avoids confusion with UI components
- Better represents discrete units
- More intuitive for users

### Why Separate Managers?
- Type-specific business logic
- Cleaner separation of concerns
- Easier testing and maintenance
- Allows type-specific optimizations

### Why File-Based Storage?
- Simple and transparent
- Easy backup and version control
- No database dependencies
- Direct file editing possible

### Why TypeScript?
- Type safety prevents errors
- Better IDE support
- Self-documenting code
- Easier refactoring

## Best Practices

### For Element Developers
1. Always extend `BaseElement` for new types
2. Implement comprehensive validation
3. Include security measures by default
4. Write thorough tests
5. Document metadata schemas

### For System Integrators
1. Use generic tools when possible
2. Handle errors gracefully
3. Respect system limits
4. Monitor performance impacts
5. Follow security guidelines

### For Contributors
1. Maintain backwards compatibility
2. Add tests for new features
3. Update documentation
4. Consider security implications
5. Follow existing patterns

## Summary

The Element System Architecture provides a robust, secure, and extensible foundation for AI portfolio management. By following consistent patterns and interfaces, the system remains maintainable while supporting diverse element types and use cases. The architecture prioritizes security, type safety, and developer experience while maintaining flexibility for future enhancements.
# Ensemble Element Guide

## Overview

The Ensemble element is the orchestrator of the DollhouseMCP element system. It allows you to combine multiple elements (personas, skills, templates, agents, memories) into a single, unified entity that works as one cohesive unit.

Think of an Ensemble as layers of capabilities combined into one AI assistant. When activated, all elements work together as a single entity - not as separate personalities interacting, but as one unified assistant with the combined abilities of all its elements.

## Key Concept: Unified Entity

**Important**: Ensembles create a single AI entity with combined capabilities. Elements are layered together, not acting as separate characters. For example:
- A "Full-Stack Developer" ensemble combines backend + frontend + testing capabilities into ONE developer
- A "Content Creator" ensemble merges writing + SEO + editing skills into ONE content professional
- Multiple personas in an ensemble don't "talk to each other" - they merge into one unified personality

## Key Features

### 1. **Multiple Activation Strategies**
- **All**: All elements activate simultaneously as one unit
- **Sequential**: Elements activate one by one in dependency order
- **Priority**: Elements activate in priority order (highest first)
- **Conditional**: Elements activate based on conditions
- **Lazy**: Elements activate only when needed

### 2. **Conflict Resolution**
When multiple elements try to modify the same context:
- **Last-write**: Most recent change wins
- **First-write**: First change is preserved
- **Priority**: Higher priority element wins
- **Merge**: Attempts to merge changes (for objects)
- **Error**: Throws error on conflict

### 3. **Circular Dependency Detection**
Ensemble automatically detects and prevents circular dependencies between elements, providing clear error messages showing the dependency cycle.

### 4. **Resource Protection**
- Maximum 50 elements per ensemble
- Maximum 5 levels of nested ensembles
- Context size limits to prevent memory exhaustion
- Activation timeouts to prevent hanging

### 5. **Shared Context Management**
Elements can read and write to a shared context, enabling communication and data sharing between elements.

## Creating an Ensemble

```typescript
import { Ensemble } from '@dollhousemcp/elements';

// Create an ensemble with sequential activation
const devTeam = new Ensemble({
  name: 'Development Team',
  description: 'A complete development team ensemble',
  activationStrategy: 'sequential',
  conflictResolution: 'merge',
  maxActivationTime: 60000 // 1 minute
});

// Add elements with specific roles
devTeam.addElement('architect', 'persona', 'primary', {
  priority: 100
});

devTeam.addElement('code-reviewer', 'skill', 'support', {
  priority: 80,
  dependencies: ['architect'] // Depends on architect
});

devTeam.addElement('test-writer', 'agent', 'support', {
  priority: 70,
  dependencies: ['code-reviewer']
});

devTeam.addElement('docs-generator', 'template', 'support', {
  priority: 60,
  activationCondition: 'code-reviewer.active == true'
});
```

## Element Roles

Each element in an ensemble has a role that defines its purpose:

- **Primary**: Main functionality providers
- **Support**: Augments primary elements
- **Override**: Can override decisions from other elements
- **Monitor**: Observes but doesn't interfere

## Activation Examples

### Sequential Activation
```typescript
// Elements activate in dependency order
await devTeam.activate();
// Order: architect → code-reviewer → test-writer → docs-generator
```

### Priority Activation
```typescript
const priorityEnsemble = new Ensemble({
  name: 'Priority Team',
  activationStrategy: 'priority'
});

// Will activate in order: urgent (100) → normal (50) → low (10)
priorityEnsemble.addElement('urgent', 'agent', 'primary', { priority: 100 });
priorityEnsemble.addElement('normal', 'skill', 'support', { priority: 50 });
priorityEnsemble.addElement('low', 'persona', 'support', { priority: 10 });
```

### Conditional Activation
```typescript
const conditionalEnsemble = new Ensemble({
  name: 'Conditional Team',
  activationStrategy: 'conditional'
});

// Only activates if condition is met
conditionalEnsemble.addElement('debugger', 'skill', 'primary', {
  activationCondition: 'error-detector.hasErrors == true'
});
```

## Shared Context

Elements can communicate through shared context:

```typescript
// Element 1 writes to context
ensemble.setContextValue('codeQuality', 'high', 'code-reviewer');

// Element 2 reads from context
const quality = ensemble.getContextValue('codeQuality');

// Conflict resolution in action
ensemble.setContextValue('config', { debug: true }, 'element1');
ensemble.setContextValue('config', { verbose: true }, 'element2');
// With merge strategy: config = { debug: true, verbose: true }
```

## Real-World Examples

### 1. Full-Stack Developer Ensemble
```typescript
const fullStackDev = new Ensemble({
  name: 'Full-Stack Developer',
  description: 'Complete full-stack development capabilities',
  activationStrategy: 'sequential'
});

fullStackDev.addElement('backend-expert', 'persona', 'primary');
fullStackDev.addElement('frontend-expert', 'persona', 'primary');
fullStackDev.addElement('database-designer', 'skill', 'support');
fullStackDev.addElement('api-tester', 'agent', 'support');
fullStackDev.addElement('deployment-scripts', 'template', 'support');
```

### 2. Content Creation Team
```typescript
const contentTeam = new Ensemble({
  name: 'Content Creation Team',
  activationStrategy: 'all',
  conflictResolution: 'priority'
});

contentTeam.addElement('creative-writer', 'persona', 'primary', { priority: 90 });
contentTeam.addElement('seo-optimizer', 'skill', 'support', { priority: 70 });
contentTeam.addElement('fact-checker', 'agent', 'override', { priority: 100 });
contentTeam.addElement('blog-template', 'template', 'support', { priority: 50 });
```

### 3. DevOps Pipeline
```typescript
const devOpsPipeline = new Ensemble({
  name: 'DevOps Pipeline',
  activationStrategy: 'sequential'
});

devOpsPipeline.addElement('code-analyzer', 'skill', 'primary');
devOpsPipeline.addElement('security-scanner', 'agent', 'override', {
  dependencies: ['code-analyzer']
});
devOpsPipeline.addElement('build-system', 'agent', 'primary', {
  dependencies: ['security-scanner'],
  activationCondition: 'security-scanner.passed == true'
});
devOpsPipeline.addElement('deploy-agent', 'agent', 'primary', {
  dependencies: ['build-system']
});
```

## Best Practices

### 1. **Design for Clarity**
- Give elements clear, descriptive names
- Use appropriate roles (primary vs support)
- Document dependencies explicitly

### 2. **Avoid Over-Complexity**
- Start with simple ensembles
- Add complexity incrementally
- Test each addition thoroughly

### 3. **Handle Failures Gracefully**
- Check activation results
- Have fallback strategies
- Log failures for debugging

### 4. **Optimize Performance**
- Use lazy activation for optional elements
- Set appropriate timeouts
- Monitor resource usage

### 5. **Security Considerations**
- Validate all inputs
- Limit ensemble size
- Monitor for suspicious patterns
- Use activation conditions carefully

## Advanced Features

### Nested Ensembles
```typescript
const mainEnsemble = new Ensemble({
  name: 'Main System',
  allowNested: true,
  maxNestingDepth: 3
});

// Add another ensemble as an element
mainEnsemble.addElement('sub-team', 'ensemble', 'support');
```

### Dynamic Activation
```typescript
// Check conditions and activate accordingly
if (taskComplexity === 'high') {
  ensemble.addElement('expert-advisor', 'persona', 'override');
}

await ensemble.activate();
```

### State Persistence
```typescript
// Serialize ensemble state
const state = ensemble.serialize();

// Later, restore it
const restoredEnsemble = new Ensemble();
restoredEnsemble.deserialize(state);
```

## Troubleshooting

### Common Issues

1. **Circular Dependencies**
   - Error: "Circular dependency detected"
   - Solution: Review and break the dependency cycle

2. **Activation Timeout**
   - Error: "Ensemble activation timed out"
   - Solution: Increase timeout or optimize element activation

3. **Context Conflicts**
   - Error: "Context conflict on key 'X'"
   - Solution: Choose appropriate conflict resolution strategy

4. **Resource Limits**
   - Error: "Maximum elements exceeded"
   - Solution: Split into multiple ensembles or increase limits

## Security Features

The Ensemble element includes comprehensive security measures:

1. **Input Sanitization**: All inputs are sanitized to prevent injection
2. **Path Validation**: Prevents directory traversal attacks
3. **Resource Limits**: Prevents DoS through resource exhaustion
4. **Audit Logging**: Security events are logged for monitoring
5. **Condition Validation**: Activation conditions are validated to prevent code injection

## Conclusion

Ensembles are the most powerful feature of the DollhouseMCP element system, enabling complex multi-element orchestration with built-in safety and flexibility. Start simple, test thoroughly, and gradually build more sophisticated ensembles as your needs grow.
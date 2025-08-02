# Element Developer Guide

This guide provides step-by-step instructions for developing new element types in the DollhouseMCP system.

## Table of Contents
1. [Quick Start](#quick-start)
2. [Creating a New Element Type](#creating-a-new-element-type)
3. [Implementing the Manager](#implementing-the-manager)
4. [Adding MCP Tool Support](#adding-mcp-tool-support)
5. [Writing Tests](#writing-tests)
6. [Security Considerations](#security-considerations)
7. [Best Practices](#best-practices)
8. [Common Patterns](#common-patterns)

## Quick Start

To add a new element type, you need to:
1. Create the element class extending `BaseElement`
2. Create a manager class implementing `IElementManager`
3. Add the type to `ElementType` enum
4. Update MCP tool handlers
5. Write comprehensive tests

## Creating a New Element Type

### Step 1: Add to ElementType Enum

First, add your new type to the `ElementType` enum in `src/portfolio/types.ts`:

```typescript
export enum ElementType {
  PERSONA = 'persona',
  SKILL = 'skill',
  TEMPLATE = 'template',
  AGENT = 'agent',
  MEMORY = 'memory',
  ENSEMBLE = 'ensemble',
  WORKFLOW = 'workflow'  // Your new type
}
```

### Step 2: Define Metadata Interface

Create a metadata interface for your element type:

```typescript
// src/elements/workflows/types.ts
import { IElementMetadata } from '../../types/elements/IElement.js';

export interface WorkflowMetadata extends IElementMetadata {
  // Required fields from IElementMetadata:
  // name, description, author, version, created, updated
  
  // Workflow-specific fields:
  steps?: WorkflowStep[];
  triggers?: WorkflowTrigger[];
  inputs?: WorkflowInput[];
  outputs?: WorkflowOutput[];
}

export interface WorkflowStep {
  id: string;
  type: 'element' | 'action' | 'condition';
  elementRef?: string;  // Reference to another element
  config?: Record<string, any>;
}
```

### Step 3: Implement the Element Class

Create your element class extending `BaseElement`:

```typescript
// src/elements/workflows/Workflow.ts
import { BaseElement } from '../BaseElement.js';
import { IElement, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';
import { WorkflowMetadata, WorkflowStep } from './types.js';
import { SecurityMonitor } from '../../security/SecurityMonitor.js';
import { sanitizeInput } from '../../utils/security.js';

export class Workflow extends BaseElement implements IElement {
  private steps: WorkflowStep[] = [];
  
  constructor(metadata: Partial<WorkflowMetadata>) {
    // SECURITY: Always sanitize inputs in constructor
    const sanitizedMetadata = {
      ...metadata,
      name: metadata.name ? 
        sanitizeInput(metadata.name, 100) : 
        'Untitled Workflow',
      description: metadata.description ? 
        sanitizeInput(metadata.description, 500) : 
        ''
    };
    
    super(ElementType.WORKFLOW, sanitizedMetadata);
    
    // Initialize workflow-specific properties
    if (metadata.steps) {
      this.steps = this.validateSteps(metadata.steps);
    }
  }
  
  // Implement additional validation
  public validate(): ElementValidationResult {
    const result = super.validate();
    
    // Add workflow-specific validation
    if (this.steps.length === 0) {
      result.warnings.push({
        code: 'WORKFLOW_NO_STEPS',
        message: 'Workflow has no steps defined',
        severity: 'warning'
      });
    }
    
    // Validate step references
    for (const step of this.steps) {
      if (step.type === 'element' && !step.elementRef) {
        result.errors.push({
          code: 'WORKFLOW_INVALID_STEP',
          message: `Step ${step.id} references element but has no elementRef`,
          severity: 'error'
        });
        result.isValid = false;
      }
    }
    
    return result;
  }
  
  // Workflow-specific methods
  public addStep(step: WorkflowStep): void {
    // Validate and sanitize
    const sanitized = this.validateSteps([step])[0];
    this.steps.push(sanitized);
    this.metadata.updated = new Date().toISOString();
  }
  
  public removeStep(stepId: string): boolean {
    const index = this.steps.findIndex(s => s.id === stepId);
    if (index >= 0) {
      this.steps.splice(index, 1);
      this.metadata.updated = new Date().toISOString();
      return true;
    }
    return false;
  }
  
  // Lifecycle methods (optional)
  public async activate(): Promise<void> {
    // Log activation
    SecurityMonitor.logSecurityEvent({
      type: 'WORKFLOW_ACTIVATED',
      severity: 'info',
      source: 'Workflow.activate',
      details: `Workflow '${this.metadata.name}' activated`
    });
    
    // Initialize workflow engine
    await this.initializeEngine();
  }
  
  public async deactivate(): Promise<void> {
    // Cleanup resources
    await this.cleanupEngine();
  }
  
  // Helper methods
  private validateSteps(steps: WorkflowStep[]): WorkflowStep[] {
    return steps.map(step => ({
      ...step,
      id: sanitizeInput(step.id, 50),
      config: step.config ? this.sanitizeConfig(step.config) : {}
    }));
  }
  
  private sanitizeConfig(config: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeInput(value, 1000);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  
  private async initializeEngine(): Promise<void> {
    // Workflow engine initialization
  }
  
  private async cleanupEngine(): Promise<void> {
    // Cleanup logic
  }
}
```

## Implementing the Manager

Create a manager class that handles CRUD operations:

```typescript
// src/elements/workflows/WorkflowManager.ts
import { BaseElementManager } from '../BaseElementManager.js';
import { IElementManager } from '../../types/elements/index.js';
import { Workflow } from './Workflow.js';
import { WorkflowMetadata } from './types.js';
import { ElementType } from '../../portfolio/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { FileLockManager } from '../../utils/FileLockManager.js';
import { SecurityMonitor } from '../../security/SecurityMonitor.js';

export class WorkflowManager extends BaseElementManager<Workflow> implements IElementManager<Workflow> {
  constructor(private workflowsDir: string) {
    super(ElementType.WORKFLOW);
  }
  
  async create(data: Partial<WorkflowMetadata>): Promise<Workflow> {
    // Create workflow instance
    const workflow = new Workflow(data);
    
    // Validate before saving
    const validation = workflow.validate();
    if (!validation.isValid) {
      throw new Error(`Invalid workflow: ${validation.errors[0].message}`);
    }
    
    // Generate filename
    const filename = `${this.slugify(workflow.metadata.name)}.md`;
    const filepath = path.join(this.workflowsDir, filename);
    
    // Check if already exists
    try {
      await fs.access(filepath);
      throw new Error(`Workflow '${workflow.metadata.name}' already exists`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    
    // Save to file
    await this.save(workflow, filepath);
    
    // Log creation
    SecurityMonitor.logSecurityEvent({
      type: 'WORKFLOW_CREATED',
      severity: 'info',
      source: 'WorkflowManager.create',
      details: `Created workflow: ${workflow.metadata.name}`
    });
    
    return workflow;
  }
  
  async load(filePath: string): Promise<Workflow> {
    // Security: Validate path
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(this.workflowsDir)) {
      throw new Error('Invalid workflow path');
    }
    
    // Read file atomically
    const content = await FileLockManager.atomicReadFile(
      filePath, 
      { encoding: 'utf-8' }
    );
    
    // Parse frontmatter
    const { data: metadata, content: body } = matter(content);
    
    // Create workflow instance
    const workflow = new Workflow({
      ...metadata,
      content: body
    });
    
    return workflow;
  }
  
  async save(workflow: Workflow, filePath: string): Promise<void> {
    // Validate workflow
    const validation = workflow.validate();
    if (!validation.isValid) {
      throw new Error(`Invalid workflow: ${validation.errors[0].message}`);
    }
    
    // Serialize to markdown with frontmatter
    const content = matter.stringify(
      workflow.serialize(),
      workflow.metadata as any
    );
    
    // Write atomically
    await FileLockManager.atomicWriteFile(
      filePath,
      content,
      { encoding: 'utf-8' }
    );
  }
  
  async delete(name: string): Promise<void> {
    const filename = `${this.slugify(name)}.md`;
    const filepath = path.join(this.workflowsDir, filename);
    
    // Check exists
    try {
      await fs.access(filepath);
    } catch {
      throw new Error(`Workflow '${name}' not found`);
    }
    
    // Delete file
    await fs.unlink(filepath);
    
    // Log deletion
    SecurityMonitor.logSecurityEvent({
      type: 'WORKFLOW_DELETED',
      severity: 'info',
      source: 'WorkflowManager.delete',
      details: `Deleted workflow: ${name}`
    });
  }
  
  async list(): Promise<Workflow[]> {
    const workflows: Workflow[] = [];
    
    try {
      const files = await fs.readdir(this.workflowsDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      
      for (const file of mdFiles) {
        try {
          const filepath = path.join(this.workflowsDir, file);
          const workflow = await this.load(filepath);
          workflows.push(workflow);
        } catch (error) {
          console.error(`Error loading workflow ${file}:`, error);
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      // Directory doesn't exist yet, return empty
    }
    
    return workflows;
  }
  
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
```

## Adding MCP Tool Support

### Step 1: Update Tool Handlers

Add support in `src/index.ts`:

```typescript
// In DollhouseMCPServer class constructor
this.workflowManager = new WorkflowManager(
  this.portfolioManager.getElementDir(ElementType.WORKFLOW)
);

// In the switch statements for create/edit/validate/delete
case ElementType.WORKFLOW:
  // Handle workflow operations
  break;
```

### Step 2: Add Type-Specific Tools (if needed)

If your element needs special tools beyond CRUD:

```typescript
// In ElementTools.ts
{
  tool: {
    name: "execute_workflow",
    description: "Execute a workflow with given inputs",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The workflow name to execute"
        },
        inputs: {
          type: "object",
          description: "Input values for the workflow",
          additionalProperties: true
        }
      },
      required: ["name"]
    }
  },
  handler: (args: ExecuteWorkflowArgs) => server.executeWorkflow(args)
}
```

## Writing Tests

### Unit Tests for the Element

```typescript
// test/__tests__/unit/elements/workflows/Workflow.test.ts
import { Workflow } from '../../../../../src/elements/workflows/Workflow.js';
import { ElementType } from '../../../../../src/portfolio/types.js';

describe('Workflow Element', () => {
  describe('constructor', () => {
    it('should create workflow with minimal metadata', () => {
      const workflow = new Workflow({
        name: 'Test Workflow',
        description: 'A test workflow'
      });
      
      expect(workflow.type).toBe(ElementType.WORKFLOW);
      expect(workflow.metadata.name).toBe('Test Workflow');
    });
    
    it('should sanitize inputs', () => {
      const workflow = new Workflow({
        name: '<script>alert("xss")</script>',
        description: 'Test'
      });
      
      expect(workflow.metadata.name).not.toContain('<script>');
    });
  });
  
  describe('validation', () => {
    it('should warn about empty workflows', () => {
      const workflow = new Workflow({
        name: 'Empty Workflow'
      });
      
      const result = workflow.validate();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].code).toBe('WORKFLOW_NO_STEPS');
    });
  });
  
  describe('step management', () => {
    it('should add and remove steps', () => {
      const workflow = new Workflow({ name: 'Test' });
      
      workflow.addStep({
        id: 'step1',
        type: 'action',
        config: { action: 'log' }
      });
      
      expect(workflow.getSteps()).toHaveLength(1);
      
      workflow.removeStep('step1');
      expect(workflow.getSteps()).toHaveLength(0);
    });
  });
});
```

### Integration Tests

```typescript
// test/__tests__/integration/WorkflowIntegration.test.ts
describe('Workflow Integration', () => {
  let server: TestMCPServer;
  
  beforeEach(async () => {
    server = await createTestServer();
  });
  
  it('should create workflow via MCP tool', async () => {
    const result = await server.createElement({
      name: 'Build Pipeline',
      type: ElementType.WORKFLOW,
      description: 'CI/CD build workflow',
      metadata: {
        steps: [
          { id: 'test', type: 'action', config: { command: 'npm test' } },
          { id: 'build', type: 'action', config: { command: 'npm build' } }
        ]
      }
    });
    
    expect(result.content[0].text).toContain('Created workflow');
  });
});
```

## Security Considerations

### Required Security Measures

1. **Input Validation**
   - Always sanitize string inputs
   - Validate lengths to prevent DoS
   - Check for dangerous patterns

2. **Path Security**
   - Never accept absolute paths from users
   - Validate all paths are within element directory
   - Use path.normalize() to prevent traversal

3. **Memory Limits**
   - Limit collection sizes (arrays, maps)
   - Set maximum string lengths
   - Implement cleanup in deactivate()

4. **Audit Logging**
   - Log all create/update/delete operations
   - Log security-relevant events
   - Include enough context for forensics

### Security Checklist

- [ ] All user inputs sanitized
- [ ] Path traversal prevention implemented
- [ ] Memory limits enforced
- [ ] No eval() or Function() usage
- [ ] No dynamic requires/imports
- [ ] Audit logging for sensitive operations
- [ ] Error messages don't leak sensitive info
- [ ] Unicode normalization for names

## Best Practices

### Do's
- ✅ Extend BaseElement for consistency
- ✅ Implement comprehensive validation
- ✅ Use TypeScript strictly
- ✅ Write tests first (TDD)
- ✅ Document metadata schema
- ✅ Handle errors gracefully
- ✅ Use async/await consistently
- ✅ Follow existing patterns

### Don'ts
- ❌ Skip input validation
- ❌ Use synchronous file operations
- ❌ Ignore memory limits
- ❌ Create global state
- ❌ Use any type unnecessarily
- ❌ Forget error handling
- ❌ Skip security measures
- ❌ Break existing APIs

## Common Patterns

### Pattern: Element with State

For elements that maintain state between activations:

```typescript
export class StatefulElement extends BaseElement {
  private stateFile: string;
  
  constructor(metadata: Metadata) {
    super(ElementType.STATEFUL, metadata);
    this.stateFile = `.state/${this.id}.json`;
  }
  
  async loadState(): Promise<State> {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return this.getDefaultState();
    }
  }
  
  async saveState(state: State): Promise<void> {
    await fs.writeFile(
      this.stateFile, 
      JSON.stringify(state, null, 2)
    );
  }
}
```

### Pattern: Element with Parameters

For elements that accept configuration:

```typescript
export class ParameterizedElement extends BaseElement {
  private parameters = new Map<string, any>();
  private readonly MAX_PARAMS = 50;
  
  setParameter(key: string, value: any): void {
    if (this.parameters.size >= this.MAX_PARAMS) {
      throw new Error('Parameter limit exceeded');
    }
    
    const sanitizedKey = sanitizeInput(key, 50);
    const sanitizedValue = this.sanitizeValue(value);
    
    this.parameters.set(sanitizedKey, sanitizedValue);
  }
}
```

### Pattern: Element with Dependencies

For elements that reference others:

```typescript
export class DependentElement extends BaseElement {
  private dependencies: string[] = [];
  
  async resolveDependencies(
    manager: ElementRegistry
  ): Promise<IElement[]> {
    const resolved: IElement[] = [];
    
    for (const dep of this.dependencies) {
      const element = await manager.find(dep);
      if (!element) {
        throw new Error(`Dependency not found: ${dep}`);
      }
      resolved.push(element);
    }
    
    return resolved;
  }
}
```

## Troubleshooting

### Common Issues

1. **Type not recognized**: Ensure ElementType enum is updated
2. **Tools not working**: Check MCP tool handler switch statements
3. **Files not loading**: Verify file extension and directory
4. **Validation failing**: Check security limits and patterns
5. **Tests failing**: Ensure test utilities are properly mocked

### Debug Tips

- Use `DEBUG=dollhouse:*` environment variable
- Add console.log in development (remove before commit)
- Check audit logs for security events
- Verify file permissions and paths
- Use TypeScript strict mode to catch errors

## Next Steps

After implementing your element type:

1. Update documentation
2. Add examples to the guide
3. Create sample files
4. Test with real Claude Desktop
5. Get code review
6. Submit PR with tests

## Resources

- [Element Architecture](./ELEMENT_ARCHITECTURE.md)
- [Element Types Reference](./ELEMENT_TYPES.md)
- [Security Guidelines](./SECURITY.md)
- [Testing Guide](./TESTING.md)
- [TypeScript Best Practices](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)
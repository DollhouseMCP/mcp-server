# DollhouseMCP Plugin Development Guide

## Overview

This guide explains how to create plugins for DollhouseMCP, extending the platform with new element types and capabilities. Plugins enable you to add functionality without modifying the core codebase.

## Plugin Architecture

### Core Concepts

DollhouseMCP uses a plugin system that allows dynamic registration of new element types. Each plugin:
- Defines a new element type
- Provides a manager for CRUD operations
- Registers MCP tools for interaction
- Maintains its own state and configuration

### Plugin Interface

```typescript
interface IElementTypePlugin {
  // Unique identifier for the element type
  type: string;
  
  // Plugin version (semantic versioning)
  version: string;
  
  // Manager handling element operations
  manager: IElementManager;
  
  // MCP tools provided by this plugin
  tools: ToolDefinition[];
  
  // Optional: Required license level
  requiredLicense?: 'community' | 'pro' | 'enterprise';
  
  // Optional: Plugin metadata
  metadata?: {
    author: string;
    description: string;
    repository?: string;
    documentation?: string;
  };
}
```

## Getting Started

### Step 1: Set Up Your Development Environment

```bash
# Clone the DollhouseMCP repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Install dependencies
npm install

# Create your plugin directory
mkdir -p src/plugins/my-element-type
```

### Step 2: Create Your Element Class

```typescript
// src/plugins/my-element-type/MyElement.ts
import { BaseElement } from '../../elements/BaseElement.js';
import { IElement } from '../../types/elements/index.js';

export interface MyElementMetadata extends IElementMetadata {
  // Add your custom metadata fields
  customField?: string;
  settings?: Record<string, any>;
}

export class MyElement extends BaseElement implements IElement {
  constructor(metadata: Partial<MyElementMetadata>) {
    super('my-element-type', metadata);
    // Initialize your element
  }
  
  // Implement required methods
  async activate(): Promise<void> {
    // Activation logic
  }
  
  async deactivate(): Promise<void> {
    // Deactivation logic
  }
  
  // Add custom methods
  async performAction(params: any): Promise<any> {
    // Custom functionality
  }
}
```

### Step 3: Create Your Element Manager

```typescript
// src/plugins/my-element-type/MyElementManager.ts
import { IElementManager } from '../../types/elements/index.js';
import { MyElement } from './MyElement.js';

export class MyElementManager implements IElementManager<MyElement> {
  async load(path: string): Promise<MyElement> {
    // Load element from file
  }
  
  async save(element: MyElement, path: string): Promise<void> {
    // Save element to file
  }
  
  async list(): Promise<MyElement[]> {
    // List all elements of this type
  }
  
  async find(predicate: (element: MyElement) => boolean): Promise<MyElement | undefined> {
    // Find element matching predicate
  }
  
  async validate(element: MyElement): Promise<ValidationResult> {
    // Validate element
  }
}
```

### Step 4: Define Your MCP Tools

```typescript
// src/plugins/my-element-type/tools.ts
import { ToolDefinition } from '../../server/tools/ToolRegistry.js';

export function getMyElementTools(): ToolDefinition[] {
  return [
    {
      name: 'create_my_element',
      description: 'Create a new element of my type',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          customField: { type: 'string' }
        },
        required: ['name', 'description']
      }
    },
    {
      name: 'execute_my_element',
      description: 'Execute an action on my element',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          action: { type: 'string' },
          params: { type: 'object' }
        },
        required: ['name', 'action']
      }
    }
  ];
}
```

### Step 5: Create Your Plugin

```typescript
// src/plugins/my-element-type/index.ts
import { IElementTypePlugin } from '../../types/plugins.js';
import { MyElementManager } from './MyElementManager.js';
import { getMyElementTools } from './tools.js';

export class MyElementPlugin implements IElementTypePlugin {
  type = 'my-element-type';
  version = '1.0.0';
  manager = new MyElementManager();
  tools = getMyElementTools();
  
  metadata = {
    author: 'Your Name',
    description: 'Description of what your element type does',
    repository: 'https://github.com/yourusername/my-element-plugin',
    documentation: 'https://docs.example.com/my-element'
  };
  
  // Optional: Initialization logic
  async initialize(): Promise<void> {
    // Set up any required resources
  }
  
  // Optional: Cleanup logic
  async cleanup(): Promise<void> {
    // Clean up resources
  }
}

// Export plugin factory
export default function createPlugin(): MyElementPlugin {
  return new MyElementPlugin();
}
```

### Step 6: Register Your Plugin

```typescript
// In your application initialization
import { ElementTypeRegistry } from './core/ElementTypeRegistry.js';
import createMyElementPlugin from './plugins/my-element-type/index.js';

const registry = ElementTypeRegistry.getInstance();
const myPlugin = createMyElementPlugin();
await registry.register(myPlugin);
```

## Best Practices

### 1. Follow the Single Responsibility Principle
Each plugin should focus on one element type and its related functionality.

### 2. Use TypeScript
Strong typing helps prevent errors and improves developer experience.

### 3. Implement Comprehensive Validation
```typescript
async validate(element: MyElement): Promise<ValidationResult> {
  const errors = [];
  
  if (!element.metadata.name) {
    errors.push('Name is required');
  }
  
  if (element.metadata.name.length > 100) {
    errors.push('Name must be 100 characters or less');
  }
  
  // Add more validation rules
  
  return {
    valid: errors.length === 0,
    errors
  };
}
```

### 4. Handle Errors Gracefully
```typescript
async performAction(params: any): Promise<any> {
  try {
    // Perform action
    return { success: true, result };
  } catch (error) {
    logger.error('Action failed:', error);
    return { 
      success: false, 
      error: error.message,
      recovery: 'Suggested recovery action'
    };
  }
}
```

### 5. Add Comprehensive Logging
```typescript
import { logger } from '../../utils/logger.js';

async activate(): Promise<void> {
  logger.info(`Activating ${this.type} element: ${this.metadata.name}`);
  // Activation logic
  logger.debug('Activation details:', { /* context */ });
}
```

### 6. Write Tests
```typescript
// test/plugins/my-element-type/MyElement.test.ts
describe('MyElement', () => {
  it('should create element with metadata', () => {
    const element = new MyElement({
      name: 'Test Element',
      description: 'Test description'
    });
    
    expect(element.metadata.name).toBe('Test Element');
  });
  
  it('should validate required fields', async () => {
    const element = new MyElement({});
    const result = await element.validate();
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Name is required');
  });
});
```

## Advanced Topics

### State Persistence

For elements that need to maintain state across sessions:

```typescript
class StatefulElement extends BaseElement {
  private stateFile: string;
  
  async loadState(): Promise<any> {
    const statePath = path.join(
      this.getStateDir(),
      `${this.metadata.name}.json`
    );
    
    if (await fs.pathExists(statePath)) {
      return await fs.readJson(statePath);
    }
    
    return this.getDefaultState();
  }
  
  async saveState(state: any): Promise<void> {
    const statePath = path.join(
      this.getStateDir(),
      `${this.metadata.name}.json`
    );
    
    await fs.ensureDir(this.getStateDir());
    await fs.writeJson(statePath, state, { spaces: 2 });
  }
}
```

### Inter-Element Communication

For plugins that need to interact with other elements:

```typescript
class CollaborativeElement extends BaseElement {
  async collaborateWith(otherElement: IElement): Promise<void> {
    // Check compatibility
    if (!this.isCompatible(otherElement)) {
      throw new Error(`Incompatible element type: ${otherElement.type}`);
    }
    
    // Exchange information
    const sharedContext = await this.createSharedContext(otherElement);
    
    // Perform collaborative action
    await this.executeCollaboration(sharedContext);
  }
}
```

### Performance Optimization

For plugins handling large amounts of data:

```typescript
class OptimizedManager implements IElementManager {
  private cache: Map<string, MyElement> = new Map();
  
  async load(path: string): Promise<MyElement> {
    // Check cache first
    if (this.cache.has(path)) {
      return this.cache.get(path)!;
    }
    
    // Load from disk
    const element = await this.loadFromDisk(path);
    
    // Cache for future use
    this.cache.set(path, element);
    
    // Implement cache eviction if needed
    if (this.cache.size > 100) {
      this.evictOldestEntry();
    }
    
    return element;
  }
}
```

## Plugin Distribution

### Publishing to npm

```json
// package.json
{
  "name": "@dollhousemcp/plugin-my-element",
  "version": "1.0.0",
  "description": "My custom element type for DollhouseMCP",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "@dollhousemcp/core": "^1.0.0"
  },
  "keywords": ["dollhousemcp", "plugin", "mcp"],
  "license": "MIT"
}
```

### Installation

Users can install your plugin:

```bash
npm install @dollhousemcp/plugin-my-element
```

### Registration in User Configuration

```typescript
// In user's configuration
import createMyElementPlugin from '@dollhousemcp/plugin-my-element';

const plugins = [
  createMyElementPlugin(),
  // Other plugins
];
```

## Community Guidelines

### Contributing Your Plugin

1. **Documentation**: Provide clear documentation with examples
2. **Tests**: Include comprehensive test coverage
3. **Examples**: Provide example elements and use cases
4. **Support**: Be responsive to issues and questions
5. **Versioning**: Follow semantic versioning
6. **License**: Choose an appropriate open source license

### Getting Help

- Join our Discord community
- Check existing plugins for examples
- Open issues on GitHub for questions
- Contribute to plugin documentation

## Example Plugins

Check out these example plugins for reference:

- **workflow-plugin**: Complex orchestration patterns
- **function-plugin**: External function calling
- **database-plugin**: Database connectivity
- **api-plugin**: REST API integration

## Troubleshooting

### Common Issues

**Plugin not loading**
- Check that your plugin implements all required interfaces
- Verify the plugin is registered correctly
- Check logs for initialization errors

**Tools not appearing**
- Ensure tools are properly defined with schemas
- Verify tool names are unique
- Check that tools are returned from the plugin

**State not persisting**
- Verify state directory permissions
- Check state serialization/deserialization
- Ensure cleanup doesn't delete state unintentionally

## Conclusion

Creating plugins for DollhouseMCP allows you to extend the platform with custom functionality while maintaining clean separation from the core. Follow these guidelines to create robust, maintainable plugins that benefit the entire community.

For more examples and support, visit our [GitHub repository](https://github.com/DollhouseMCP/mcp-server) and join our community discussions.

---

*Happy plugin development!*
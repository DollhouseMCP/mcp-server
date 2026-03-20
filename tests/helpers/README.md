# Test Helpers

This directory contains reusable test utilities and mock factories for the DollhouseMCP test suite.

## Dependency Injection Mocks (`di-mocks.ts`)

Provides factory functions for creating mock services used in the dependency injection pattern.

### Quick Start

```typescript
import {
  createMockPersonaManager,
  createMockInitializationService,
  createMockPersonaIndicatorService
} from '../helpers/di-mocks';

describe('MyHandler', () => {
  let handler: MyHandler;
  let mockPersonaManager: any;

  beforeEach(() => {
    // Create mocks with default behavior
    mockPersonaManager = createMockPersonaManager();
    const mockInitService = createMockInitializationService();
    const mockPersonaIndicatorService = createMockPersonaIndicatorService();

    // Inject into handler
    handler = new MyHandler(
      mockPersonaManager,
      mockInitService,
      mockPersonaIndicatorService
    );
  });

  it('should list personas', async () => {
    // Override default behavior for this test
    mockPersonaManager.list.mockResolvedValue([
      { name: 'Test Persona', filename: 'test.md' }
    ]);

    const result = await handler.listPersonas();
    expect(mockPersonaManager.list).toHaveBeenCalled();
  });
});
```

### Available Mock Factories

**Core Services:**
- `createMockPersonaManager()` - PersonaManager with list, find, create, etc.
- `createMockInitializationService()` - InitializationService with ensureInitialized
- `createMockPersonaIndicatorService(indicator?)` - PersonaIndicatorService with getPersonaIndicator

**Element Managers:**
- `createMockSkillManager()` - SkillManager
- `createMockTemplateManager()` - TemplateManager
- `createMockAgentManager()` - AgentManager
- `createMockMemoryManager()` - MemoryManager

**Other Services:**
- `createMockPortfolioManager()` - PortfolioManager
- `createMockCollectionBrowser()` - CollectionBrowser
- `createMockCollectionSearch()` - CollectionSearch
- `createMockGitHubAuthManager()` - GitHubAuthManager
- `createMockPersonaExporter()` - PersonaExporter
- `createMockPersonaImporter()` - PersonaImporter

**Utilities:**
- `createMockStateAccessor<T>(initialValue)` - State accessor with get/set
- `createHandlerMocks()` - Returns all common mocks in one object

### Customizing Mocks

All mock factories accept an `overrides` parameter to customize behavior:

```typescript
const mockPersonaManager = createMockPersonaManager({
  list: jest.fn().mockResolvedValue([/* custom data */]),
  find: jest.fn().mockImplementation(async (predicate) => {
    // Custom logic
  })
});
```

### State Accessors

For testing stateful interactions (like active persona):

```typescript
const activePersona = createMockStateAccessor<string | null>(null);

const handler = new PersonaHandler(
  mockPersonaManager,
  //... other services
  activePersona  // { get, set, state }
);

// In your test
activePersona.set('test-persona.md');
expect(activePersona.get()).toBe('test-persona.md');
```

### Bulk Mock Creation

For handlers that need many services:

```typescript
const mocks = createHandlerMocks();

const handler = new ElementCRUDHandler(
  mocks.skillManager,
  mocks.templateManager,
  mocks.templateRenderer,
  mocks.agentManager,
  mocks.memoryManager,
  mocks.personaManager,
  mocks.portfolioManager,
  mocks.initService,
  mocks.indicatorService
);
```

## Other Test Helpers

### `integration-container.ts`
Creates a real DI container for integration tests.

### `portfolio-test-utils.ts`
Utilities for testing portfolio operations (10KB+).

### `test-persona-factory.ts`
Factory functions for creating test persona data (7KB+).

### `test-fixtures.ts`
Common test data and fixtures (2.8KB).

### `test-server.ts`
Utilities for creating test MCP servers (4KB).

### `file-utils.ts`
File system utilities for tests (2.6KB).

## Best Practices

### 1. Use Mock Factories Over Manual Mocks

**❌ Don't:**
```typescript
const mockService = {
  method1: jest.fn(),
  method2: jest.fn(),
  method3: jest.fn()
};
```

**✅ Do:**
```typescript
const mockService = createMockServiceName();
```

### 2. Override Only What You Need

**❌ Don't:**
```typescript
const mockService = createMockServiceName({
  method1: jest.fn().mockResolvedValue([]),
  method2: jest.fn().mockResolvedValue(null),
  method3: jest.fn().mockResolvedValue(undefined)
});
```

**✅ Do:**
```typescript
const mockService = createMockServiceName();
// Only override for specific tests
mockService.method1.mockResolvedValue(customData);
```

### 3. Use Descriptive Test Data

**❌ Don't:**
```typescript
mockPersonaManager.list.mockResolvedValue([{ name: 'Test' }]);
```

**✅ Do:**
```typescript
mockPersonaManager.list.mockResolvedValue([
  { name: 'Creative Writer', description: 'Helps with creative writing', filename: 'creative-writer.md' }
]);
```

### 4. Test Mock Interactions

Always verify that your handler calls the mocks correctly:

```typescript
it('should reload personas', async () => {
  await handler.reloadPersonas();
  expect(mockPersonaManager.reload).toHaveBeenCalledTimes(1);
});
```

## Contributing

When adding new services or managers:

1. Add a corresponding mock factory to `di-mocks.ts`
2. Include common methods with sensible defaults
3. Support the `overrides` parameter
4. Update this README with the new factory
5. Write a usage example

## Testing the Test Helpers

The test helpers themselves should be simple and not require their own tests. However, if you add complex logic, consider adding tests in `tests/unit/helpers/`.

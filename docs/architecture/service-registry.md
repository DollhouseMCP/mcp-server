# DI Container Service Registry

**Last Updated:** November 7, 2025
**Version:** 1.9.26

## Table of Contents

1. [Overview](#overview)
2. [Service Categories](#service-categories)
3. [Complete Service List](#complete-service-list)
4. [Service Dependencies](#service-dependencies)
5. [Lifecycle Management](#lifecycle-management)
6. [Adding New Services](#adding-new-services)
7. [Best Practices](#best-practices)

---

## Overview

The `DollhouseContainer` (`src/di/Container.ts`) is a lightweight dependency injection (DI) container that manages the lifecycle of all services and handlers in the DollhouseMCP server. It provides:

- **Centralized Service Registration**: Single source of truth for all dependencies
- **Singleton Management**: Services are singletons by default (shared instance)
- **Lazy Instantiation**: Services created only when first requested
- **Dependency Resolution**: Automatic injection of dependencies
- **Lifecycle Management**: Graceful initialization and disposal

### Why Dependency Injection?

| Without DI | With DI |
|------------|---------|
| Manual instantiation everywhere | Container manages instances |
| Tight coupling between classes | Loose coupling via interfaces |
| Difficult to test | Easy to mock dependencies |
| Hard to manage singletons | Automatic singleton lifecycle |
| Complex initialization order | Dependency graph resolved automatically |

### Container Size

The custom DI container is lightweight (~20KB) compared to full IoC frameworks (e.g., InversifyJS ~200KB+). It provides exactly what DollhouseMCP needs without bloat.

---

## Service Categories

The DollhouseContainer manages **54 services** organized into logical categories:

### Core & Configuration (7 services)
Services providing foundational functionality and configuration management.

### Caching & Performance (4 services)
Services for caching, rate limiting, and performance monitoring.

### GitHub & Authentication (5 services)
Services for GitHub API interaction and OAuth authentication.

### Collection Management (5 services)
Services for browsing, searching, and installing from the community collection.

### Portfolio Management (8 services)
Services for local portfolio, indexing, and GitHub synchronization.

### Element Managers (6 services)
Managers for each element type (personas, skills, templates, agents, memories, ensembles).

### NLP & Indexing (5 services)
Advanced indexing, semantic analysis, and relationship tracking.

### Security Services (7 services)
Encryption, validation, telemetry, and security monitoring.

### Conversion & Import/Export (3 services)
Format converters and import/export utilities.

### Server & Diagnostics (3 services)
Server setup, build info, and performance monitoring.

---

## Complete Service List

### Core & Configuration

#### `ConfigManager`
**Purpose:** Manages all DollhouseMCP configuration (user settings, GitHub auth, display preferences, sync settings)
**Scope:** Singleton
**Dependencies:** None
**Used By:** GitHubAuthManager, PortfolioHandler, ConfigHandler, many others
**File:** `src/config/ConfigManager.ts`

#### `IndexConfigManager`
**Purpose:** Manages configuration for Enhanced Index (NLP, relationships, performance tuning)
**Scope:** Singleton
**Dependencies:** None
**Used By:** NLPScoringManager, VerbTriggerManager, RelationshipManager, EnhancedIndexManager
**File:** `src/portfolio/config/IndexConfig.ts`

#### `IndicatorConfig`
**Purpose:** Configuration for persona indicator display (style, emoji, format)
**Scope:** Singleton
**Dependencies:** None
**Used By:** PersonaManager, IndicatorService
**File:** `src/config/indicator-config.ts`

#### `StateChangeNotifier`
**Purpose:** Pub/sub for element activation/deactivation events
**Scope:** Singleton
**Dependencies:** None
**Used By:** PersonaManager, IndicatorService
**File:** `src/services/StateChangeNotifier.ts`

#### `FileLockManager`
**Purpose:** File locking for concurrent access control
**Scope:** Singleton
**Dependencies:** None
**Used By:** All element managers (prevents race conditions in file I/O)
**File:** `src/security/fileLockManager.ts`

#### `InitializationService`
**Purpose:** Coordinates server initialization and startup sequence
**Scope:** Singleton
**Dependencies:** PersonaManager
**Used By:** DollhouseMCPServer, handlers
**File:** `src/services/InitializationService.ts`

#### `IndicatorService`
**Purpose:** Manages persona indicator generation and formatting
**Scope:** Singleton
**Dependencies:** PersonaManager, IndicatorConfig, StateChangeNotifier
**Used By:** PersonaHandler, ElementCRUDHandler
**File:** `src/services/IndicatorService.ts`

---

### Caching & Performance

#### `APICache`
**Purpose:** Caches GitHub API responses (5-minute TTL, LRU eviction)
**Scope:** Singleton
**Dependencies:** None
**Used By:** GitHubClient, CollectionHandler, SubmitToPortfolioTool
**File:** `src/cache/APICache.ts`

#### `CollectionCache`
**Purpose:** Offline cache for community collection data
**Scope:** Singleton
**Dependencies:** None
**Used By:** CollectionBrowser, CollectionHandler
**File:** `src/cache/CollectionCache.ts`

#### `RateLimitTracker`
**Purpose:** Tracks GitHub API rate limit state
**Scope:** Singleton
**Dependencies:** None
**Implementation:** `Map<string, number[]>`
**Used By:** GitHubClient

#### `PerformanceMonitor`
**Purpose:** Monitors and logs performance metrics (operation timing, resource usage)
**Scope:** Singleton
**Dependencies:** None
**Used By:** CollectionSearch, UnifiedIndexManager
**File:** `src/utils/PerformanceMonitor.ts`

---

### GitHub & Authentication

#### `GitHubClient`
**Purpose:** Low-level GitHub REST API client with caching and rate limiting
**Scope:** Singleton
**Dependencies:** APICache, RateLimitTracker
**Used By:** CollectionBrowser, CollectionSearch, PersonaDetails, ElementInstaller
**File:** `src/collection/GitHubClient.ts`

#### `GitHubAuthManager`
**Purpose:** OAuth device flow authentication, token management
**Scope:** Singleton
**Dependencies:** APICache, ConfigManager
**Used By:** GitHubAuthHandler, PortfolioHandler
**File:** `src/auth/GitHubAuthManager.ts`

#### `GitHubRateLimiter`
**Purpose:** GitHub API rate limiting enforcement
**Scope:** Singleton
**Dependencies:** None
**Used By:** SubmitToPortfolioTool
**File:** `src/utils/GitHubRateLimiter.ts`

#### `GitHubPortfolioIndexer`
**Purpose:** Indexes elements from GitHub portfolio repositories
**Scope:** Singleton
**Dependencies:** None
**Used By:** UnifiedIndexManager, PortfolioPullHandler
**File:** `src/portfolio/GitHubPortfolioIndexer.ts`

#### `PortfolioRepoManager`
**Purpose:** Manages GitHub portfolio repository operations (create, validate, content management)
**Scope:** Singleton
**Dependencies:** getPortfolioRepositoryName() config
**Used By:** PortfolioHandler, PortfolioPullHandler, SubmitToPortfolioTool
**File:** `src/portfolio/PortfolioRepoManager.ts`

---

### Collection Management

#### `CollectionBrowser`
**Purpose:** Browses community collection by section (library, showcase, catalog)
**Scope:** Singleton
**Dependencies:** GitHubClient, CollectionCache, CollectionIndexManager
**Used By:** CollectionHandler
**File:** `src/collection/CollectionBrowser.ts`

#### `CollectionSearch`
**Purpose:** Searches community collection with pagination and filtering
**Scope:** Singleton
**Dependencies:** GitHubClient, CollectionCache, PerformanceMonitor
**Used By:** CollectionHandler
**File:** `src/collection/CollectionSearch.ts`

#### `CollectionIndexManager`
**Purpose:** Manages indexed collection metadata for fast search
**Scope:** Singleton
**Dependencies:** None
**Used By:** CollectionBrowser
**File:** `src/collection/CollectionIndexManager.ts`

#### `ElementInstaller`
**Purpose:** Installs elements from collection to local portfolio
**Scope:** Singleton
**Dependencies:** GitHubClient, PortfolioManager
**Used By:** CollectionHandler
**File:** `src/collection/ElementInstaller.ts`

#### `PersonaDetails`
**Purpose:** Retrieves detailed persona information from collection
**Scope:** Singleton
**Dependencies:** GitHubClient
**Used By:** CollectionHandler
**File:** `src/collection/PersonaDetails.ts`

---

### Portfolio Management

#### `PortfolioManager`
**Purpose:** Core portfolio operations (directory structure, element discovery, path management)
**Scope:** Singleton
**Dependencies:** None
**Used By:** All element managers, CollectionHandler, handlers
**File:** `src/portfolio/PortfolioManager.ts`

#### `PortfolioIndexManager`
**Purpose:** Maintains index of local portfolio elements for fast lookup
**Scope:** Singleton
**Dependencies:** IndexConfigManager, PortfolioManager
**Used By:** EnhancedIndexManager, UnifiedIndexManager, PortfolioHandler
**File:** `src/portfolio/PortfolioIndexManager.ts`

#### `UnifiedIndexManager`
**Purpose:** Multi-source search across local, GitHub, and collection
**Scope:** Singleton
**Dependencies:** PortfolioIndexManager, GitHubPortfolioIndexer, GitHubClient, PerformanceMonitor
**Used By:** PortfolioHandler, CollectionHandler
**File:** `src/portfolio/UnifiedIndexManager.ts`

#### `EnhancedIndexManager`
**Purpose:** Semantic indexing with NLP scoring and relationship tracking
**Scope:** Singleton
**Dependencies:** IndexConfigManager, ConfigManager, PortfolioIndexManager, NLPScoringManager, VerbTriggerManager, RelationshipManager
**Used By:** EnhancedIndexHandler
**File:** `src/portfolio/EnhancedIndexManager.ts`

#### `PortfolioSyncManager`
**Purpose:** Portfolio synchronization with GitHub (push, pull, bidirectional)
**Scope:** Singleton
**Dependencies:** ConfigManager, PortfolioManager, PortfolioRepoManager, GitHubPortfolioIndexer
**Used By:** PortfolioHandler
**File:** `src/portfolio/PortfolioSyncManager.ts`

#### `PortfolioSyncComparer`
**Purpose:** Compares local vs remote portfolio state for sync operations
**Scope:** Singleton
**Dependencies:** None
**Used By:** PortfolioPullHandler
**File:** `src/sync/PortfolioSyncComparer.ts`

#### `PortfolioDownloader`
**Purpose:** Downloads individual elements from GitHub portfolio
**Scope:** Singleton
**Dependencies:** None
**Used By:** PortfolioPullHandler
**File:** `src/sync/PortfolioDownloader.ts`

#### `MigrationManager`
**Purpose:** Migrates legacy portfolio formats to current version
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager
**Used By:** DollhouseContainer.preparePortfolio()
**File:** `src/portfolio/MigrationManager.ts`

---

### Element Managers

All element managers extend `BaseElementManager` and provide CRUD operations for their element type.

#### `PersonaManager`
**Purpose:** Manages persona lifecycle (activation, deactivation, import, export)
**Scope:** Singleton
**Dependencies:** PortfolioManager, IndicatorConfig, FileLockManager, PersonaImporter, StateChangeNotifier
**Used By:** PersonaHandler, ElementCRUDHandler, InitializationService
**File:** `src/persona/PersonaManager.ts`

#### `SkillManager`
**Purpose:** Manages skill elements (discrete capabilities)
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager
**Used By:** ElementCRUDHandler
**File:** `src/elements/skills/SkillManager.ts`

#### `TemplateManager`
**Purpose:** Manages template elements (reusable content structures)
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager
**Used By:** ElementCRUDHandler, TemplateRenderer
**File:** `src/elements/templates/TemplateManager.ts`

#### `AgentManager`
**Purpose:** Manages agent elements (autonomous task actors)
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager, base directory
**Used By:** ElementCRUDHandler
**File:** `src/elements/agents/AgentManager.ts`

#### `MemoryManager`
**Purpose:** Manages memory elements (persistent context storage)
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager
**Used By:** ElementCRUDHandler, BackgroundValidator
**File:** `src/elements/memories/MemoryManager.ts`

#### `EnsembleManager`
**Purpose:** Manages ensemble elements (coordinated element groups)
**Scope:** Singleton
**Dependencies:** PortfolioManager, FileLockManager
**Used By:** ElementCRUDHandler
**File:** `src/elements/ensembles/EnsembleManager.ts`

---

### NLP & Indexing

#### `NLPScoringManager`
**Purpose:** Semantic similarity scoring (Jaccard, Shannon entropy)
**Scope:** Singleton
**Dependencies:** IndexConfigManager
**Used By:** EnhancedIndexManager, RelationshipManager
**File:** `src/portfolio/NLPScoringManager.ts`

#### `VerbTriggerManager`
**Purpose:** Maps action verbs to elements that can handle them
**Scope:** Singleton
**Dependencies:** IndexConfigManager
**Used By:** EnhancedIndexManager, RelationshipManager
**File:** `src/portfolio/VerbTriggerManager.ts`

#### `RelationshipManager`
**Purpose:** Tracks element relationships (semantic, verb-based, dependencies)
**Scope:** Singleton
**Dependencies:** IndexConfigManager, VerbTriggerManager, NLPScoringManager
**Used By:** EnhancedIndexManager
**File:** `src/portfolio/RelationshipManager.ts`

#### `TemplateRenderer`
**Purpose:** Renders template content with variable substitution
**Scope:** Singleton
**Dependencies:** TemplateManager
**Used By:** ElementCRUDHandler
**File:** `src/utils/TemplateRenderer.ts`

#### `SubmitToPortfolioTool`
**Purpose:** Submits elements to GitHub portfolio and collection
**Scope:** Singleton
**Dependencies:** APICache, GitHubAuthManager, PortfolioManager, PortfolioIndexManager, PortfolioRepoManager, GitHubRateLimiter
**Used By:** CollectionHandler
**File:** `src/tools/portfolio/submitToPortfolioTool.ts`

---

### Security Services

#### `PatternEncryptor`
**Purpose:** Encrypts sensitive patterns in memory content
**Scope:** Singleton
**Dependencies:** None
**Used By:** PatternDecryptor, PatternExtractor
**File:** `src/security/encryption/PatternEncryptor.ts`

#### `PatternDecryptor`
**Purpose:** Decrypts encrypted patterns with context tracking
**Scope:** Singleton
**Dependencies:** PatternEncryptor, ContextTracker
**Used By:** Memory validation flows
**File:** `src/security/encryption/PatternDecryptor.ts`

#### `ContextTracker`
**Purpose:** Tracks context for pattern encryption/decryption
**Scope:** Singleton
**Dependencies:** None
**Used By:** PatternDecryptor
**File:** `src/security/encryption/ContextTracker.ts`

#### `PatternExtractor`
**Purpose:** Extracts and validates patterns from content
**Scope:** Singleton
**Dependencies:** PatternEncryptor
**Used By:** BackgroundValidator
**File:** `src/security/validation/PatternExtractor.ts`

#### `BackgroundValidator`
**Purpose:** Background validation of memory security patterns
**Scope:** Singleton
**Dependencies:** PatternExtractor, MemoryManager
**Used By:** DollhouseMCPServer.run() (started on initialization)
**File:** `src/security/validation/BackgroundValidator.ts`

#### `SecurityTelemetry`
**Purpose:** Collects security metrics and audit events
**Scope:** Singleton
**Dependencies:** None
**Used By:** ContentValidator (via resolver pattern)
**File:** `src/security/telemetry/SecurityTelemetry.ts`

#### `FileLockManager` (listed in Core but crucial for security)
**Purpose:** Prevents race conditions and ensures atomic file operations
**Scope:** Singleton
**Dependencies:** None
**Used By:** All element managers

---

### Conversion & Import/Export

#### `AnthropicToDollhouseConverter`
**Purpose:** Converts Anthropic persona format to DollhouseMCP format
**Scope:** Singleton
**Dependencies:** None
**Used By:** Persona import workflows
**File:** `src/converters/AnthropicToDollhouseConverter.ts`

#### `DollhouseToAnthropicConverter`
**Purpose:** Converts DollhouseMCP persona format to Anthropic format
**Scope:** Singleton
**Dependencies:** None
**Used By:** Persona export workflows
**File:** `src/converters/DollhouseToAnthropicConverter.ts`

#### `PersonaImporter`
**Purpose:** Imports personas from files or JSON blobs
**Scope:** Singleton
**Dependencies:** PortfolioManager, PersonaManager (for user attribution)
**Used By:** PersonaHandler, PersonaManager
**File:** `src/persona/export-import/PersonaImporter.ts`

---

### Server & Diagnostics

#### `ServerSetup`
**Purpose:** Server initialization and configuration
**Scope:** Singleton
**Dependencies:** None
**Used By:** DollhouseMCPServer
**File:** `src/server/ServerSetup.ts`

#### `BuildInfoService`
**Purpose:** Provides build metadata (version, git SHA, platform, dependencies)
**Scope:** Singleton
**Dependencies:** None
**Used By:** BuildInfoTools
**File:** `src/services/BuildInfoService.ts`

#### `PerformanceMonitor` (also in Caching)
**Purpose:** Monitors operation timing and resource usage
**Scope:** Singleton
**Dependencies:** None
**Used By:** CollectionSearch, UnifiedIndexManager
**File:** `src/utils/PerformanceMonitor.ts`

---

### Handler Services (Created in createHandlers())

The following handlers are NOT registered as services (created on-demand):

- `PersonaHandler` - Persona operations
- `ElementCRUDHandler` - Generic element CRUD
- `CollectionHandler` - Collection interactions
- `PortfolioHandler` - Portfolio management
- `GitHubAuthHandler` - GitHub authentication
- `DisplayConfigHandler` - Display configuration
- `IdentityHandler` - User identity
- `ConfigHandler` - Configuration operations
- `SyncHandler` (SyncHandlerV2) - Synchronization
- `EnhancedIndexHandler` - Enhanced indexing
- `PortfolioPullHandler` - Individual element download

These are instantiated in `DollhouseContainer.createHandlers()` after portfolio initialization.

---

## Service Dependencies

### Dependency Graph (Key Services)

```
PortfolioManager (root)
├── PersonaManager
│   ├── IndicatorConfig
│   ├── FileLockManager
│   ├── PersonaImporter
│   └── StateChangeNotifier
├── EnhancedIndexManager
│   ├── IndexConfigManager
│   ├── ConfigManager
│   ├── PortfolioIndexManager
│   ├── NLPScoringManager
│   ├── VerbTriggerManager
│   └── RelationshipManager
├── UnifiedIndexManager
│   ├── PortfolioIndexManager
│   ├── GitHubPortfolioIndexer
│   ├── GitHubClient
│   └── PerformanceMonitor
└── All Element Managers (Skill, Template, Agent, Memory, Ensemble)
    ├── PortfolioManager
    └── FileLockManager

GitHubClient
├── APICache
└── RateLimitTracker

GitHubAuthManager
├── APICache
└── ConfigManager

CollectionBrowser
├── GitHubClient
├── CollectionCache
└── CollectionIndexManager
```

### Circular Dependency Prevention

The container uses **lazy resolution** to prevent circular dependencies:

```typescript
// PersonaImporter needs PersonaManager for currentUser
this.register('PersonaImporter', () => {
  const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');
  const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);

  // Lazy resolution - PersonaManager resolved when needed, not during registration
  const currentUserProvider = () => this.resolve<PersonaManager>('PersonaManager').getCurrentUserForAttribution();

  return new PersonaImporter(personasDir, currentUserProvider);
});
```

---

## Lifecycle Management

### Service Lifecycle Phases

#### 1. Registration (Constructor)
All services registered with factory functions:
```typescript
constructor() {
  this.registerServices();
}

private registerServices(): void {
  this.register('ConfigManager', () => new ConfigManager());
  this.register('PortfolioManager', () => new PortfolioManager());
  // ... 51 more services
}
```

#### 2. Portfolio Preparation (preparePortfolio)
```typescript
public async preparePortfolio(): Promise<void> {
  const migrationManager = this.resolve<MigrationManager>('MigrationManager');
  const portfolioManager = this.resolve<PortfolioManager>('PortfolioManager');

  // Migrate legacy formats
  await migrationManager.migrate();

  // Initialize portfolio directories
  await portfolioManager.initialize();

  // Initialize collection cache
  await this.initializeCollectionCache();

  this.personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
}
```

#### 3. Handler Creation (createHandlers)
```typescript
public async createHandlers(server: Server): Promise<HandlerBundle> {
  // Create all 10 handlers with dependencies
  const personaHandler = new PersonaHandler(
    this.resolve('PersonaManager'),
    // ... dependencies
  );

  // ... create remaining handlers

  return {
    personaHandler,
    elementCrudHandler,
    collectionHandler,
    // ... all handlers
  };
}
```

#### 4. Runtime (Lazy Resolution)
Services instantiated on first use:
```typescript
const configManager = this.resolve<ConfigManager>('ConfigManager');
// ConfigManager factory called here if not already cached
```

#### 5. Disposal (dispose)
```typescript
public async dispose(): Promise<void> {
  // Clean up resources, close connections, etc.
  // Called on server shutdown
}
```

---

## Adding New Services

### Step-by-Step Guide

#### 1. Create Service Class
```typescript
// src/services/MyNewService.ts
export class MyNewService {
  constructor(private dependency1: Dependency1, private dependency2: Dependency2) {}

  async doSomething(): Promise<void> {
    // Implementation
  }
}
```

#### 2. Register Service in Container
```typescript
// src/di/Container.ts
import { MyNewService } from '../services/MyNewService.js';

private registerServices(): void {
  // ... existing registrations

  this.register('MyNewService', () => new MyNewService(
    this.resolve('Dependency1'),
    this.resolve('Dependency2')
  ));
}
```

#### 3. Use Service
```typescript
// In any handler or service
const myService = this.container.resolve<MyNewService>('MyNewService');
await myService.doSomething();
```

### Singleton vs Transient

Most services should be **singletons** (default):
```typescript
this.register('MyService', () => new MyService(), { singleton: true });
```

Use **transient** only for stateless utilities or per-request services:
```typescript
this.register('MyUtility', () => new MyUtility(), { singleton: false });
```

---

## Best Practices

### 1. Keep Services Focused
Each service should have a single, well-defined responsibility:
- ✅ `ConfigManager` - manages configuration
- ✅ `GitHubClient` - GitHub API client
- ❌ `EverythingManager` - does too much

### 2. Inject All Dependencies
Never create dependencies manually inside a service:
```typescript
// Bad
class MyService {
  private config = new ConfigManager();  // ❌ Manual instantiation
}

// Good
class MyService {
  constructor(private config: ConfigManager) {}  // ✅ Dependency injection
}
```

### 3. Use Interfaces for Testability
```typescript
interface IConfigManager {
  getSetting(key: string): any;
}

class MyService {
  constructor(private config: IConfigManager) {}  // ✅ Interface
}
```

### 4. Avoid Circular Dependencies
If Service A needs Service B, and Service B needs Service A, refactor:
- Extract shared logic to a third service
- Use lazy resolution (provider functions)
- Reconsider responsibilities

### 5. Document Dependencies
```typescript
/**
 * MyService - Does something important
 *
 * Dependencies:
 * - ConfigManager: Configuration access
 * - FileLockManager: File locking
 *
 * Used By:
 * - MyHandler: Primary consumer
 */
```

### 6. Keep Registration Order Logical
Group related services together:
```typescript
// Core services first
this.register('ConfigManager', ...);
this.register('FileLockManager', ...);

// Then higher-level services
this.register('PortfolioManager', ...);

// Finally handlers
```

---

## Summary

The DollhouseContainer manages **54 services** across 10 categories:

| Category | Count | Key Services |
|----------|-------|--------------|
| Core & Configuration | 7 | ConfigManager, FileLockManager |
| Caching & Performance | 4 | APICache, CollectionCache |
| GitHub & Authentication | 5 | GitHubClient, GitHubAuthManager |
| Collection Management | 5 | CollectionBrowser, CollectionSearch |
| Portfolio Management | 8 | PortfolioManager, UnifiedIndexManager |
| Element Managers | 6 | PersonaManager, SkillManager, etc. |
| NLP & Indexing | 5 | NLPScoringManager, VerbTriggerManager |
| Security Services | 7 | PatternEncryptor, BackgroundValidator |
| Conversion | 3 | AnthropicToDollhouseConverter, PersonaImporter |
| Server & Diagnostics | 3 | ServerSetup, BuildInfoService |

All services follow the **Dependency Injection** pattern for:
- ✅ Testability (easy to mock dependencies)
- ✅ Maintainability (clear dependencies)
- ✅ Flexibility (swap implementations)
- ✅ Lifecycle Management (centralized control)

For detailed architecture, see [Architecture Overview](./overview.md).

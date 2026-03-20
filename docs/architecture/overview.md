# DollhouseMCP Server Architecture

**Version:** 2.0.0-beta
**Last Updated:** March 2026

## 1. Introduction

### 1.1. Project Overview

The DollhouseMCP Server is an open-source, AI customization platform that provides personas, skills, templates, agents, memories, and ensembles for AI assistants through the Model Context Protocol (MCP). It is a TypeScript-based server that runs as a local service, extending the capabilities of AI assistants by allowing users to manage and interact with a portfolio of "elements." All element operations are exposed through the MCP-AQL (Agent Query Language) CRUDE interface, a unified protocol layer that consolidates 50+ discrete tools into 5 semantically grouped endpoints with built-in permission enforcement.

This document provides a comprehensive overview of the server's architecture, components, and key workflows.

### 1.2. Purpose of this Document

This document is intended to help developers understand the architecture of the DollhouseMCP Server. It provides a high-level overview of the system, as well as a detailed breakdown of its components. This document should enable developers to:

*   Understand the overall architecture and design principles.
*   Navigate the codebase and locate specific functionality.
*   Contribute to the project by fixing bugs or adding new features.

### 1.3. Target Audience

This document is intended for software developers who are new to the DollhouseMCP Server project. It assumes a working knowledge of TypeScript, Node.js, and common software design patterns.

### 1.4. Terminology Glossary

This section defines key terms used throughout the document to ensure consistent understanding:

*   **Element:** A self-contained unit of functionality (Persona, Skill, Template, Agent, Memory, Ensemble). Can refer to the data class, the file on disk, or the concept.
*   **Element Type:** Category of element (Personas, Skills, Templates, Agents, Memories, Ensembles). Represented by the `ElementType` enum.
*   **Ensemble:** A composite element that bundles multiple elements (personas, skills, templates, agents, memories) into a single activatable unit with coordinated policies.
*   **Element Manager:** Service class managing CRUD operations for a specific element type. All managers extend `BaseElementManager`.
*   **Handler:** Facade layer implementing the MCP tool interface. Handlers route tool calls to appropriate managers and services.
*   **MCP-AQL:** Model Context Protocol - Agent Query Language. The unified interface layer that consolidates all element operations into 5 CRUDE endpoints. See [MCP-AQL Architecture](mcp-aql/OVERVIEW.md).
*   **CRUDE:** Create, Read, Update, Delete, Execute. The five endpoint categories of MCP-AQL. Extends traditional CRUD with an Execute endpoint for agent lifecycle operations.
*   **Gatekeeper:** The permission enforcement layer that validates every MCP-AQL operation against active element policies. Implements a four-level permission model (AUTO_APPROVE, CONFIRM_SESSION, CONFIRM_SINGLE_USE, DENY). See [Gatekeeper Confirmation Model](../security/gatekeeper-confirmation-model.md).
*   **Autonomy Evaluator:** The component that scores whether an executing agent should continue autonomously or pause for human input after each step.
*   **Danger Zone:** Hard-block enforcement for high-risk operations. Danger Zone denials cannot be confirmed or bypassed by the LLM; the element must be deactivated or the policy changed.
*   **Activation Store:** Per-session persistence of element activation state. Survives MCP server restarts by writing activation records to `~/.dollhouse/state/activations-{sessionId}.json`.
*   **Portfolio:** The user's collection of local elements stored on the filesystem, located in `~/.dollhouse/portfolio/`.
*   **Collection:** The community-managed repository of elements hosted on GitHub at `DollhouseMCP/collection`.
*   **Service:** A reusable business logic component (e.g., `GitHubClient`, `ConfigManager`, `PortfolioManager`).
*   **MCP Tool:** An interface exposed to AI assistants via the Model Context Protocol. In v2, tools are exposed as MCP-AQL endpoints rather than discrete per-operation tools.
*   **Container:** The Dependency Injection container (`DollhouseContainer`) that manages service lifecycle and dependencies.
*   **Scope:** In dependency injection, defines instance lifetime—**Singleton** (one shared instance) or **Transient** (new instance per resolution).

## 2. High-Level Architecture

### 2.1. Architectural Style

The DollhouseMCP Server follows a **modular monolith** architecture. The server is a single, deployable unit, but it is internally organized into a set of loosely coupled modules with well-defined responsibilities. The architecture employs dedicated responsibility domains for element management, collection services, portfolio operations, and MCP tool handling, ensuring maintainability and testability through clear separation of concerns.

#### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│              MCP Protocol (stdio/JSON-RPC)              │
└───────────────────────┬─────────────────────────────────┘
                        │
               ┌────────▼────────────┐
               │ DollhouseMCPServer  │
               │   Server Lifecycle  │
               └────────┬────────────┘
                        │
         ┌──────────────┴──────────────────────────────────┐
         │       MCP-AQL Layer (CRUDE Interface)           │
         ├─────────────────────────────────────────────────┤
         │  mcp_aql_create   │  mcp_aql_read               │
         │  mcp_aql_update   │  mcp_aql_delete             │
         │  mcp_aql_execute  │  (+ single unified mode)    │
         └────────┬────────────────────────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │       Security & Permission Layer               │
         ├─────────────────────────────────────────────────┤
         │  Gatekeeper           │  DangerZoneEnforcer     │
         │  Autonomy Evaluator   │  ActivationStore        │
         └────────┬────────────────────────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │         Handler Layer (Facade Pattern)          │
         ├─────────────────────────────────────────────────┤
         │  MCPAQLHandler     │  ElementCRUDHandler        │
         │  CollectionHandler │  PortfolioHandler          │
         │  PersonaHandler    │  EnhancedIndexHandler      │
         │  ConfigHandler     │  ResourceHandler           │
         └────────┬────────────────────────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │      Element Management Layer                   │
         ├─────────────────────────────────────────────────┤
         │  PersonaManager      │  PersonaElementManager   │
         │  SkillManager        │  TemplateManager         │
         │  AgentManager        │  MemoryManager           │
         │  EnsembleManager     │                          │
         └────────┬────────────────────────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │          Service & Infrastructure Layer         │
         ├─────────────────────────────────────────────────┤
         │  PortfolioManager         │  UnifiedIndexMgr    │
         │  EnhancedIndexManager     │  GitHubClient       │
         │  CollectionBrowser        │  ConfigManager      │
         │  GitHubAuthManager        │  SecurityMonitor    │
         └────────┬────────────────────────────────────────┘
                  │
         ┌────────▼────────────────────────────────────────┐
         │     Storage & External Services Layer           │
         ├─────────────────────────────────────────────────┤
         │  ~/.dollhouse/portfolio/  │  GitHub API         │
         │  ~/.dollhouse/state/      │  Collection Cache   │
         │  ~/.dollhouse/pages/      │  Security Audit     │
         └─────────────────────────────────────────────────┘
```

### 2.2. Key Principles

The architecture is guided by the following principles:

*   **Separation of Concerns (SoC):** The codebase is divided into distinct modules, each with a specific responsibility (e.g., element management, MCP tool handling, portfolio management).
*   **Dependency Injection (DI):** The server uses a DI container to manage the lifecycle of its components and to decouple them from each other. This makes the code more modular, testable, and maintainable.
*   **Single Responsibility Principle (SRP):** Each class and module has a single, well-defined responsibility.
*   **Design Patterns:** The system implements several industry-standard patterns (Template Method, Facade, Strategy, Repository) to ensure consistency and maintainability.

### 2.2.1. Architectural Patterns

The system implements several industry-standard design patterns:

*   **Template Method Pattern** (`BaseElementManager`)
    *   Defines the skeleton of element management operations in the base class
    *   Subclasses override specific steps for element type-specific behavior
    *   Eliminates code duplication across element managers
    *   Example: The `load()` method provides a template with `parseMetadata()` as an overridable hook

*   **Facade Pattern** (Handlers)
    *   Simplifies the complex subsystem of managers, services, and MCP protocol
    *   Provides a single, unified interface for related operations
    *   Handlers shield implementation details from the MCP layer
    *   Example: `ElementCRUDHandler` wraps all element manager calls with a consistent interface

*   **Dependency Injection Pattern** (`DollhouseContainer`)
    *   Decouples services from their dependencies
    *   Centralizes service configuration and lifecycle management
    *   Enables testability through mockable dependencies
    *   Example: Handlers receive all dependencies via constructor injection

*   **Strategy Pattern** (Element-specific implementations)
    *   Different strategies for parsing and validating different element types
    *   Shared interface through `BaseElementManager`
    *   Each element type implements its own parsing and validation strategy
    *   Example: Persona vs Skill vs Template metadata parsing

*   **Repository Pattern** (`PortfolioManager`, `GitHubClient`)
    *   Abstracts data source access (local filesystem, GitHub API)
    *   Provides uniform interface for local and remote storage
    *   Enables caching and optimization strategies transparently
    *   Example: Fetch elements from cache or API without caller awareness

*   **Observer Pattern** (Security auditing)
    *   Security monitors observe operations without intrusion
    *   Non-intrusive security checks and logging
    *   Audit trail generation for compliance
    *   Example: `SecurityMonitor` tracks file access and validation events

*   **Singleton Pattern** (Selected services)
    *   Managed by the DI container for lifecycle control
    *   Single instance per process for shared state
    *   Examples: `PortfolioManager`, `ConfigManager`, `GitHubAuthManager`

### 2.3. Technology Stack

*   **Language:** TypeScript
*   **Runtime:** Node.js
*   **Framework:** The server is built on top of the `@modelcontextprotocol/sdk`, which provides the core MCP server implementation.
*   **Key Libraries:**
    *   `gray-matter`: For parsing YAML frontmatter from Markdown files.
    *   `js-yaml`: For parsing YAML.
    *   `madge`: For detecting circular dependencies.

## 3. Core Concepts

### 3.1. Elements

Elements are the core building blocks of the DollhouseMCP ecosystem. Each element is a self-contained customization file — a markdown or YAML document that shapes the LLM's behavior, capabilities, or context in a specific structured way. The following element types are supported:

*   **Personas:** AI behavioral profiles that define the assistant's personality and communication style. Contain `instructions` (behavioral directives) as their primary field.
*   **Skills:** Discrete capabilities that the assistant can perform (e.g., code review, data analysis).
*   **Templates:** Reusable content structures with section format support (`<template>`, `<style>`, `<script>` blocks).
*   **Agents:** Autonomous task actors that can be given goals to achieve. Execute through the agentic loop with Gatekeeper and Autonomy Evaluator enforcement at every step.
*   **Memories:** Persistent context storage for the AI assistant. Modern memories use YAML `entries:` format.
*   **Ensembles:** Composite elements that bundle multiple element types (personas, skills, templates, agents, memories) into a single activatable unit. Ensembles define member elements, activation strategies, and coordinated Gatekeeper policies. When activated, all constituent elements activate together with unified policy enforcement.

### 3.2. Model Context Protocol (MCP)

MCP is a JSON-RPC-based protocol that allows AI assistants to communicate with local services like the DollhouseMCP Server. The server exposes a set of MCP tools that the assistant can use to manage and interact with elements.

### 3.3. Portfolio

The portfolio is a user-managed collection of elements stored on the local filesystem. The server is responsible for loading, managing, and saving elements in the portfolio.

### 3.4. Collection

The collection is a community-managed repository of elements hosted on GitHub. The server provides tools for browsing, searching, and installing elements from the collection.

## 4. Directory Structure

The `mcp-server/src` directory is organized by domain with clear separation of concerns:

### Top-Level Modules

*   **`auth/`** - GitHub authentication management
    *   `GitHubAuthManager.ts` - OAuth device flow and token management
    *   `types.ts` - Authentication type definitions

*   **`cache/`** - Caching layer for performance and resilience
    *   `CollectionCache.ts` - Community collection data cache
    *   `CollectionIndexCache.ts` - Indexed collection cache
    *   `APICache.ts` - API response caching
    *   `LRUCache.ts` - Least Recently Used cache implementation

*   **`cli/`** - Command-line utilities
    *   `format-element.ts` - Element formatting for display

*   **`collection/`** - Community collection interaction
    *   `CollectionBrowser.ts` - Browsing functionality
    *   `CollectionSearch.ts` - Search implementation
    *   `CollectionIndexManager.ts` - Index management
    *   `ElementInstaller.ts` - Installation from collection
    *   `GitHubClient.ts` - GitHub API client
    *   `PersonaDetails.ts` - Persona information retrieval
    *   `PersonaSubmitter.ts` - Collection submission handler

*   **`config/`** - Configuration management
    *   `ConfigManager.ts` - Main configuration handler
    *   `ConfigWizard.ts` - Interactive setup wizard
    *   `element-types.ts` - Element type definitions
    *   `portfolio-constants.ts` - Portfolio-specific constants
    *   `indicator-config.ts` - Display indicator configuration

*   **`constants/`** - Project-wide constants
    *   `defaultPersonas.ts` - Built-in default personas
    *   `limits.ts` - System limits and boundaries

*   **`di/`** - Dependency Injection Container
    *   `Container.ts` - `DollhouseContainer` implementation (20.8KB)

*   **`elements/`** - Core element management system
    *   `base/` - Shared element infrastructure
        *   `BaseElementManager.ts` - Abstract template method base class
        *   `ElementFileOperations.ts` - File system operations
        *   `ElementValidation.ts` - Validation framework
    *   `skills/` - Skill element type
        *   `SkillManager.ts` - Skill-specific operations
    *   `templates/` - Template element type
        *   `TemplateManager.ts` - Template-specific operations
        *   `TemplateRenderer.ts` - Template rendering engine
    *   `agents/` - Agent element type
        *   `AgentManager.ts` - Agent-specific operations
    *   `memories/` - Memory element type
        *   `MemoryManager.ts` - Memory-specific operations
    *   `ensembles/` - Ensemble element type
        *   `EnsembleManager.ts` - Ensemble composition and orchestration
        *   `Ensemble.ts` - Ensemble data model
    *   `BaseElement.ts` - Base class for all elements
    *   `FeedbackProcessor.ts` - User feedback handling

*   **`errors/`** - Custom error classes
    *   Domain-specific error definitions and error handling

*   **`generated/`** - Auto-generated files
    *   Tool definitions and type stubs

*   **`handlers/`** - MCP Tool Handlers (Facade Layer)
    *   `mcp-aql/` - MCP-AQL CRUDE interface layer
        *   `MCPAQLHandler.ts` - Main entry point, orchestrates dispatch
        *   `UnifiedEndpoint.ts` - Single endpoint mode routing
        *   `Gatekeeper.ts` - Route validation and policy enforcement
        *   `OperationRouter.ts` - Operation-to-endpoint mapping
        *   `OperationSchema.ts` - Declarative operation definitions
        *   `SchemaDispatcher.ts` - Schema-driven handler dispatch
        *   `IntrospectionResolver.ts` - GraphQL-style introspection
    *   `ElementCRUDHandler.ts` - Generic element CRUD operations
    *   `PersonaHandler.ts` - Persona-specific operations
    *   `CollectionHandler.ts` - Collection interactions
    *   `PortfolioHandler.ts` - Portfolio management
    *   `GitHubAuthHandler.ts` - GitHub authentication
    *   `EnhancedIndexHandler.ts` - Semantic analysis and relationships
    *   `DisplayConfigHandler.ts` - Indicator configuration
    *   `IdentityHandler.ts` - User identity management
    *   `ConfigHandler.ts` - Configuration operations
    *   `SyncHandlerV2.ts` - Synchronization orchestration
    *   `PortfolioPullHandler.ts` - GitHub portfolio pulling
    *   `ResourceHandler.ts` - MCP Resources capability management
    *   `ToolRegistry.ts` - Handler registration with MCP tools
    *   `element-crud/` - CRUD handler specialization
    *   `strategies/` - Activation strategies (including EnsembleActivationStrategy)
    *   `types/` - Handler type definitions

*   **`persona/`** - Persona-specific logic
    *   `PersonaManager.ts` - Persona lifecycle management (28.2KB)
    *   `PersonaElementManager.ts` - Extends BaseElementManager (14.4KB)
    *   `PersonaLoader.ts` - Specialized loading with caching (9.9KB)
    *   `PersonaElement.ts` - Data model (10.5KB)
    *   `PersonaValidator.ts` - Validation logic (6.3KB)
    *   `export-import/` - Import/export functionality

*   **`portfolio/`** - Portfolio management system
    *   `PortfolioManager.ts` - Main portfolio interface
    *   `PortfolioIndexManager.ts` - Indexing operations
    *   `UnifiedIndexManager.ts` - Multi-source indexing
    *   `EnhancedIndexManager.ts` - Semantic indexing with NLP
    *   `VerbTriggerManager.ts` - Action verb to element mapping
    *   `RelationshipManager.ts` - Element relationship tracking
    *   `NLPScoringManager.ts` - Semantic similarity scoring
    *   `MigrationManager.ts` - Legacy format migration
    *   `PortfolioRepoManager.ts` - GitHub repository management
    *   `PortfolioSyncManager.ts` - Synchronization strategies
    *   `GitHubPortfolioIndexer.ts` - GitHub portfolio indexing
    *   `config/` - Portfolio configuration files
    *   `types/` - Portfolio type definitions

*   **`security/`** - Security and validation
    *   `InputValidator.ts` - Input sanitization
    *   `pathValidator.ts` - Path traversal prevention
    *   `secureYamlParser.ts` - Secure YAML parsing (YAML bomb prevention)
    *   `fileLockManager.ts` - Concurrent access control
    *   `errorHandler.ts` - Secure error handling
    *   `securityMonitor.ts` - Security event monitoring
    *   `validators/` - Specialized validators
    *   `audit/` - Security audit system
        *   `scanners/` - Vulnerability scanners
        *   `rules/` - Audit rules
        *   `reporters/` - Audit reporters
        *   `config/` - Audit configuration

*   **`server/`** - Server setup and MCP integration
    *   `ServerSetup.ts` - Server initialization
    *   `startup.ts` - Startup sequence
    *   `tools/` - MCP tool implementations
    *   `types.ts` - Server type definitions

*   **`services/`** - Business logic services
    *   Domain-specific service implementations

*   **`sync/`** - Synchronization logic
    *   Portfolio and collection synchronization services

*   **`tools/`** - MCP Tool Implementations
    *   `portfolio/` - Portfolio-related tools

*   **`types/`** - TypeScript type definitions
    *   `persona.ts` - Persona types
    *   `elements/` - Element type definitions
    *   Global type definitions

*   **`utils/`** - Utility functions
    *   `logger.ts` - Logging infrastructure
    *   `ErrorHandler.ts` - Error handling utilities
    *   `TemplateRenderer.ts` - Template rendering
    *   `migrate-legacy-memories.ts` - Memory migration utility

### Special Files

*   **`index.ts`** (745 lines) - Main server entry point
    *   Server lifecycle management
    *   Handler delegation
    *   Tool registry management
    *   Graceful shutdown handling

*   **`benchmarks/`** - Performance benchmarking
    *   `IndexPerformanceBenchmark.ts` - Index performance testing

## 5. Detailed Component Breakdown

This section provides a detailed description of the major components of the server.

### 5.1. Dependency Injection (`src/di`)

*   **Purpose:** Manages the lifecycle of all services and handlers, following Inversion of Control (IoC) principles.

*   **Key Files:**
    *   `Container.ts` (20.8KB) - The `DollhouseContainer` implementation

*   **How it Works:**

The `DollhouseContainer` is a lightweight, custom-built DI container that provides centralized service management.

#### Service Registration

The `registerServices()` method is the single source of truth for dependency configuration. Services are registered with:

*   **Name:** Unique identifier for resolution (e.g., `'portfolioManager'`, `'personaHandler'`)
*   **Factory Function:** Creates instances with dependencies injected as parameters
*   **Scope:**
    *   **Singleton:** Single instance shared across the application (most services)
    *   **Transient:** New instance created per resolution (rare cases)

#### Service Resolution

When a service is requested via `container.resolve(name)`:

1. Check if singleton instance already exists in cache
2. If not cached, invoke factory function with required dependencies
3. Cache result if singleton scope
4. Return instance to caller

The container handles lazy instantiation—singletons are only created when first requested, not at registration time.

#### Key Services Registered

The container manages 80+ services and handlers:

*   **Portfolio Services:** `PortfolioManager`, `EnhancedIndexManager`, `PortfolioIndexManager`, `UnifiedIndexManager`
*   **Element Managers:** `PersonaManager`, `PersonaElementManager`, `SkillManager`, `TemplateManager`, `AgentManager`, `MemoryManager`, `EnsembleManager`
*   **MCP-AQL Layer:** `MCPAQLHandler`, `Gatekeeper`, `OperationRouter`, `SchemaDispatcher`, `IntrospectionResolver`
*   **Security & Permissions:** `Gatekeeper`, `DangerZoneEnforcer`, `SecurityMonitor`, `FileLockManager`, `VerificationStore`, `TokenManager`, `PatternEncryptor`, `BackgroundValidator`, `SecurityTelemetry`
*   **Activation & State:** `ActivationStore` (per-session element persistence), `ContextTracker`
*   **Collection Services:** `GitHubClient`, `CollectionBrowser`, `CollectionSearch`, `ElementInstaller`, `CollectionIndexManager`
*   **Authentication:** `GitHubAuthManager`
*   **Handlers:** `MCPAQLHandler`, `ElementCRUDHandler`, `PersonaHandler`, `CollectionHandler`, `PortfolioHandler`, `GitHubAuthHandler`, `EnhancedIndexHandler`, `DisplayConfigHandler`, `IdentityHandler`, `ConfigHandler`, `ResourceHandler`
*   **Index Management:** `VerbTriggerManager`, `RelationshipManager`, `NLPScoringManager`
*   **Element Services:** `SerializationService`, `MetadataService`, `ValidationService`, `TriggerValidationService`, `PolicyExportService`
*   **Query Services:** `ElementQueryService`, `PaginationService`, `FilterService`, `SortService`
*   **Observability:** `OperationalTelemetry`, `LogManager`, `BuildInfoService`, `PerformanceMonitor`
*   **Configuration:** `ConfigManager`

#### Lifecycle Management

*   **`preparePortfolio()`:** Initializes portfolio manager and creates all element type directories
*   **`createHandlers(server)`:** Instantiates all handlers after portfolio is ready
*   **`dispose()`:** Gracefully shuts down services and cleans up resources

#### Why Custom Container?

The custom container is lightweight (~20KB) compared to full IoC frameworks (e.g., InversifyJS ~200KB+). It provides exactly what DollhouseMCP needs:

*   Simple service registration
*   Dependency resolution
*   Singleton lifecycle management
*   Graceful disposal

This keeps the bundle size small and startup fast while providing full DI benefits.

### 5.2. Element Management (`src/elements`)

*   **Purpose:** Provides the core logic for managing elements (Personas, Skills, Templates, Agents, Memories, Ensembles).

*   **Key Files:**
    *   `base/BaseElementManager.ts` (14.6KB) - Abstract template method base class
    *   `base/ElementFileOperations.ts` (8.7KB) - File system operations
    *   `base/ElementValidation.ts` (8.4KB) - Validation framework
    *   Element-specific managers in their respective directories

*   **How it Works:**

This component uses the **Template Method Pattern** to provide a consistent, reusable framework for all element types. `PersonaManager` remains a specialized legacy manager that orchestrates persona activation, while `PersonaElementManager` implements the shared template-method API for persona files. Skills, templates, agents, and memories all extend `BaseElementManager`.

#### Base Architecture

**`BaseElementManager`** (14.6KB) provides:

*   **Common CRUD Operations:** `load()`, `save()`, `list()`, `delete()`, `exists()`
*   **File I/O Handling:** Path validation, sanitization, concurrent access protection
*   **Caching Mechanisms:** In-memory caching for frequently accessed elements
*   **Template Methods:** Abstract methods for element-specific logic

The base class handles all common concerns, delegating element-specific behavior to subclasses through abstract methods:

*   `parseMetadata(content)`: Parse element-specific metadata from file content
*   `createElement(metadata, content)`: Instantiate element-specific class
*   `validateElement(element)`: Perform element-specific validation

**`ElementFileOperations`** (8.7KB) handles:

*   Sanitized file path handling with security validation
*   Concurrent access protection via `FileLockManager`
*   File read/write operations with error handling
*   Migration support for legacy file formats

**`ElementValidation`** (8.4KB) provides:

*   Metadata validation framework
*   Content validation
*   Custom validation hooks for subclasses
*   Validation error reporting

#### Element-Specific Managers

Each element type has a concrete manager extending `BaseElementManager`:

*   **`SkillManager.ts`**: Manages discrete capabilities
    *   Trigger validation (action verbs that invoke the skill)
    *   Skill metadata parsing
    *   Integration with `VerbTriggerManager`

*   **`TemplateManager.ts`**: Manages reusable content structures
    *   Template variable parsing
    *   Rendering integration with `TemplateRenderer`
    *   Variable validation

*   **`AgentManager.ts`**: Manages autonomous task actors
    *   Goal validation
    *   Agent capability tracking
    *   Decision-making logic support

*   **`MemoryManager.ts`**: Manages persistent context storage
    *   **Special Architecture:** Uses YAML files in organized folders
    *   **Memory Storage Organization (v1.9.26+):**
        *   `system/` - System-provided memories (seeds, baseline knowledge)
        *   `adapters/` - Adapter-specific configuration and context
        *   `backups/system/` - Backups of system memories
        *   `YYYY-MM-DD/` - User-created memories (date-organized)
    *   Memory indexing by date for chronological retrieval
    *   Metadata extraction for search
    *   This structure follows Unix conventions and enables clean separation of system vs. user content

*   **`EnsembleManager.ts`**: Manages ensemble elements (collections of personas, skills, templates, agents, memories)
    *   Ensemble composition and orchestration
    *   Multiple activation strategies support
    *   Conflict resolution between constituent elements

#### Personas (Special Case)

Personas have extended infrastructure due to their complexity:

*   **`PersonaManager.ts`** (28.2KB) - High-level persona operations
    *   Persona lifecycle management (activation, deactivation)
    *   Persona discovery and listing
    *   Integration with display indicators
    *   Import/export functionality

*   **`PersonaElementManager.ts`** (14.4KB) - Extends `BaseElementManager`
    *   File operations for persona files
    *   Delegates to `PersonaManager` for business logic
    *   Bridges element management pattern with persona-specific features

*   **`PersonaLoader.ts`** (9.9KB) - Specialized loading with caching
    *   Optimized persona loading from disk
    *   In-memory cache management
    *   Lazy loading support

*   **`PersonaElement.ts`** (10.5KB) - Data model
    *   Extended metadata (triggers, version, author, category)
    *   Persona content structure
    *   Validation rules

*   **`PersonaValidator.ts`** (6.3KB) - Persona-specific validation
    *   Trigger validation
    *   Metadata completeness checks
    *   Content structure validation

This separation allows persona-specific features (activation state, triggers, rich metadata) while maintaining consistency with other element types through the `BaseElementManager` pattern.

### 5.3. Handlers (`src/handlers`)

*   **Purpose:** Handle incoming MCP tool requests and orchestrate business logic. Handlers are the primary entry point for all MCP tool calls.

*   **Key Files:** 9 handler classes implementing the Facade pattern

*   **How it Works:**

Handlers act as a **Facade** layer, simplifying the interface to the complex subsystem of managers, services, and MCP protocol. They receive raw MCP tool requests, parse and validate arguments, coordinate services, and format responses.

This keeps the main server entry point (`index.ts`) focused on lifecycle management while handlers implement all business logic.

#### Core Handlers

*   **`ElementCRUDHandler.ts`** (25.9KB) - Generic element CRUD operations
    *   Element listing across all types (personas, skills, templates, agents, memories)
    *   Element activation and deactivation
    *   Element details retrieval
    *   Create, edit, validate, delete operations
    *   Delegates to appropriate `ElementManager` based on element type
    *   Handles cross-element operations (listing active elements of all types)

*   **`PersonaHandler.ts`** (19.8KB) - Persona-specific operations
    *   Persona listing with filtering (active, available, by category)
    *   Persona activation and deactivation state management
    *   Persona details and metadata retrieval
    *   Import/export functionality
    *   Integration with display indicators
    *   Delegates to `PersonaManager` and `PersonaElementManager`

*   **`CollectionHandler.ts`** (29.1KB) - Community collection interactions
    *   Collection browsing by section (library, showcase, catalog)
    *   Collection search with pagination and filtering
    *   Element installation from collection to local portfolio
    *   Collection content details retrieval
    *   Content submission to collection
    *   Cache health monitoring and management
    *   Delegates to `CollectionBrowser`, `CollectionSearch`, `ElementInstaller`

*   **`PortfolioHandler.ts`** (46.4KB) - User portfolio management
    *   Portfolio status and initialization
    *   Synchronization with GitHub (push, pull, bidirectional)
    *   Portfolio configuration management
    *   Portfolio search (local, GitHub, unified)
    *   Individual element download/upload
    *   Delegates to `PortfolioManager`, `PortfolioSyncManager`, `UnifiedIndexManager`

#### Supporting Handlers

*   **`GitHubAuthHandler.ts`** (28.5KB) - GitHub authentication and OAuth
    *   GitHub authentication setup via OAuth device flow
    *   Authentication status checking
    *   GitHub disconnection
    *   OAuth configuration management
    *   OAuth helper process monitoring
    *   Delegates to `GitHubAuthManager` and `ConfigManager`

*   **`EnhancedIndexHandler.ts`** (16.4KB) - Semantic analysis and relationships
    *   Find semantically similar elements using NLP scoring
    *   Get element relationships (semantic, verb-based, cross-element)
    *   Search elements by action verb (e.g., "analyze", "create", "debug")
    *   Relationship statistics and index health
    *   Delegates to `EnhancedIndexManager`, `VerbTriggerManager`, `RelationshipManager`

*   **`DisplayConfigHandler.ts`** (7KB) - Indicator configuration
    *   Persona indicator configuration (prefix symbols like `>>`)
    *   Indicator retrieval for active persona
    *   Display preferences management

*   **`IdentityHandler.ts`** (6.8KB) - User identity management
    *   User identity configuration (username, display preferences)
    *   Identity retrieval
    *   Identity clearing
    *   Delegates to `ConfigManager`

*   **`ConfigHandler.ts`** (13KB) - DollhouseMCP configuration
    *   Configuration management (get, set, reset, export, import)
    *   Configuration wizard for interactive setup
    *   Section-specific configuration updates
    *   Configuration validation

*   **`ResourceHandler.ts`** - MCP Resources capability management
    *   Registers and manages MCP Resources protocol handlers
    *   Provides capability index resources (summary, full, stats)
    *   Configuration-controlled resource advertisement
    *   Delegates to `CapabilityIndexResource` for content generation
    *   Handles `resources/list` and `resources/read` RPC requests

#### Handler Registry

*   **`ToolRegistry.ts`** (3.7KB) - Registers all handlers with MCP tools
    *   Maps MCP tool names to handler methods
    *   In v2, registers the 5 CRUDE endpoints (or single unified endpoint) rather than individual tools
    *   Handles tool discovery for MCP protocol

#### Handler Architecture Benefits

*   **Separation of Concerns:** Business logic isolated from MCP protocol details
*   **Testability:** Handlers can be unit tested independently of MCP layer
*   **Reusability:** Same handler methods can be called from different entry points
*   **Error Handling:** Centralized error handling and user message sanitization
*   **Validation:** Input validation and sanitization at handler boundary

### 5.4. Portfolio & Indexing System (`src/portfolio`)

*   **Purpose:** Manages the user's local portfolio of elements and provides advanced indexing, search, and relationship capabilities.

*   **Key Components:** Portfolio management, multi-source indexing, semantic analysis, relationship tracking

#### Portfolio Management

**`PortfolioManager.ts`** - Core portfolio operations

The `PortfolioManager` is the single source of truth for the physical layout of the portfolio on disk:

*   **Directory Management:** Creates and manages directory structure for all element types (`~/.dollhouse/portfolio/personas`, `/skills`, `/templates`, `/agents`, `/memories`, `/ensembles`)
*   **Element Discovery:** Lists available elements of each type, filtering test files and non-element files
*   **Path Management:** Resolves full paths to element files with security checks to prevent path traversal attacks
*   **Migration:** Handles migration of legacy portfolio structures to current version

**`PortfolioIndexManager.ts`** - Local portfolio indexing

*   Maintains index of local portfolio elements
*   Fast element lookup by name, type, metadata
*   Index persistence and rebuilding
*   Integration with element managers

#### Advanced Indexing System

The DollhouseMCP server includes a sophisticated multi-source indexing system for fast, intelligent element discovery:

**`UnifiedIndexManager.ts`** - Multi-source search coordination

*   **Unified Search:** Searches across local portfolio, GitHub portfolios, and community collection simultaneously
*   **Source Priority:** Configurable source priorities (local first, then GitHub, then collection)
*   **Duplicate Detection:** Identifies same element across different sources
*   **Result Merging:** Combines results from multiple sources with relevance scoring
*   **Pagination:** Efficient pagination across distributed sources
*   **Caching:** Caches unified search results for performance

**`EnhancedIndexManager.ts`** - Semantic indexing with NLP

This is a major architectural component providing intelligent element discovery:

*   **Semantic Similarity:** Uses NLP scoring (Jaccard similarity, Shannon entropy) to find related elements
*   **Relationship Mapping:** Tracks relationships between elements (uses, extends, requires, complements)
*   **Content Analysis:** Analyzes element content for semantic understanding
*   **Similarity Scoring:** Scores element similarity (0-1 range) based on multiple factors:
    *   Metadata overlap (name, description, tags, category)
    *   Content similarity
    *   Trigger word overlap
    *   Keyword matching
*   **Relationship Types:**
    *   **Semantic:** Elements with similar purpose or content
    *   **Verb-based:** Elements triggered by similar action verbs
    *   **Cross-element:** References between different element types
    *   **Uses/Extends/Requires/Complements:** Explicit relationships

**`VerbTriggerManager.ts`** - Action verb to element mapping

*   **Verb Indexing:** Maps action verbs (e.g., "analyze", "create", "debug") to elements that can handle them
*   **Trigger Patterns:** Recognizes verb patterns in element metadata and content
*   **Action Discovery:** Finds elements by the actions they can perform
*   **Integration:** Works with skills, agents, and personas that have trigger words
*   **Use Case:** "Find elements that can analyze code" → returns code analysis skills/agents

**`RelationshipManager.ts`** - Element relationship tracking

*   **Relationship Storage:** Maintains graph of element relationships
*   **Relationship Queries:** Find all elements related to a given element
*   **Relationship Statistics:** Tracks most connected elements, relationship types
*   **Relationship Validation:** Ensures referenced elements exist
*   **Use Cases:**
    *   Find skills used by an agent
    *   Find templates required by a persona
    *   Find complementary elements for a workflow

**`NLPScoringManager.ts`** - Semantic similarity scoring

*   **Jaccard Similarity:** Measures set overlap between element metadata
*   **Shannon Entropy:** Measures information content and uniqueness
*   **Keyword Extraction:** Identifies key terms from content
*   **Scoring Algorithm:** Combines multiple signals for overall similarity score
*   **Performance:** Optimized for fast scoring across large element sets

#### Benefits of the Indexing System

*   **Fast Discovery:** Find elements in milliseconds across thousands of entries
*   **Intelligent Search:** Semantic understanding beyond keyword matching
*   **Relationship Navigation:** Explore related elements easily
*   **Multi-Source:** Seamlessly search local and remote sources
*   **Action-Based:** Find elements by what they can do, not just what they're called

### 5.5. Collection (`src/collection`)

*   **Purpose:** Provides an interface to the community-managed collection of elements hosted on GitHub.
*   **Key Files:**
    *   `CollectionBrowser.ts`: Provides functionality for browsing the collection.
    *   `CollectionSearch.ts`: Provides functionality for searching the collection.
    *   `ElementInstaller.ts`: Provides functionality for installing elements from the collection.
*   **How it Works:** This component acts as a client for the `DollhouseMCP/collection` GitHub repository. It uses the GitHub API to fetch information about the available elements. To improve performance and resilience, it also uses a local cache (`src/cache/CollectionCache.ts`). When a user requests to browse the collection, the server first tries to fetch the information from the GitHub API. If the API is unavailable or the request fails, it falls back to the local cache.

### 5.6. GitHub Integration (`src/portfolio`, `src/auth`, `src/sync`)

*   **Purpose:** Provides seamless integration with GitHub for portfolio backup, synchronization, and community collaboration.

*   **Key Components:** Authentication, portfolio repositories, synchronization, remote indexing

#### GitHub Authentication

**`GitHubAuthManager.ts`** (in `src/auth/`) - OAuth device flow authentication

*   **OAuth Device Flow:** Implements GitHub's device flow for secure authentication without browser redirects
*   **Token Management:** Securely stores and manages GitHub access tokens
*   **Authentication Status:** Tracks connection state and user information
*   **Token Refresh:** Handles token expiration and refresh
*   **Security:** Tokens stored securely with appropriate file permissions

**Authentication Flow:**

1. User initiates auth via `setupGitHubAuth` MCP tool
2. Server generates device code and user code
3. User visits GitHub and enters code
4. Server polls for authorization
5. On success, stores access token
6. Token used for all subsequent GitHub API calls

#### Portfolio Repository Management

**`PortfolioRepoManager.ts`** - GitHub repository operations

*   **Repository Creation:** Creates `dollhouse-portfolio` repository for user
*   **Repository Validation:** Verifies repository exists and is accessible
*   **Content Management:** Reads/writes portfolio elements to GitHub
*   **Branch Management:** Handles main branch operations
*   **GitHub API Client:** Wraps GitHub REST API calls with error handling

#### Portfolio Synchronization

**`PortfolioSyncManager.ts`** - Synchronization orchestration

Provides three synchronization modes:

*   **Additive Mode** (default, safest):
    *   Only adds new elements
    *   Never deletes anything
    *   Merges local and remote without data loss
    *   Ideal for continuous backup

*   **Mirror Mode** (exact sync):
    *   Makes local match remote exactly (or vice versa)
    *   Requires confirmation for deletions
    *   Two-way: `--direction both` mirrors both sides
    *   Use when you want identical local/remote state

*   **Backup Mode** (GitHub as source):
    *   Treats GitHub as the authoritative source
    *   Only pulls missing items locally
    *   Never pushes changes
    *   Use for restoring from GitHub backup

**Sync Operations:**

*   **Push:** Upload local elements to GitHub
*   **Pull:** Download remote elements to local
*   **Bidirectional:** Sync in both directions
*   **Dry Run:** Preview changes without applying
*   **Conflict Resolution:** Detects conflicts and prompts user
*   **Progress Tracking:** Reports sync progress

**`SyncHandlerV2.ts`** - Sync handler implementation

*   Orchestrates sync operations via MCP tools
*   Validates sync parameters
*   Handles user confirmations for destructive operations
*   Reports sync results

#### Remote Portfolio Indexing

**`GitHubPortfolioIndexer.ts`** - Indexes elements from GitHub portfolios

*   **Remote Indexing:** Indexes elements from any GitHub `dollhouse-portfolio` repository
*   **Multi-User Support:** Can index portfolios from multiple GitHub users
*   **Caching:** Caches remote portfolio indexes for performance
*   **Search Integration:** Integrates with `UnifiedIndexManager` for cross-source search
*   **Metadata Extraction:** Parses element metadata from GitHub files

#### Individual Element Management

**`PortfolioPullHandler.ts`** - Downloads individual elements

*   **Selective Download:** Download specific elements without full sync
*   **Fuzzy Matching:** Find elements by partial name match
*   **Type Filtering:** Download elements of specific type
*   **Conflict Handling:** Prompts before overwriting local elements
*   **Bulk Operations:** Download multiple elements at once

#### GitHub Integration Benefits

*   **Backup:** Automatic portfolio backup to GitHub
*   **Sharing:** Share portfolio elements with team or community
*   **Multi-Device:** Access portfolio from multiple machines
*   **Collaboration:** Work on shared element libraries
*   **Version Control:** Leverage Git's version history
*   **Discoverability:** Others can discover and use your elements

### 5.7. Security Architecture (`src/security`)

*   **Purpose:** Provides comprehensive security validation, sanitization, and audit capabilities.

*   **Key Components:** Input validation, path security, YAML security, file locking, audit system

#### Input Validation & Sanitization

**`InputValidator.ts`** - Input sanitization

*   **XSS Prevention:** Sanitizes HTML and script injection attempts
*   **SQL Injection Prevention:** Escapes special characters
*   **Path Traversal Prevention:** Validates and normalizes file paths
*   **Unicode Normalization:** Handles Unicode normalization attacks
*   **Length Limits:** Enforces maximum input lengths
*   **Type Validation:** Validates data types and formats

**`pathValidator.ts`** - Path security

*   **Path Traversal Prevention:** Blocks `../` and absolute path attempts
*   **Whitelist Validation:** Ensures paths stay within allowed directories
*   **Symbolic Link Protection:** Resolves and validates symlinks
*   **Normalized Paths:** Converts all paths to canonical form
*   **Security Checks:** Validates paths before any file operation

**`UnicodeValidator.ts`** - Unicode security

*   **Normalization Attack Prevention:** Detects Unicode homoglyph attacks
*   **Mixed Script Detection:** Identifies suspicious character combinations
*   **Normalization:** Converts to safe Unicode normal forms
*   **Validation:** Ensures text uses expected character sets

#### YAML Security

**`SecureYamlParser.ts`** - Secure YAML parsing

*   **YAML Bomb Prevention:** Detects and blocks YAML bomb attacks
*   **Depth Limiting:** Enforces maximum nesting depth
*   **Size Limiting:** Enforces maximum document size
*   **Reference Limiting:** Prevents excessive anchor/alias references
*   **Safe Types Only:** Restricts to safe YAML types
*   **Schema Validation:** Validates against expected schema

#### Concurrent Access Control

**`FileLockManager.ts`** - File locking

*   **Lock Acquisition:** Acquires exclusive locks for file operations
*   **Deadlock Prevention:** Timeout-based lock acquisition
*   **Lock Release:** Automatic lock cleanup
*   **Concurrent Safety:** Prevents race conditions in file I/O
*   **Queue Management:** Queues conflicting operations

#### Security Monitoring & Auditing

**`SecurityMonitor.ts`** - Real-time security monitoring

*   **Event Tracking:** Tracks all security-relevant operations
*   **Anomaly Detection:** Identifies suspicious patterns
*   **Audit Logging:** Logs security events for compliance
*   **Alert Generation:** Generates alerts for security violations
*   **Metrics Collection:** Collects security metrics

**Security Audit System** (`src/security/audit/`)

*   **`scanners/`** - Vulnerability scanners
    *   Path traversal scanner
    *   Input validation scanner
    *   Dependency vulnerability scanner
    *   Configuration security scanner

*   **`rules/`** - Audit rules
    *   Security policy definitions
    *   Compliance rules
    *   Custom rule engine

*   **`reporters/`** - Audit reporters
    *   Console reporter (human-readable)
    *   Markdown reporter (documentation)
    *   JSON reporter (machine-readable)

*   **`config/`** - Audit configuration
    *   Rule configuration
    *   Suppression configuration
    *   Severity thresholds

#### Error Handling

**`SecureErrorHandler.ts`** - Secure error messages

*   **Message Sanitization:** Removes sensitive information from error messages
*   **Stack Trace Filtering:** Filters internal paths from stack traces
*   **User-Friendly Messages:** Converts technical errors to user-friendly messages
*   **Logging Separation:** Detailed errors to logs, safe messages to users

#### Security Benefits

*   **Defense in Depth:** Multiple layers of security validation
*   **Audit Trail:** Complete audit trail for compliance
*   **Proactive Detection:** Identifies issues before exploitation
*   **Safe by Default:** Secure defaults for all operations
*   **Compliance Ready:** Audit system supports compliance requirements

### 5.8. MCP-AQL Interface Layer (`src/handlers/mcp-aql`)

*   **Purpose:** Provides the unified MCP tool interface that consolidates 50+ discrete tools into 5 CRUDE (Create, Read, Update, Delete, Execute) endpoints with built-in permission enforcement, introspection, and schema-driven dispatch.

*   **Key Files:**
    *   `MCPAQLHandler.ts` - Main entry point, orchestrates dispatch
    *   `UnifiedEndpoint.ts` - Single endpoint mode routing
    *   `Gatekeeper.ts` - Route validation, policy enforcement
    *   `OperationRouter.ts` - Operation-to-endpoint mapping
    *   `OperationSchema.ts` - Declarative operation definitions
    *   `SchemaDispatcher.ts` - Schema-driven handler dispatch
    *   `IntrospectionResolver.ts` - GraphQL-style introspection

*   **How it Works:**

MCP-AQL replaces the original discrete-tool interface with a unified protocol layer. Instead of registering 50+ individual MCP tools (one per operation), the server exposes 5 semantically grouped endpoints:

| Endpoint | Safety | Description | Example Operations |
|----------|--------|-------------|-------------------|
| **`mcp_aql_create`** | Non-destructive | Additive operations | `create_element`, `import_element`, `activate_element` |
| **`mcp_aql_read`** | Read-only | Safe query operations | `list_elements`, `get_element`, `search`, `introspect` |
| **`mcp_aql_update`** | Modifying | Modify existing state | `edit_element` |
| **`mcp_aql_delete`** | Destructive | Remove state | `delete_element`, `clear` |
| **`mcp_aql_execute`** | Stateful | Agent lifecycle | `execute_agent`, `record_execution_step`, `complete_execution` |

This achieves an ~85% token reduction (from ~29,592 to ~4,314 tokens for tool registration) while maintaining full functionality. A single-endpoint mode (`mcp_aql`) achieves ~96% reduction (~1,100 tokens).

#### Operation Discovery via Introspection

LLMs discover available operations using GraphQL-style introspection queries rather than parsing large tool schemas:

```typescript
// Query all available operations
{ operation: "introspect", params: { query: "operations" } }

// Get details for a specific operation
{ operation: "introspect", params: { query: "operations", name: "create_element" } }

// Query available types
{ operation: "introspect", params: { query: "types", name: "ElementType" } }
```

#### Request Flow

Every MCP-AQL request follows this path:

1. LLM sends `{ operation, params }` to a CRUDE endpoint
2. `MCPAQLHandler` parses the operation input
3. `Gatekeeper` validates the operation is allowed on this endpoint and checks all active element policies
4. `OperationRouter` resolves the operation to its handler
5. `SchemaDispatcher` maps parameters and invokes the target handler method
6. Result returned to LLM with any autonomy guidance

For complete MCP-AQL documentation, see [MCP-AQL Architecture](mcp-aql/OVERVIEW.md).

### 5.9. Gatekeeper Permission System (`src/handlers/mcp-aql/Gatekeeper.ts`)

*   **Purpose:** Enforces a multi-layer permission system on every MCP-AQL operation, ensuring that active element policies are respected and that high-risk operations require explicit human confirmation.

*   **How it Works:**

The Gatekeeper evaluates every operation against four permission levels:

| Level | Behavior | Operations |
|---|---|---|
| **AUTO_APPROVE** | No confirmation needed | All reads, search, list, activate, deactivate, introspect |
| **CONFIRM_SESSION** | One confirmation unlocks for the entire session | create, import, install, submit, sync, auth setup |
| **CONFIRM_SINGLE_USE** | Fresh confirmation required every time | edit, delete, clear, execute_agent, abort |
| **DENY** | Hard-blocked, cannot be confirmed | (none by default -- elements can add) |

#### Element Policy Controls

Active elements (personas, skills, agents, ensembles) can declare Gatekeeper policies that modify operation defaults:

```yaml
gatekeeper:
  # Internal operations (MCP-AQL layer)
  allow:
    - create_element    # Elevate to AUTO_APPROVE (if canBeElevated)
  confirm:
    - some_operation    # Require confirmation
  deny:
    - delete_element    # Hard-block -- cannot be confirmed
    - execute_agent

  # External tool calls (CLI layer)
  externalRestrictions:
    description: "Read-only development"
    allowPatterns:
      - "git status*"
    denyPatterns:
      - "rm -rf *"
```

Policy priority: **element deny > element confirm > element allow > route default**. A deny from any active element cannot be overridden.

#### The Sandbox Model

When any active element has `deny: ['confirm_operation']` in its Gatekeeper policy, ALL confirmations are blocked. The LLM cannot unlock any gated operation -- the session becomes effectively read-only for non-AUTO_APPROVE operations. This prevents automated confirmation loops where the LLM rubber-stamps its own approvals.

#### canBeElevated Invariants

Some operations have `canBeElevated: false`, meaning element `allow` lists cannot elevate them to AUTO_APPROVE:

*   `execute_agent` -- always CONFIRM_SINGLE_USE
*   `delete_element` -- always CONFIRM_SINGLE_USE
*   `clear` -- always CONFIRM_SINGLE_USE

These are server-side invariants that element authors cannot override.

For complete Gatekeeper documentation, see [Gatekeeper Confirmation Model](../security/gatekeeper-confirmation-model.md).

### 5.10. Agent Execution Architecture

*   **Purpose:** Provides the agentic loop, autonomy evaluation, and Danger Zone enforcement that governs how Dollhouse Agents execute goals.

*   **Key Components:** Agentic loop, Autonomy Evaluator, DangerZoneEnforcer, step recording, human-in-the-loop

*   **How it Works:**

A Dollhouse Agent pursues a goal through a continuous loop where the LLM and the MCP server pass control back and forth. The LLM handles all semantic work (reasoning, deciding, interpreting). The MCP server handles all programmatic work (executing, enforcing, persisting). Neither operates alone.

#### The Agentic Loop

```
 ┌───────────────┐
 │   HUMAN       │
 │  (optional)   │◄──── LLM asks for guidance
 │               │      when autonomy evaluator
 │ Approve, deny,│      says "pause"
 │ or guide      │
 └───────┬───────┘
         │ responds to LLM
         ▼
 ┌─────────────┐     ┌───────────────────────────--──┐     ┌─────────────┐
 │             │     │  DollhouseMCP MCP Server      │     │             │
 │    LLM      │────▶│                               │────▶│    LLM      │
 │             │     │  1. Gatekeeper checks policy  │     │             │
 │  Decides    │     │  2. Autonomy Evaluator scores │     │  Records    │
 │  next       │     │  3. Danger Zone enforcement   │     │  step and   │
 │  action     │     │  4. Execute or block          │     │  continues  │
 │             │     │  5. Return result + autonomy  │     │  or pauses  │
 │             │◀────│     guidance to LLM           │◀────│             │
 └─────────────┘     └────────────────────────--─────┘     └─────────────┘
        │                                                       │
        └──────────────── repeats every step ───────────────────┘
```

At each step:

1. **LLM decides** what to do next -- which MCP-AQL operation to call, with what parameters
2. **Gatekeeper** checks the operation against all active element policies. Deny = blocked. Confirm = ask the human. Allow = proceed.
3. **Autonomy Evaluator** scores whether the agent should continue autonomously or pause for human input. Factors include step count, operation risk, element policies, and configured autonomy limits.
4. **Danger Zone** enforces hard blocks on high-risk operations that cannot be confirmed or bypassed.
5. **Step recording** logs the action, outcome, and autonomy decision for audit.
6. **The LLM receives the result** along with autonomy guidance: continue, pause, or escalate.

#### Division of Labor

| | LLM (Semantic) | MCP Server (Programmatic) |
|---|---|---|
| **Decides** | What to do next, which tool to call, when the goal is done | Nothing -- it executes, doesn't decide |
| **Executes** | Nothing -- it decides, doesn't execute | Tool calls, file I/O, element CRUD, state persistence |
| **Enforces** | Nothing -- it can be told "no" | Gatekeeper policies, Danger Zone blocks, autonomy limits |
| **Context** | Active element instructions (personas, skills, memories) | Element metadata, policy definitions, execution state |

#### Autonomy Evaluator

After each step, the Autonomy Evaluator decides whether the agent should continue or pause:

*   **Continue** -- the action was routine and within configured limits
*   **Pause** -- the action was unusual, the step count is high, or the element policy requires human review
*   **Escalate** -- a Danger Zone trigger or a notification that needs human attention

Agents configure autonomy via frontmatter:

```yaml
autonomy:
  maxAutonomousSteps: 10   # pause after 10 steps for human review
  # maxAutonomousSteps: 0  # unlimited -- run until goal is complete
```

#### Danger Zone Enforcer (`src/security/DangerZoneEnforcer.ts`)

Hard blocks on operations that should never be automated without explicit approval:

*   File deletion outside approved directories
*   External API calls to unknown endpoints
*   System commands with destructive potential
*   Any operation denied by an active element's policy

Danger Zone blocks cannot be confirmed or bypassed. The element must be deactivated or the policy changed. The `DangerZoneEnforcer` is a DI-managed singleton resolved via `AgentManager.setDangerZoneEnforcerResolver()`.

#### Execution Lifecycle Operations

| Operation | Endpoint | What It Does |
|-----------|----------|-------------|
| `execute_agent` | Execute | Start a new execution with goal parameters |
| `record_execution_step` | Create | Log a step with description, outcome, findings |
| `get_execution_state` | Read | Inspect current progress, steps, and autonomy status |
| `get_gathered_data` | Read | Retrieve data collected during execution |
| `complete_execution` | Execute | Mark goal as successfully achieved |
| `abort_execution` | Execute | Cancel execution with a reason |
| `continue_execution` | Execute | Resume from a paused state |
| `prepare_handoff` | Execute | Serialize state for session transfer |
| `resume_from_handoff` | Execute | Restore state in a new session |

#### Agent Composition

Agents compose with all other element types during execution:

*   **Activate Personas** -- change the LLM's behavior during execution
*   **Activate Skills** -- add capabilities
*   **Use Templates** -- produce structured outputs
*   **Load Memories** -- access persistent context
*   **Run as Ensembles** -- bundle an agent with its supporting elements into a single activatable unit

When an agent activates elements, those elements' Gatekeeper policies take effect immediately, shaping what the agent can do for the rest of its execution.

For complete agent execution documentation, see [Agent Execution Guide](../guides/agent-execution.md).

### 5.11. Activation Store (`src/services/ActivationStore.ts`)

*   **Purpose:** Persists per-session element activation state to disk so that activated elements survive MCP server restarts.

*   **How it Works:**

Each MCP session (identified by `DOLLHOUSE_SESSION_ID` environment variable) gets its own activation file at `~/.dollhouse/state/activations-{sessionId}.json`. When elements are activated or deactivated, the store writes an updated snapshot to disk. On server restart, the Container's `restoreActivations()` method reads the file and re-activates all previously active elements.

#### Key Design Properties

*   **Per-session isolation:** Concurrent sessions (e.g., interactive + bridge) maintain independent activation profiles via distinct session IDs.
*   **Fire-and-forget writes:** In-memory state is the hot path. Disk writes use atomic write-to-temp + rename to prevent partial reads.
*   **Tolerant loading:** Missing or corrupt activation files are silently ignored (clean start).
*   **Pruning:** Elements that no longer exist in the portfolio are automatically pruned from the activation file on restore.
*   **Opt-out:** Set `DOLLHOUSE_ACTIVATION_PERSISTENCE=false` to disable persistence entirely.
*   **Forward compatible:** The versioned file format (v1) can evolve to include userId, orgId, and audit fields for multi-user HTTPS mode.

#### Session Monitor Agent Pattern

The Activation Store enables the **Session Monitor** agent pattern, where a long-running agent (e.g., a Zulip bridge watcher) maintains its element configuration across server restarts. The bridge sets `DOLLHOUSE_SESSION_ID=zulip-bridge`, seeds element activations once during an interactive ceremony, and those activations persist indefinitely -- surviving MCP server restarts, Node.js process recycling, and system reboots.

### 5.12. Server Entry Point (`src/index.ts`)

*   **Purpose:** Main server entry point and lifecycle management.

*   **Current State:** Lean, focused implementation (745 lines)

*   **Key Responsibilities:**

**Lifecycle Management:**

*   **Server Initialization:** Creates `DollhouseMCPServer` instance
*   **Container Setup:** Initializes dependency injection container
*   **Lazy Initialization:** Delays heavy operations until first use
*   **Handler Delegation:** Delegates all tool calls to specialized handlers
*   **Graceful Shutdown:** Handles cleanup on process termination

**Server Architecture:**

The `DollhouseMCPServer` class is deliberately lean, focusing on:

1. **Delegation:** All business logic delegated to handlers
2. **Lifecycle:** Manages server startup, initialization, and shutdown
3. **MCP Integration:** Registers tools and handles MCP protocol
4. **Error Handling:** Top-level error handling and logging

**Key Methods:**

*   `run()`: Starts server and initializes portfolio
*   `initializePortfolio()`: Lazy portfolio initialization
*   `completeInitialization()`: Creates handlers after portfolio ready
*   `ensureInitialized()`: Safety check for test/direct access
*   MCP tool methods: Thin wrappers delegating to handlers

**Design Philosophy:**

*   **Single Responsibility:** Server manages lifecycle, handlers implement features
*   **Testability:** Handlers can be tested independently
*   **Maintainability:** Clear separation of concerns
*   **Performance:** Lazy initialization keeps startup fast

## 6. Key Workflows

### 6.1. Server Startup and Initialization

The DollhouseMCP Server uses a **lazy initialization pattern** to balance startup performance with functionality.

#### Phase 1: Constructor Initialization (Fast Startup)

1. Entry point creates `DollhouseMCPServer` instance
2. Constructor creates MCP Server instance (from `@modelcontextprotocol/sdk`)
3. Creates `DollhouseContainer` but does NOT initialize services yet
4. Sets up indicator configuration and environment variables
5. Constructor completes immediately (no blocking I/O)

**Result:** Server can start in milliseconds

#### Phase 2: Portfolio Initialization (First Access)

When `run()` method is called:

1. **`initializePortfolio()`** is called:
   - Creates `PortfolioManager` singleton from container
   - Portfolio manager creates all element type directories:
     - `~/.dollhouse/portfolio/personas`
     - `~/.dollhouse/portfolio/skills`
     - `~/.dollhouse/portfolio/templates`
     - `~/.dollhouse/portfolio/agents`
     - `~/.dollhouse/portfolio/memories`
     - `~/.dollhouse/portfolio/ensembles`
   - Performs any necessary migrations from older portfolio versions
   - MigrationManager handles legacy format conversion (see [Migration Guide](../guides/migration-from-legacy-tools.md) for details)

2. **`completeInitialization()`** is called:
   - Invokes `container.createHandlers(server)`
   - Container resolves all service dependencies in correct order
   - Instantiates all 9 handler classes with their dependencies
   - Handlers create their manager instances as needed
   - Returns handlers object with all handler references

3. Server stores handler references in instance variables
4. Sets `isInitialized = true` flag
5. Connects to MCP transport via stdio
6. Registers graceful shutdown handlers (SIGINT, SIGTERM, SIGHUP)

#### Phase 3: MCP Connection

1. `StdioServerTransport` connects stdio to parent process
2. Sets `MCPConnected` flag in logger (suppresses console output)
3. Server awaits incoming MCP tool requests via JSON-RPC
4. Server is now fully operational

#### Lazy Initialization Safety

The `ensureInitialized()` method provides safety for tests and direct handler access:

1. Check if `isInitialized` flag is set
2. If false, check if initialization is already in progress (via promise)
3. If in progress, await the existing initialization promise
4. If not started, begin initialization sequence
5. Cache the initialization promise to prevent race conditions

**Benefits:**

*   **Fast Startup:** Server starts in milliseconds, heavy work delayed
*   **Test Safety:** Can trigger initialization manually for unit tests
*   **Race Prevention:** Single initialization per process guaranteed
*   **Graceful Handling:** All code paths ensure initialization before use

### 6.2. Handling an MCP-AQL Request

#### Request Flow Diagram

```
MCP Protocol (stdin/JSON-RPC)
        |
        v
CRUDE Endpoint (mcp_aql_create/read/update/delete/execute)
        |
        v
MCPAQLHandler (parse operation + params)
        |
        v
Gatekeeper (validate route + enforce element policies)
        |
        v
OperationRouter (resolve handler reference)
        |
        v
SchemaDispatcher (map params, invoke handler)
        |
        v
Target Handler / Manager (performs work)
        |
        v
Result Formatting + Autonomy Guidance
        |
        v
MCP Response (stdout/JSON-RPC)
```

#### Detailed Steps

1. **Request Reception**
   - MCP server receives JSON-RPC tool request on stdin
   - Request targets a CRUDE endpoint with `{ operation, params }` arguments

2. **MCP-AQL Dispatch**
   - `MCPAQLHandler` parses the operation input and routes to the appropriate handler
   - Example routing:
     - `{ operation: "list_elements", params: { type: "personas" } }` via `mcp_aql_read`
     - `{ operation: "create_element", params: { ... } }` via `mcp_aql_create`
     - `{ operation: "execute_agent", params: { ... } }` via `mcp_aql_execute`

3. **Gatekeeper Enforcement**
   - Gatekeeper validates the operation is routed to the correct endpoint
   - Evaluates all active element policies (deny > confirm > allow > route default)
   - If denied: returns hard block with explanation
   - If confirmation required: returns `confirmationPending` with human-readable summary
   - If allowed: proceeds to dispatch

4. **Argument Parsing & Validation**
   - Handler validates and sanitizes all arguments
   - Input validation via `InputValidator.sanitizeInput()`
   - Path validation via `PathValidator.validatePath()`
   - Type checking and required field validation
   - Rejects invalid input with clear error messages

5. **Service Layer Execution**
   - Handler calls appropriate service or manager
   - Manager performs actual work (file I/O, API calls, computation)
   - Results may be cached for performance (`LRUCache`, `APICache`)
   - Security checks applied throughout (audit logging, validation)

6. **Error Handling**
   - Exceptions caught by handler try/catch blocks
   - Errors logged via `logger` with full details
   - User messages sanitized via `SecureErrorHandler`
   - Sensitive information stripped from user-facing messages
   - Error returned to user via MCP error response

7. **Response Formatting**
   - Handler formats result as MCP `TextContent` or `ToolUseResultContent`
   - If persona is active, indicator prepended to response (`>>` or custom)
   - For agent execution operations, autonomy guidance included in response
   - Response sent to stdout via MCP transport
   - JSON-RPC response wraps result with request ID

#### Example: Create Element Flow

```
LLM calls mcp_aql_create({ operation: "create_element", params: { name: "MySkill", type: "skills", ... } })
        ↓
MCPAQLHandler.handleCreate() parses operation input
        ↓
Gatekeeper validates: create_element allowed on CREATE endpoint
Gatekeeper checks active element policies (CONFIRM_SESSION by default)
        ↓
If first create this session: returns confirmationPending
LLM calls confirm_operation → retries → Gatekeeper allows
        ↓
SchemaDispatcher dispatches to elementCRUDHandler.createElement()
        ↓
Handler validates arguments, sanitizes name, description, content
        ↓
Handler calls skillManager.create()
        ↓
SkillManager validates metadata
SkillManager calls BaseElementManager.save()
        ↓
ElementFileOperations.save() writes to disk
FileLockManager ensures exclusive access
        ↓
Success! Return element details
        ↓
Handler formats as MCP response
        ↓
Response sent to stdout
```

#### Example: Search Flow with Caching

```
LLM calls mcp_aql_read({ operation: "search", params: { query: "debug", sources: ["local", "github", "collection"] } })
        ↓
MCPAQLHandler → Gatekeeper (AUTO_APPROVE for reads) → SchemaDispatcher
        ↓
Delegates to unifiedIndexManager.search()
        ↓
Check cache for query "debug"
        ↓
Cache miss! Perform search
        ↓
Search local portfolio (PortfolioIndexManager)
Search GitHub portfolios (GitHubPortfolioIndexer)
Search collection (CollectionSearch)
        ↓
Merge results, deduplicate
Score relevance, sort
        ↓
Cache results for 5 minutes
        ↓
Return top results
        ↓
Handler formats results
        ↓
Response sent to user
```

### 6.3. Element Activation Flow

Demonstrates how personas (or other activatable elements) are activated:

1. LLM calls `mcp_aql_create({ operation: "activate_element", params: { type: "personas", name: "Creative Writer" } })`
2. Gatekeeper validates (AUTO_APPROVE for activation)
3. `personaHandler.activatePersona()` validates request
4. Calls `personaManager.activatePersona("Creative Writer")`
5. `PersonaManager` loads persona via `PersonaLoader`
6. `PersonaLoader` checks cache, loads from disk if needed
7. Validates persona with `PersonaValidator`
8. Deactivates currently active persona (if any)
9. Sets new persona as active in state
10. Updates display indicator configuration
11. `ActivationStore` persists the activation to `~/.dollhouse/state/activations-{sessionId}.json`
12. Returns success with persona details

Future requests now include persona indicator in responses. If the element has Gatekeeper policies, those take effect immediately.

#### Ensemble Activation

Ensemble activation follows a similar pattern but activates all constituent elements as a unit:

1. LLM calls `mcp_aql_create({ operation: "activate_element", params: { type: "ensembles", name: "code-review-team" } })`
2. `EnsembleActivationStrategy` resolves all member elements
3. Each member element is activated in dependency order
4. All member Gatekeeper policies take effect
5. `ActivationStore` records the ensemble activation (members tracked individually)
6. Returns success with ensemble composition summary

### 6.4. GitHub Sync Flow

Demonstrates portfolio synchronization:

1. User calls `syncPortfolio({ mode: "additive", direction: "push", dryRun: true })`
2. `portfolioHandler.syncPortfolio()` validates arguments
3. Calls `portfolioSyncManager.sync(options)`
4. Sync manager checks GitHub authentication
5. If dry run, simulates changes without applying
6. Compares local vs remote elements
7. Identifies: new elements, modified elements, deleted elements
8. In additive mode: only upload new/modified, never delete
9. Generates change summary
10. Returns dry run results showing what would change
11. User reviews, calls again with `dryRun: false` to apply
12. Sync manager uploads elements to GitHub
13. Updates remote index
14. Returns final sync report

## 7. Getting Started for Developers

### 7.1. Setup

1.  Clone the repository.
2.  Navigate to the `mcp-server` directory.
3.  Run `npm install` to install the dependencies.

### 7.2. Running the Server

*   `npm run dev`: Starts the server in development mode with auto-reloading.
*   `npm start`: Starts the server in production mode.

### 7.3. Testing

The project includes comprehensive test coverage (8,100+ unit tests, 1,200+ integration tests, >96% coverage):

*   **Unit Tests:** `npm test` - Fast tests for individual components
*   **Integration Tests:** Test interactions between components
*   **End-to-End Tests:** `npm run test:e2e` - Full workflow tests
*   **Security Tests:** `npm run security:all` - Security audit suite
*   **Coverage:** `npm run test:coverage` - Generate coverage report

### 7.4. How to Add a New Element Type

Use the dedicated checklist in `docs/developer-guide/adding-elements.md` when introducing a new element type. The high-level workflow is:

1. Extend the `ElementType` enum in `src/portfolio/types.ts` and update every derived allowlist (`validTypes` in `src/index.ts`, `MCP_SUPPORTED_TYPES` in `src/config/element-types.ts` and `src/collection/CollectionBrowser.ts`, directory maps, etc.).
2. Implement a `BaseElement` subclass plus a `BaseElementManager` subclass (or extend the persona-specific managers when appropriate). Reuse the helpers in `src/elements/base/` for file operations, validation, and locking.
3. Register the new manager and any handler/tool wiring inside `src/di/Container.ts`. Wire the new type into the MCP-AQL layer via `OperationSchema.ts` and `MCPAQLHandler.ts` so it is accessible through the CRUDE endpoints.
4. Ensure the new type is supported by `ActivationStore` (add to `ACTIVATABLE_TYPES` if the type supports activation) and by `EnsembleManager` (if ensembles should be able to include the new type).
5. Add tests that exercise CRUD, validation, Gatekeeper policy enforcement, and sync flows alongside any Enhanced Index triggers or Unified Index search integration.

The checklist calls out every required file touchpoint and should be considered authoritative when planning the work.

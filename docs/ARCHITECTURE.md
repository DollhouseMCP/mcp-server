# DollhouseMCP Architecture v1.6.1

This document describes the comprehensive architecture of DollhouseMCP v1.6.1, including core systems, design patterns, and architectural components that create a complete AI persona management ecosystem.

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Architectural Components](#core-architectural-components)
3. [Design Patterns](#design-patterns)
4. [Data Flow Architecture](#data-flow-architecture)
5. [Security Architecture](#security-architecture)
6. [Performance Architecture](#performance-architecture)
7. [External Dependencies](#external-dependencies)
8. [System Boundaries](#system-boundaries)
9. [Scalability Design](#scalability-design)

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        End Users                             │
│                 (Claude Desktop, AI Apps)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │ MCP Protocol
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (Core v1.6.1)                 │
│  • Portfolio System (PortfolioManager)                       │
│  • Unified Indexing (UnifiedIndexManager)                    │
│  • Tool Registry (23+ tools)                                 │
│  • Element Management (BaseElement + Managers)               │
│  • Security Framework (Multi-layer)                          │
│  • Caching System (LRUCache + Factory)                       │
│  • Error Handling (Centralized)                              │
│  • Build Information (Runtime)                               │
└──────┬──────────────┬──────────────────┬────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Collection  │ │   Catalog    │ │ Experimental │
│   (Public)   │ │  (Private)   │ │  (Private)   │
│              │ │              │ │              │
│ • Personas   │ │ • Premium    │ │ • Future     │
│ • Templates  │ │   Elements   │ │   Features   │
│ • Skills     │ │ • Enterprise │ │ • R&D        │
│ • Tools      │ │   Features   │ │ • Coming     │
│ • Agents     │ │              │ │   Soon       │
└──────────────┘ └──────────────┘ └──────────────┘
```

## Core Architectural Components

### 1. Portfolio System Architecture

The Portfolio System manages all element types through a unified directory structure and provides comprehensive element lifecycle management.

```
Portfolio System
├── PortfolioManager (Singleton)
│   ├── Thread-safe initialization
│   ├── Element directory management
│   ├── Security validation integration
│   └── Default element provisioning
│
├── UnifiedIndexManager (Three-tier Search)
│   ├── Local portfolio indexing
│   ├── GitHub repository indexing
│   ├── Collection integration
│   ├── Intelligent result merging
│   ├── Version conflict resolution
│   └── Performance optimization
│
├── GitHubPortfolioIndexer
│   ├── Repository content scanning
│   ├── Branch and tag handling
│   ├── Rate limiting compliance
│   ├── Incremental updates
│   └── Error recovery mechanisms
│
├── PortfolioRepoManager
│   ├── Repository lifecycle management
│   ├── Git operations
│   ├── Authentication handling
│   └── Synchronization control
│
└── PortfolioElementAdapter
    ├── Element type conversion
    ├── Metadata normalization
    ├── Validation orchestration
    └── Cross-system compatibility
```

**Key Features:**
- **Singleton Pattern**: Thread-safe PortfolioManager ensures single point of control
- **Three-tier Indexing**: Local, GitHub, and Collection indexing with intelligent merging
- **Version Management**: Automatic conflict detection and resolution
- **Security Integration**: All operations validated through security framework

### 2. Caching Architecture

High-performance caching system with memory awareness and automatic cleanup.

```
Caching System
├── LRUCache<T> (Memory-aware)
│   ├── Doubly-linked list implementation
│   ├── O(1) get/set operations
│   ├── Memory usage monitoring
│   ├── TTL (Time-to-Live) support
│   ├── Automatic eviction policies
│   └── Performance metrics collection
│
├── CollectionIndexCache
│   ├── Specialized for collection data
│   ├── Intelligent cache invalidation
│   ├── Batch operations support
│   └── Search result optimization
│
├── CacheFactory (Factory Pattern)
│   ├── Cache instance creation
│   ├── Configuration management
│   ├── Type-specific optimizations
│   └── Memory pool management
│
└── Performance Monitoring
    ├── Hit/miss ratio tracking
    ├── Memory usage analysis
    ├── Cache efficiency metrics
    └── Automated optimization suggestions
```

### 3. Error Handling Architecture

Centralized error handling with structured error categories and consistent user experience.

```
Error Handling System
├── ErrorHandler (Service)
│   ├── Error categorization
│   ├── Stack trace preservation
│   ├── User-friendly messaging
│   ├── Logging integration
│   └── Recovery suggestions
│
├── ErrorCategory (Enum)
│   ├── USER_ERROR (Input validation)
│   ├── SYSTEM_ERROR (Internal failures)
│   ├── NETWORK_ERROR (API/connectivity)
│   ├── AUTH_ERROR (Authentication)
│   └── VALIDATION_ERROR (Data validation)
│
├── ApplicationError (Class)
│   ├── Structured error information
│   ├── Error code system
│   ├── Additional context data
│   ├── Original error preservation
│   └── Debugging metadata
│
└── Error Codes System
    ├── Hierarchical error codes
    ├── Machine-readable identifiers
    ├── Internationalization support
    └── Error recovery guidance
```

### 4. Build Information System

Runtime information collection and system diagnostics.

```
Build Information System
├── BuildInfoService
│   ├── Package metadata collection
│   ├── Git information extraction
│   ├── Runtime environment analysis
│   ├── Docker detection
│   ├── Performance metrics
│   └── System health monitoring
│
├── Runtime Information
│   ├── Node.js version and platform
│   ├── Memory usage tracking
│   ├── Process uptime monitoring
│   ├── Environment variable analysis
│   └── Configuration state
│
└── Integration Points
    ├── MCP tool exposure
    ├── Debug information access
    ├── Health check endpoints
    └── Monitoring system integration
```

### 5. Element Serialization Architecture

Comprehensive element serialization with multiple output formats.

```
Element Serialization Flow
├── BaseElement.serialize() → Markdown/YAML
│   ├── YAML frontmatter generation
│   ├── Markdown content formatting
│   ├── Unicode validation
│   ├── Security sanitization
│   └── Cross-platform compatibility
│
├── BaseElement.serializeToJSON() → JSON
│   ├── Structured data export
│   ├── Type-safe serialization
│   ├── Validation state preservation
│   ├── Metadata enrichment
│   └── API-ready format
│
├── Element Managers and Adapters
│   ├── Type-specific serialization
│   ├── Validation orchestration
│   ├── Format conversion
│   ├── Batch processing
│   └── Error handling
│
└── Security Integration
    ├── Content sanitization
    ├── Unicode normalization
    ├── Injection prevention
    └── Size limit enforcement
```

### 6. Security Architecture

Multi-layer security framework with comprehensive protection mechanisms.

```
Security Framework
├── SecureYamlParser
│   ├── Safe YAML deserialization
│   ├── Schema validation
│   ├── Type safety enforcement
│   ├── Size limit controls
│   └── Injection attack prevention
│
├── UnicodeValidator
│   ├── Direction override detection
│   ├── Mixed script analysis
│   ├── Normalization processing
│   ├── Character category validation
│   └── Security event logging
│
├── SecurityMonitor
│   ├── Event aggregation
│   ├── Threat detection
│   ├── Audit trail maintenance
│   ├── Real-time monitoring
│   └── Alert generation
│
├── FileLockManager
│   ├── Concurrent access control
│   ├── Deadlock prevention
│   ├── Resource cleanup
│   ├── Timeout handling
│   └── Cross-platform compatibility
│
└── Input Validation
    ├── Path traversal prevention
    ├── Command injection protection
    ├── Content length validation
    ├── Regular expression safety
    └── Data type enforcement
```

## Design Patterns

### 1. Singleton Pattern

**Implementation:** PortfolioManager, ConfigManager

```typescript
export class PortfolioManager {
  private static instance: PortfolioManager;
  private static instanceLock = false;
  private static initializationPromise: Promise<void> | null = null;
  
  // Thread-safe instance creation with initialization lock
  public static async getInstance(config?: PortfolioConfig): Promise<PortfolioManager> {
    // Implementation ensures single instance across application lifecycle
  }
}
```

**Benefits:**
- Thread-safe initialization
- Global state management
- Resource conservation
- Consistent configuration

### 2. Factory Pattern

**Implementation:** CacheFactory

```typescript
export class CacheFactory {
  public static createIndexCache(): LRUCache<IndexEntry[]> {
    return new LRUCache<IndexEntry[]>({
      maxSize: 100,
      maxMemoryMB: 10,
      ttlMs: 5 * 60 * 1000 // 5 minutes
    });
  }
}
```

**Benefits:**
- Centralized cache configuration
- Type-specific optimizations
- Memory management
- Configuration consistency

### 3. Adapter Pattern

**Implementation:** PortfolioElementAdapter

```typescript
export class PortfolioElementAdapter {
  public static async adaptToPortfolioElement(
    elementData: any,
    type: ElementType
  ): Promise<IElement> {
    // Converts external element formats to internal representation
  }
}
```

**Benefits:**
- Cross-system compatibility
- Format normalization
- Validation orchestration
- Type safety enforcement

### 4. Strategy Pattern

**Implementation:** Element Activation Strategies

Different activation strategies for various element types:
- Persona activation: Context injection
- Template activation: Content rendering
- Skill activation: Tool registration
- Agent activation: Decision engine initialization

## Data Flow Architecture

### Element Activation Flow

```
1. User Request
   ↓
2. Portfolio Manager
   ├── Element Discovery (UnifiedIndexManager)
   ├── Local Search
   ├── GitHub Search
   └── Collection Search
   ↓
3. Element Retrieval
   ├── Cache Check (LRUCache)
   ├── Security Validation (SecurityMonitor)
   ├── Download/Load
   └── Integrity Verification
   ↓
4. Element Processing
   ├── Parsing (SecureYamlParser)
   ├── Validation (UnicodeValidator)
   ├── Adapter Processing (PortfolioElementAdapter)
   └── Type-specific Manager
   ↓
5. Activation
   ├── Tool Registration (ToolRegistry)
   ├── Context Injection
   ├── State Management
   └── Error Handling (ErrorHandler)
   ↓
6. Response
   └── User Confirmation
```

### Portfolio Synchronization Flow

```
1. Synchronization Trigger
   ↓
2. Index Manager Coordination
   ├── Local Index Update
   ├── GitHub Repository Scan
   └── Collection Refresh
   ↓
3. Conflict Resolution
   ├── Version Comparison
   ├── Timestamp Analysis
   ├── Source Priority
   └── User Preference
   ↓
4. Cache Management
   ├── Invalidation
   ├── Refresh
   ├── Optimization
   └── Memory Cleanup
   ↓
5. Notification
   └── Update Status
```

### Error Propagation Flow

```
1. Error Origin
   ↓
2. Error Categorization (ErrorCategory)
   ↓
3. Context Enrichment
   ├── Stack Trace Preservation
   ├── User Context Addition
   ├── System State Capture
   └── Debug Information
   ↓
4. Error Handler Processing
   ├── Severity Assessment
   ├── Recovery Strategies
   ├── User Message Generation
   └── Logging Integration
   ↓
5. Security Monitoring
   ├── Threat Detection
   ├── Event Logging
   ├── Alert Generation
   └── Audit Trail
   ↓
6. User Feedback
   └── Error Message + Recovery Suggestions
```

## System Boundaries

### Internal Systems
- **Portfolio Management**: Local element storage and indexing
- **Element Processing**: Parsing, validation, and activation
- **Security Framework**: Multi-layer protection systems
- **Caching System**: Performance optimization
- **Error Handling**: Centralized error management
- **Build Information**: Runtime diagnostics

### External Dependencies
- **GitHub API**: Repository access and authentication
- **NPM Registry**: Package distribution and updates
- **MCP Protocol**: AI platform integration
- **File System**: Local storage operations
- **Node.js Runtime**: Platform foundation

### API Boundaries
- **MCP Tools**: Exposed functionality to AI platforms
- **GitHub Integration**: Repository operations
- **OAuth Flow**: Authentication management
- **Configuration Management**: Settings persistence
- **Update System**: Automatic updates and patches

## Performance Considerations

### Memory Management
- **LRU Caching**: Automatic memory cleanup with configurable limits
- **Lazy Loading**: On-demand resource loading
- **Object Pooling**: Reuse of expensive objects
- **Garbage Collection Optimization**: Minimal object creation

### I/O Optimization
- **Batch Operations**: Grouped file system operations
- **Async Processing**: Non-blocking operations
- **Connection Pooling**: Reused network connections
- **Compression**: Efficient data transfer

### Search Performance
- **Three-tier Indexing**: Local, GitHub, and Collection optimization
- **Parallel Processing**: Concurrent search operations
- **Result Caching**: Cached search results
- **Smart Pagination**: Efficient large result handling

## Scalability Design

### Horizontal Scaling Considerations
- **Stateless Operations**: No session state dependencies
- **Cache Distribution**: Distributed caching capabilities
- **Load Balancing**: Multiple instance support
- **Database Agnostic**: File-based storage for simplicity

### Vertical Scaling Features
- **Memory Efficiency**: Optimized memory usage patterns
- **CPU Optimization**: Efficient algorithms and caching
- **I/O Minimization**: Reduced file system operations
- **Network Optimization**: Minimized API calls

### Future Architecture Enhancements
1. **Microservices Decomposition**: Service separation for large deployments
2. **Event-Driven Architecture**: Reactive system design
3. **Container Orchestration**: Kubernetes deployment support
4. **Cloud-Native Features**: Auto-scaling and service mesh integration
5. **Distributed Caching**: Redis/Memcached integration
6. **CDN Integration**: Global content delivery
7. **Real-time Synchronization**: WebSocket-based updates

## Repository Relationships

### 1. Core Platform
**mcp-server** is the heart of the system:
- Implements the MCP protocol
- Manages all element types (personas, templates, skills, tools, agents)
- Handles security, validation, and updates
- Provides the CLI and programmatic interfaces

### 2. Content Sources

#### Collection (Community Content)
- Public repository for community-contributed elements
- Free to use and contribute
- Integrated with mcp-server via GitHub API
- Elements validated before acceptance

#### Catalog (Premium Content)
- Private repository for premium elements
- Enterprise features and professional content
- Subscription-based access (coming soon)
- Enhanced security and support

#### Experimental (Innovation Lab)
- Private R&D repository
- Next-generation features under development
- Not accessible to public
- Testing ground for future enhancements

### 3. Developer Ecosystem

#### Developer Kit
- Templates for creating new elements
- Integration examples
- Testing utilities
- Documentation for external developers

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines on:
- Code standards
- Testing requirements
- PR process
- Community guidelines

---

**Architecture Version**: v1.6.1  
**Last Updated**: August 19, 2025  
**Next Review**: September 2025

*This architecture is designed for scalability, security, and community growth while maintaining simplicity for end users and comprehensive functionality for AI platforms.*
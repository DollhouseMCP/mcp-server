# Next Element: Memory Implementation Guide

## Overview
Memory elements provide persistent context storage with multiple backends, retention policies, and privacy levels.

## Quick Start (Next Session)
```bash
# After Agent PR is merged
git checkout main
git pull
git checkout -b feature/memory-element-implementation

# Create structure
mkdir -p src/elements/memories
mkdir -p test/__tests__/unit/elements/memories

# Create files
touch src/elements/memories/Memory.ts
touch src/elements/memories/MemoryManager.ts
touch src/elements/memories/constants.ts
touch src/elements/memories/types.ts
touch src/elements/memories/index.ts
touch src/elements/memories/backends/FileBackend.ts
touch src/elements/memories/backends/InMemoryBackend.ts
touch test/__tests__/unit/elements/memories/Memory.test.ts
touch test/__tests__/unit/elements/memories/MemoryManager.test.ts
```

## Memory Element Design

### Core Features (from ELEMENT_IMPLEMENTATION_GUIDE.md)
1. **Multiple Storage Backends**
   - File-based (default)
   - In-memory (for testing)
   - Future: Database, cloud

2. **Retention Policies**
   - Time-based (expire after X days)
   - Count-based (keep last N items)
   - Size-based (max storage limit)
   - Priority-based (keep important items)

3. **Privacy Levels**
   - Public (shareable)
   - Private (user-only)
   - Sensitive (encrypted)

4. **Search Capabilities**
   - Full-text search
   - Tag-based filtering
   - Date range queries
   - Relevance scoring

### Implementation Structure

```typescript
// src/elements/memories/types.ts
export interface MemoryMetadata extends IElementMetadata {
  backend?: 'file' | 'memory' | 'database';
  retentionPolicy?: RetentionPolicy;
  privacyLevel?: 'public' | 'private' | 'sensitive';
  capacity?: number;  // Max items
  encryption?: boolean;
}

export interface MemoryEntry {
  id: string;
  timestamp: Date;
  content: string;
  tags?: string[];
  importance: number;  // 0-1
  metadata?: Record<string, any>;
  expiresAt?: Date;
}

export interface RetentionPolicy {
  type: 'time' | 'count' | 'size' | 'priority';
  value: number;
  unit?: 'days' | 'items' | 'bytes';
}

// src/elements/memories/Memory.ts
export class Memory extends BaseElement implements IElement {
  private backend: IMemoryBackend;
  private entries: Map<string, MemoryEntry>;
  
  constructor(metadata: Partial<MemoryMetadata>) {
    super(ElementType.MEMORY, metadata);
    this.backend = this.createBackend(metadata.backend || 'file');
    this.entries = new Map();
  }
  
  public async remember(content: string, tags?: string[]): Promise<MemoryEntry> {
    // Validate content
    // Check capacity
    // Apply retention policy
    // Store with backend
    // Return entry
  }
  
  public async recall(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    // Search entries
    // Apply privacy filter
    // Sort by relevance
    // Return results
  }
  
  public async forget(id: string): Promise<void> {
    // Security check
    // Remove from backend
    // Update indices
  }
}
```

### Security Considerations
1. **Input Validation**
   - Sanitize all memory content
   - Validate search queries
   - Check tag validity

2. **Privacy Protection**
   - Enforce privacy levels
   - Audit sensitive access
   - Encrypt sensitive data

3. **Resource Limits**
   - Max memory size
   - Search result limits
   - Rate limiting

### Backend Interface
```typescript
interface IMemoryBackend {
  store(id: string, entry: MemoryEntry): Promise<void>;
  retrieve(id: string): Promise<MemoryEntry | null>;
  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
  list(filter?: MemoryFilter): Promise<MemoryEntry[]>;
  applyRetention(policy: RetentionPolicy): Promise<number>; // Returns deleted count
}
```

## Testing Strategy

### Unit Tests
1. **Memory Operations**
   - Remember with validation
   - Recall with search
   - Forget with security
   - Retention enforcement

2. **Backend Tests**
   - File persistence
   - In-memory operations
   - Error handling
   - Concurrent access

3. **Security Tests**
   - Injection prevention
   - Privacy enforcement
   - Resource exhaustion
   - Audit logging

### Test Patterns from Agent
```typescript
// Mock setup
beforeEach(() => {
  (FileLockManager.atomicWriteFile as jest.Mock) = jest.fn().mockResolvedValue(undefined);
  (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();
});

// Capacity limits
it('should enforce memory capacity', async () => {
  const memory = new Memory({ capacity: 2 });
  await memory.remember('First');
  await memory.remember('Second');
  await expect(memory.remember('Third')).rejects.toThrow('capacity');
});
```

## Integration Points

### With Agents
- Agents can store/retrieve context
- Decision history in memory
- Goal persistence

### With Templates
- Template variables from memory
- Dynamic content generation

### With Skills
- Skill execution history
- Parameter learning

## Constants to Define
```typescript
export const MEMORY_LIMITS = {
  MAX_ENTRIES: 10000,
  MAX_ENTRY_SIZE: 50000,      // 50KB per entry
  MAX_TOTAL_SIZE: 10485760,   // 10MB total
  MAX_SEARCH_RESULTS: 100,
  MAX_TAGS_PER_ENTRY: 20,
  DEFAULT_RETENTION_DAYS: 90
};

export const MEMORY_DEFAULTS = {
  BACKEND: 'file' as const,
  PRIVACY_LEVEL: 'private' as const,
  IMPORTANCE_THRESHOLD: 0.3,
  SEARCH_LIMIT: 20
};
```

## Review Preparation
Based on Agent PR patterns, expect:
1. Questions about backend extensibility
2. Encryption implementation details
3. Search performance concerns
4. Privacy audit trail requirements

## Success Criteria
- [ ] All patterns from Agent/Skill followed
- [ ] Multiple backends working
- [ ] Retention policies enforced
- [ ] Privacy levels respected
- [ ] Search functionality complete
- [ ] 30+ comprehensive tests
- [ ] Security measures documented
- [ ] TypeScript compilation clean

---
*Reference this when implementing Memory element type*
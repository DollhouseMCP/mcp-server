# Memory Element Implementation Notes

## Quick Reference for Future Implementation

### Intelligent Memory Sequencing - Key Implementation Points

1. **Concurrent Memory Handling**
   - Current: Memories use timestamp + random ID suffix
   - Problem: Same millisecond = arbitrary order
   - Solution: Content analysis to determine logical sequence

2. **Temporal Markers to Extract**
   ```typescript
   // Explicit: "2025-07-21", "July 21st", "7/21/25"
   // Relative: "yesterday", "last week", "earlier today"
   // Sequential: "first", "then", "afterwards", "finally"
   // Causal: "because", "therefore", "as a result", "leading to"
   ```

3. **Example Algorithm Flow**
   ```
   Input: [MemoryC, MemoryA, MemoryB] (creation order)
   
   Step 1: Extract markers
   - MemoryA: "First, we discussed the requirements"
   - MemoryB: "Finally, we agreed on the approach"
   - MemoryC: "Then we evaluated three options"
   
   Step 2: Build sequence graph
   A -> C -> B (based on "First" -> "Then" -> "Finally")
   
   Output: [MemoryA, MemoryC, MemoryB] (logical order)
   ```

### RAG Integration - Architecture Overview

1. **Memory → RAG Flow**
   ```
   DollhouseMCP Memory 
     → Privacy Check (only public/private, not sensitive)
     → Transform to RAG format
     → Generate embeddings
     → Push to vector DB
     → Verify insertion
   ```

2. **RAG → Memory Flow**
   ```
   Query RAG system
     → Retrieve relevant documents
     → Extract key insights
     → Generate synthetic memories
     → Validate & sanitize
     → Import as new memories
   ```

3. **Key Integration Points**
   - Use existing Memory search() for finding exportable memories
   - Leverage privacy levels to control what gets exported
   - Add `ragSyncStatus` to memory metadata for tracking
   - Create new MCP tools: `sync_memories_to_rag`, `import_from_rag`

### Security Considerations for RAG

1. **API Key Management**
   ```typescript
   // Store in environment variables
   PINECONE_API_KEY=xxx
   CHROMA_API_URL=xxx
   WEAVIATE_TOKEN=xxx
   
   // Never store in memories or config files
   ```

2. **Privacy Enforcement**
   - NEVER export sensitive memories to RAG
   - Always check privacy level before export
   - Log all export operations with SecurityMonitor

3. **Rate Limiting**
   - Reuse existing RateLimiter from UpdateChecker
   - Default: 100 memories per minute to RAG
   - Configurable per adapter

### Testing Strategy

1. **Sequencing Tests**
   - Concurrent timestamp scenarios
   - Causal chain detection
   - Circular reference handling
   - Performance with 1000+ memories

2. **RAG Integration Tests**
   - Mock adapters for testing
   - Verify privacy filtering
   - Test embedding generation
   - Sync conflict scenarios

### Performance Optimizations

1. **Sequencing**
   - Cache temporal entities after extraction
   - Limit analysis to recent memories (e.g., last 1000)
   - Use parallel processing for entity extraction

2. **RAG Sync**
   - Batch API calls (10-50 memories per request)
   - Implement exponential backoff for failures
   - Use checksums to detect changes

### MCP Tools to Add

```typescript
// For sequencing
'sequence_memories': {
  timeRange?: string;  // "last_hour", "today", "all"
  method?: 'smart' | 'timestamp';  // Algorithm choice
}

// For RAG export
'export_memories_to_rag': {
  adapter: string;  // "pinecone", "chroma", etc.
  filter?: MemorySearchOptions;
  batchSize?: number;
}

// For RAG import  
'import_memories_from_rag': {
  adapter: string;
  query: string;
  limit?: number;
  generateSynthetic?: boolean;
}

// For sync status
'get_rag_sync_status': {
  adapter?: string;
}
```

### Next Session Checklist

When implementing these features:

1. **Start with Sequencing** (most self-contained)
   - [ ] Create MemorySequencer class
   - [ ] Implement temporal entity extraction
   - [ ] Add causal relationship detection
   - [ ] Write comprehensive tests
   - [ ] Add MCP tool

2. **Then RAG Export** (builds on existing)
   - [ ] Define IRAGAdapter interface
   - [ ] Implement first adapter (Pinecone or Chroma)
   - [ ] Add privacy filtering
   - [ ] Create export pipeline
   - [ ] Add MCP tools

3. **Finally RAG Import** (most complex)
   - [ ] Implement query interface
   - [ ] Add memory generation logic
   - [ ] Handle deduplication
   - [ ] Create import pipeline
   - [ ] Add sync manager

### Code Patterns to Follow

Use the existing Memory element patterns:
- Input validation with sanitizeMemoryContent()
- Security logging with SecurityMonitor
- Constants in constants.ts
- Comprehensive inline documentation
- Test coverage >90%

### Important Notes

1. **Don't break existing functionality** - All current tests must pass
2. **Maintain backward compatibility** - Existing memories must work
3. **Security first** - Every feature needs security review
4. **Document everything** - Inline comments for complex logic
5. **Performance matters** - These features will process many memories
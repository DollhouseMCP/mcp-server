# Enhanced Index Architecture Diagram

## Overview
The Enhanced Capability Index is a complex system designed to provide semantic relationships, verb-based triggers, and extensible metadata for portfolio elements. This document diagrams the architecture to identify issues and plan integration.

## Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                     EnhancedIndexManager                         │
│                        (Singleton)                               │
│  - Orchestrates entire indexing process                         │
│  - Manages file locking and caching                             │
│  - Controls index building and retrieval                        │
└─────────────────┬──────────────────────────┬────────────────────┘
                  │                          │
                  ▼                          ▼
    ┌──────────────────────┐      ┌────────────────────┐
    │  IndexConfigManager  │      │     FileLock       │
    │    (Singleton)       │      │  (Instance per     │
    │                      │      │   index file)      │
    │ - Central config     │      │                    │
    │ - Performance limits │      │ - Prevents races   │
    │ - NLP thresholds    │      │ - Stale detection  │
    └──────────────────────┘      └────────────────────┘
                  │
                  ├──────────────┬────────────┬──────────────┐
                  ▼              ▼            ▼              ▼
    ┌──────────────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────────────┐
    │ NLPScoringManager│  │ VerbTrigger│ │Relationship│  │PortfolioIndexMgr│
    │  (Instance)      │  │  Manager   │ │  Manager   │  │   (Singleton)    │
    │                  │  │(Singleton) │ │(Singleton) │  │                  │
    │ - Jaccard calc   │  │            │ │            │  │ - File scanning  │
    │ - Entropy calc   │  │ - Verb     │ │ - Pattern  │  │ - Metadata parse │
    │ - LRU cache     │  │   mapping  │ │   matching │  │ - Entry creation │
    │ - Score caching │  │ - Category │ │ - Inverse  │  └──────────┬───────┘
    └──────────────────┘  │   detect  │ │   rels     │             │
                          └─────┬──────┘ └────────────┘             ▼
                                │                          ┌──────────────────┐
                                ▼                          │ PortfolioManager │
                          ⚠️ CIRCULAR!                      │   (Singleton)    │
                          Calls getIndex()                 │                  │
                          during build!                    │ - Directory scan │
                                                          │ - File validation│
                                                          └──────────────────┘
```

## Data Flow & Processing Pipeline

```
1. INDEX BUILD REQUEST
   │
   ▼
2. FILE LOCK ACQUISITION (60s timeout)
   │
   ▼
3. PORTFOLIO SCANNING
   │
   ├─> Read all .md files from:
   │   - ~/.dollhouse/portfolio/personas/
   │   - ~/.dollhouse/portfolio/skills/
   │   - ~/.dollhouse/portfolio/templates/
   │   - ~/.dollhouse/portfolio/agents/
   │   - ~/.dollhouse/portfolio/memories/
   │   - ~/.dollhouse/portfolio/ensembles/
   │
   ▼
4. METADATA EXTRACTION (Per File)
   │
   ├─> SecureYamlParser.parse()
   │   ├─> Size validation (64KB YAML, 1MB content)
   │   ├─> YAML bomb detection
   │   ├─> Unicode normalization
   │   ├─> Pattern matching (CRITICAL ISSUE HERE!)
   │   └─> Field validation
   │
   ▼
5. ELEMENT DEFINITION BUILDING
   │
   ├─> Core metadata (name, description, version)
   ├─> Search data (keywords, tags, triggers)
   ├─> Verb triggers extraction
   └─> Initial relationships
   │
   ▼
6. SEMANTIC RELATIONSHIP CALCULATION (BOTTLENECK!)
   │
   ├─> Text preparation (combine fields)
   ├─> Entropy calculation (per element)
   ├─> Similarity matrix calculation:
   │   │
   │   ├─> IF elements <= 20 THEN
   │   │   └─> Full matrix (all pairs)
   │   │       - O(n²) comparisons
   │   │       - With our fix: max 190 comparisons
   │   │
   │   └─> IF elements > 20 THEN
   │       └─> Sampled relationships
   │           ├─> Keyword clustering (60% budget)
   │           └─> Cross-type sampling (40% budget)
   │               - With our fix: max 100 total
   │
   ▼
7. RELATIONSHIP DISCOVERY
   │
   ├─> Pattern-based discovery (regex matching)
   ├─> Verb-based discovery (DISABLED - circular dep!)
   └─> Inverse relationship creation
   │
   ▼
8. INDEX PERSISTENCE
   │
   └─> Save to ~/.dollhouse/portfolio/capability-index.yaml
```

## Initialization Chain Issues

```
USER CALLS getIndex()
    │
    ▼
EnhancedIndexManager.getInstance()
    │
    ├─> Creates singleton if not exists
    │   ├─> new IndexConfigManager()
    │   ├─> new NLPScoringManager()
    │   ├─> VerbTriggerManager.getInstance()
    │   ├─> RelationshipManager.getInstance()
    │   └─> new FileLock()
    │
    ▼
manager.getIndex()
    │
    ├─> Check if index exists and is fresh
    │   └─> If stale/missing → buildIndex()
    │
    ▼
buildIndex()
    │
    ├─> Acquire file lock (ISSUE: Can timeout in tests)
    ├─> Get PortfolioIndexManager.getInstance()
    │   └─> Triggers full portfolio scan
    ├─> Process each element
    ├─> calculateSemanticRelationships()
    │   └─> ISSUE: Can run thousands of comparisons
    ├─> discoverRelationships()
    │   └─> ISSUE: VerbTriggerManager calls getIndex() = CIRCULAR!
    └─> Save index
```

## Identified Issues & Bottlenecks

### 🔴 CRITICAL Issues

1. **Circular Dependency**
   ```
   RelationshipManager.discoverVerbRelationships()
       → VerbTriggerManager.getVerbsForElement()
           → EnhancedIndexManager.getIndex()  ← CIRCULAR!
   ```
   **Status**: Fixed by disabling verb-based discovery

2. **NLP Scoring Explosion**
   - Original: Could make 50,000+ comparisons for 100 elements
   - Fixed: Limited to max 100 comparisons
   - **Remaining Issue**: Still makes many redundant calculations

### 🟡 MEDIUM Issues

3. **File Lock Conflicts**
   - Multiple processes can fight over lock
   - Tests create race conditions
   - Stale lock detection sometimes fails

4. **Security Validation False Positives**
   - Skills with "audit", "security", "scan" trigger alerts
   - Overly aggressive pattern matching
   - Blocks legitimate security testing tools

### 🟢 MINOR Issues

5. **Cache Efficiency**
   - LRU cache works but evicts too frequently
   - Cache keys use only first 50 chars (collision risk)
   - No persistent cache between runs

## Performance Analysis

### Current Timings (After Fixes)
```
Operation                  | Time    | Details
--------------------------|---------|------------------
Portfolio Scan            | ~50ms   | 50-100 files
Metadata Extraction       | ~200ms  | Includes security validation
Entropy Calculation       | ~10ms   | Per element
NLP Scoring (per pair)    | ~1ms    | With cache hit
Full Build (50 elements)  | ~5000ms | With our limits
Index Retrieval (cached)  | ~10ms   | From disk
```

### Scaling Characteristics
```
Elements | Comparisons | Time  | Strategy
---------|-------------|-------|----------
10       | 45          | 1s    | Full matrix
20       | 190         | 2s    | Full matrix
50       | 100         | 3s    | Sampled
100      | 100         | 5s    | Sampled
500      | 100         | 8s    | Sampled
```

## Integration Points with Main App

Currently **NOT INTEGRATED** - Enhanced Index is completely isolated!

```
src/index.ts (Main MCP Server)
    │
    ├─> Uses: PortfolioManager directly
    ├─> Uses: PersonaManager directly
    ├─> Uses: SkillManager directly
    └─> Does NOT use: EnhancedIndexManager ❌

Where it SHOULD integrate:
    │
    ├─> portfolio_search tool
    │   └─> Could use semantic relationships
    │
    ├─> activate_element tool
    │   └─> Could suggest related elements
    │
    ├─> get_active_elements tool
    │   └─> Could show relationships
    │
    └─> New tools:
        ├─> find_similar_elements
        ├─> get_element_relationships
        └─> search_by_verb_trigger
```

## Proposed Solutions

### Phase 1: Stabilize (Current Session)
✅ Limit comparisons aggressively
✅ Add timeout circuit breakers
✅ Disable circular dependencies
⬜ Fix security validation patterns
⬜ Improve test isolation

### Phase 2: Optimize
⬜ Implement progressive indexing (index on demand)
⬜ Add persistent cache between runs
⬜ Use worker threads for NLP calculations
⬜ Implement incremental updates (only reindex changed files)

### Phase 3: Integrate
⬜ Create new MCP tools for relationship queries
⬜ Add relationship info to existing tools
⬜ Enable verb-based triggers in main app
⬜ Add relationship-aware element suggestions

### Phase 4: Enhance
⬜ Add more relationship types
⬜ Implement element composition
⬜ Add dependency tracking
⬜ Enable cross-element validation

## Key Architectural Decisions Needed

1. **Should Enhanced Index be required or optional?**
   - Required: All users get relationships but pay performance cost
   - Optional: Faster startup but features may be missing
   - **Recommendation**: Optional with lazy loading

2. **How to handle verb triggers without circular deps?**
   - Option A: Two-phase building (relationships after index)
   - Option B: Pass index to verb manager instead of fetching
   - Option C: Separate verb index file
   - **Recommendation**: Option B

3. **What's the right comparison limit?**
   - Current: 100 (very conservative)
   - Original: 10,000+ (too high)
   - **Recommendation**: 500 with better sampling

4. **How to integrate with main app?**
   - Option A: Replace existing managers
   - Option B: Augment with optional features
   - Option C: Parallel system with migration path
   - **Recommendation**: Option B

## Next Steps

1. **Immediate** (This session):
   - Fix security validation patterns
   - Re-enable verb triggers safely
   - Increase comparison limit to 500

2. **Short term** (Next session):
   - Add integration points to main app
   - Create new relationship-aware tools
   - Implement incremental indexing

3. **Long term**:
   - Full production integration
   - Performance optimization
   - Feature enhancement

---
*Created: September 24, 2025*
*Status: Architecture documented, stabilization in progress*
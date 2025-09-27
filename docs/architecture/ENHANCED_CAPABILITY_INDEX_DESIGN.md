# Enhanced Capability Index Design
## Server-Side Semantic Intelligence for DollhouseMCP

Created: September 22, 2025
Status: Design Phase
Priority: HIGH

## Overview

This document outlines the enhanced capability index system that provides server-side semantic intelligence while keeping the LLM's context window minimal and cost-effective.

## Core Architecture

### 1. Persistent Index File (`~/.dollhouse/capability-index.yaml`)

```yaml
# DollhouseMCP Enhanced Capability Index
# Generated: 2025-09-22T19:00:00Z
# Version: 2.0.0

metadata:
  total_elements: 287
  last_updated: "2025-09-22T19:00:00Z"
  entropy_threshold: 4.5  # Minimum entropy for meaningful content
  jaccard_threshold: 0.15  # Minimum similarity for relationships

# Verb-based action triggers (always loaded)
action_triggers:
  debug:
    - debug-detective
    - javascript-undefined-errors
    - python-debugging-guide

  create:
    - creative-writer
    - docker-test-framework
    - github-issue-creator

  fix:
    - debug-detective
    - security-analyst
    - memory-repair-tool

  explain:
    - eli5-explainer
    - technical-analyst

  test:
    - test-runner
    - capability-index-tests
    - docker-test-framework

# Element definitions with relationships
elements:
  memories:
    docker-authentication-solution:
      # Basic metadata
      name: "Docker Claude Code Authentication Solution"
      description: "Complete working solution for Docker authentication"
      version: "1.0.0"
      created: "2025-09-22"
      author: "mick"

      # Keywords for traditional search
      keywords: ["docker", "authentication", "apiKeyHelper", "claude", "code"]
      tags: ["docker", "auth", "solution", "tested"]

      # NEW: Verb-based action triggers
      action_triggers:
        - "create docker test"
        - "fix docker authentication"
        - "run docker container"
        - "authenticate claude"

      # NEW: USE_WHEN patterns (regex-based hooks)
      use_when:
        - pattern: "docker.*auth.*fail"
          confidence: 0.95
        - pattern: "apiKeyHelper.*not.*work"
          confidence: 0.92
        - pattern: "container.*permission.*denied"
          confidence: 0.88

      # NEW: Cross-element relationships
      relationships:
        similar_to:
          - element: "docker-dollhousemcp-setup-guide"
            jaccard: 0.61
            entropy: 4.9
            reason: "Shares Docker authentication terminology"

        used_by:
          - element: "capability-index-docker-test"
            confidence: 1.0
            reason: "Test requires authentication"

        helps_debug:
          - element: "docker-connection-errors"
            confidence: 0.85

        prerequisite_for:
          - element: "docker-advanced-testing"
            confidence: 0.9

      # NEW: Contextual snippets for injection
      context_snippets:
        brief: "Docker auth via apiKeyHelper method"
        detailed: |
          Complete Docker authentication solution using apiKeyHelper:
          1. Create ~/.claude/anthropic_key_helper.sh
          2. Configure with: claude config set --global apiKeyHelper
          3. Verified working September 22, 2025

      # NEW: Semantic scoring data
      semantic_data:
        entropy: 4.87  # Information density
        unique_terms: 47
        total_terms: 312
        avg_term_frequency: 2.3

    session-2025-09-22-capability-index:
      name: "Capability Index Testing Session"
      description: "Empirical testing that revealed token optimization flaws"

      relationships:
        contradicts:
          - element: "capability-index-theory"
            confidence: 0.95
            evidence: "9% token increase vs 97% reduction claim"

        references:
          - element: "docker-authentication-solution"
            reason: "Used Docker auth for testing"

        led_to:
          - element: "enhanced-capability-index-design"
            reason: "Failures led to this new approach"

      use_when:
        - pattern: "capability.*index.*not.*work"
          confidence: 0.9
        - pattern: "token.*optimization.*fail"
          confidence: 0.85

  personas:
    debug-detective:
      name: "Debug Detective"
      description: "Systematic debugging specialist"

      action_triggers:
        - "debug this"
        - "fix error"
        - "troubleshoot"
        - "root cause"

      relationships:
        commonly_used_with:
          - element: "javascript-undefined-errors"
            confidence: 0.78
          - element: "python-debugging-guide"
            confidence: 0.72

        complements:
          - element: "security-analyst"
            reason: "Security issues often need debugging"

      semantic_data:
        entropy: 4.2
        unique_terms: 38

# Conversation context tracking
context_tracking:
  recent_keywords:
    - term: "docker"
      frequency: 7
      last_seen: "2025-09-22T18:45:00Z"
      weight: 0.9

    - term: "test"
      frequency: 4
      last_seen: "2025-09-22T18:43:00Z"
      weight: 0.7

  active_relationships:
    - from: "docker-authentication-solution"
      to: "capability-index-docker-test"
      strength: 0.85
      reason: "Recently discussed together"

# Scoring configuration
scoring:
  jaccard_weights:
    keywords: 0.3
    action_triggers: 0.4
    relationships: 0.3

  entropy_thresholds:
    meaningful: 4.5   # Below this = common words
    technical: 5.0    # Above this = specialized

  context_decay:
    half_life_minutes: 15  # Context relevance decays
    minimum_weight: 0.1
```

## 2. In-Memory Cache Structure

```typescript
interface EnhancedPortfolioIndex {
  // Current mappings (fast lookups)
  byName: Map<string, IndexEntry>;
  byKeyword: Map<string, IndexEntry[]>;

  // NEW: Enhanced mappings
  byActionTrigger: Map<string, IndexEntry[]>;  // "debug" -> [elements]
  byUseWhenPattern: Map<RegExp, IndexEntry[]>; // Pattern -> [elements]
  byRelationship: Map<string, RelationshipGraph>; // Element -> graph

  // NEW: Scoring data
  semanticScores: Map<string, SemanticData>;
  jaccardMatrix: Map<string, Map<string, number>>; // Pairwise similarities

  // NEW: Context tracking
  contextKeywords: PriorityQueue<Keyword>;  // Decaying weights
  recentActivations: LRUCache<string>;      // Recently used elements
}

interface RelationshipGraph {
  element: string;
  edges: {
    type: 'similar_to' | 'used_by' | 'helps_debug' | 'prerequisite_for';
    target: string;
    weight: number;
    metadata: any;
  }[];
}
```

## 3. Context Injection Strategy

### Configurable Parameters

```yaml
# ~/.dollhouse/index-config.yaml

injection:
  # Size limits
  max_snippets: 5          # Maximum elements to inject
  max_tokens_per_snippet: 100
  total_token_limit: 500

  # Formatting
  format: "hierarchical"    # or "flat", "grouped"
  include_relationships: true
  include_confidence: true

  # Labeling
  labels:
    high_confidence: "✓ Recommended:"
    medium_confidence: "○ Consider:"
    low_confidence: "△ Possible:"

  # Priority ordering
  ordering:
    - "exact_match"         # Exact keyword matches first
    - "action_trigger"      # Verb matches second
    - "use_when_pattern"    # Pattern matches third
    - "relationship"        # Related elements last
```

### Example Injection Format

```markdown
## Available Capabilities for "docker testing"

✓ **Recommended** (confidence: 0.95)
• Docker Authentication Solution - Complete auth fix using apiKeyHelper
  Related: Docker Test Framework, Capability Index Tests

○ **Consider** (confidence: 0.72)
• Docker Test Framework - Testing utilities for containers
  Prerequisites: Docker Authentication Solution

△ **Possible** (confidence: 0.45)
• Debug Detective - Can help troubleshoot Docker issues
  Often used with: Docker error memories
```

## 4. NLP Integration Points

### Libraries to Integrate

```javascript
// For Node.js implementation

// Jaccard Similarity
const jaccardSimilarity = require('jaccard-similarity');

// Shannon Entropy
const entropy = require('shannon-entropy');

// Stop word removal & stemming
const natural = require('natural');
const stopwords = require('stopwords-json');

// Keyword extraction
const keywordExtractor = require('keyword-extractor');

// Pattern matching
const minimatch = require('minimatch');
```

### Scoring Algorithm

```javascript
function scoreRelevance(element, context) {
  const jaccard = calculateJaccard(element.keywords, context.keywords);
  const entropy = calculateEntropy(element.content);

  // High Jaccard + Moderate Entropy = Good match
  if (jaccard > 0.6 && entropy > 4.5 && entropy < 6.0) {
    return 0.95; // Excellent match
  }

  // High Jaccard + Low Entropy = Stop words
  if (jaccard > 0.6 && entropy < 3.0) {
    return 0.2;  // Superficial match
  }

  // Low Jaccard + Similar Entropy = Different domain
  if (jaccard < 0.2 && Math.abs(entropy - context.entropy) < 0.5) {
    return 0.1;  // Wrong domain
  }

  // Weighted combination
  return (jaccard * 0.6) + (entropyMatch * 0.4);
}
```

## 5. Future: Local LLM Integration

### Architecture for Semantic Co-processor

```yaml
# ~/.dollhouse/llm-config.yaml

local_llm:
  enabled: false  # Future feature
  model: "llama2-7b"  # Or other local model
  endpoint: "http://localhost:8080"

  tasks:
    - extract_relationships    # Find new element connections
    - classify_conversations   # Tag conversation topics
    - generate_summaries      # Create memory summaries
    - suggest_capabilities    # Recommend what to activate

  feedback_loop:
    capture_conversation: true
    analyze_interval: 30s     # Process every 30 seconds
    update_index: true        # Write insights back to index
    confidence_threshold: 0.7 # Only accept high-confidence insights
```

## 6. Implementation Phases

### Phase 1: Enhanced Index Structure (Week 1)
- [ ] Create YAML index file format
- [ ] Add verb-based triggers
- [ ] Implement USE_WHEN patterns
- [ ] Add relationship mappings

### Phase 2: Scoring System (Week 2)
- [ ] Integrate Jaccard similarity
- [ ] Add Shannon entropy calculation
- [ ] Build scoring algorithm
- [ ] Test with real memories

### Phase 3: Context Extraction (Week 3)
- [ ] Monitor conversation flow
- [ ] Extract keywords with NLP
- [ ] Weight by recency
- [ ] Query enhanced index

### Phase 4: Smart Injection (Week 4)
- [ ] Format injection snippets
- [ ] Add confidence scores
- [ ] Configure parameters
- [ ] Test with various formats

### Phase 5: Local LLM Hooks (Future)
- [ ] Design API interface
- [ ] Create feedback capture
- [ ] Implement insight extraction
- [ ] Test enhancement loop

## Benefits

1. **Cost Reduction**: 90%+ reduction in context tokens
2. **Better Targeting**: LLM sees relevant options
3. **Human Verifiable**: All YAML files readable
4. **Progressive Enhancement**: Local LLM adds value without cost
5. **Relationship Aware**: GraphRAG-like traversal

## Success Metrics

- Token usage reduction: >80%
- Correct element selection: >90%
- Response time: <200ms
- Human readability: 100% (YAML format)
- Relationship accuracy: >75% (Jaccard validation)

---

*This design provides semantic intelligence at the server level while maintaining human readability and cost effectiveness.*
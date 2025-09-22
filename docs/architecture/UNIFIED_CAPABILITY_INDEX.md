# Unified Capability Index for DollhouseMCP
## Optimized LLM Priming Strategy

Created: September 22, 2025
Based on: Empirical testing results from capability index tests

## Critical Design Principles

### 1. Verb-Based Action Triggers (Not Nouns)
- Use action words that match user intent
- Examples: debug, fix, explain, analyze, create, search, find
- NOT: debugger, fixer, explainer, analyst

### 2. Flat Structure with High Attention Surface
- Simple key-value pairs at top level
- No deep nesting that reduces attention probability
- Direct mappings visible immediately

### 3. Progressive Disclosure Pattern
- Level 1: Triggers (10 tokens) - Always visible
- Level 2: Summaries (50 tokens) - Load on match
- Level 3: Full content (150-500 tokens) - Load on demand

## The Unified Index Structure

```yaml
# DOLLHOUSE_CAPABILITY_INDEX
# This index MUST appear at the TOP of any CLAUDE.md or context

CAPABILITY_TRIGGERS:
  # Debugging & Errors
  debug → debug-detective
  error → debug-detective
  crash → debug-detective
  fix → debug-detective
  broken → debug-detective

  # Explanation & Learning
  explain → eli5-explainer
  teach → eli5-explainer
  simplify → eli5-explainer
  understand → eli5-explainer

  # Security & Analysis
  security → security-analyst
  vulnerability → security-analyst
  audit → security-analyst
  analyze → technical-analyst
  investigate → technical-analyst

  # Creation & Writing
  write → creative-writer
  story → creative-writer
  create → creative-writer
  imagine → creative-writer

  # Business & Strategy
  roi → business-consultant
  strategy → business-consultant
  business → business-consultant
  profit → business-consultant

  # Memory Operations
  remember → memory-manager
  recall → memory-manager
  forgot → memory-manager
  previous → memory-manager
  session → memory-manager

  # Git & Version Control
  git → git-workflow
  commit → git-workflow
  branch → git-workflow
  merge → git-workflow

  # Docker & Containers
  docker → docker-memory
  container → docker-memory
  authentication → docker-memory

  # GitHub Operations
  issue → github-tools
  pr → github-tools
  pull-request → github-tools

  # Testing & Quality
  test → test-runner
  verify → test-runner
  validate → test-runner
  check → test-runner

# CAPABILITY_SUMMARIES (Load when trigger matches)

debug-detective:
  DO: "Systematic debugging, root cause analysis, error isolation"
  USE_WHEN: "error|bug|crash|failure|broken|not working|undefined"
  ACTION: "activate_element('debug-detective', 'personas')"
  MEMORIES: ["javascript-errors", "python-errors", "common-bugs"]
  TOKEN_COST: 145

eli5-explainer:
  DO: "Simple explanations using analogies and examples"
  USE_WHEN: "explain|teach|simplify|understand|confusing|complex"
  ACTION: "activate_element('eli5-explainer', 'personas')"
  MEMORIES: ["teaching-techniques", "common-analogies"]
  TOKEN_COST: 132

security-analyst:
  DO: "Security vulnerability detection and remediation"
  USE_WHEN: "security|vulnerability|exploit|injection|xss|csrf"
  ACTION: "activate_element('security-analyst', 'personas')"
  MEMORIES: ["owasp-top-10", "security-best-practices"]
  TOKEN_COST: 156

memory-manager:
  DO: "Retrieve and manage persistent memories"
  USE_WHEN: "remember|recall|forgot|previous|earlier|session"
  SEARCHES:
    - "search_portfolio(query)"
    - "list_elements('memories')"
    - "get_element_details(name, 'memories')"
  TOKEN_COST: 98

git-workflow:
  DO: "Git operations and version control"
  USE_WHEN: "git|commit|branch|merge|rebase|cherry-pick"
  MEMORIES: ["gitflow-strategy", "commit-conventions"]
  TOOLS: ["gh", "git"]
  TOKEN_COST: 112

docker-memory:
  CONTAINS: "Docker authentication solution for Claude Code"
  USE_WHEN: "docker|container|authentication|apiKeyHelper"
  ACTION: "get_element_details('docker-claude-code-authentication-solution', 'memories')"
  TOKEN_COST: 287

github-tools:
  DO: "GitHub issue and PR management"
  USE_WHEN: "issue|pr|pull request|review|merge"
  TOOLS: ["gh pr", "gh issue"]
  TEMPLATES: ["pr-template", "issue-template"]
  TOKEN_COST: 134

# MEMORY_SELECTION_HINTS (For retrieval scenarios)

MEMORY_PRIORITIES:
  # When multiple memories match, prefer by recency and specificity

  javascript-errors:
    CONTAINS: "TypeError, undefined properties, optional chaining"
    PRIORITY: 1  # Highest for JS errors

  session-recent:
    PATTERN: "session-2025-09-*"
    PRIORITY: 2  # Recent sessions second

  generic-debugging:
    CONTAINS: "General debugging strategies"
    PRIORITY: 5  # Lowest priority

# TOOL_SELECTION_RULES

TOOL_PREFERENCES:
  # Direct mappings for common operations

  list_any: "list_elements(type)"
  search_local: "search_portfolio(query)"
  search_community: "search_collection(query)"
  get_details: "get_element_details(name, type)"
  activate: "activate_element(name, type)"
  deactivate: "deactivate_element(name, type)"

# ACTIVATION_PATTERNS

AUTO_ACTIVATE:
  # Patterns that should trigger immediate activation

  "fix this error":
    - activate_element('debug-detective', 'personas')
    - search_portfolio('error')

  "explain simply":
    - activate_element('eli5-explainer', 'personas')

  "check security":
    - activate_element('security-analyst', 'personas')
    - search_portfolio('security')

  "what did we do":
    - search_portfolio('session')
    - list_elements('memories')
```

## Implementation Strategy

### 1. Where to Place the Index

The index should be injected at the **TOP** of context in this order:
1. System prompt
2. **CAPABILITY_INDEX** (this document)
3. User's CLAUDE.md
4. Other context

### 2. Token Budget

```
Always Loaded (Level 1):
- Trigger map: ~50 tokens
- Tool preferences: ~30 tokens
- Total: ~80 tokens

Conditionally Loaded (Level 2):
- Relevant summaries: ~50 tokens each
- Usually 2-3 match: ~100-150 tokens

On-Demand (Level 3):
- Full capability: ~150-500 tokens
- Only when executing

Total Average: ~250-350 tokens vs 7,000+ without index
```

### 3. Validation Testing

To verify the index works:

1. **Trigger Test**: Use each trigger word, verify correct capability loads
2. **Memory Selection**: Create 3 similar memories, verify correct selection
3. **Cascade Test**: Monitor token usage at each level
4. **Heavy Context**: Embed in 25k context, measure performance

### 4. Expected Behaviors

When working correctly, you should see:

```
User: "I need to debug this error"
AI: [Sees "debug" → loads debug-detective summary]
    [Activates debug-detective persona]
    [Searches for relevant error memories]
    [Provides targeted solution]

Tokens used: ~400 (vs ~2,000 without index)
```

### 5. Continuous Improvement

The index should be updated based on:
- Most frequently used capabilities
- Failed activation attempts
- New elements added to portfolio
- User feedback on response quality

## Metrics for Success

1. **Token Reduction**: Target 80% reduction in memory token usage
2. **Activation Accuracy**: >90% correct capability selection
3. **Response Time**: <100ms to select capability
4. **Memory Selection**: >80% correct memory retrieval
5. **User Satisfaction**: Fewer manual activations needed

## Next Steps

1. Implement index generation from existing elements
2. Add to MCP server startup routine
3. Inject at top of all contexts
4. Monitor and measure performance
5. Iterate based on real usage data

---

*This unified index represents the optimal priming strategy based on empirical testing and token mechanics analysis.*
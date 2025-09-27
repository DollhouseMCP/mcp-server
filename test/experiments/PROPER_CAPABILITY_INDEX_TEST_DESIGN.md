# PROPER Capability Index Test Design
## Based on the ACTUAL Architecture We Designed

## The Real Capability Index Structure (Cascade Pattern)

### Level 1: Trigger Map (10 tokens) - ALWAYS visible
```yaml
CAPABILITY_TRIGGERS:
  debug → debug-detective
  error → debug-detective
  explain → eli5-explainer
  security → security-analyst
  docker → docker-auth-memory
  session → session-memories
  git → git-workflow-memory
```

### Level 2: Capability Summary (50 tokens each) - Loaded on match
```yaml
debug-detective:
  DO: "Systematic debugging, root cause analysis, error isolation"
  USE_WHEN: "error|bug|crash|failure|broken|not working"
  ACTION: "activate_element('debug-detective')"
  TOKEN_COST: 145

docker-auth-memory:
  CONTAINS: "apiKeyHelper solution for Claude Code authentication"
  CREATED: "2025-09-22"
  USE_WHEN: "docker|authentication|apiKeyHelper|login error"
  ACTION: "search_portfolio('docker-authentication-solution')"
  TOKEN_COST: 287

session-2025-09-20-memory:
  CONTAINS: "Bug fixes, CI improvements, v1.9.5 release"
  USE_WHEN: "september 20|bug fixes|CI|v1.9.5"
  ACTION: "get_element_details('session-2025-09-20-bug-fixes')"
  TOKEN_COST: 412

session-2025-09-21-memory:
  CONTAINS: "Capability index architecture, cascade pattern design"
  USE_WHEN: "capability index|cascade|token optimization"
  ACTION: "get_element_details('session-2025-09-21-capability-index')"
  TOKEN_COST: 523
```

### Level 3: Full Content (150-500 tokens) - Loaded on demand
```yaml
debug-detective-full:
  procedures:
    - "1. Identify error message and context"
    - "2. Trace execution path"
    - "3. Isolate variables"
    - "4. Test hypotheses"
  memories:
    corrective: "NEVER use console.log in production"
    procedural: "Always check logs first, then stack trace"
  tools: ["grep", "find", "git bisect"]
  [... full content ...]
```

## Test Scenario: Memory Retrieval with Similar Options

### Context Setup (25,000 tokens)

#### 1. Plant an Actual Error (Line 12,543 of context)
```javascript
// Deep in the context...
function processUserData(user) {
  const result = user.data.profile.settings.theme.color; // Error here
  return result;
}
// Error: Cannot read property 'color' of undefined
```

#### 2. Load Multiple Similar Memories (via Capability Index)

**Memory A: docker-debugging** (Wrong)
```yaml
docker-debugging:
  CONTAINS: "Docker container debugging techniques"
  USE_WHEN: "docker|container|build error"
  TOKEN_COST: 342
```

**Memory B: javascript-undefined-errors** (CORRECT)
```yaml
javascript-undefined-errors:
  CONTAINS: "Common undefined property errors, optional chaining solutions"
  USE_WHEN: "undefined|cannot read property|TypeError"
  ACTION: "get_element_details('javascript-undefined-errors')"
  TOKEN_COST: 298
```

**Memory C: general-debugging-tips** (Too generic)
```yaml
general-debugging-tips:
  CONTAINS: "General debugging strategies"
  USE_WHEN: "debug|error|problem"
  TOKEN_COST: 256
```

### Test Queries with Expected Behaviors

#### Test 1: Memory Retrieval
**Query**: "I'm getting an undefined error in processUserData"

**Expected CASCADE**:
1. Sees "error" → triggers `debug-detective`
2. Sees "undefined" → checks memory summaries
3. Finds `javascript-undefined-errors` matches best
4. Loads ONLY that memory (298 tokens, not all 896)
5. Provides solution using that specific memory

**Without Index**: Loads all memories (896 tokens) or none

#### Test 2: Persona Activation with Context
**Query**: "Explain this error as simply as possible"

**Expected CASCADE**:
1. Sees "explain" and "simply" → triggers `eli5-explainer`
2. Activates persona (145 tokens)
3. Explains the undefined error simply

**Escalation Test**:
- First: "Explain this simply"
- If no activation: "Explain like I'm five"
- Measure token usage for each attempt

#### Test 3: Complex Workflow
**Query**: "Debug this error and save the solution for next time"

**Expected CASCADE**:
1. "debug" → `debug-detective` activation
2. Find and fix the error
3. "save" → `create_element(type='memories')`
4. Measure total tokens vs doing all at once

## What We're ACTUALLY Measuring

### 1. Cascade Effectiveness
```python
tokens_used = {
    'trigger_map': 10,  # Always loaded
    'summaries_checked': 0,  # How many summaries loaded?
    'full_content_loaded': 0,  # How many full loads?
    'total': 0
}
```

### 2. Memory Selection Accuracy
- Did it pick `javascript-undefined-errors` (correct)?
- Or `docker-debugging` (wrong topic)?
- Or `general-debugging-tips` (too generic)?
- Or load ALL memories (cascade failed)?

### 3. Progressive Disclosure
- Does it load summary first, then full?
- Or immediate full load?
- Or no load at all?

### 4. Token Savings
```
Without Index:
- Load all 3 memories: 896 tokens
- Plus debug persona: 145 tokens
- Total: 1,041 tokens

With Cascade:
- Trigger map: 10 tokens
- Check 3 summaries: 150 tokens
- Load 1 correct memory: 298 tokens
- Load debug persona: 145 tokens
- Total: 603 tokens (42% reduction)
```

### 5. Response Time with Heavy Context
- Time to find error in 25k tokens
- Time to select correct memory
- Time to activate persona
- Time to generate solution

## Test Implementation Structure

### Phase 1: Setup
1. Generate 25k tokens with error at line 12,543
2. Create capability index with trigger → summary → full
3. Prepare 3 similar memories (only 1 correct)

### Phase 2: Run Tests
1. **No Index Control**: 25k context + query
2. **Index at Top**: Cascade index → 25k context → query
3. **Index at Bottom**: 25k context → cascade index → query
4. **Split Index**: Triggers at top, summaries at bottom

### Phase 3: Measure
- Token usage at each cascade level
- Which memory was selected
- Time to selection
- Output quality

## Why This Test is Different

| Previous Tests | This Test |
|---|---|
| Simple key→tool mapping | Full cascade pattern |
| Memory creation | Memory RETRIEVAL |
| Single correct answer | Multiple similar options |
| No actual error | Real error in context |
| Noun-based | Verb-based triggers |
| All-or-nothing | Progressive disclosure |

## Expected Outcomes

### If Cascade Works:
- 40-60% token reduction
- Correct memory selected 80%+ of time
- Faster response (fewer tokens to process)
- Clear cascade in output

### If Cascade Fails:
- No token savings (loads everything)
- Random memory selection
- Same speed regardless
- No evidence of cascade in output

---

*This is the test we SHOULD run based on our actual design*
# Complete Test Architecture Analysis - Capability Index Testing
## How We're ACTUALLY Injecting the Index

## 1. The Injection Method: CLAUDE.md File

### Current Implementation
```bash
# For each test, we create a CLAUDE.md file:
cat > "$test_dir/CLAUDE.md" <<EOF
$prompt_content  # e.g., "CRITICAL: Check index first"

## Capability Index

$structure_content  # e.g., "personas → list_elements()"

## Context
You have DollhouseMCP tools available...
EOF

# Then mount it in Docker:
-v "$(pwd)/$test_dir/CLAUDE.md:/home/claude/CLAUDE.md:ro"
```

### What This Does
1. Creates a CLAUDE.md file in test directory
2. Mounts it as `/home/claude/CLAUDE.md` in container
3. Claude Code MAY read it (but we have no proof it does)

## 2. The ACTUAL Test Flow (With Real Timings)

```
START TEST
    |
    ├─[2-3s] Docker container starts
    |   └─ claude-mcp-test-env-v2 image loads
    |
    ├─[0.5s] Mount CLAUDE.md as volume
    |   └─ File available at /home/claude/CLAUDE.md
    |
    ├─[1s] Setup authentication
    |   ├─ Create apiKeyHelper script
    |   └─ Configure Claude to use it
    |
    ├─[3-4s] Claude API call ← THE ACTUAL TEST
    |   ├─ Query: "Show me available personas"
    |   ├─ Context includes: ???
    |   ├─ MCP tools available via --allowedTools
    |   └─ Response generated
    |
    ├─[1s] MCP tool execution
    |   └─ list_elements("personas") called
    |
    └─[1s] Output written to file
```

**Total: ~10 seconds, but only 4-5 seconds is actual Claude work**

## 3. The Problem: We Don't Know If CLAUDE.md Is Being Read

### Evidence It's NOT Being Used:
1. **No difference between tests** - all produce same output
2. **Control test (no index) works identically**
3. **No reference to index in outputs**
4. **No token difference observed**

### Evidence It MIGHT Be Used:
1. File is mounted and available
2. Claude Code COULD read it
3. We just can't see internal processing

## 4. What DollhouseMCP's Built-in Index Looks Like

### Current MCP Server Tools (What's ACTUALLY Available):
```javascript
// From DollhouseMCP server
tools: {
  list_elements: { description: "List elements by type" },
  search_collection: { description: "Search community elements" },
  search_portfolio: { description: "Search local elements" },
  activate_element: { description: "Activate an element" },
  // ... 30+ more tools
}
```

### How Claude Sees These:
Via `--allowedTools` flag, not via capability index!

## 5. Why Our Test Results Are So Flat

### We're Testing the WRONG Variable
**What we're changing:** CLAUDE.md content
**What actually matters:** --allowedTools list

### All Tests Use Same Allowed Tools:
```bash
--allowedTools mcp__dollhousemcp__list_elements,\
               mcp__dollhousemcp__search_collection,\
               mcp__dollhousemcp__search_portfolio,\
               mcp__dollhousemcp__activate_element
```

**Result:** Same tools → Same behavior → Flat results

## 6. What We SHOULD Test (Worse Scenarios)

### Test 1: Information Overload
```
CAPABILITY_INDEX:
  [500 entries mapping every possible query to tools]
```
**Hypothesis:** More tokens, slower processing

### Test 2: Deep Nesting
```
capabilities:
  level1:
    level2:
      level3:
        level4:
          level5:
            tool: list_elements
```
**Hypothesis:** Parsing overhead

### Test 3: Conflicting Instructions
```
CRITICAL: Use search_collection for personas
CAPABILITY_INDEX:
  personas → list_elements  # Contradicts above
```
**Hypothesis:** Confusion, slower decisions

### Test 4: No Allowed Tools
```bash
# Remove --allowedTools entirely
# Force Claude to work from index alone
```
**Hypothesis:** Will it fail? Use index as fallback?

## 7. The Real Questions We Haven't Answered

1. **Does Claude Code even read CLAUDE.md?**
   - No evidence in our tests
   - Need to add traceable content

2. **How does --allowedTools interact with capability index?**
   - Currently overrides everything
   - Index might be ignored

3. **What's the baseline without Docker?**
   ```bash
   # Direct test (no Docker):
   time echo "List personas" | claude --model sonnet --print
   # Expected: 2-3 seconds total
   ```

4. **Does MCP server have its own index?**
   - Need to check DollhouseMCP source
   - May be competing with our index

## 8. Proposed Better Test Architecture

### A. Test Response Time Properly
```bash
# Start container ONCE
docker run -d --name test-container ...

# Multiple queries (measure each)
for i in {1..10}; do
  START=$(date +%s%N)
  docker exec test-container claude-query "..."
  END=$(date +%s%N)
  echo "Query $i: $(($END-$START))ns"
done
```

### B. Test With Varying Complexity
```javascript
// Simple index (10 entries)
// Medium index (100 entries)
// Complex index (1000 entries)
// Measure: tokens, time, accuracy
```

### C. Test Without --allowedTools
```bash
# Force reliance on capability index
claude --model sonnet --print \
  --mcp-config /path/to/config.json
# No --allowedTools flag
```

### D. Add Traceable Markers
```
CAPABILITY_INDEX:
  UNIQUE_MARKER_12345 → list_elements

If Claude references "UNIQUE_MARKER_12345", we know it read the index
```

## 9. The Injection We're NOT Doing

### What We Could Inject Via:
1. **System prompts** (if Claude Code allows)
2. **MCP server configuration**
3. **Tool descriptions themselves**
4. **Environment variables**
5. **Pre-conversation context**

### What We ARE Injecting Via:
1. **CLAUDE.md file only** (maybe not even read)

## Conclusion: We're Testing Wrong

**Current Test:**
- Changes CLAUDE.md content
- Same tools always available
- Measures Docker overhead mostly
- Can't prove index is even read

**What We Need:**
- Vary --allowedTools
- Add traceable markers
- Test without Docker overhead
- Measure actual API response time
- Test degradation scenarios

---

*The flat results make sense: we're not actually changing what matters*
*The capability index might not even be reaching Claude*
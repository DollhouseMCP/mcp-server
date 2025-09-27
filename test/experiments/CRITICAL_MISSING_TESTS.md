# Critical Missing Tests for Capability Index

## What We've Been Missing

### 1. We're Only Testing MCP Tools, Not Elements
**Current tests:**
- list_elements()
- search_collection()
- search_portfolio()

**MISSING tests:**
- **activate_element('persona-name')** - Activating personas
- **create_element(type='memories')** - Creating memories
- **deactivate_element()** - Deactivating elements
- **render_template()** - Using templates
- **execute_agent()** - Running agents

### 2. We're Not Testing Heavy Context Scenarios

**Need to test with:**
- 25,000+ tokens of context BEFORE the query
- Multiple competing priorities in context
- Conflicting information that index should resolve

### 3. Capability Index Should Cover ALL Elements

```yaml
CAPABILITY_INDEX:
  # PERSONAS (behavioral activation)
  debug → activate_element('debug-detective')
  creative → activate_element('creative-writer')
  security → activate_element('security-analyst')

  # MEMORIES (context management)
  save → create_element(type='memories', content=current)
  recall → search_portfolio('memory')
  session → get_element_details('session-*')

  # SKILLS (capability enhancement)
  code_review → activate_element('code-review-skill')
  testing → activate_element('test-writer-skill')

  # TEMPLATES (structured output)
  report → render_template('status-report')
  pr → render_template('pull-request')

  # AGENTS (autonomous tasks)
  research → execute_agent('research-agent', goal)
  refactor → execute_agent('refactor-agent', code)

  # ENSEMBLES (combined elements)
  team → activate_element('dev-team-ensemble')
```

## Tests We SHOULD Run

### Test A: Persona Activation Under Load
```bash
# 25,000 tokens of documentation
# Query: "Help me debug this error"
# Expected: activate_element('debug-detective')
# Measure: Time to activation, tokens used
```

### Test B: Memory Creation with Context
```bash
# 25,000 tokens of conversation history
# Query: "Save this for tomorrow's session"
# Expected: create_element(type='memories', ...)
# Measure: What gets saved, how much context
```

### Test C: Progressive Disclosure
```bash
# Index with multiple levels:
CAPABILITY_INDEX:
  personas → list_names_only
  personas_detailed → list_with_descriptions
  personas_full → get_all_metadata

# Test if Claude uses minimal option first
```

### Test D: Index vs No Index with Heavy Load
```bash
# Scenario 1: 25k tokens + NO index
# Scenario 2: 25k tokens + index at TOP
# Scenario 3: 25k tokens + index at BOTTOM
# Scenario 4: 25k tokens + index REPEATED

# Measure: Response time, correct element activation
```

### Test E: Conflicting Context
```bash
# Context says: "Always use creative-writer"
# Query: "Help me debug"
# Index says: debug → debug-detective

# What wins? Context or index?
```

## Why Current Tests Are Insufficient

### 1. Binary Tool Execution
All our tests just check if `list_elements` runs. We're not testing:
- Which persona gets activated
- Whether memories are created/retrieved
- Template rendering
- Agent execution

### 2. Clean Context
Testing with empty/minimal context doesn't reflect reality where:
- Context is already full of information
- Multiple possible interpretations exist
- Performance degrades with size

### 3. Single Element Type
Only testing "list personas" doesn't cover:
- Cross-element workflows
- Combined operations
- Progressive refinement

## Proposed Comprehensive Test

### Setup
1. Load 25,000 tokens of mixed content
2. Include conflicting instructions
3. Add noise/distractions

### Test Matrix
| Context Size | Index Position | Element Type | Query Type |
|-------------|----------------|--------------|------------|
| 0 tokens | None | Persona | Direct |
| 10k tokens | Top | Memory | Indirect |
| 25k tokens | Bottom | Skill | Ambiguous |
| 50k tokens | Both | Template | Complex |

### Measurements
1. **Activation accuracy**: Right element activated?
2. **Response time**: How long to decide?
3. **Token usage**: Input + output tokens
4. **Cascade behavior**: Progressive disclosure?
5. **Conflict resolution**: What wins?

## The Real Question

**Does a capability index help Claude navigate a heavy context to activate the right elements (personas, memories, skills) more efficiently?**

Current answer: **We don't know because we haven't tested it properly**

---

*We've been testing the wrong thing in the wrong way*
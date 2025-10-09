# DollhouseMCP Ambient Intelligence Architecture

**Document Version**: 1.0.0
**Date**: October 9, 2025
**Status**: Technical Specification
**Vision**: Transform DollhouseMCP into an ambient intelligence layer for Claude Code

---

## Executive Summary

This document describes a paradigm shift for DollhouseMCP: from a tool that users actively invoke to an **ambient intelligence layer** that proactively assists with every interaction. Using Claude Code hooks and the Capability Index as a local knowledge graph, DollhouseMCP will monitor conversations, suggest relevant tools, offer to create new capabilities, and surface memories - all without consuming context tokens.

### The Core Insight

The Capability Index (46,000 tokens) and all memories (YAML files) exist **outside Claude's context window** as a local knowledge graph. A universal hook queries this graph for every user message, intelligently deciding what Claude needs to see. This creates an AI copilot that knows your entire toolkit and can create new tools on demand.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   User Message                          │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│          Universal Hook (UserPromptSubmit)              │
│                                                         │
│  1. Extract verbs/intent from message                  │
│  2. Query Capability Index (LOCAL, 0 tokens)           │
│  3. Search memories (LOCAL, 0 tokens)                  │
│  4. Identify relevant elements                         │
│  5. Detect creation opportunities                      │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│              Intelligent Response                       │
│                                                         │
│  • "I have Debug Detective persona for this"           │
│  • "Found 3 memories about similar problems"           │
│  • "Nothing exists yet - shall I create it?"           │
│  • Inject only relevant context                        │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│           Claude Processes with Context                 │
└─────────────────────────────────────────────────────────┘
```

---

## The Capability Index as Local Intelligence

### Current State
- 20,559 lines of YAML (46,000 tokens)
- Maps verbs to elements
- Contains semantic relationships
- Tracks usage patterns
- **Never loaded into Claude**

### New Role: Knowledge Graph
```yaml
# Extended Capability Index Structure
action_triggers:
  debug:
    personas: [Debug-Detective, Error-Analyst]
    skills: [python-debugger, stack-trace-analyzer]
    memories: [session-2025-09-debug-patterns]
    templates: [bug-report-template]

  create:
    skills: [element-creator, template-generator]
    memories: [element-creation-patterns]
    suggestion: "I can create new {type} for {purpose}"

  convert:
    skills: [markdown-to-html, format-converter]
    memories: [conversion-techniques]
    missing: "No converter for {format} yet - create one?"

semantic_relationships:
  Debug-Detective:
    similar: [Error-Analyst, Troubleshooter]
    complements: [Python-Expert, Stack-Trace-Analyzer]
    memories: [debug-session-*, error-resolution-*]

memory_index:
  keywords:
    authentication: [session-2025-09-auth, security-patterns]
    performance: [optimization-notes, benchmark-results]
```

---

## Universal Hook Implementation

### Core Hook: UserPromptSubmit

```python
#!/usr/bin/env python3
"""
DollhouseMCP Universal Intelligence Hook
Monitors all user messages and provides ambient assistance
"""

import json
import sys
import yaml
import re
from pathlib import Path

# Load configuration
DOLLHOUSE_HOME = Path.home() / ".dollhouse"
CAPABILITY_INDEX = DOLLHOUSE_HOME / "portfolio" / "capability-index.yaml"
MEMORIES_DIR = DOLLHOUSE_HOME / "portfolio" / "memories"

def extract_intent(message):
    """Extract action verbs and intent from user message"""
    # Common action patterns
    patterns = {
        'create': r'(create|make|build|generate|write)\s+(\w+)',
        'debug': r'(debug|fix|troubleshoot|error|bug)',
        'convert': r'(convert|transform|change|format)',
        'search': r'(find|search|look for|where|remember)',
        'help': r'(help|assist|how to|guide|explain)'
    }

    intents = []
    for intent, pattern in patterns.items():
        if re.search(pattern, message.lower()):
            intents.append(intent)

    return intents

def query_capability_index(intents):
    """Query local Capability Index for relevant elements"""
    with open(CAPABILITY_INDEX, 'r') as f:
        index = yaml.safe_load(f)

    suggestions = []

    for intent in intents:
        if intent in index['action_triggers']:
            triggers = index['action_triggers'][intent]

            # Check for existing elements
            for element_type in ['personas', 'skills', 'templates', 'agents']:
                if element_type in triggers:
                    for element in triggers[element_type]:
                        suggestions.append({
                            'type': 'existing',
                            'element_type': element_type,
                            'name': element,
                            'action': 'activate'
                        })

            # Check for memories
            if 'memories' in triggers:
                for memory_pattern in triggers['memories']:
                    # Search memories directory
                    memories = search_memories(memory_pattern)
                    for memory in memories:
                        suggestions.append({
                            'type': 'memory',
                            'name': memory,
                            'action': 'recall'
                        })

            # Check for creation opportunities
            if 'missing' in triggers:
                suggestions.append({
                    'type': 'create',
                    'suggestion': triggers['missing'],
                    'action': 'offer_creation'
                })

    return suggestions

def search_memories(pattern):
    """Search memory files matching pattern"""
    memories = []
    for memory_file in MEMORIES_DIR.rglob("*.yaml"):
        if pattern in memory_file.stem:
            memories.append(memory_file.stem)
    return memories

def generate_context_injection(suggestions):
    """Generate context to inject based on suggestions"""

    if not suggestions:
        return None

    # Build context message
    context_parts = []

    # Group by type
    existing = [s for s in suggestions if s['type'] == 'existing']
    memories = [s for s in suggestions if s['type'] == 'memory']
    create = [s for s in suggestions if s['type'] == 'create']

    if existing:
        context_parts.append("🎯 **Available DollhouseMCP Elements:**")
        for item in existing[:3]:  # Limit to top 3
            context_parts.append(f"- {item['element_type']}: {item['name']}")
        context_parts.append("*Use 'activate_element' to enable*")
        context_parts.append("")

    if memories:
        context_parts.append("🧠 **Relevant Memories:**")
        for item in memories[:3]:  # Limit to top 3
            context_parts.append(f"- {item['name']}")
        context_parts.append("*These memories contain related context*")
        context_parts.append("")

    if create:
        context_parts.append("✨ **Creation Opportunity:**")
        for item in create:
            context_parts.append(f"- {item['suggestion']}")
        context_parts.append("*Use 'create_element' to build new capabilities*")

    return "\n".join(context_parts)

def main():
    # Read input from Claude Code
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(1)

    # Extract user message
    message = input_data.get('user_prompt', '')

    # Skip if message is too short
    if len(message) < 10:
        sys.exit(0)

    # Extract intent from message
    intents = extract_intent(message)

    if not intents:
        sys.exit(0)

    # Query Capability Index
    suggestions = query_capability_index(intents)

    # Generate context injection
    context = generate_context_injection(suggestions)

    if context:
        # Output JSON to inject context
        output = {
            "continue": True,
            "additionalContext": context,
            "suppressOutput": True  # Don't show raw output in transcript
        }
        print(json.dumps(output))

    sys.exit(0)

if __name__ == "__main__":
    main()
```

### Hook Configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.dollhouse/hooks/universal-intelligence.py",
            "timeout": 2
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.dollhouse/hooks/load-project-context.sh"
          }
        ]
      }
    ]
  }
}
```

---

## Key Capabilities

### 1. Ambient Element Discovery
When user says: "I need to debug this Python code"
- Hook detects "debug" and "Python"
- Queries Capability Index locally
- Finds: Debug-Detective persona, python-debugger skill
- Injects: "I have Debug-Detective and python-debugger available"

### 2. Proactive Creation Offers
When user says: "Convert this YAML to TOML"
- Hook detects "convert", "YAML", "TOML"
- Queries index, finds no YAML-to-TOML converter
- Injects: "No YAML to TOML converter exists yet - shall I create one?"

### 3. Memory Surfacing
When user says: "How did we handle authentication last time?"
- Hook detects "authentication", "last time"
- Searches memories for auth-related sessions
- Injects: "Found 3 relevant memories about authentication patterns"

### 4. Dynamic Capability Growth
Every created element:
- Automatically adds to Capability Index
- Updates verb mappings
- Builds relationships
- Becomes discoverable immediately

---

## Implementation Phases

### Phase 1: Core Hook (Week 1)
- [x] Research hook architecture
- [ ] Implement UserPromptSubmit hook
- [ ] Basic intent extraction
- [ ] Capability Index querying

### Phase 2: Memory Integration (Week 2)
- [ ] Memory search functionality
- [ ] Semantic memory matching
- [ ] Context summarization
- [ ] Relevance scoring

### Phase 3: Creation Intelligence (Week 3)
- [ ] Detect missing capabilities
- [ ] Auto-generate creation prompts
- [ ] Template suggestions
- [ ] Element relationship building

### Phase 4: Advanced Features (Week 4+)
- [ ] Learning from usage patterns
- [ ] Predictive element loading
- [ ] Context budget management
- [ ] Multi-turn conversation tracking

---

## Performance Considerations

### Token Economics
- **Capability Index**: 46,000 tokens → 0 tokens (local query)
- **Memory Search**: Unlimited memories → 0 tokens (local search)
- **Context Injection**: Only relevant items → ~500-1500 tokens
- **Total Savings**: 90%+ reduction in context usage

### Response Latency
- Hook timeout: 2 seconds max
- Index query: ~50ms
- Memory search: ~100ms
- Total overhead: <500ms

### Scaling Behavior
```
10 elements:    Hook finds 1-2 relevant → 200 tokens
100 elements:   Hook finds 2-3 relevant → 400 tokens
1000 elements:  Hook finds 3-5 relevant → 600 tokens
10000 elements: Hook finds 3-5 relevant → 600 tokens (constant!)
```

---

## Security Considerations

### Hook Security
- Validate all inputs
- Sanitize file paths
- Use read-only access to index
- No arbitrary code execution
- Timeout protection (2 seconds)

### Privacy
- All processing happens locally
- No data sent to external services
- User controls what gets injected
- Transparent operation

---

## Competitive Advantage

### Why This Is Revolutionary

1. **Zero-Token Knowledge Graph**
   - Entire knowledge base accessible without context cost
   - Scales infinitely without token penalties

2. **Ambient Intelligence**
   - Proactive assistance without user prompting
   - Discovers opportunities automatically

3. **Self-Improving System**
   - Every interaction can create new capabilities
   - System gets smarter with use

4. **Creation as Core Feature**
   - Not just using tools, but creating them
   - Natural language tool generation

### Competitive Moat
- 6+ months to replicate Capability Index
- Network effects from element creation
- Compound value from memory accumulation
- First-mover in ambient AI assistance

---

## Success Metrics

### User Experience
- Relevant suggestions on 80%+ of messages
- Creation offers accepted 30%+ of time
- Memory recall accuracy >90%
- Response latency <500ms

### System Growth
- Elements created per user per week
- Memory utilization rate
- Cross-element relationships discovered
- Token savings achieved

---

## Conclusion

This architecture transforms DollhouseMCP from a powerful but manual tool into an **ambient intelligence layer** that makes every Claude Code interaction smarter. By keeping the massive Capability Index and memory system local while intelligently injecting only relevant context, we achieve:

1. **Infinite scaling** without token penalties
2. **Proactive assistance** without user effort
3. **Continuous improvement** through creation
4. **Unmatched efficiency** in context usage

The universal hook becomes the bridge between a vast local knowledge graph and Claude's context window, creating an AI assistant that truly knows everything you've built and can build anything you need.

---

*Next Steps: Implement Phase 1 core hook and test with real Capability Index queries.*
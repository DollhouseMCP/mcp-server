# DollhouseMCP Ambient Intelligence Architecture

**Document Version**: 2.0.0
**Date**: October 9, 2025
**Status**: Detailed Technical Specification
**Vision**: Transform DollhouseMCP into an adaptive ambient intelligence layer across all AI platforms

---

## Executive Summary

This document describes a paradigm shift for DollhouseMCP: from a tool that users actively invoke to an **ambient intelligence layer** that proactively assists with every interaction. Using a dual approach (programmatic pattern matching + semantic LLM understanding), DollhouseMCP will monitor conversations, suggest relevant tools, offer to create new capabilities, and surface memories - all without consuming context tokens.

### The Core Insight

The Capability Index (46,000 tokens) and all memories (YAML files) exist **outside Claude's context window** as a local knowledge graph. A universal hook queries this graph for every user message using BOTH programmatic pattern matching AND lightweight LLM semantic understanding, intelligently deciding what Claude needs to see.

### Platform Reality

Multiple AI platforms are implementing similar architectures:
- **Claude Code**: Hooks and plugins (announced Oct 9, 2025)
- **Cloudflare Code Mode**: Context window management
- **Others**: Coming soon

DollhouseMCP must detect its environment and adapt accordingly.

---

## Dual Intelligence Architecture

### The Two-Layer Approach

```python
class DollhouseIntelligence:
    """
    Hybrid intelligence system:
    Layer 1: Programmatic (5ms, 80% coverage)
    Layer 2: Semantic LLM (200ms, 100% coverage)
    """

    def __init__(self):
        self.programmatic = ProgrammaticMatcher()
        self.semantic = SemanticAnalyzer()
        self.confidence_threshold = 0.75

    def process(self, message):
        # Always try programmatic first (fast, cheap)
        prog_result = self.programmatic.analyze(message)

        if prog_result.confidence > self.confidence_threshold:
            return prog_result  # 80% of cases handled here

        # Fall back to semantic for complex intent
        return self.semantic.analyze(message, prog_result)
```

### Layer 1: Programmatic Intelligence (5ms)

Based on 15+ years of NLP pattern recognition (4 patents), handles 80% of cases:

```python
class ProgrammaticMatcher:
    def __init__(self):
        # Pre-compiled regex patterns for speed
        self.verb_patterns = self.compile_verb_patterns()
        self.entity_extractors = self.build_entity_extractors()
        self.intent_classifiers = self.load_intent_models()

        # Load Capability Index into memory (once)
        self.capability_index = self.load_and_index_capabilities()
        self.memory_index = self.build_memory_index()

    def analyze(self, message):
        # 1. Tokenization and POS tagging (1ms)
        tokens = self.tokenize(message)
        pos_tags = self.pos_tag(tokens)

        # 2. Verb extraction (1ms)
        verbs = self.extract_verbs(tokens, pos_tags)

        # 3. Entity recognition (1ms)
        entities = self.extract_entities(tokens, pos_tags)

        # 4. Intent classification (1ms)
        intent = self.classify_intent(verbs, entities)

        # 5. Capability matching (1ms)
        matches = self.match_capabilities(intent, verbs, entities)

        return AnalysisResult(
            intent=intent,
            matches=matches,
            confidence=self.calculate_confidence(matches)
        )

    def compile_verb_patterns(self):
        """
        Sophisticated verb extraction using linguistic patterns
        """
        return {
            'debug': re.compile(r'\b(debug|fix|troubleshoot|diagnose|trace|investigate|solve)\b', re.I),
            'create': re.compile(r'\b(create|make|build|generate|construct|develop|write|design)\b', re.I),
            'convert': re.compile(r'\b(convert|transform|translate|change|format|parse|serialize)\b', re.I),
            'analyze': re.compile(r'\b(analyze|examine|review|assess|evaluate|inspect|audit)\b', re.I),
            'optimize': re.compile(r'\b(optimize|improve|enhance|refactor|speed up|performance)\b', re.I),
            'test': re.compile(r'\b(test|verify|validate|check|ensure|assert|confirm)\b', re.I),
            'document': re.compile(r'\b(document|explain|describe|annotate|comment|readme)\b', re.I),
            'search': re.compile(r'\b(find|search|look for|locate|where|remember|recall)\b', re.I),
        }

    def extract_entities(self, tokens, pos_tags):
        """
        Extract programming languages, file types, concepts
        """
        entities = {
            'languages': [],
            'file_types': [],
            'concepts': [],
            'tools': []
        }

        # Language detection
        lang_patterns = {
            'python': r'\b(python|py|pip|django|flask)\b',
            'javascript': r'\b(javascript|js|node|npm|react|vue)\b',
            'typescript': r'\b(typescript|ts|tsx|angular)\b',
            'rust': r'\b(rust|cargo|rustc)\b',
            'go': r'\b(golang|go)\b',
        }

        for lang, pattern in lang_patterns.items():
            if re.search(pattern, ' '.join(tokens), re.I):
                entities['languages'].append(lang)

        # File type detection
        file_patterns = r'\.(py|js|ts|rs|go|md|yaml|json|html|css|sql)\b'
        entities['file_types'] = re.findall(file_patterns, ' '.join(tokens), re.I)

        # Concept extraction (nouns following certain patterns)
        for i, (token, pos) in enumerate(zip(tokens, pos_tags)):
            if pos in ['NN', 'NNS', 'NNP']:  # Nouns
                entities['concepts'].append(token.lower())

        return entities

    def match_capabilities(self, intent, verbs, entities):
        """
        Match against Capability Index using sophisticated scoring
        """
        matches = []

        # Direct verb matching
        for verb in verbs:
            if verb in self.capability_index['action_triggers']:
                elements = self.capability_index['action_triggers'][verb]
                for element_type, element_list in elements.items():
                    for element in element_list:
                        matches.append({
                            'element': element,
                            'type': element_type,
                            'score': 1.0,  # Direct match
                            'reason': f'verb:{verb}'
                        })

        # Semantic similarity matching
        for concept in entities['concepts']:
            similar = self.find_similar_capabilities(concept)
            for match in similar:
                match['score'] *= 0.8  # Slightly lower confidence
                matches.append(match)

        # Language/tool specific matching
        for lang in entities['languages']:
            lang_specific = self.find_language_capabilities(lang)
            for match in lang_specific:
                match['score'] *= 0.9
                matches.append(match)

        # Memory matching
        memory_matches = self.search_memories(intent, entities)
        matches.extend(memory_matches)

        # Deduplicate and sort by score
        return self.deduplicate_and_rank(matches)
```

### Layer 2: Semantic Intelligence (200ms)

Using Claude Haiku or local LLM for complex understanding:

```python
class SemanticAnalyzer:
    def __init__(self):
        self.llm = self.setup_llm()
        self.capability_summary = self.build_capability_summary()

    def setup_llm(self):
        """
        Choose LLM based on availability and user preference
        """
        if self.is_haiku_available():
            return HaikuClient()  # $0.25/million tokens
        elif self.is_local_llm_available():
            return LocalLLM()  # Ollama with Llama 3.2 1B
        else:
            return None  # Fall back to programmatic only

    def analyze(self, message, programmatic_result):
        """
        Use LLM for semantic understanding
        """
        if not self.llm:
            return programmatic_result

        # Build compact prompt with context
        prompt = self.build_analysis_prompt(message, programmatic_result)

        # Get LLM analysis (with timeout)
        try:
            response = self.llm.analyze(prompt, timeout=0.2)
            return self.merge_results(programmatic_result, response)
        except TimeoutError:
            return programmatic_result  # Graceful fallback

    def build_analysis_prompt(self, message, prog_result):
        """
        Create efficient prompt for LLM
        """
        return f"""
        Analyze user intent and map to available tools.

        User message: {message}

        Initial analysis:
        - Detected verbs: {prog_result.verbs}
        - Entities: {prog_result.entities}
        - Confidence: {prog_result.confidence}

        Available capabilities (summary):
        {self.capability_summary}

        Return JSON:
        {{
            "primary_intent": "debug|create|analyze|etc",
            "suggested_elements": ["element1", "element2"],
            "create_opportunity": "description if nothing exists",
            "confidence": 0.95
        }}
        """

    def build_capability_summary(self):
        """
        Build compact representation of capabilities for LLM
        """
        # Summarize capabilities into ~500 tokens
        summary = []

        # Top personas
        summary.append("Personas: Debug-Detective, Creative-Writer, Python-Expert...")

        # Top skills by category
        summary.append("Debug skills: error-analyzer, stack-tracer...")
        summary.append("Creation skills: element-creator, template-builder...")

        # Memory categories
        summary.append("Memory types: session-notes, architecture, patterns...")

        return '\n'.join(summary)
```

### Haiku Integration

```python
class HaikuClient:
    def __init__(self):
        self.api_key = os.getenv('ANTHROPIC_API_KEY')
        self.model = 'claude-3-haiku-20240307'

    def analyze(self, prompt, timeout=0.2):
        """
        Call Haiku for fast semantic analysis
        Cost: ~$0.000125 per message
        """
        response = anthropic.Anthropic(api_key=self.api_key).messages.create(
            model=self.model,
            max_tokens=200,
            temperature=0,
            messages=[{
                "role": "user",
                "content": prompt
            }]
        )

        return json.loads(response.content)
```

### Local LLM Option

```python
class LocalLLM:
    def __init__(self):
        # Using Ollama with small model
        self.model = 'llama3.2:1b'  # 1B parameter model

    def analyze(self, prompt, timeout=0.2):
        """
        Local inference for privacy and speed
        Latency: ~50ms on M1 Mac
        """
        import ollama

        response = ollama.chat(
            model=self.model,
            messages=[{
                'role': 'system',
                'content': 'You are a tool selection assistant. Return only JSON.'
            }, {
                'role': 'user',
                'content': prompt
            }],
            options={'temperature': 0}
        )

        return json.loads(response['message']['content'])
```

---

## Environment Detection and Adaptation

### Multi-Platform Strategy

```python
class EnvironmentDetector:
    """
    Detect which AI platform we're running in and adapt
    """

    def __init__(self):
        self.environment = self.detect_environment()
        self.capabilities = self.get_platform_capabilities()

    def detect_environment(self):
        """
        Identify the runtime environment
        """
        # Check for Claude Code
        if os.getenv('CLAUDE_PROJECT_DIR'):
            return 'claude_code'

        # Check for Claude Desktop
        elif os.path.exists(os.path.expanduser('~/Library/Application Support/Claude')):
            return 'claude_desktop'

        # Check for VS Code
        elif os.getenv('VSCODE_PID'):
            return 'vscode'

        # Check for Cursor
        elif os.getenv('CURSOR_APP'):
            return 'cursor'

        # Check for Cloudflare Code Mode
        elif os.getenv('CF_CODE_MODE'):
            return 'cloudflare_code_mode'

        # Default
        return 'unknown'

    def get_platform_capabilities(self):
        """
        Return platform-specific capabilities
        """
        capabilities = {
            'claude_code': {
                'hooks': True,
                'plugins': True,
                'context_injection': True,
                'slash_commands': True,
                'mcp_support': True
            },
            'claude_desktop': {
                'hooks': False,
                'plugins': False,
                'context_injection': False,
                'slash_commands': False,
                'mcp_support': True
            },
            'vscode': {
                'hooks': False,
                'plugins': True,  # VS Code extensions
                'context_injection': False,
                'slash_commands': False,
                'mcp_support': False
            },
            'cloudflare_code_mode': {
                'hooks': 'unknown',
                'plugins': 'unknown',
                'context_injection': True,  # They mention this
                'slash_commands': 'unknown',
                'mcp_support': False
            }
        }

        return capabilities.get(self.environment, {})

    def adapt_behavior(self):
        """
        Adjust DollhouseMCP behavior based on platform
        """
        if self.environment == 'claude_code':
            # Full ambient intelligence with hooks
            return ClaudeCodeAdapter()

        elif self.environment == 'claude_desktop':
            # Traditional MCP server mode
            return ClassicMCPAdapter()

        elif self.environment == 'cloudflare_code_mode':
            # Adapt to their context management
            return CloudflareAdapter()

        else:
            # Fallback to basic MCP
            return BasicAdapter()
```

### Platform-Specific Adapters

```python
class ClaudeCodeAdapter:
    """
    Full ambient intelligence for Claude Code
    """

    def setup(self):
        # Install hooks in ~/.claude/settings.json
        self.install_hooks()

        # Register slash commands if plugin
        self.register_commands()

        # Enable full intelligence
        self.enable_ambient_mode()

    def install_hooks(self):
        settings_path = Path.home() / '.claude' / 'settings.json'

        hooks_config = {
            "hooks": {
                "UserPromptSubmit": [{
                    "hooks": [{
                        "type": "command",
                        "command": "~/.dollhouse/hooks/ambient-intelligence.py",
                        "timeout": 2
                    }]
                }],
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "~/.dollhouse/hooks/load-context.py",
                        "timeout": 1
                    }]
                }]
            }
        }

        # Merge with existing settings
        self.merge_settings(settings_path, hooks_config)

class ClassicMCPAdapter:
    """
    Traditional MCP server mode for Claude Desktop
    """

    def setup(self):
        # No hooks available
        # Rely on user calling MCP tools directly
        # Could potentially use a "helper" persona that's always active

        # Auto-activate assistant persona on startup
        self.auto_activate_assistant()

    def auto_activate_assistant(self):
        """
        Activate a lightweight assistant that suggests tools
        """
        # This persona would have instructions like:
        # "Monitor conversation and suggest DollhouseMCP tools"
        pass

class CloudflareAdapter:
    """
    Adapt to Cloudflare's Code Mode architecture
    """

    def setup(self):
        # Research their API when available
        # Likely similar to hooks but different implementation
        pass
```

---

## Detailed Implementation Specifications

### Weekend MVP Implementation Plan

#### Friday Evening (4 hours)
```bash
# Hour 1: Setup
- Create ~/.dollhouse/hooks/ directory
- Copy Capability Index to optimized format
- Set up Python environment

# Hour 2-3: Programmatic Matcher
- Implement verb extraction
- Build pattern matchers
- Test with 10 sample messages

# Hour 4: Basic Hook
- Create minimal UserPromptSubmit hook
- Test injection into Claude Code
- Verify it works end-to-end
```

#### Saturday (8 hours)
```bash
# Morning (4 hours): Programmatic Refinement
- Enhance verb patterns
- Add entity extraction
- Implement memory search
- Test with 50 real messages
- Measure accuracy

# Afternoon (4 hours): Semantic Layer
- Set up Haiku client
- Create LLM prompt template
- Implement fallback logic
- Test hybrid approach
- Compare accuracy: programmatic vs hybrid
```

#### Sunday (6 hours)
```bash
# Morning (3 hours): Integration
- Environment detection
- Platform adapters
- Installation script
- Documentation

# Afternoon (3 hours): Testing & Demo
- Real workflow testing
- Performance optimization
- Demo video recording
- Launch preparation
```

### Core Files Structure

```
~/.dollhouse/
├── hooks/
│   ├── ambient-intelligence.py      # Main universal hook
│   ├── programmatic_matcher.py      # Layer 1 intelligence
│   ├── semantic_analyzer.py         # Layer 2 intelligence
│   ├── environment_detector.py      # Platform detection
│   └── install.py                   # Setup script
├── cache/
│   ├── capability_index.json        # Optimized index
│   ├── memory_index.json           # Memory search index
│   └── llm_cache.json              # Cache LLM responses
└── config/
    ├── settings.json                # User preferences
    └── platforms.json               # Platform configurations
```

### Performance Specifications

#### Latency Budget (per message)
```
Total Budget: 500ms

Breakdown:
- Message parsing: 5ms
- Programmatic analysis: 10ms
- Capability Index query: 20ms
- Memory search: 30ms
- Semantic analysis (if needed): 200ms
- Context generation: 10ms
- JSON output: 5ms

Reserve: 220ms
```

#### Token Economics
```
Without Ambient Intelligence:
- Capability Index: 46,000 tokens if loaded
- Active elements: 5,000 tokens average
- Total: 51,000 tokens per conversation

With Ambient Intelligence:
- Capability Index: 0 tokens (local)
- Injected suggestions: 200-500 tokens
- Active elements (on-demand): 1,000 tokens
- Total: 1,500 tokens average

Savings: 97% reduction
```

#### Cost Analysis (Semantic Layer)
```
Haiku Costs:
- Input: $0.25/million tokens
- Output: $1.25/million tokens
- Average message: 500 input + 100 output
- Cost per message: $0.000125 + $0.000125 = $0.00025

Monthly (1000 messages/day):
- 30,000 messages × $0.00025 = $7.50/month

Local LLM Costs:
- One-time setup: Download 1B model (~2GB)
- Running cost: Electricity only
- Latency: 50ms on M1 Mac
```

---

## Advanced Features

### Conversation Context Tracking

```python
class ConversationTracker:
    """
    Track multi-turn conversations for better suggestions
    """

    def __init__(self):
        self.history = []
        self.active_elements = set()
        self.session_intent = None

    def update(self, message, suggestions):
        self.history.append({
            'message': message,
            'suggestions': suggestions,
            'timestamp': time.time()
        })

        # Detect session-level intent
        self.infer_session_intent()

    def infer_session_intent(self):
        """
        Detect what the user is trying to accomplish
        """
        # Look at last 5 messages
        recent = self.history[-5:]

        # Common patterns
        if self.is_debugging_session(recent):
            self.session_intent = 'debugging'
            self.suggest_debugging_workflow()
        elif self.is_creation_session(recent):
            self.session_intent = 'creating'
            self.suggest_creation_workflow()
```

### Learning and Adaptation

```python
class UsageAnalytics:
    """
    Learn from user behavior to improve suggestions
    """

    def __init__(self):
        self.accepted_suggestions = []
        self.rejected_suggestions = []
        self.element_usage = {}

    def record_acceptance(self, suggestion):
        self.accepted_suggestions.append({
            'suggestion': suggestion,
            'context': self.get_context(),
            'timestamp': time.time()
        })

        # Update scoring weights
        self.update_weights(suggestion, accepted=True)

    def update_weights(self, suggestion, accepted):
        """
        Adjust scoring based on user behavior
        """
        # If user consistently rejects certain suggestions,
        # lower their scores in future
        pass
```

### Creation Intelligence

```python
class CreationAssistant:
    """
    Intelligently offer to create new elements
    """

    def detect_creation_opportunity(self, message, existing_capabilities):
        # Pattern: "I need X but it doesn't exist"
        if self.is_request_for_missing(message, existing_capabilities):
            return self.generate_creation_prompt(message)

        # Pattern: "How do I Y without Z"
        if self.is_workaround_attempt(message):
            return self.suggest_custom_tool(message)

        return None

    def generate_creation_prompt(self, message):
        """
        Generate a creation suggestion
        """
        return f"""
        I notice you need something that doesn't exist yet.
        Shall I create a new element for this?

        Suggested: {self.infer_element_type(message)}
        Name: {self.suggest_name(message)}
        Purpose: {self.extract_purpose(message)}

        Say 'yes' to create, or describe what you need differently.
        """
```

---

## Security and Privacy

### Hook Security Model

```python
class SecurityValidator:
    """
    Validate all hook inputs and outputs
    """

    def __init__(self):
        self.max_message_length = 10000
        self.max_output_length = 5000
        self.blocked_patterns = self.load_blocked_patterns()

    def validate_input(self, message):
        # Length check
        if len(message) > self.max_message_length:
            raise ValueError("Message too long")

        # Injection detection
        if self.detect_injection(message):
            raise SecurityError("Potential injection detected")

        # PII detection
        if self.contains_pii(message):
            self.sanitize_pii(message)

        return True

    def validate_output(self, output):
        # Ensure no sensitive data leaks
        if self.contains_secrets(output):
            raise SecurityError("Output contains secrets")

        return True
```

### Privacy Considerations

```python
class PrivacyManager:
    """
    Ensure user privacy
    """

    def __init__(self):
        self.opt_out = self.load_opt_out_preferences()
        self.data_retention = self.load_retention_policy()

    def should_process(self, message):
        # Check opt-out
        if self.opt_out.get('semantic_analysis'):
            return 'programmatic_only'

        # Check for sensitive content
        if self.is_sensitive(message):
            return 'local_only'

        return 'full'

    def is_sensitive(self, message):
        # Detect medical, legal, financial content
        sensitive_patterns = [
            r'\b(medical|health|diagnosis)\b',
            r'\b(legal|lawsuit|attorney)\b',
            r'\b(password|secret|key|token)\b'
        ]

        for pattern in sensitive_patterns:
            if re.search(pattern, message, re.I):
                return True

        return False
```

---

## Competitive Landscape

### Similar Initiatives (October 2025)

1. **Claude Code Plugins** (Anthropic)
   - Announced: October 9, 2025
   - Focus: Plugins and hooks
   - Our advantage: Capability Index + ambient intelligence

2. **Code Mode** (Cloudflare)
   - Announced: October 9, 2025 (same day!)
   - Focus: Context window management
   - Our advantage: Dual-layer intelligence

3. **GitHub Copilot Context**
   - Existing
   - Focus: Code completion
   - Our advantage: Element creation + memory system

4. **Cursor AI**
   - Existing
   - Focus: IDE integration
   - Our advantage: Platform agnostic

### Our Unique Value Proposition

1. **Capability Index**: 46K tokens of structured knowledge, locally searchable
2. **Dual Intelligence**: Programmatic (fast) + Semantic (smart)
3. **Creation Core**: Not just using tools but creating them
4. **Memory System**: Persistent context across sessions
5. **Platform Agnostic**: Works across all AI platforms

---

## Success Metrics

### MVP Success Criteria (Weekend)

#### Technical Metrics
- [ ] Hook responds in <500ms for 95% of messages
- [ ] Programmatic matcher handles 70%+ of cases
- [ ] Semantic layer improves accuracy by 20%+
- [ ] Zero token cost for Capability Index access
- [ ] Installation takes <2 minutes

#### User Experience Metrics
- [ ] Relevant suggestions on 60%+ of messages (MVP)
- [ ] False positive rate <20%
- [ ] Creation opportunities identified 30%+ of time
- [ ] Memory recall when relevant 80%+ accuracy

#### Business Metrics
- [ ] Cost per message <$0.001 (with Haiku)
- [ ] Cost per message $0 (with local LLM)
- [ ] 90%+ token reduction vs loading everything

### Long-term Success (30 days)

- 80%+ of messages get relevant suggestions
- 50%+ of creation opportunities accepted
- 95%+ memory recall accuracy
- <100ms latency for programmatic layer
- Platform detection works for 5+ environments

---

## Implementation Checklist

### Friday Evening
- [ ] Set up hooks directory structure
- [ ] Create programmatic matcher v1
- [ ] Test verb extraction
- [ ] Build basic hook script
- [ ] Test with Claude Code
- [ ] Verify injection works

### Saturday
- [ ] Enhance pattern matching
- [ ] Add entity extraction
- [ ] Implement memory search
- [ ] Set up Haiku client
- [ ] Create semantic analyzer
- [ ] Test hybrid approach
- [ ] Measure accuracy

### Sunday
- [ ] Environment detection
- [ ] Platform adapters
- [ ] Installation script
- [ ] Performance optimization
- [ ] Documentation
- [ ] Demo preparation

### Monday (GitHub Issues)
- [ ] Create implementation epic
- [ ] Break down into component issues
- [ ] Set up project board
- [ ] Assign priorities
- [ ] Create test plan

---

## Conclusion

This architecture represents a fundamental shift in how AI assistants work. Instead of passive tools waiting for commands, DollhouseMCP becomes an **ambient intelligence** that:

1. **Knows everything you've built** (via Capability Index)
2. **Remembers everything you've done** (via Memory System)
3. **Understands what you need** (via Dual Intelligence)
4. **Creates what doesn't exist** (via Creation Core)
5. **Costs almost nothing** (via Local Processing)

The dual-layer approach (programmatic + semantic) ensures both speed and intelligence, while platform detection ensures it works everywhere.

By keeping the massive Capability Index and memory system local while intelligently injecting only relevant context, we achieve unlimited scaling without token penalties.

---

## Appendix A: Patent-Inspired Algorithms

### From Social Media Classification Patents

These algorithms from 15 years ago are directly applicable:

```python
class PatentedClassifier:
    """
    Based on patents for social media classification
    Adapted for tool selection
    """

    def semantic_clustering(self, documents):
        """
        Patent: Semantic clustering of unstructured text
        Original: Twitter posts
        Now: User messages and tool descriptions
        """
        # TF-IDF vectorization
        vectors = self.tfidf.fit_transform(documents)

        # Cosine similarity matrix
        similarity = cosine_similarity(vectors)

        # Hierarchical clustering
        clusters = self.hierarchical_cluster(similarity)

        return clusters

    def intent_classification(self, message):
        """
        Patent: Multi-level intent classification
        Original: Facebook posts
        Now: Developer requests
        """
        # Level 1: Broad category (create, debug, analyze)
        category = self.classify_category(message)

        # Level 2: Specific action
        action = self.classify_action(message, category)

        # Level 3: Target entity
        target = self.extract_target(message, action)

        return Intent(category, action, target)

    def temporal_pattern_detection(self, message_history):
        """
        Patent: Temporal pattern detection in message streams
        Original: Tweet streams
        Now: Conversation history
        """
        # Sliding window analysis
        patterns = []
        for window in self.sliding_windows(message_history):
            pattern = self.detect_pattern(window)
            if pattern:
                patterns.append(pattern)

        # Pattern frequency analysis
        frequent = self.find_frequent_patterns(patterns)

        return frequent
```

---

## Appendix B: Example Interactions

### Example 1: Debugging Session
```
User: "This Python code is throwing weird errors"

Programmatic Analysis (5ms):
- Verbs: [throwing]
- Entities: {languages: [python], concepts: [errors]}
- Confidence: 0.65 (below threshold)

Semantic Analysis (200ms):
- Intent: "debug"
- Context: "python runtime errors"
- Suggestions: ["Debug-Detective", "Python-Expert", "Stack-Trace-Analyzer"]

Injection:
"🎯 DollhouseMCP can help debug this:
- Debug-Detective persona for systematic debugging
- Python-Expert skill for Python-specific issues
- Found 3 memories about similar Python errors
Use 'activate_element' to enable assistance."
```

### Example 2: Creation Opportunity
```
User: "I need to convert this YAML config to TOML"

Programmatic Analysis (5ms):
- Verbs: [convert]
- Entities: {file_types: [yaml, toml]}
- Confidence: 0.90 (high)

Result (no semantic needed):
"✨ No YAML to TOML converter exists yet.
Shall I create one? This would be a new skill that:
- Parses YAML input
- Converts to TOML format
- Handles nested structures
Say 'yes' to create this skill."
```

### Example 3: Memory Recall
```
User: "How did we handle that authentication bug last week?"

Programmatic Analysis (5ms):
- Verbs: [handle]
- Entities: {concepts: [authentication, bug], temporal: [last week]}
- Memory search triggered

Memory Results:
- session-2025-10-02-authentication-fix
- bug-pattern-oauth-timeout
- security-fix-jwt-validation

Injection:
"🧠 Found relevant memories:
- Session notes from Oct 2: OAuth timeout fix
- Bug pattern documentation for authentication
- Security fix for JWT validation
These contain the authentication debugging approach."
```

---

*Next Steps: Begin Friday evening implementation focusing on programmatic layer first, then add semantic intelligence on Saturday.*
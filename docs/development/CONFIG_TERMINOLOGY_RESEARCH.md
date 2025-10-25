# Configuration Terminology Research & Clarifications

## 1. Portfolio Directory - Current Status

**CONFIRMED**: Portfolio directory IS in config at `elements.default_element_dir: /Users/mick/.dollhouse/portfolio`

**PROBLEM**: It's shown in `dollhouse_config action: "get"` but buried under the `elements` section, which is not intuitive.

**SOLUTION**: Restructure to support multiple portfolios:

```yaml
portfolios:
  active: default  # Which portfolio is currently active
  directories:
    - alias: default
      path: ~/.dollhouse/portfolio
      description: "Main portfolio"
      auto_backup: true
      backup_path: ~/.dollhouse/backups/default
      
    - alias: work
      path: ~/work/.dollhouse-work
      description: "Work-related elements only"
      auto_backup: true
      backup_path: ~/work/.dollhouse-work/backups
      encrypted: false  # Future: support encryption
      
    - alias: personal
      path: ~/personal/.dollhouse-personal
      description: "Personal elements"
      auto_backup: true
      backup_path: ~/personal/.dollhouse-personal/backups
      encrypted: false
```

---

## 2. Standard Industry Terminology Research

### Installation/Usage Analytics

**Industry Terms** (from research of npm, VS Code, Homebrew, Telemetry, PostHog docs):

| Term | What It Means | Used By | Our Fit |
|------|---------------|---------|---------|
| **Installation Telemetry** | One-time event: version, platform, install date | npm, Homebrew | ✅ Accurate - we track install event |
| **Usage Analytics** | Ongoing: feature usage, session duration, frequency | VS Code, JetBrains | ❌ Too broad - we don't track usage |
| **Operational Telemetry** | System health, errors, performance | Azure, AWS | ❌ Misleading - implies monitoring |
| **Product Analytics** | User behavior, conversion, retention | PostHog, Mixpanel | ❌ Too commercial |
| **Anonymous Analytics** | Generic term for privacy-first tracking | Many | ✅ Accurate but vague |
| **Adoption Metrics** | Install counts, version distribution, platforms | Open source projects | ✅ BEST FIT - this is what we track |

**RECOMMENDATION**: `adoption_metrics` or `install_tracking`

**What We Actually Track**:
- Installation UUID (one-time, persistent)
- DollhouseMCP version
- Operating system (darwin/win32/linux)
- Node.js version
- MCP client type (Claude Desktop/Code/etc)
- Installation timestamp

**What We DON'T Track**:
- Which tools are used
- How often server is used
- Session duration
- Feature usage
- User content

**BEST NAME**: `install_tracking` (most accurate) or `adoption_metrics` (broader context)

---

### Enhanced Index "Telemetry"

**What It Actually Does** (from code inspection):

```typescript
// Tracks:
- Verb extraction success rate (how many verbs found per element)
- Trigger matching performance (speed, accuracy)
- Pattern detection effectiveness (which patterns work best)
- Sampling rate (only tracks X% of operations)
- Metrics reported every 60 seconds

// Purpose:
- Improve verb extraction algorithms
- Tune pattern matching
- Identify which verbs are most useful
- Optimize trigger detection

// Storage:
- LOCAL ONLY (never sent anywhere)
- Logs to console (debug level)
- Aggregated metrics
```

**Industry Terms**:

| Term | What It Means | Our Fit |
|------|---------------|---------|
| **Search Analytics** | User search behavior, queries, results | ❌ NO - we don't track searches |
| **Pattern Recognition Metrics** | ML model performance, accuracy | ⚠️ Close but too technical |
| **Discovery Performance** | How well auto-discovery works | ✅ Accurate |
| **Trigger Analytics** | Trigger effectiveness tracking | ✅ Accurate |
| **Capability Indexing** | Building search indexes | ⚠️ Describes feature, not telemetry |
| **Feature Learning** | System learning which features work | ✅ Accurate |

**BEST NAME**: `discovery_performance` or `trigger_analytics`

**Plain English Description**:
"Tracks how well the automatic discovery system finds the right elements for your tasks. Helps improve verb pattern matching and trigger detection. All data stays on your computer."

---

## 3. Configuration Settings Explained (Plain Language)

### Performance Settings - EXPLAINED

```yaml
performance:
  cache:
    max_size_mb: 50
    # WHAT IT MEANS: Maximum memory used for caching element data
    # WHY IT MATTERS: Larger = faster but more RAM used
    # GOOD SETTINGS: 50MB (default), 100MB (power users), 25MB (limited RAM)
    
    ttl_seconds: 3600
    # WHAT IT MEANS: How long cached data stays valid (Time To Live)
    # WHY IT MATTERS: Shorter = more up-to-date, Longer = faster
    # GOOD SETTINGS: 3600 (1 hour default), 7200 (2 hours), 1800 (30 min)
    
  timeouts:
    api_request_ms: 30000
    # WHAT IT MEANS: How long to wait for GitHub API before giving up
    # WHY IT MATTERS: Prevents hanging on slow connections
    # GOOD SETTINGS: 30000 (30 sec default), 60000 (slow internet), 15000 (fast)
    
    file_lock_ms: 5000
    # WHAT IT MEANS: How long to wait for exclusive file access
    # WHY IT MATTERS: Prevents conflicts when multiple processes access files
    # GOOD SETTINGS: 5000 (5 sec default), 10000 (slow disk), 2000 (SSD)
```

### Security Settings - EXPLAINED

```yaml
security:
  strict_validation: true
  # WHAT IT MEANS: Extra security checks on all inputs (file paths, URLs, YAML)
  # WHY IT MATTERS: Prevents malicious elements from accessing your system
  # WHEN TO DISABLE: Testing, debugging, or if you trust all your elements
  # PERFORMANCE IMPACT: Minimal (< 1% slower)
  
  auto_update_check: true
  # WHAT IT MEANS: Check for security updates on startup
  # WHY IT MATTERS: Notifies you of critical security patches
  # WHEN TO DISABLE: Air-gapped systems, corporate firewalls
  # FREQUENCY: Once per day maximum
```

---

## 4. Auto-Activate Clarification

**CONFUSION**: Two different concepts both called "auto-activate"

### Concept A: Startup Auto-Activation (What I meant)
```yaml
elements:
  auto_activate:
    personas: ["Creative-Writer", "Code-Reviewer"]
    skills: ["debug-helper"]
    # WHAT IT MEANS: These elements load automatically when server starts
    # WHY USEFUL: Don't need to manually activate frequently-used elements
```

### Concept B: Verb Trigger Auto-Discovery (What you meant)
```yaml
discovery:
  automatic_activation: true
  # WHAT IT MEANS: When you say "debug this", automatically activates Debug persona
  # HOW IT WORKS: Verb triggers detect intent and load relevant elements
  # THIS IS THE ENHANCED INDEX FEATURE
```

**RECOMMENDATION**: Rename to avoid confusion:
- `startup_elements` - Elements to load on server start
- `auto_discovery` - Automatic verb-based element activation

---

## 5. Token Usage Profiles

**EXCELLENT IDEA** - Preset configurations for different use cases:

```yaml
profiles:
  active: balanced  # Which profile is currently active
  
  presets:
    minimal:
      description: "Lowest token usage, fastest responses"
      settings:
        discovery.auto_discovery: false  # Manual activation only
        discovery.resources.advertise: false  # No MCP resources
        cache.max_size_mb: 25
        startup_elements.personas: []  # Don't auto-load anything
        
    balanced:
      description: "Good performance with moderate token usage"
      settings:
        discovery.auto_discovery: true
        discovery.resources.variants.summary: true  # ~1K tokens
        discovery.resources.variants.full: false
        cache.max_size_mb: 50
        startup_elements.personas: []  # Auto-discover instead
        
    power:
      description: "Maximum capability, highest token usage"
      settings:
        discovery.auto_discovery: true
        discovery.resources.variants.summary: true
        discovery.resources.variants.full: true  # ~48K tokens
        cache.max_size_mb: 100
        startup_elements.personas: ["all-favorites"]  # Load common ones
```

---

## 6. Platform Detection - Broader Thinking

**Current thinking is too narrow** - Need to support:

### Platform Categories

```yaml
platform:
  detection:
    auto_detect: true
    detected: "claude-code"
    category: "desktop-ide"  # NEW: Broader categorization
    
  categories:
    terminal-cli:
      # Plain terminal: no artifacts, no file system UI
      capabilities:
        artifacts: false
        file_picker: false
        progress_bars: false
        os_commands: true
        
    desktop-ide:
      # Claude Code, Cursor, etc: Full IDE integration
      capabilities:
        artifacts: true
        file_picker: true
        file_system_access: true
        os_commands: true
        window_management: true
        terminal_access: true
        
    chat-interface:
      # Claude Desktop, web chat: Artifact support, limited system access
      capabilities:
        artifacts: true
        file_picker: limited  # Via MCP servers
        file_system_access: false  # Sandboxed
        os_commands: false
        
    voice-interface:
      # Voice assistants: Audio in/out, no visual
      capabilities:
        artifacts: false
        audio_output: true
        audio_input: true
        tts_available: true
        visual_output: false
        
    multimodal:
      # Image/video LLMs: Visual processing
      capabilities:
        artifacts: true
        image_generation: true
        image_analysis: true
        video_analysis: true
        
  capability_requirements:
    # Elements can specify what they need
    audio-summarizer:
      required: [os_commands, tts_available]
      platform_category: [terminal-cli, desktop-ide]
      os: [darwin, linux]  # macOS/Linux only (uses 'say' command)
      
    documentation-writer:
      required: [file_system_access]
      fallback: artifacts  # If no FS access, use artifacts
      
    voice-assistant:
      required: [audio_output, tts_available]
      platform_category: [voice-interface]
```

**USE CASES**:
1. Audio summarizer skill checks: "Do I have os_commands + TTS? If no, disable gracefully"
2. Doc writer checks: "Do I have file_system_access? If no, create artifact instead"
3. Voice skill checks: "Am I in voice-interface category? If no, don't activate"

---

## 7. Collections vs Marketplaces

**User Preference**: Collection-first terminology

**RATIONALE**: 
- "Marketplace" implies commercial transactions
- "Collection" emphasizes community sharing
- Open source friendly messaging

**RECOMMENDATION**: `collections` with optional "marketplace" context

```yaml
collections:
  # Primary terminology: collections
  # Note: Some communities use "marketplace" - both terms refer to the same concept
  
  sources:
    - id: dollhousemcp-official
      name: "DollhouseMCP Collection"
      description: "Official community-maintained collection of elements"
      url: "https://github.com/DollhouseMCP/collection"
      type: github
      enabled: true
      default: true
      trust_level: official
```

---

## 8. Advanced vs Basic Settings

**EXCELLENT IDEA** - Segment by user expertise:

### Basic Settings (Shown by default)
```yaml
# User sees these in main config UI
- user (identity)
- portfolios (storage locations)
- github.portfolio (where to sync)
- collections (where to browse)
- display (UI preferences)
- profiles (token usage preset)
```

### Advanced Settings (Collapsed/hidden by default)
```yaml
# Power users expand to see these
- discovery.limits (trigger limits)
- discovery.verb_patterns (custom patterns)
- performance.cache (memory/speed tuning)
- performance.timeouts (network tuning)
- security.strict_validation (security controls)
- logging (debug options)
```

**UI Treatment**:
- Basic: Always visible, clear descriptions
- Advanced: Collapsed section with "Show Advanced Settings" toggle
- Expert: Raw YAML editing mode

---

## NEXT STEPS

1. Create new GitHub issue with this research
2. Define clear names for all settings
3. Reorganize config schema with Basic/Advanced sections
4. Add platform capability detection
5. Implement token usage profiles
6. Update dollhouse-config-ui skill


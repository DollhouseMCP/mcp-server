# Configuration Overhaul - Before/After Comparison

## Complete Schema Comparison

### Privacy & Tracking

#### BEFORE (v1):
```yaml
telemetry:
  operational_telemetry: true
  # Confusing name, unclear what it tracks
  # No explanation of data collected
  # Users don't know if it's privacy-invasive

enhanced_index:
  telemetry: true
  # Two different "telemetry" settings
  # No explanation this is local-only
```

#### AFTER (v2):
```yaml
privacy:
  install_tracking: true
  # WHAT: One-time anonymous install metrics (version, OS, platform)
  # WHY: Helps us know which platforms/versions to support
  # DATA COLLECTED: Install UUID, version, OS, Node version, MCP client, timestamp
  # DATA NOT COLLECTED: Usage frequency, which tools used, element content
  # SENT TO: DollhouseMCP telemetry server
  # FREQUENCY: Once on first install, updates on version change

  trigger_analytics: false
  # WHAT: Local-only performance tracking for auto-discovery system
  # WHY: Helps improve verb pattern matching and trigger detection
  # DATA: Verb extraction success rate, trigger matching speed, pattern effectiveness
  # STORAGE: Local only (never sent anywhere), debug logs only
  # WHEN TO ENABLE: If you want to help improve auto-discovery accuracy
```

**Impact:**
- ✅ Clear names explain what they do
- ✅ Complete transparency on data collection
- ✅ Users can make informed privacy decisions
- ✅ No more confusion about "two telemetry settings"

---

### Portfolio Management

#### BEFORE (v1):
```yaml
elements:
  default_element_dir: /Users/mick/.dollhouse/portfolio
  # Hidden in elements section
  # Only supports single portfolio
  # No context separation
```

#### AFTER (v2):
```yaml
portfolios:
  active: default
  # Which portfolio is currently active

  directories:
    - alias: default
      path: ~/.dollhouse/portfolio
      description: "Main portfolio for personal elements"
      auto_backup: true
      backup_path: ~/.dollhouse/backups/default

    - alias: work
      path: ~/work/.dollhouse-work
      description: "Work-related elements only"
      auto_backup: true
      backup_path: ~/work/.dollhouse-work/backups
      encrypted: false  # Future: encryption support

    - alias: personal
      path: ~/personal/.dollhouse-personal
      description: "Personal experiments and learning"
      auto_backup: true
      backup_path: ~/personal/.dollhouse-personal/backups
      encrypted: false

  # WHAT: Multiple portfolio directories with aliases
  # WHY: Separate work/personal contexts, switch easily
  # EXAMPLES:
  #   - Switch: dollhouse portfolio switch work
  #   - Add client portfolio for specific projects
  #   - Future: Encrypted portfolios for sensitive content
```

**Impact:**
- ✅ Top-level section (not buried in elements)
- ✅ Multiple portfolios with descriptive aliases
- ✅ Auto-backup per portfolio
- ✅ Future: encryption support
- ✅ Clear separation of work/personal contexts

---

### Collections (Marketplace)

#### BEFORE (v1):
```yaml
marketplace:
  enabled: true
  sources:
    - url: "https://github.com/DollhouseMCP/collection"
      enabled: true
  # "Marketplace" implies commerce
  # Feels like a store, not community
```

#### AFTER (v2):
```yaml
collections:
  # Note: Some communities call this a "marketplace" - both terms mean the same thing

  sources:
    - id: dollhousemcp-official
      name: "DollhouseMCP Collection"
      description: "Official community-maintained collection"
      url: "https://github.com/DollhouseMCP/collection"
      type: github
      enabled: true
      default: true
      trust_level: official

    - id: community-contrib
      name: "Community Contributions"
      description: "User-submitted elements (review before installing)"
      url: "https://github.com/DollhouseMCP/collection/community"
      type: github
      enabled: true
      trust_level: community

    - id: custom-collection
      name: "My Team's Collection"
      description: "Company-internal elements"
      url: "https://github.com/mycompany/dollhouse-elements"
      type: github
      enabled: false
      trust_level: custom

  # WHAT: Where to browse/install elements from
  # WHY: Access community elements, share with others
  # TRUST LEVELS:
  #   - official: DollhouseMCP core team verified
  #   - verified: Community verified, safe to use
  #   - community: User-submitted, review before installing
  #   - custom: Your own sources (team/company repos)
```

**Impact:**
- ✅ "Collections" = community sharing, not commerce
- ✅ Trust levels for security awareness
- ✅ Clear descriptions for each source
- ✅ Open-source friendly terminology

---

### Platform Detection

#### BEFORE (v1):
```yaml
platform:
  cli_mode: true
  # Binary: CLI or Desktop
  # No support for voice, multimodal, etc.
  # Elements can't check capabilities
```

#### AFTER (v2):
```yaml
platform:
  detection:
    auto_detect: true
    detected: "claude-code"
    category: "desktop-ide"
    # WHAT: Automatic detection of platform capabilities
    # WHY: Elements can check if required features are available

  categories:
    terminal-cli:
      # Plain terminal: no artifacts, no file system UI
      capabilities:
        artifacts: false
        file_picker: false
        progress_bars: false
        os_commands: true
        file_system_access: true
        window_management: false
        terminal_access: true
        audio_output: false
        tts_available: false
        image_generation: false

    desktop-ide:
      # Claude Code, Cursor, Windsurf: Full IDE integration
      capabilities:
        artifacts: true
        file_picker: true
        file_system_access: true
        os_commands: true
        window_management: true
        terminal_access: true
        audio_output: true
        tts_available: true
        image_generation: false

    chat-interface:
      # Claude Desktop, web chat: Artifacts, limited system access
      capabilities:
        artifacts: true
        file_picker: limited  # Via MCP servers
        file_system_access: false  # Sandboxed
        os_commands: false
        window_management: false
        terminal_access: false
        audio_output: true
        tts_available: false
        image_generation: true

    voice-interface:
      # Voice assistants: Audio in/out, no visual
      capabilities:
        artifacts: false
        file_picker: false
        file_system_access: false
        os_commands: false
        window_management: false
        terminal_access: false
        audio_output: true
        audio_input: true
        tts_available: true
        visual_output: false
        image_generation: false

    multimodal:
      # Image/video-capable LLMs
      capabilities:
        artifacts: true
        file_picker: true
        file_system_access: true
        os_commands: true
        window_management: true
        terminal_access: true
        audio_output: true
        tts_available: true
        image_generation: true
        image_analysis: true
        video_analysis: true

  # WHAT: Platform capability categories
  # WHY: Elements can check if they can run on current platform
  # EXAMPLES:
  #   - Audio summarizer checks: os_commands + tts_available
  #   - Doc writer checks: file_system_access (fallback to artifacts)
  #   - Voice skill checks: voice-interface category
```

**Impact:**
- ✅ Supports 5+ platform categories (not just CLI/Desktop)
- ✅ Elements can check capabilities before activation
- ✅ Graceful degradation (fallback modes)
- ✅ Future-proof for voice, multimodal, embedded systems

---

### Token Usage (NEW in v2)

#### BEFORE (v1):
```yaml
# No token usage awareness
# Users don't know they're using 48K tokens
# No easy way to reduce token usage
```

#### AFTER (v2):
```yaml
profiles:
  active: balanced
  # WHAT: Preset configurations for different use cases
  # WHY: Easy way to control token usage and performance
  # OPTIONS:
  #   - minimal: Lowest tokens, manual activation (~100 tokens)
  #   - balanced: Moderate tokens, auto-discovery (~1-2K tokens)
  #   - power: Maximum capability, highest tokens (~48K tokens)

  presets:
    minimal:
      description: "Lowest token usage, fastest responses, manual control"
      settings:
        discovery.auto_discovery: false
        discovery.resources.advertise: false
        discovery.resources.variants.summary: false
        discovery.resources.variants.full: false
        cache.max_size_mb: 25
        startup_elements.personas: []
      estimated_tokens_per_session: "~100 tokens"

    balanced:
      description: "Good performance with moderate token usage (recommended)"
      settings:
        discovery.auto_discovery: true
        discovery.resources.advertise: true
        discovery.resources.variants.summary: true
        discovery.resources.variants.full: false
        cache.max_size_mb: 50
        startup_elements.personas: []
      estimated_tokens_per_session: "~1-2K tokens"

    power:
      description: "Maximum capability, auto-activation, full context"
      settings:
        discovery.auto_discovery: true
        discovery.resources.advertise: true
        discovery.resources.variants.summary: true
        discovery.resources.variants.full: true
        cache.max_size_mb: 100
        startup_elements.personas: ["Creative-Writer", "Code-Reviewer"]
      estimated_tokens_per_session: "~48K tokens"
```

**Impact:**
- ✅ Users aware of token usage
- ✅ Easy presets for different needs
- ✅ Clear trade-offs explained
- ✅ Custom profiles possible

---

### Auto-Activation Clarification

#### BEFORE (v1):
```yaml
elements:
  auto_activate:
    personas: ["Creative-Writer"]
    skills: ["debug-helper"]
  # Confused with auto-discovery (verb triggers)
  # Two different concepts, same name
```

#### AFTER (v2):
```yaml
startup_elements:
  # WHAT: Elements to load automatically when server starts
  # WHY: Don't manually activate frequently-used elements
  personas: []
  skills: []
  templates: []
  agents: []
  memories: []
  # EXAMPLE: personas: ["Creative-Writer", "Code-Reviewer"]
  # NOTE: This is different from auto-discovery (verb triggers)

discovery:
  auto_discovery: true
  # WHAT: Automatic verb-based element activation
  # WHY: When you say "debug this", automatically activates Debug persona
  # HOW: Enhanced Index analyzes verbs and triggers relevant elements
```

**Impact:**
- ✅ Clear distinction: startup vs discovery
- ✅ No confusion between two concepts
- ✅ Separate settings for separate features

---

### Settings Organization

#### BEFORE (v1):
```yaml
# All settings shown to all users
# Beginners see cache TTL seconds
# Power users buried in basics
# No clear hierarchy
```

#### AFTER (v2):
```yaml
# ============================================================================
# BASIC SETTINGS (Always visible to users)
# ============================================================================

user: {...}
portfolios: {...}
github: {...}
collections: {...}
display: {...}
profiles: {...}
privacy: {...}

# ============================================================================
# ADVANCED SETTINGS (Collapsed by default, power users expand)
# ============================================================================

startup_elements: {...}
platform: {...}
discovery: {...}
performance: {...}
security: {...}
logging: {...}

# CLI commands:
# dollhouse config get              # Basic view
# dollhouse config get --advanced   # Advanced view
# dollhouse config get --expert     # Raw YAML
```

**Impact:**
- ✅ Beginners see simple settings only
- ✅ Power users expand for advanced tuning
- ✅ Clear hierarchy: basic → advanced → expert
- ✅ Progressive disclosure

---

### Documentation in Config

#### BEFORE (v1):
```yaml
performance:
  cache:
    max_size_mb: 50
    ttl_seconds: 3600
  timeouts:
    api_request_ms: 30000
    file_lock_ms: 5000
# No explanation of what these do
# No guidance on good values
# Users guess or leave defaults
```

#### AFTER (v2):
```yaml
performance:
  cache:
    max_size_mb: 50
    # WHAT: Maximum memory for caching element data
    # WHY: Larger = faster but more RAM used
    # GOOD VALUES: 25MB (limited RAM), 50MB (default), 100MB (power users)

    ttl_seconds: 3600
    # WHAT: How long cached data stays valid (Time To Live)
    # WHY: Shorter = more up-to-date, Longer = faster
    # GOOD VALUES: 1800 (30 min), 3600 (1 hour default), 7200 (2 hours)

  timeouts:
    api_request_ms: 30000
    # WHAT: How long to wait for GitHub API before giving up
    # WHY: Prevents hanging on slow connections
    # GOOD VALUES: 15000 (fast internet), 30000 (default), 60000 (slow/satellite)

    file_lock_ms: 5000
    # WHAT: How long to wait for exclusive file access
    # WHY: Prevents conflicts when multiple processes access files
    # GOOD VALUES: 2000 (SSD), 5000 (default), 10000 (slow HDD)
```

**Impact:**
- ✅ Every setting explains WHAT it does
- ✅ Every setting explains WHY it matters
- ✅ Every setting suggests GOOD VALUES
- ✅ Users make informed decisions

---

## Real-World Examples

### Example 1: Privacy-Conscious User

#### BEFORE (v1):
```bash
# User sees "operational_telemetry: true"
User: "What does operational telemetry mean?"
User: "Is it tracking my usage?"
User: "Is this safe to disable?"
# No clear answers, user guesses
```

#### AFTER (v2):
```bash
dollhouse config get privacy

# Output:
privacy:
  install_tracking: true
  # One-time anonymous install metrics
  # Tracks: Install UUID, version, OS, Node version, MCP client, timestamp
  # Does NOT track: Usage frequency, which tools used, element content
  # Helps us support your platform/version

  trigger_analytics: false
  # Local-only performance tracking (never sent anywhere)
  # Helps improve auto-discovery accuracy

# User: "Oh, install tracking is just version/OS, that's fine"
# User: "Trigger analytics is local-only, I'll enable to help improve it"
dollhouse config privacy.trigger_analytics true
```

---

### Example 2: Work/Personal Separation

#### BEFORE (v1):
```bash
# User has ONE portfolio
# Work elements mixed with personal
# Client asks: "Delete all personal elements"
# User manually searches through hundreds of elements
```

#### AFTER (v2):
```bash
# Setup work portfolio
dollhouse portfolio create work \
  --path ~/work/.dollhouse-work \
  --description "Work-only elements"

# Switch to work
dollhouse portfolio switch work

# Install only work-appropriate elements
dollhouse install library/personas/Corporate-Communications.md
dollhouse install library/skills/code-review.md

# Switch back to personal
dollhouse portfolio switch default

# Work elements completely isolated
dollhouse list personas
# Only shows personal personas

# Client asks to delete personal elements:
# Answer: "They're in a separate portfolio, no cleanup needed"
```

---

### Example 3: Token-Conscious User

#### BEFORE (v1):
```bash
# User doesn't know they're using 48K tokens per session
# API quota exhausted
User: "Why is my API usage so high?"
Support: "You have full resource advertisement enabled"
User: "How do I reduce tokens?"
Support: "Disable discovery.resources.variants.full and..."
# Complex multi-setting changes
```

#### AFTER (v2):
```bash
# User sets up initially
dollhouse config setup

Wizard: "Choose token usage profile:
  - minimal (~100 tokens): Manual activation, no auto-discovery
  - balanced (~1-2K tokens): Auto-discovery, summary resources (recommended)
  - power (~48K tokens): Full resources, maximum capability"

User: "balanced"

# Later, API quota running low
dollhouse profile set minimal

# Output:
✅ Profile set to 'minimal'
Estimated token usage: ~100 tokens per session
Auto-discovery: disabled (use 'dollhouse activate' to load elements)
Resource advertisement: disabled

# Single command, clear impact
```

---

### Example 4: Platform-Aware Element

#### BEFORE (v1):
```yaml
# audio-summarizer tries to use TTS
# No capability checking
# Fails on Claude Desktop with cryptic error
```

#### AFTER (v2):
```yaml
# Element metadata:
capabilities:
  required: [os_commands, tts_available]
  platform_category: [terminal-cli, desktop-ide]
  os: [darwin, linux]

# On Claude Code (desktop-ide, macOS):
dollhouse activate skill audio-summarizer
# ✅ Success - all requirements met

# On Claude Desktop (chat-interface):
dollhouse activate skill audio-summarizer
# ❌ Error: Audio Summarizer requires OS command access
#
# This skill needs:
#   - os_commands: Execute system commands (not available)
#   - tts_available: Text-to-speech (not available)
#
# Supported platforms:
#   - Claude Code (desktop-ide)
#   - Terminal CLI (terminal-cli)
#
# Your platform: chat-interface (Claude Desktop)
# Suggestion: Try this skill in Claude Code or terminal
```

---

## Migration Experience

### BEFORE (Manual Migration):
```bash
# User sees breaking changes
# No auto-migration
# User manually edits config.yaml
# High risk of errors
```

### AFTER (Auto-Migration):
```bash
# User upgrades to v2.0.0
# Server detects v1 config:

⚠️  DollhouseMCP detected v1 configuration
Automatically migrating to v2 schema...

Migrating settings:
  ✓ telemetry.operational_telemetry → privacy.install_tracking
  ✓ enhanced_index.telemetry → privacy.trigger_analytics
  ✓ marketplace → collections
  ✓ platform.cli_mode → platform.detection.category (auto-detected: desktop-ide)
  ✓ elements.default_element_dir → portfolios.directories[0].path

✅ Migration complete

Major changes:
  - Privacy settings now have clear explanations
  - Multi-portfolio support available
  - Token usage profiles available (currently: balanced)
  - Platform capabilities auto-detected

See full changelog: https://docs.dollhousemcp.com/changelog/v2.0.0

# All settings preserved, zero user action required
```

---

## Command Comparison

### Configuration

#### BEFORE (v1):
```bash
# Generic config commands
dollhouse config get
dollhouse config set telemetry.operational_telemetry false
```

#### AFTER (v2):
```bash
# Basic view (beginners)
dollhouse config get

# Advanced view (power users)
dollhouse config get --advanced

# Expert view (raw YAML)
dollhouse config get --expert

# Interactive setup
dollhouse config setup

# Get help on specific setting
dollhouse config help privacy.install_tracking
# Shows: WHAT, WHY, DATA COLLECTED, FREQUENCY, etc.

# Set with clarity
dollhouse config privacy.install_tracking false
```

---

### Portfolio Management (NEW)

#### BEFORE (v1):
```bash
# No portfolio commands
# Single portfolio only
```

#### AFTER (v2):
```bash
# List portfolios
dollhouse portfolio list

# Switch portfolios
dollhouse portfolio switch work

# Create portfolio
dollhouse portfolio create client-acme \
  --path ~/clients/acme/.dollhouse \
  --description "ACME Corp project"

# Portfolio status
dollhouse portfolio info

# Sync portfolio
dollhouse portfolio sync  # Current portfolio
dollhouse portfolio sync --all  # All portfolios
```

---

### Profile Management (NEW)

#### BEFORE (v1):
```bash
# No profile commands
# Manual multi-setting changes
```

#### AFTER (v2):
```bash
# Set profile
dollhouse profile set minimal
dollhouse profile set balanced
dollhouse profile set power

# View current profile
dollhouse profile info
# Shows: Active profile, token usage, settings applied

# Create custom profile
dollhouse profile create my-profile \
  --based-on balanced \
  --set discovery.auto_discovery=true \
  --set cache.max_size_mb=75

# List profiles
dollhouse profile list
```

---

### Platform Info (NEW)

#### BEFORE (v1):
```bash
# No platform commands
# Binary CLI mode check only
```

#### AFTER (v2):
```bash
# Detect platform
dollhouse platform info
# Shows: Category, capabilities, OS, detected client

# Check capabilities
dollhouse platform capabilities
# Lists all available capabilities

# Check element compatibility
dollhouse element check-compat audio-summarizer
# Shows: Required capabilities, compatibility status, suggestions
```

---

## Summary of Benefits

### Naming Changes
- ❌ **BEFORE:** "operational_telemetry" - confusing jargon
- ✅ **AFTER:** "install_tracking" - clear and specific

### Multi-Portfolio
- ❌ **BEFORE:** Single portfolio, work/personal mixed
- ✅ **AFTER:** Multiple portfolios with aliases, context separation

### Token Awareness
- ❌ **BEFORE:** Users unaware of 48K token usage
- ✅ **AFTER:** Clear presets, estimated usage, easy control

### Platform Support
- ❌ **BEFORE:** Binary CLI/Desktop, no capability checking
- ✅ **AFTER:** 5+ categories, capability detection, graceful degradation

### Terminology
- ❌ **BEFORE:** "Marketplace" implies commerce
- ✅ **AFTER:** "Collections" emphasizes community

### Documentation
- ❌ **BEFORE:** No setting explanations
- ✅ **AFTER:** WHAT/WHY/GOOD VALUES for everything

### User Experience
- ❌ **BEFORE:** All settings shown to all users
- ✅ **AFTER:** Basic/Advanced/Expert progressive disclosure

---

**Net Result:** Clearer, more powerful, easier to use, better for everyone.

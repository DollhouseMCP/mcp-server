# Feature: Configuration System Overhaul - Better Names, Multi-Portfolio, Platform Detection

## Overview

This proposal addresses extensive user feedback and research to fundamentally improve DollhouseMCP's configuration system. The overhaul focuses on **clarity over precision** in naming, supports real-world multi-context workflows, and enables intelligent platform-aware element activation.

**Core Principles:**
1. **Plain-English naming** - "install_tracking" instead of "operational_telemetry"
2. **Multi-portfolio support** - Work, personal, and project-specific portfolios with aliases
3. **Collection-first terminology** - Emphasize community sharing over commercial "marketplace" language
4. **Platform capability detection** - Elements know what capabilities they need (file access, TTS, artifacts, etc.)
5. **Token usage profiles** - Minimal/Balanced/Power presets for different use cases
6. **Basic vs Advanced segmentation** - Most users see simple settings, power users get full control
7. **Clear documentation** - Every setting explains WHAT it does, WHY it matters, GOOD VALUES

**Research Completed:** [See `/tmp/config-terminology-research.md` for full details]

---

## Current Problems

### 1. Confusing Terminology
```yaml
# BEFORE: Technical jargon that confuses users
telemetry:
  operational_telemetry: true  # What does "operational" mean?

enhanced_index:
  telemetry: true  # Why two different "telemetry" settings?
```

**Problem:** Users don't know what these track, whether it's privacy-invasive, or why they'd disable them.

### 2. Single Portfolio Limitation
```yaml
# BEFORE: Hidden in elements section, only supports one portfolio
elements:
  default_element_dir: /Users/mick/.dollhouse/portfolio
```

**Problem:** Users need separate portfolios for work/personal contexts, but current design assumes single location.

### 3. CLI/Desktop Binary Thinking
```yaml
# BEFORE: Too narrow
platform:
  cli_mode: true  # What about voice interfaces? Multimodal LLMs?
```

**Problem:** Future platforms (voice assistants, image-capable LLMs, embedded systems) don't fit this model.

### 4. No Token Usage Guidance
**Problem:** Users don't know that full resource advertisement uses 48K tokens vs 1K for summary mode. No easy way to say "I want minimal token usage."

### 5. Marketplace vs Collection Language
```yaml
# BEFORE: Commercial language for open source project
marketplace:
  enabled: true
```

**Problem:** "Marketplace" implies commerce, not community contribution.

### 6. Everything Looks Important
**Problem:** Power users see cache TTL seconds, beginners see complex performance tuning. No clear separation between "settings everyone needs" vs "advanced tuning."

---

## Proposed Solution

### New Configuration Schema (v2.0)

```yaml
# ============================================================================
# BASIC SETTINGS (Always visible to users)
# ============================================================================

# --- User Identity ---
user:
  username: "mick"
  email: "mick@example.com"
  display_name: "Mick"
  # WHAT: Your identity for GitHub sync and element attribution
  # WHY: Required for portfolio sync, optional for local-only usage

# --- Portfolio Management ---
portfolios:
  active: default
  # WHAT: Which portfolio is currently active
  # WHY: Switch between work/personal/project portfolios

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
  #   - "dollhouse config portfolios.active work" (switch to work portfolio)
  #   - Add project-specific portfolios for client work
  #   - Future: Encrypted portfolios for sensitive content

# --- GitHub Integration ---
github:
  portfolio:
    enabled: true
    repository: "dollhouse-portfolio"
    visibility: public
    auto_sync: false
    sync_direction: push
    # WHAT: Your GitHub backup/sharing repository
    # WHY: Backup elements, share with community, sync across machines

# --- Collections (Community Element Sources) ---
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

# --- Display & UI ---
display:
  theme: auto  # auto, light, dark
  compact_lists: false
  show_examples: true
  expert_mode: false  # Show advanced settings by default
  # WHAT: How information is displayed
  # WHY: Personal preference for readability

# --- Token Usage Profiles ---
profiles:
  active: balanced
  # WHAT: Preset configurations for different use cases
  # WHY: Easy way to control token usage and performance
  # OPTIONS:
  #   - minimal: Lowest tokens, manual activation (good for API quotas)
  #   - balanced: Moderate tokens, auto-discovery (recommended)
  #   - power: Maximum capability, highest tokens (best for IDE use)

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

# --- Privacy & Tracking ---
privacy:
  install_tracking: true
  # WHAT: One-time anonymous install metrics (version, OS, platform)
  # WHY: Helps us know which platforms/versions to support
  # DATA COLLECTED: Install UUID, version, OS, Node version, MCP client, timestamp
  # DATA NOT COLLECTED: Usage frequency, which tools used, element content
  # SENT TO: DollhouseMCP telemetry server (https://telemetry.dollhousemcp.com)
  # FREQUENCY: Once on first install, updates on version change

  trigger_analytics: false
  # WHAT: Local-only performance tracking for auto-discovery system
  # WHY: Helps improve verb pattern matching and trigger detection
  # DATA: Verb extraction success rate, trigger matching speed, pattern effectiveness
  # STORAGE: Local only (never sent anywhere), debug logs only
  # WHEN TO ENABLE: If you want to help improve auto-discovery accuracy

# ============================================================================
# ADVANCED SETTINGS (Collapsed by default, power users expand)
# ============================================================================

# --- Element Auto-Loading ---
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

# --- Platform Detection ---
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
        audio_output: true  # Desktop has speakers
        tts_available: true  # Can use OS TTS
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
        image_generation: true  # Some support image gen

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

# --- Discovery System ---
discovery:
  auto_discovery: true
  # WHAT: Automatic verb-based element activation
  # WHY: When you say "debug this", auto-activates Debug persona
  # HOW: Enhanced Index analyzes verbs and triggers relevant elements

  resources:
    advertise: true
    # WHAT: Expose element library to MCP clients
    # WHY: Clients can see available personas/skills

    variants:
      summary: true
      # WHAT: Brief element descriptions (~1K tokens)
      # WHY: Good for auto-discovery without token bloat

      full: false
      # WHAT: Complete element content (~48K tokens)
      # WHY: Maximum context but high token usage

  limits:
    max_triggers_per_element: 10
    max_verb_patterns: 100
    max_simultaneous_activations: 5
    # WHAT: Safeguards to prevent runaway activation
    # WHY: Prevent accidentally activating 50 personas at once

  verb_patterns:
    custom: []
    # WHAT: Add your own verb trigger patterns
    # WHY: Customize auto-discovery for your workflow
    # EXAMPLE: ["analyze-.*-for-security", "refactor-using-.*"]

# --- Performance Tuning ---
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

# --- Security Controls ---
security:
  strict_validation: true
  # WHAT: Extra security checks on all inputs (file paths, URLs, YAML)
  # WHY: Prevents malicious elements from accessing your system
  # WHEN TO DISABLE: Testing, debugging, or if you trust all elements
  # PERFORMANCE IMPACT: Minimal (< 1% slower)

  auto_update_check: true
  # WHAT: Check for security updates on startup
  # WHY: Notifies you of critical security patches
  # WHEN TO DISABLE: Air-gapped systems, corporate firewalls
  # FREQUENCY: Once per day maximum

  allowed_paths:
    - ~/
    - /tmp/
    # WHAT: Directories elements can access
    # WHY: Sandboxing to prevent malicious file access
    # DEFAULT: User home + temp, expandable as needed

# --- Logging & Debugging ---
logging:
  level: info
  # WHAT: How much detail to log
  # WHY: Balance between debugging info and noise
  # OPTIONS: error, warn, info, debug, trace

  outputs:
    - type: console
      enabled: true
    - type: file
      enabled: true
      path: ~/.dollhouse/logs/dollhousemcp.log
      max_size_mb: 10
      max_files: 5

  categories:
    discovery: info
    cache: warn
    github: info
    elements: info
    # WHAT: Per-category log levels
    # WHY: Debug specific subsystems without flooding logs
```

---

## Implementation Plan

### Phase 1: Schema Migration (v2.0.0)
**Timeline:** 1-2 weeks

1. **Create migration system**
   - Detect v1 config, auto-migrate to v2
   - Preserve user settings during migration
   - Clear migration messages explaining changes

2. **Rename confusing settings**
   ```yaml
   # Migration mapping:
   telemetry.operational_telemetry → privacy.install_tracking
   enhanced_index.telemetry → privacy.trigger_analytics
   platform.cli_mode → platform.detection.category (auto-detect)
   marketplace → collections
   elements.default_element_dir → portfolios.directories[0].path
   ```

3. **Add new basic settings**
   - `profiles` with minimal/balanced/power presets
   - `portfolios` with multi-directory support
   - `display` for UI preferences

4. **Testing**
   - Unit tests for migration logic
   - Integration tests for config loading
   - User acceptance testing with real configs

### Phase 2: Multi-Portfolio Support (v2.1.0)
**Timeline:** 2-3 weeks

1. **Portfolio switching**
   ```bash
   # CLI commands
   dollhouse config portfolios.active work
   dollhouse portfolio switch personal
   dollhouse portfolio list
   ```

2. **Portfolio management**
   - Create new portfolio with alias
   - Auto-backup on write operations
   - Conflict detection when switching

3. **GitHub sync per portfolio**
   - Each portfolio can sync to different repo
   - Or same repo with different branches
   - Configurable sync direction per portfolio

4. **Testing**
   - Multi-portfolio switching
   - Backup/restore functionality
   - Sync integrity across portfolios

### Phase 3: Platform Detection (v2.2.0)
**Timeline:** 2-3 weeks

1. **Auto-detection system**
   ```typescript
   // Detect platform capabilities
   const platform = await detectPlatform();
   // Returns: { category: 'desktop-ide', capabilities: [...] }
   ```

2. **Element capability requirements**
   ```yaml
   # In element metadata
   capabilities:
     required: [file_system_access, os_commands]
     fallback: artifacts
     platform_category: [terminal-cli, desktop-ide]
     os: [darwin, linux]  # macOS/Linux only
   ```

3. **Graceful degradation**
   - Elements check capabilities before activation
   - Fallback modes (e.g., artifact instead of file)
   - Clear error messages when incompatible

4. **Testing**
   - Mock different platform categories
   - Verify capability detection accuracy
   - Test fallback modes

### Phase 4: Token Usage Profiles (v2.3.0)
**Timeline:** 1 week

1. **Preset implementation**
   - Apply profile settings on startup
   - CLI command: `dollhouse profile set power`
   - Estimated token usage display

2. **Profile customization**
   - Create custom profiles based on presets
   - Save/load custom profiles
   - Share profiles with team

3. **Token usage tracking** (optional)
   - Display estimated tokens per session
   - Warn when switching to high-token profile
   - Suggest profile based on usage patterns

4. **Testing**
   - Verify profile switching applies all settings
   - Token estimation accuracy
   - Profile save/load integrity

### Phase 5: UI Segmentation (v2.4.0)
**Timeline:** 1-2 weeks

1. **Basic/Advanced separation**
   ```bash
   # Basic view (default)
   dollhouse config get
   # Shows: user, portfolios, github, collections, display, profiles, privacy

   # Advanced view
   dollhouse config get --advanced
   # Shows: All settings including performance, discovery, security, logging

   # Expert view (raw YAML)
   dollhouse config get --expert
   # Shows: Full YAML for direct editing
   ```

2. **Interactive configuration wizard**
   ```bash
   dollhouse config setup
   # Guided setup for basic settings
   # Detects platform, suggests profile, sets up GitHub
   ```

3. **Setting descriptions in help**
   ```bash
   dollhouse config help privacy.install_tracking
   # Shows: WHAT, WHY, DATA COLLECTED, FREQUENCY
   ```

4. **Testing**
   - UI displays correct settings per mode
   - Help text accuracy
   - Wizard completion flows

---

## Examples

### Example 1: Work/Personal Portfolio Separation

```bash
# Setup work portfolio
dollhouse config portfolios.directories[1].alias work
dollhouse config portfolios.directories[1].path ~/work/.dollhouse-work
dollhouse config portfolios.directories[1].description "Work projects only"

# Switch to work portfolio
dollhouse portfolio switch work

# Install work-specific elements
dollhouse install library/personas/Corporate-Communications.md

# Switch back to personal
dollhouse portfolio switch default

# Work elements not visible in personal portfolio
dollhouse list personas
# Only shows personal personas, not Corporate-Communications
```

### Example 2: Platform-Aware Audio Summarizer

```yaml
# Element: audio-summarizer.yaml
name: Audio-Summarizer
description: Reads text aloud using OS text-to-speech
version: 1.0.0

capabilities:
  required: [os_commands, tts_available]
  platform_category: [terminal-cli, desktop-ide]
  os: [darwin, linux]  # macOS and Linux only (uses 'say' or 'espeak')

metadata:
  activation_check: |
    const platform = await getPlatformCapabilities();
    if (!platform.capabilities.os_commands) {
      throw new Error("Audio Summarizer requires OS command access");
    }
    if (!platform.capabilities.tts_available) {
      throw new Error("No text-to-speech available on this platform");
    }
    if (platform.os === 'win32') {
      throw new Error("Audio Summarizer requires macOS or Linux");
    }
```

```bash
# On Claude Code (desktop-ide, macOS)
dollhouse activate skill audio-summarizer
# ✅ Success - all requirements met

# On Claude Desktop (chat-interface)
dollhouse activate skill audio-summarizer
# ❌ Error: Audio Summarizer requires OS command access
# Suggestion: This skill works best in Claude Code or terminal-cli platforms
```

### Example 3: Token Usage Profile Switching

```bash
# User with API quota limits
dollhouse profile set minimal
# ✅ Set profile to 'minimal'
# Estimated token usage: ~100 tokens per session
# Changes applied:
#   - Auto-discovery: disabled
#   - Resource advertisement: disabled
#   - Startup elements: none
# You'll need to manually activate elements with: dollhouse activate

# User wants full power
dollhouse profile set power
# ⚠️  Warning: 'power' profile uses ~48K tokens per session
# This includes:
#   - Full resource advertisement (~48K tokens)
#   - Auto-discovery enabled
#   - Auto-loaded personas: Creative-Writer, Code-Reviewer
# Continue? [y/N] y
# ✅ Profile set to 'power'

# Check current profile
dollhouse profile info
# Active: power
# Estimated tokens: ~48K per session
# Auto-discovery: enabled
# Resource variants: summary + full
# Startup elements: 2 personas
```

### Example 4: Privacy-Conscious User

```bash
# User wants to disable all tracking
dollhouse config privacy.install_tracking false
dollhouse config privacy.trigger_analytics false

# Verify no tracking
dollhouse config get privacy
# privacy:
#   install_tracking: false  # No install metrics sent
#   trigger_analytics: false # No local performance tracking

# User wants to help improve auto-discovery
dollhouse config privacy.trigger_analytics true
# ✅ Trigger analytics enabled
# Note: This data stays on your computer and is never sent anywhere.
# It helps improve verb pattern matching and trigger detection.
```

---

## Benefits

### For Users

1. **Clarity over confusion**
   - "Install tracking" is immediately understandable
   - "Operational telemetry" required research to understand

2. **Real-world workflows**
   - Separate work/personal portfolios match actual usage
   - No more mixing company elements with personal experiments

3. **Token awareness**
   - Users know if they're using 100 tokens or 48K tokens
   - Easy presets for different use cases

4. **Platform compatibility**
   - Elements gracefully handle platform limitations
   - Clear error messages when incompatible

5. **Community-first language**
   - "Collections" emphasizes sharing, not selling
   - Open source friendly messaging

6. **Progressive disclosure**
   - Beginners see simple settings
   - Power users get full control
   - Experts can edit raw YAML

### For Developers

1. **Platform capability checking**
   ```typescript
   // Check before using OS commands
   if (!platform.capabilities.os_commands) {
     return fallbackMode();
   }
   ```

2. **Clear configuration contract**
   - Every setting has WHAT/WHY/GOOD VALUES
   - No guessing what settings do

3. **Easier support**
   - Users can articulate their setup
   - "I'm on minimal profile" vs explaining individual settings

4. **Future-proof**
   - New platforms (voice, multimodal) already categorized
   - Capability system extensible

### For the Project

1. **Better telemetry clarity**
   - Users understand what's tracked (install metrics only)
   - Increased opt-in rate due to transparency

2. **Reduced support burden**
   - Clearer settings = fewer "what does this do?" questions
   - Profiles eliminate "how do I reduce tokens?" questions

3. **Professional polish**
   - Documentation for every setting
   - Thoughtful UX for different user levels

4. **Competitive advantage**
   - Multi-portfolio support unique among MCP servers
   - Platform detection enables broader ecosystem

---

## Testing Requirements

### Unit Tests

1. **Configuration migration**
   ```typescript
   test('migrates v1 config to v2', () => {
     const v1Config = loadFixture('v1-config.yaml');
     const v2Config = migrateConfig(v1Config);
     expect(v2Config.privacy.install_tracking).toBe(v1Config.telemetry.operational_telemetry);
     expect(v2Config.collections.sources[0]).toBeDefined();
   });
   ```

2. **Portfolio switching**
   ```typescript
   test('switches portfolio and updates active elements', async () => {
     await portfolioManager.switch('work');
     expect(config.portfolios.active).toBe('work');
     expect(elementRegistry.getAll()).toMatchWorkPortfolio();
   });
   ```

3. **Platform detection**
   ```typescript
   test('detects desktop-ide capabilities', async () => {
     const platform = await detectPlatform();
     expect(platform.category).toBe('desktop-ide');
     expect(platform.capabilities.file_system_access).toBe(true);
   });
   ```

4. **Profile application**
   ```typescript
   test('applies minimal profile settings', () => {
     applyProfile('minimal');
     expect(config.discovery.auto_discovery).toBe(false);
     expect(config.discovery.resources.advertise).toBe(false);
   });
   ```

### Integration Tests

1. **Full configuration flow**
   - Load v1 config
   - Migrate to v2
   - Verify all settings preserved
   - Verify new defaults applied

2. **Multi-portfolio workflow**
   - Create two portfolios
   - Add elements to each
   - Switch between them
   - Verify isolation

3. **Platform capability enforcement**
   - Mock different platforms
   - Attempt to activate incompatible elements
   - Verify graceful failure + clear messages

4. **Profile switching**
   - Switch profiles
   - Verify all dependent settings change
   - Verify token usage estimates accurate

### User Acceptance Testing

1. **Migration UAT**
   - Real users migrate existing configs
   - Verify settings preserved
   - Collect feedback on migration messages

2. **Portfolio UAT**
   - Users create work/personal portfolios
   - Test real-world workflows
   - Verify no cross-contamination

3. **Documentation UAT**
   - Users read setting descriptions
   - Verify clarity and accuracy
   - Collect suggestions for improvement

---

## Success Criteria

### Must Have (v2.0.0 Release)

- [ ] All confusing settings renamed with clear names
- [ ] Plain-English descriptions for all settings (WHAT/WHY/GOOD VALUES)
- [ ] Migration system preserves v1 user settings
- [ ] Basic/Advanced settings segmentation
- [ ] "Collections" terminology throughout (no more "marketplace")
- [ ] Privacy section with clear tracking explanations
- [ ] Documentation updated to match new schema
- [ ] All tests pass (unit + integration)

### Should Have (v2.1.0 - v2.3.0)

- [ ] Multi-portfolio support with aliases
- [ ] Portfolio switching via CLI
- [ ] Platform capability detection system
- [ ] Token usage profiles (minimal/balanced/power)
- [ ] Interactive configuration wizard
- [ ] GitHub sync per portfolio

### Nice to Have (v2.4.0+)

- [ ] Portfolio encryption support
- [ ] Custom profile creation
- [ ] Token usage tracking and suggestions
- [ ] UI for configuration (Web UI or TUI)
- [ ] Profile sharing within teams
- [ ] Platform compatibility badges in collection

---

## Migration Path

### Breaking Changes

**v1 config will auto-migrate, but API changes are breaking:**

```yaml
# BREAKING: Renamed settings
telemetry.operational_telemetry → privacy.install_tracking
enhanced_index.telemetry → privacy.trigger_analytics
platform.cli_mode → platform.detection.category
marketplace → collections
elements.default_element_dir → portfolios.directories[0].path

# BREAKING: Restructured settings
elements.auto_activate → startup_elements
(Auto-discovery is now discovery.auto_discovery, separate from startup)

# BREAKING: New required fields
portfolios.active (required, defaults to 'default')
profiles.active (required, defaults to 'balanced')
```

### Deprecation Timeline

- **v2.0.0:** Warning logged when v1 config detected, auto-migrate
- **v2.1.0:** Warning logged, auto-migrate (last version supporting v1)
- **v2.2.0:** v1 config no longer supported, migration required

### User Communication

1. **v2.0.0 release notes:**
   - Clear changelog explaining all renames
   - Migration guide with examples
   - FAQ for common questions

2. **Startup warning:**
   ```
   ⚠️  DollhouseMCP detected v1 configuration
   Automatically migrating to v2 schema...
   ✅ Migration complete

   Major changes:
   - "operational_telemetry" is now "install_tracking"
   - "marketplace" is now "collections"
   - See full changelog: https://docs.dollhousemcp.com/changelog/v2.0.0
   ```

3. **Documentation updates:**
   - Configuration reference updated
   - Migration guide published
   - Video walkthrough for major changes

---

## Related Issues

- #XXX - Users confused by "operational_telemetry"
- #XXX - Request for work/personal portfolio separation
- #XXX - Token usage too high (no easy way to reduce)
- #XXX - Elements don't check platform capabilities before activation
- #XXX - "Marketplace" terminology feels too commercial

---

## Additional Context

### Research Documents
- `/tmp/config-terminology-research.md` - Full terminology research and analysis

### Industry Benchmarks
- **VS Code:** Uses "telemetry" with clear descriptions of what's tracked
- **npm:** Uses "install statistics" for package download counts
- **Homebrew:** Uses "analytics" with opt-in/opt-out clarity
- **JetBrains:** Uses "usage statistics" with granular control
- **PostHog:** Uses "product analytics" with event-level descriptions

### User Quotes
> "I have no idea what 'operational telemetry' means. Is that my usage? System health? Install count?"

> "I need separate portfolios for work and personal. I can't mix my company's custom elements with my personal experiments."

> "Why does the server use so many tokens? Can I reduce that?"

> "I tried to use the audio skill but it doesn't work in Claude Desktop. How do I know which elements work where?"

> "Why is it called a 'marketplace'? This is open source, not a store."

---

## Implementation Checklist

- [ ] Create v2 schema TypeScript types
- [ ] Implement migration system (v1 → v2)
- [ ] Update configuration validator
- [ ] Add portfolio manager module
- [ ] Implement platform detection system
- [ ] Create profile preset definitions
- [ ] Add setting descriptions to help system
- [ ] Update CLI commands for new schema
- [ ] Migrate all existing tests
- [ ] Write new tests for v2 features
- [ ] Update documentation (README, docs site)
- [ ] Create migration guide
- [ ] Update MCP tool descriptions
- [ ] Test on all platforms (macOS, Linux, Windows)
- [ ] Beta testing with real users
- [ ] Create release notes and changelog
- [ ] Publish v2.0.0

---

**Estimated Total Effort:** 8-12 weeks (for full implementation through v2.4.0)

**Priority:** HIGH - Addresses fundamental UX issues and enables future features

**Labels:** enhancement, breaking-change, configuration, UX, documentation

---

**Ready for implementation pending approval.**

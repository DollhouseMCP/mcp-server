# Configuration Overhaul - Quick Reference

## At a Glance: What's Changing

### Naming Changes (Clarity Over Precision)

| Old Name (v1) | New Name (v2) | Why Changed |
|---------------|---------------|-------------|
| `telemetry.operational_telemetry` | `privacy.install_tracking` | "Install tracking" is clear, "operational telemetry" is jargon |
| `enhanced_index.telemetry` | `privacy.trigger_analytics` | Describes what it does (tracks trigger performance) |
| `marketplace` | `collections` | Open-source friendly, emphasizes community over commerce |
| `platform.cli_mode` | `platform.detection.category` | Supports more than just CLI/Desktop (voice, multimodal, etc.) |
| `elements.auto_activate` | `startup_elements` | Clearer distinction from auto-discovery (verb triggers) |
| `elements.default_element_dir` | `portfolios.directories[0].path` | Part of multi-portfolio system |

---

## New Features

### 1. Multiple Portfolio Support

**BEFORE:**
```yaml
elements:
  default_element_dir: ~/.dollhouse/portfolio
```

**AFTER:**
```yaml
portfolios:
  active: default
  directories:
    - alias: default
      path: ~/.dollhouse/portfolio
      description: "Personal elements"

    - alias: work
      path: ~/work/.dollhouse-work
      description: "Work-only elements"

    - alias: personal
      path: ~/personal/.dollhouse-personal
      description: "Personal experiments"
```

**Use Cases:**
- Separate work/personal contexts
- Client-specific portfolios
- Encrypted portfolios (future)

---

### 2. Token Usage Profiles

**NEW:**
```yaml
profiles:
  active: balanced

  presets:
    minimal:
      description: "~100 tokens per session"
      # Auto-discovery OFF, manual activation only

    balanced:
      description: "~1-2K tokens per session"
      # Auto-discovery ON, summary resources only

    power:
      description: "~48K tokens per session"
      # Full resources, auto-activation, maximum capability
```

**Quick Commands:**
```bash
dollhouse profile set minimal  # Reduce token usage
dollhouse profile set power    # Maximum capability
dollhouse profile info         # See current profile
```

---

### 3. Platform Capability Detection

**NEW:**
```yaml
platform:
  categories:
    terminal-cli:
      capabilities: [os_commands, file_system_access, terminal_access]

    desktop-ide:
      capabilities: [artifacts, file_picker, file_system_access,
                    os_commands, window_management, tts_available]

    chat-interface:
      capabilities: [artifacts, file_picker(limited), image_generation]

    voice-interface:
      capabilities: [audio_output, audio_input, tts_available]

    multimodal:
      capabilities: [artifacts, image_generation, image_analysis,
                    video_analysis, tts_available]
```

**Elements Can Require Capabilities:**
```yaml
# audio-summarizer.yaml
capabilities:
  required: [os_commands, tts_available]
  platform_category: [terminal-cli, desktop-ide]
  os: [darwin, linux]  # macOS/Linux only
```

---

### 4. Basic vs Advanced Settings

**Basic Settings** (always visible):
- User identity
- Portfolio locations
- GitHub sync
- Collections (sources)
- Display preferences
- Token usage profile
- Privacy settings

**Advanced Settings** (collapsed by default):
- Platform detection details
- Discovery system tuning
- Performance tuning (cache, timeouts)
- Security controls
- Logging configuration
- Custom verb patterns

**CLI:**
```bash
dollhouse config get              # Basic view
dollhouse config get --advanced   # Advanced view
dollhouse config get --expert     # Raw YAML
```

---

### 5. Collections (Not Marketplace)

**BEFORE:**
```yaml
marketplace:
  enabled: true
  sources: [...]
```

**AFTER:**
```yaml
collections:
  # Note: Some communities call this "marketplace" - same concept

  sources:
    - id: dollhousemcp-official
      name: "DollhouseMCP Collection"
      trust_level: official

    - id: community-contrib
      name: "Community Contributions"
      trust_level: community

    - id: custom-collection
      name: "My Team's Collection"
      trust_level: custom
```

**Trust Levels:**
- `official` - DollhouseMCP core team verified
- `verified` - Community verified, safe to use
- `community` - User-submitted, review before installing
- `custom` - Your own sources (team/company repos)

---

## Setting Documentation Format

**Every setting now has:**

```yaml
setting_name: value
# WHAT: What this setting does
# WHY: Why it matters / when you'd change it
# GOOD VALUES: Recommended settings for different use cases
# EXAMPLES: Real-world usage examples
```

**Example:**

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
```

---

## Privacy Settings Explained

### Install Tracking

```yaml
privacy:
  install_tracking: true
  # WHAT: One-time anonymous install metrics
  # DATA COLLECTED:
  #   - Install UUID (random, persistent)
  #   - DollhouseMCP version
  #   - Operating system (darwin/win32/linux)
  #   - Node.js version
  #   - MCP client type (Claude Desktop/Code/etc)
  #   - Installation timestamp
  #
  # DATA NOT COLLECTED:
  #   - Usage frequency
  #   - Which tools are used
  #   - Element content
  #   - User identity
  #
  # SENT TO: DollhouseMCP telemetry server
  # FREQUENCY: Once on install, updates on version change
  # WHY: Helps us know which platforms/versions to support
```

### Trigger Analytics

```yaml
privacy:
  trigger_analytics: false
  # WHAT: Local-only performance tracking for auto-discovery
  # DATA:
  #   - Verb extraction success rate
  #   - Trigger matching speed
  #   - Pattern effectiveness
  #
  # STORAGE: Local only (never sent anywhere)
  # OUTPUT: Debug logs only
  # WHY: Helps improve verb pattern matching
  # WHEN TO ENABLE: If you want to help improve auto-discovery
```

---

## Migration Impact

### Auto-Migration

When you upgrade to v2.0.0, your config will automatically migrate:

```bash
⚠️  DollhouseMCP detected v1 configuration
Automatically migrating to v2 schema...
✅ Migration complete

Major changes:
- "operational_telemetry" → "install_tracking"
- "marketplace" → "collections"
- "elements.default_element_dir" → "portfolios.directories[0]"

See full changelog: https://docs.dollhousemcp.com/changelog/v2.0.0
```

### What's Preserved

✅ All your settings values
✅ Element locations and paths
✅ GitHub configuration
✅ Privacy preferences

### What Changes

⚠️ Setting names (but values preserved)
⚠️ Config file structure (but auto-migrated)
⚠️ Some API method names (breaking change)

---

## Quick Commands

### Portfolio Management

```bash
# Switch portfolios
dollhouse portfolio switch work
dollhouse portfolio switch personal

# List portfolios
dollhouse portfolio list

# Create new portfolio
dollhouse portfolio create client-acme \
  --path ~/clients/acme/.dollhouse \
  --description "ACME Corp project"

# Active portfolio
dollhouse config portfolios.active
```

### Profile Management

```bash
# Set profile
dollhouse profile set minimal
dollhouse profile set balanced
dollhouse profile set power

# View current profile
dollhouse profile info

# Create custom profile
dollhouse profile create my-profile \
  --based-on balanced \
  --set discovery.auto_discovery=true \
  --set cache.max_size_mb=75
```

### Platform Info

```bash
# Check detected platform
dollhouse platform info

# Check capabilities
dollhouse platform capabilities

# Check if element compatible
dollhouse element check-compat audio-summarizer
```

### Configuration

```bash
# View basic settings
dollhouse config get

# View advanced settings
dollhouse config get --advanced

# View raw YAML
dollhouse config get --expert

# Interactive setup
dollhouse config setup

# Get help on specific setting
dollhouse config help privacy.install_tracking
```

---

## Breaking Changes

**API Changes (v2.0.0):**

```typescript
// BEFORE (v1):
config.telemetry.operational_telemetry
config.marketplace.sources
config.platform.cli_mode

// AFTER (v2):
config.privacy.install_tracking
config.collections.sources
config.platform.detection.category
```

**File Structure Changes:**

```yaml
# BEFORE (v1):
~/.dollhouse/config.yaml (all settings)

# AFTER (v2):
~/.dollhouse/config.yaml (user settings)
~/.dollhouse/portfolios/default/ (default portfolio)
~/.dollhouse/portfolios/work/ (work portfolio)
~/.dollhouse/profiles/custom.yaml (custom profiles)
```

---

## Benefits Summary

### For Users

1. **Clearer settings** - "install_tracking" vs "operational_telemetry"
2. **Context separation** - Work/personal portfolios
3. **Token awareness** - Easy presets for different use cases
4. **Platform compatibility** - Elements work where they should
5. **Community language** - "Collections" not "marketplace"
6. **Progressive complexity** - Simple by default, powerful when needed

### For Developers

1. **Platform checking** - `if (!platform.capabilities.os_commands) { fallback() }`
2. **Clear docs** - WHAT/WHY/GOOD VALUES for all settings
3. **Easier support** - Users can articulate setup clearly
4. **Future-proof** - Voice/multimodal platforms already categorized

### For the Project

1. **Better transparency** - Users understand tracking clearly
2. **Reduced support** - Clearer settings = fewer questions
3. **Professional polish** - Documentation for everything
4. **Competitive edge** - Multi-portfolio unique among MCP servers

---

## Timeline

- **v2.0.0** (Weeks 1-2): Schema migration, renamed settings
- **v2.1.0** (Weeks 3-5): Multi-portfolio support
- **v2.2.0** (Weeks 6-8): Platform detection
- **v2.3.0** (Weeks 9-10): Token profiles
- **v2.4.0** (Weeks 11-12): UI segmentation, wizard

**Total: 8-12 weeks for full implementation**

---

## Success Metrics

- [ ] All confusing settings renamed
- [ ] Every setting has WHAT/WHY/GOOD VALUES docs
- [ ] Multi-portfolio workflow tested
- [ ] Platform detection works for all categories
- [ ] Token profiles reduce average usage by 30%+
- [ ] 90%+ users find Basic settings sufficient
- [ ] Migration preserves 100% of user settings
- [ ] Documentation rated "clear" by 80%+ users

---

**Status:** Ready for approval and implementation

**Priority:** HIGH - Fundamental UX improvements

**Labels:** enhancement, breaking-change, configuration, UX, documentation

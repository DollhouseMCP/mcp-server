# Configuration Overhaul - Quick Changes Table

## Setting Renames (v1 → v2)

| v1 Setting Path | v2 Setting Path | Reason for Change |
|----------------|-----------------|-------------------|
| `telemetry.operational_telemetry` | `privacy.install_tracking` | "Install tracking" is clear; "operational telemetry" is jargon |
| `enhanced_index.telemetry` | `privacy.trigger_analytics` | Describes purpose (trigger performance tracking) |
| `marketplace` | `collections` | Open-source friendly; emphasizes community over commerce |
| `platform.cli_mode` | `platform.detection.category` | Supports voice, multimodal, not just CLI/Desktop |
| `elements.auto_activate` | `startup_elements` | Clearer distinction from auto-discovery (verb triggers) |
| `elements.default_element_dir` | `portfolios.directories[0].path` | Now supports multiple portfolios |

---

## New Features (v2 Only)

| Feature | Config Section | Impact |
|---------|---------------|--------|
| **Multi-Portfolio Support** | `portfolios.directories[]` | Separate work/personal/project contexts |
| **Token Usage Profiles** | `profiles.presets{}` | Easy control: minimal (~100 tokens) vs power (~48K tokens) |
| **Platform Detection** | `platform.categories{}` | Elements check capabilities before activation |
| **Trust Levels** | `collections.sources[].trust_level` | Security awareness (official, verified, community, custom) |
| **Basic/Advanced Segmentation** | (UI/CLI behavior) | Beginners see simple settings, power users get full control |
| **Setting Documentation** | (inline comments) | Every setting has WHAT/WHY/GOOD VALUES |

---

## Privacy Settings - Data Transparency

| Setting | What It Tracks | Where Data Goes | Opt-Out Impact |
|---------|----------------|-----------------|----------------|
| `privacy.install_tracking` | Install UUID, version, OS, Node version, MCP client, timestamp | DollhouseMCP telemetry server | No impact; helps us support your platform |
| `privacy.trigger_analytics` | Verb extraction success rate, trigger speed, pattern effectiveness | **Local only** (never sent) | No impact; data stays on your computer |

**Key Difference from v1:**
- ✅ Clear names explain what's tracked
- ✅ Complete transparency on data collection
- ✅ Explicit "local only" for analytics
- ✅ Users can make informed decisions

---

## Portfolio Management

| Capability | v1 | v2 |
|------------|----|----|
| **Number of portfolios** | 1 (single) | Unlimited (multi) |
| **Portfolio aliases** | ❌ None | ✅ Named (default, work, personal, client-X) |
| **Auto-backup** | ❌ No | ✅ Per-portfolio with configurable paths |
| **Context switching** | ❌ N/A | ✅ `dollhouse portfolio switch work` |
| **Portfolio isolation** | ❌ N/A | ✅ Work elements invisible in personal |
| **GitHub sync** | Single repo | Per-portfolio repos or branches |
| **Future encryption** | ❌ No | ✅ Planned (per-portfolio) |

---

## Platform Categories & Capabilities

| Platform Category | Example Clients | Key Capabilities |
|-------------------|----------------|------------------|
| **terminal-cli** | Terminal, bash, zsh | os_commands, file_system_access, terminal_access |
| **desktop-ide** | Claude Code, Cursor, Windsurf | artifacts, file_picker, os_commands, window_management, tts_available |
| **chat-interface** | Claude Desktop, web chat | artifacts, file_picker(limited), image_generation |
| **voice-interface** | Voice assistants | audio_output, audio_input, tts_available (no visual) |
| **multimodal** | Image/video LLMs | artifacts, image_generation, image_analysis, video_analysis |

**Use Cases:**
- Elements check: `if (!platform.capabilities.os_commands) { fallback() }`
- Audio skill requires: `os_commands + tts_available + [darwin, linux]`
- Doc writer checks: `file_system_access` (fallback to artifacts if missing)

---

## Token Usage Profiles

| Profile | Token Usage | Auto-Discovery | Resource Ads | Startup Elements | Use Case |
|---------|-------------|----------------|--------------|------------------|----------|
| **minimal** | ~100 tokens | ❌ Disabled | ❌ None | ❌ None | API quotas, manual control |
| **balanced** | ~1-2K tokens | ✅ Enabled | ✅ Summary only | ❌ None | Recommended, good balance |
| **power** | ~48K tokens | ✅ Enabled | ✅ Summary + Full | ✅ Common personas | IDE use, maximum capability |

**Quick Commands:**
```bash
dollhouse profile set minimal   # Reduce token usage
dollhouse profile set balanced  # Default (recommended)
dollhouse profile set power     # Maximum capability
```

---

## Collections Trust Levels

| Trust Level | Meaning | When to Use | Review Required |
|-------------|---------|-------------|-----------------|
| **official** | DollhouseMCP core team verified | Official collection | ❌ No (vetted) |
| **verified** | Community verified, safe | Popular community sources | ⚠️ Optional |
| **community** | User-submitted | New/experimental sources | ✅ Yes (before install) |
| **custom** | Your own sources | Team/company repos | ✅ If sharing externally |

---

## Settings Organization (Basic vs Advanced)

### Basic Settings (Always Visible)
| Section | What It Controls | Who Needs It |
|---------|------------------|--------------|
| `user` | Identity for GitHub sync | Everyone (if using GitHub) |
| `portfolios` | Storage locations | Everyone |
| `github` | GitHub integration | Anyone syncing |
| `collections` | Where to browse elements | Anyone installing elements |
| `display` | UI preferences | Everyone |
| `profiles` | Token usage preset | Everyone |
| `privacy` | Tracking settings | Everyone (transparency) |

### Advanced Settings (Collapsed by Default)
| Section | What It Controls | Who Needs It |
|---------|------------------|--------------|
| `startup_elements` | Auto-load on start | Power users |
| `platform` | Capability detection | Element developers |
| `discovery` | Auto-discovery tuning | Power users |
| `performance` | Cache/timeout tuning | Performance optimization |
| `security` | Validation controls | Security-conscious users |
| `logging` | Debug output | Developers/troubleshooting |

---

## Migration Path

### v1 → v2 Auto-Migration

| v1 Setting | v2 Equivalent | Preserved? |
|-----------|---------------|------------|
| `telemetry.operational_telemetry: true` | `privacy.install_tracking: true` | ✅ Yes |
| `enhanced_index.telemetry: false` | `privacy.trigger_analytics: false` | ✅ Yes |
| `marketplace.enabled: true` | `collections.sources[0].enabled: true` | ✅ Yes |
| `platform.cli_mode: true` | `platform.detection.category: "terminal-cli"` | ✅ Yes (auto-detected) |
| `elements.default_element_dir: /path` | `portfolios.directories[0].path: /path` | ✅ Yes |
| `elements.auto_activate.personas: [...]` | `startup_elements.personas: [...]` | ✅ Yes |

**Migration Process:**
1. Server detects v1 config
2. Logs migration message
3. Automatically converts all settings
4. Preserves all user values
5. Adds new defaults for new settings
6. **Zero user action required**

**Deprecation Timeline:**
- **v2.0.0:** Auto-migrate with warning
- **v2.1.0:** Auto-migrate with warning (last version)
- **v2.2.0:** v1 config no longer supported

---

## Documentation Format (Every Setting)

### Before (v1):
```yaml
performance:
  cache:
    max_size_mb: 50
# No explanation
```

### After (v2):
```yaml
performance:
  cache:
    max_size_mb: 50
    # WHAT: Maximum memory for caching element data
    # WHY: Larger = faster but more RAM used
    # GOOD VALUES: 25MB (limited RAM), 50MB (default), 100MB (power users)
```

**Every setting now includes:**
- **WHAT:** What this setting does
- **WHY:** Why it matters / when you'd change it
- **GOOD VALUES:** Recommended settings for different use cases
- **EXAMPLES:** Real-world usage (when applicable)

---

## Command Comparison

| Task | v1 Command | v2 Command |
|------|-----------|-----------|
| **View config** | `dollhouse config get` | `dollhouse config get` (basic view)<br>`dollhouse config get --advanced`<br>`dollhouse config get --expert` |
| **Set privacy** | `dollhouse config telemetry.operational_telemetry false` | `dollhouse config privacy.install_tracking false` |
| **Get help** | ❌ N/A | `dollhouse config help privacy.install_tracking` |
| **Switch portfolio** | ❌ N/A | `dollhouse portfolio switch work` |
| **Set profile** | ❌ N/A | `dollhouse profile set minimal` |
| **Check platform** | ❌ N/A | `dollhouse platform info` |
| **Check compat** | ❌ N/A | `dollhouse element check-compat audio-summarizer` |

---

## Breaking Changes Summary

### API Changes (for developers)
| Area | Breaking Change | Migration |
|------|----------------|-----------|
| **Config paths** | All renamed settings | Use new paths, v1 auto-migrated |
| **Portfolio access** | `config.elements.default_element_dir` → `config.portfolios.directories[0].path` | Update code to use new path |
| **Platform detection** | `config.platform.cli_mode` → `config.platform.detection.category` | Update to use category system |
| **Auto-activation** | `config.elements.auto_activate` → `config.startup_elements` | Separate startup from discovery |

### No Breaking Changes for End Users
- ✅ Config auto-migrates
- ✅ All values preserved
- ✅ Elements work unchanged
- ✅ GitHub sync unaffected
- ✅ No manual steps required

---

## Implementation Phases

| Phase | Version | Timeline | Key Features |
|-------|---------|----------|--------------|
| **Phase 1** | v2.0.0 | Weeks 1-2 | Schema migration, renamed settings, Basic/Advanced segmentation |
| **Phase 2** | v2.1.0 | Weeks 3-5 | Multi-portfolio support, portfolio switching |
| **Phase 3** | v2.2.0 | Weeks 6-8 | Platform detection, capability checking |
| **Phase 4** | v2.3.0 | Weeks 9-10 | Token usage profiles (minimal/balanced/power) |
| **Phase 5** | v2.4.0 | Weeks 11-12 | UI segmentation, interactive wizard |

**Total Timeline:** 8-12 weeks

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Migration success rate** | 100% | Zero config errors post-upgrade |
| **Setting clarity** | 80%+ "clear" rating | User survey |
| **Token reduction** | 30%+ (for minimal profile) | Analytics comparison |
| **Support tickets** | 50% reduction | "What does X mean?" questions |
| **Basic settings sufficiency** | 90%+ users | % using only basic settings |
| **Platform compat errors** | 75% reduction | Capability check failures |

---

## Key Benefits

### For End Users
- ✅ **Clarity:** "install_tracking" vs "operational_telemetry"
- ✅ **Control:** Easy token usage profiles
- ✅ **Organization:** Work/personal portfolio separation
- ✅ **Transparency:** Know what's tracked and why
- ✅ **Simplicity:** Basic settings for most users
- ✅ **Power:** Advanced settings for customization

### For Developers
- ✅ **Platform checking:** `if (!platform.capabilities.X) { fallback() }`
- ✅ **Documentation:** Every setting explained
- ✅ **Extensibility:** New platforms easily added
- ✅ **Future-proof:** Voice, multimodal already planned

### For the Project
- ✅ **Support reduction:** Fewer "what does this do?" questions
- ✅ **Professional polish:** Complete documentation
- ✅ **Competitive advantage:** Multi-portfolio unique feature
- ✅ **Community trust:** "Collections" not "marketplace"

---

**Ready for GitHub posting:** `/tmp/config-overhaul-issue.md`

**Supporting documents:**
- `/tmp/config-overhaul-summary.md` - Quick reference
- `/tmp/config-overhaul-comparison.md` - Before/after details
- `/tmp/config-terminology-research.md` - Original research
- `/tmp/config-overhaul-checklist.md` - Pre-post checklist
- `/tmp/config-overhaul-changes-table.md` - This document

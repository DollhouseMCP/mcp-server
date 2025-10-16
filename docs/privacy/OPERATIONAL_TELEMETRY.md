# Operational Telemetry Privacy Policy

**Version**: 1.0
**Last Updated**: October 15, 2025
**Effective**: v1.9.18
**Status**: Active

---

## Overview

DollhouseMCP includes minimal, privacy-respecting operational telemetry to help us understand adoption patterns, prioritize platform support, and improve installation reliability. This document explains exactly what we collect, why we collect it, and how you can control it.

### Our Privacy Commitments

1. **Anonymous by Design** - No personally identifiable information is ever collected
2. **Minimal Data Collection** - Only what's necessary to improve the product
3. **Local-First** - All data stored locally where you can inspect it
4. **Easy Opt-Out** - Disable with a single environment variable
5. **Transparent** - Complete disclosure of what we collect and why
6. **No Network Transmission** - Currently local-only (server infrastructure will be separate issue)

---

## Remote Telemetry (Optional)

Starting in v1.9.18, DollhouseMCP supports **optional** remote telemetry via PostHog for better usage insights:

### Key Features

- **Opt-in only**: Requires explicit API key configuration in `.env.local` file
- **Anonymous**: Uses same UUID system as local telemetry, no PII collected
- **Additional opt-out**: Set `DOLLHOUSE_TELEMETRY_NO_REMOTE=true` to disable only remote sending while keeping local logs
- **Free tier**: PostHog offers 1M events/month free
- **Data location**: Can use US or EU servers (GDPR compliant)
- **Same data**: Remote telemetry sends the exact same data as local logs (no additional fields)

### Configuration

1. Create a free account at https://app.posthog.com
2. Get your API key (starts with `phc_`)
3. Add to `.env.local` file in project root:

```bash
# PostHog Configuration (Optional)
POSTHOG_API_KEY=phc_YOUR_KEY_HERE
POSTHOG_HOST=https://app.posthog.com  # Or use EU: https://eu.posthog.com
```

4. Restart the MCP server

### What's Sent to PostHog

When configured, the same installation event stored locally is also sent to PostHog:

```json
{
  "distinctId": "550e8400-e29b-41d4-a716-446655440000",
  "event": "server_installation",
  "properties": {
    "version": "1.9.18",
    "os": "darwin",
    "node_version": "20.11.0",
    "mcp_client": "claude-desktop"
  }
}
```

**No additional data** is sent beyond what's in your local `~/.dollhouse/telemetry.log`.

### PostHog Privacy

- **Anonymous tracking**: Uses same random UUID as local telemetry
- **No cookies**: PostHog session tracking disabled
- **No IP collection**: PostHog IP capture disabled
- **GDPR compliant**: Can use EU servers
- **Data retention**: Configurable (default: 90 days)
- **Self-hosting**: PostHog can be self-hosted if desired

### Disabling Remote Telemetry

Three ways to disable remote telemetry:

1. **Don't configure API key** (default) - Remote telemetry never activates
2. **Set `DOLLHOUSE_TELEMETRY_NO_REMOTE=true`** - Keeps local logs, disables PostHog
3. **Set `DOLLHOUSE_TELEMETRY=false`** - Disables all telemetry (local and remote)

```bash
# Option 1: Only disable remote (keep local logs)
export DOLLHOUSE_TELEMETRY_NO_REMOTE=true

# Option 2: Disable all telemetry
export DOLLHOUSE_TELEMETRY=false
```

### Why PostHog?

- **Open source**: PostHog is open source (MIT license)
- **Privacy-first**: Built with GDPR compliance in mind
- **Generous free tier**: 1M events/month free
- **Self-hostable**: Can run your own PostHog instance
- **EU servers available**: GDPR data residency compliance
- **No vendor lock-in**: Standard events API, easy to migrate

---

## What We Collect

### Installation Event (One-Time)

On first run, a single installation event is recorded. This is the **only** data collected in v1.9.18:

```json
{
  "event": "install",
  "install_id": "550e8400-e29b-41d4-a716-446655440000",
  "version": "1.9.18",
  "os": "darwin",
  "node_version": "20.11.0",
  "mcp_client": "claude-desktop",
  "timestamp": "2025-10-15T18:45:00.000Z"
}
```

### Field Descriptions

| Field | Description | Why We Collect It | Example Values |
|-------|-------------|-------------------|----------------|
| `event` | Event type identifier | To distinguish event types in future versions | `"install"` |
| `install_id` | Anonymous UUID v4 | To count unique installations without identifying users | `"550e8400-e29b-41d4-a716-446655440000"` |
| `version` | DollhouseMCP version | To track version adoption and update success rates | `"1.9.18"` |
| `os` | Operating system type | To prioritize platform-specific support and testing | `"darwin"`, `"win32"`, `"linux"` |
| `node_version` | Node.js version (major.minor) | To understand runtime compatibility and set minimum requirements | `"20.11"`, `"18.17"` |
| `mcp_client` | MCP client being used | To optimize for most common clients (Claude Desktop, Claude Code, etc.) | `"claude-desktop"`, `"claude-code"`, `"unknown"` |
| `timestamp` | Event timestamp (ISO 8601, UTC) | To track installation trends over time | `"2025-10-15T18:45:00.000Z"` |

### Installation ID Generation

The `install_id` is a cryptographically random UUID v4 generated locally on your machine:

```typescript
// Generated using Node.js crypto.randomUUID()
// Example: 550e8400-e29b-41d4-a716-446655440000

// Important characteristics:
// - Generated LOCALLY (never sent over network to be assigned)
// - Completely RANDOM (no relationship to your identity)
// - ANONYMOUS (cannot be traced back to you)
// - UNIQUE per installation (reinstalling = new ID)
```

**Why UUID v4?**
- Industry standard for anonymous tracking
- Cryptographically random (no patterns or predictability)
- No timestamp encoding (unlike UUID v1)
- Cannot be reverse-engineered to find user information

---

## What We DON'T Collect

We have explicit safeguards to **never** collect:

### Personal Information
- ❌ Your name
- ❌ Email address
- ❌ GitHub username or OAuth tokens
- ❌ IP address (not even anonymized)
- ❌ Geographic location
- ❌ Computer name or hostname
- ❌ MAC address or hardware identifiers
- ❌ Network information

### User Content
- ❌ Persona content or definitions
- ❌ Skill content
- ❌ Template content
- ❌ Memory content
- ❌ Agent configurations
- ❌ Any user-generated content

### File System Information
- ❌ Installation directory paths
- ❌ File paths containing usernames
- ❌ Directory structure
- ❌ File names
- ❌ Portfolio contents

### Behavioral Data
- ❌ Which tools you use
- ❌ How often you use the server
- ❌ Command history
- ❌ Conversation content
- ❌ Interaction patterns
- ❌ Session duration

### System Details
- ❌ Specific OS version builds (e.g., "macOS 14.1.2 Build 23B92")
- ❌ CPU model or specifications
- ❌ Memory/RAM amounts
- ❌ Disk space or serial numbers
- ❌ Other installed software

---

## How It Works

### 1. First Run Detection

When DollhouseMCP starts, it checks for a telemetry ID file:

```bash
# Location: ~/.dollhouse/.telemetry-id
# If this file exists = not first run
# If this file doesn't exist = first run, record installation event
```

### 2. UUID Generation

On first run, a unique installation ID is generated:

```typescript
// Using Node.js built-in crypto module
import crypto from 'crypto';

const installId = crypto.randomUUID();
// Example output: "550e8400-e29b-41d4-a716-446655440000"

// Store in ~/.dollhouse/.telemetry-id for future runs
```

### 3. Event Recording

The installation event is written to a local log file:

```bash
# Location: ~/.dollhouse/telemetry.log
# Format: JSON Lines (NDJSON) - one event per line
# Permissions: Only readable by your user account
```

Example log file content:

```json
{"event":"install","install_id":"550e8400-e29b-41d4-a716-446655440000","version":"1.9.18","os":"darwin","node_version":"20.11.0","mcp_client":"claude-desktop","timestamp":"2025-10-15T18:45:00.000Z"}
```

### 4. Local Storage Only

**Current Status (v1.9.18)**: All telemetry data stays on your machine. Nothing is transmitted over the network.

**Future Plans**: Server infrastructure will be implemented in a separate issue. When ready:
- You will be able to inspect local logs before any transmission
- A separate opt-in will be requested before enabling network transmission
- You can continue using local-only mode indefinitely
- Environment variable opt-out will prevent any transmission

---

## Data Storage

### Local Storage Locations

All telemetry data is stored in the `~/.dollhouse/` directory:

```bash
~/.dollhouse/
├── .telemetry-id          # Your anonymous installation UUID
└── telemetry.log          # Event log (JSON Lines format)
```

### File Details

**`.telemetry-id`**
- Content: Single line containing your installation UUID
- Format: Plain text UUID v4
- Permissions: Read/write by your user only (0600)
- Purpose: Persists your installation ID across restarts

**`telemetry.log`**
- Content: One JSON event per line
- Format: NDJSON (newline-delimited JSON)
- Permissions: Read/write by your user only (0600)
- Rotation: None currently (file grows with events)
- Purpose: Local record of all telemetry events

### Data Retention

- **Local files**: Kept indefinitely until you delete them
- **User-controlled**: You can delete these files at any time
- **No expiration**: Files don't auto-delete
- **No size limits**: Currently no rotation or size management

### Access Control

Only you can access these files:
- Stored in your home directory (`~/.dollhouse/`)
- Unix permissions: `0600` (owner read/write only)
- No network access to these files
- No cloud sync or backup by DollhouseMCP

---

## Network Transmission

### Current Status: Local Only

**v1.9.18 does NOT transmit any data over the network.**

All telemetry events are:
- Generated locally
- Stored locally
- Inspectable locally
- Deletable locally

### Future Server Infrastructure

When server infrastructure is implemented (separate issue), we will:

1. **Request New Consent**
   - Explicit prompt before enabling network transmission
   - Separate from installation telemetry consent
   - Clear explanation of what will be sent

2. **Respect Opt-Out Preference**
   - `DOLLHOUSE_TELEMETRY=false` will prevent all transmission
   - Network transmission can be disabled independently
   - Local logging can continue even if transmission is disabled

3. **Allow Inspection**
   - You can review `~/.dollhouse/telemetry.log` to see exactly what would be sent
   - No surprises - what you see locally is what gets transmitted
   - No additional data added during transmission

4. **Secure Transmission**
   - HTTPS only (TLS 1.2+)
   - Certificate pinning for security
   - Retry with exponential backoff on failure
   - Graceful degradation (no errors if server unavailable)

5. **Server Features** (when implemented)
   - Aggregated public statistics dashboard
   - Data deletion endpoint (delete your installation's data)
   - Open source server code (AGPL-3.0)
   - Self-hosting documentation

---

## Opt-Out Instructions

Telemetry is **enabled by default** (industry standard for open source projects like VS Code, npm, Homebrew). However, opting out is simple and immediate.

### Opt-Out Levels

You can disable telemetry at different levels:

1. **Remote only**: `DOLLHOUSE_TELEMETRY_NO_REMOTE=true` - Keeps local logs, disables PostHog
2. **All telemetry**: `DOLLHOUSE_TELEMETRY=false` - Disables both local and remote
3. **No configuration**: Default behavior (local telemetry enabled, remote requires API key)

### Method 1: Environment Variable (Recommended)

Set the `DOLLHOUSE_TELEMETRY` environment variable to `false`:

**Bash/Zsh:**
```bash
# Disable all telemetry
# Add to ~/.bashrc or ~/.zshrc for persistence
export DOLLHOUSE_TELEMETRY=false

# Or disable only remote telemetry (keep local logs)
export DOLLHOUSE_TELEMETRY_NO_REMOTE=true
```

**Fish Shell:**
```fish
# Add to ~/.config/fish/config.fish
set -x DOLLHOUSE_TELEMETRY false
# Or disable only remote:
set -x DOLLHOUSE_TELEMETRY_NO_REMOTE true
```

**Windows PowerShell:**
```powershell
# Disable all telemetry - User-level (recommended)
[Environment]::SetEnvironmentVariable("DOLLHOUSE_TELEMETRY", "false", "User")

# Or disable only remote telemetry
[Environment]::SetEnvironmentVariable("DOLLHOUSE_TELEMETRY_NO_REMOTE", "true", "User")

# Session-level only
$env:DOLLHOUSE_TELEMETRY = "false"
```

**Windows Command Prompt:**
```cmd
REM Disable all - User-level (recommended)
setx DOLLHOUSE_TELEMETRY false

REM Or disable only remote
setx DOLLHOUSE_TELEMETRY_NO_REMOTE true

REM Session-level only
set DOLLHOUSE_TELEMETRY=false
```

### Method 2: Delete Telemetry ID File

Manually delete the installation ID file:

```bash
# Remove installation ID (stops all telemetry)
rm ~/.dollhouse/.telemetry-id

# Optionally, remove the log file too
rm ~/.dollhouse/telemetry.log
```

**Note**: If you only delete `.telemetry-id`, a new installation event will be recorded on next run (with a new UUID). To permanently disable, use the environment variable method.

### Method 3: CI/CD Environments

For automated environments, telemetry is automatically disabled if:
- `CI=true` environment variable is set (standard CI/CD variable)
- Or `DOLLHOUSE_TELEMETRY=false` is explicitly set

### Verification

Check if telemetry is disabled:

**Check environment variable:**
```bash
echo $DOLLHOUSE_TELEMETRY
# Output should be "false" if disabled
```

**Check for telemetry ID file:**
```bash
ls -la ~/.dollhouse/.telemetry-id
# File should not exist if disabled, or should not be created on next run
```

**Check telemetry log:**
```bash
# Should be empty or not updated after disabling
cat ~/.dollhouse/telemetry.log
```

---

## Frequently Asked Questions

### Why collect telemetry at all?

**Problem**: We currently have zero visibility into:
- How many active installations exist (npm downloads include bots, CI/CD, mirrors)
- What platforms users are running (macOS, Windows, Linux distributions)
- Which MCP clients are being used (Claude Desktop, Claude Code, Gemini, etc.)
- Installation success rates

**Impact**: Without this data, we:
- Can't prioritize which platforms to optimize for
- Don't know if installation process has issues
- Can't make data-driven decisions about where to focus effort
- May break platforms we didn't know were widely used

**Solution**: Minimal installation telemetry tells us:
- "200 macOS users installed v1.9.18 this week"
- "80% of installations are Claude Desktop, 15% Claude Code"
- "Linux installations are growing 20% month-over-month"

This helps us prioritize bug fixes, optimize for common platforms, and make better decisions.

### Can you identify me from this data?

**No.** Here's why:

1. **Anonymous UUID**: The installation ID is a random UUID v4. It contains no information about you:
   - Not based on your MAC address (UUID v1 does this, we don't use it)
   - Not based on your hostname or username
   - Not linked to any account or service
   - Just a random number

2. **No PII Collected**: We don't collect:
   - GitHub username or OAuth tokens
   - Email address
   - IP address
   - Computer name
   - File paths with usernames

3. **Multiple Installations = Multiple IDs**: If you install DollhouseMCP on 3 machines, we see 3 installation IDs. We have no way to know they're the same person.

4. **Example**:
   ```
   Installation 1: 550e8400-e29b-41d4-a716-446655440000
   Installation 2: f47ac10b-58cc-4372-a567-0e02b2c3d479

   Question: Are these the same person?
   Answer: We have absolutely no way to know. Could be same person,
           could be different people. The UUIDs are just random numbers.
   ```

### What if I don't trust this?

**You don't have to trust us - you can verify:**

1. **Read the Code**
   - All telemetry code is open source (AGPL-3.0)
   - Location: `src/utils/telemetry.ts` (when implemented)
   - Audit it yourself or have a security researcher review it

2. **Inspect Local Logs**
   - All telemetry events are written to `~/.dollhouse/telemetry.log`
   - You can read this file to see exactly what's being collected
   - No hidden or encrypted data

3. **Monitor Network Traffic**
   - In v1.9.18, there's NO network transmission
   - Use tools like Wireshark or Little Snitch to verify
   - When network transmission is added, you can still monitor it

4. **Opt Out**
   - Simple, immediate opt-out via environment variable
   - No degraded functionality when opted out
   - All features work exactly the same

5. **Modify or Remove**
   - Under AGPL-3.0, you can modify or remove telemetry code
   - Fork the project and remove telemetry entirely
   - Share your modifications (AGPL requirement)

### Will you sell my data?

**No. And there's nothing to sell.**

1. **No Personal Data**: We don't collect personally identifiable information
2. **Anonymous**: Installation IDs are random UUIDs with no link to identity
3. **Aggregate Only**: When we publish statistics, it's aggregate counts:
   - "500 macOS users" (not "John Doe on macOS")
   - "80% Claude Desktop" (not "alice@example.com uses Claude Desktop")

4. **Open Source Commitment**: Under AGPL-3.0, we're committed to transparency
5. **No Business Model**: We don't monetize telemetry data

### What about GDPR/CCPA compliance?

**GDPR (European Union):**
- Telemetry collects no personal data, so GDPR requirements are minimal
- However, we still provide:
  - ✅ Transparent disclosure (this document)
  - ✅ Opt-out mechanism (environment variable)
  - ✅ Data minimization (only installation event)
  - ✅ Right to deletion (delete local files)

**CCPA (California):**
- No personal information collected
- Do Not Sell: We don't sell data (and have nothing to sell)
- Right to opt-out: Environment variable disables collection
- Disclosure: This document describes what's collected

**Other Regulations:**
- PIPEDA (Canada): Compliant (anonymous, minimal, opt-out available)
- LGPD (Brazil): Compliant (based on GDPR principles)
- COPPA (Children): No age-specific collection

**Summary**: Because we collect no personally identifiable information, most privacy regulations don't apply. But we follow best practices anyway.

### Can I see what's being collected?

**Yes! Inspect your local telemetry log:**

```bash
# View the raw log file
cat ~/.dollhouse/telemetry.log

# Pretty-print JSON (requires jq)
cat ~/.dollhouse/telemetry.log | jq .

# Count events
wc -l ~/.dollhouse/telemetry.log

# View your installation ID
cat ~/.dollhouse/.telemetry-id
```

**Example output:**
```json
{
  "event": "install",
  "install_id": "550e8400-e29b-41d4-a716-446655440000",
  "version": "1.9.18",
  "os": "darwin",
  "node_version": "20.11.0",
  "mcp_client": "claude-desktop",
  "timestamp": "2025-10-15T18:45:00.000Z"
}
```

**What you see locally is exactly what would be sent to the server (when implemented).**

### What if I reinstall or upgrade?

**Reinstall (delete and install again):**
- New installation ID is generated
- New installation event is recorded
- We see this as a new installation (can't tell it's the same person)

**Upgrade (update to newer version):**
- Installation ID is preserved (same UUID)
- No new installation event in v1.9.18 (only recorded on first install)
- Future versions may add upgrade events

### Will features be locked behind telemetry?

**Absolutely not.**

- All features work fully with telemetry disabled
- No degraded functionality
- No "premium" features requiring telemetry
- No feature gates or restrictions

Telemetry is purely for product improvement, not feature gating.

### How do I delete my data?

**Local data:**
```bash
# Delete installation ID (stops future collection)
rm ~/.dollhouse/.telemetry-id

# Delete event log
rm ~/.dollhouse/telemetry.log
```

**Server-side data (when implemented):**
- Deletion endpoint will be available
- Provide your installation ID to request deletion
- Aggregated statistics (no installation ID) will remain

### Can I partially opt-in?

**In v1.9.18**: No, it's all-or-nothing (just installation event).

**Future versions** may support granular control:
```bash
# Examples (not yet implemented)
DOLLHOUSE_TELEMETRY_INSTALLATION=true   # Installation events only
DOLLHOUSE_TELEMETRY_CRASHES=false       # No crash reports
DOLLHOUSE_TELEMETRY_USAGE=false         # No usage statistics
```

### What about corporate/enterprise environments?

**Recommendations for corporate use:**

1. **Disable in CI/CD pipelines:**
   ```bash
   # CI=true automatically disables telemetry
   # Or explicitly disable:
   export DOLLHOUSE_TELEMETRY=false
   ```

2. **Company-wide policy:**
   ```bash
   # Add to company-wide shell configuration
   export DOLLHOUSE_TELEMETRY=false
   ```

3. **Self-hosting (future):**
   - When server infrastructure is released, companies can self-host
   - Keep all telemetry data internal
   - Full control over data storage and retention

4. **Network restrictions:**
   - Block telemetry endpoint at firewall level (when implemented)
   - DollhouseMCP will gracefully handle failed transmissions
   - No errors or degraded functionality

### How do you prevent data breaches?

**Multiple layers of protection:**

1. **No sensitive data**: We don't collect PII, so there's no sensitive data to breach
2. **Local storage**: Data stored in your home directory with restrictive permissions (0600)
3. **Future network transmission**:
   - HTTPS only (TLS 1.2+)
   - Encryption at rest on server
   - Regular security audits
   - Minimal retention (aggregate and delete)

4. **Open source**: Community can audit security measures

### Will you change what data is collected?

**If we add new telemetry events in future versions:**

1. **Announcement**: Detailed release notes explaining new collection
2. **Documentation**: Updated privacy policy
3. **Version bump**: Privacy policy version incremented
4. **Opt-out still works**: Environment variable disables all telemetry

**We will NOT:**
- Silently add new data collection
- Change existing event schemas without notice
- Collect personal data in future versions

### What if I find a privacy issue?

**Please report it immediately:**

1. **Security Issues**:
   - Email: security@dollhousemcp.com
   - GitHub Security Advisory (private disclosure)

2. **Privacy Concerns**:
   - GitHub Issue: https://github.com/DollhouseMCP/mcp-server/issues
   - Email: privacy@dollhousemcp.com

**We will:**
- Acknowledge within 24 hours
- Fix critical issues immediately
- Notify all users of privacy issues
- Credit security researchers (if desired)

---

## Industry Standards and Comparisons

We follow telemetry best practices from leading open source projects:

### VS Code
- **Opt-out telemetry** (default enabled, but easy to disable)
- **Transparent documentation** of what's collected
- **User control** via settings
- **Open source** telemetry code

**What we learned:**
- Clear documentation builds trust
- Granular control is appreciated
- Transparency matters more than opt-in vs opt-out default

### npm CLI
- **Anonymous installation tracking**
- **Minimal data collection** (platform, version, success/failure)
- **Simple opt-out**: `npm config set send-metrics false`

**What we learned:**
- Installation metrics are valuable for prioritization
- Keep data collection minimal
- Focus on actionable insights

### Homebrew
- **Anonymous by design** (no user IDs at all)
- **Public analytics dashboard**
- **Auto-disable in CI environments**
- **Simple opt-out**: `brew analytics off`

**What we learned:**
- Public dashboards increase transparency
- Auto-detection of CI environments prevents noise
- Anonymous-by-design is best approach

### Next.js
- **Zero personal data collection**
- **Public disclosure** of all event types
- **Example telemetry events** in documentation
- **Simple opt-out**: `npx next telemetry disable`

**What we learned:**
- Show real examples of collected data
- Document event schemas publicly
- Focus on product improvement use cases

### Key Differences

DollhouseMCP telemetry is **more conservative** than these projects:

- **No behavioral tracking** (unlike VS Code's feature usage tracking)
- **Installation only** in v1.9.18 (no heartbeats, session tracking, etc.)
- **Local-first** (no network transmission yet)
- **AGPL-3.0** (requires open source server, allows self-hosting)

---

## Changes to This Policy

### How We'll Communicate Changes

If we update this privacy policy:

1. **Version number bump** in this document
2. **Update announcement** in release notes
3. **GitHub issue** for discussion
4. **CHANGELOG.md entry**
5. **Post at** https://dollhousemcp.com/privacy/telemetry (when website is ready)

### When We'll Update

Privacy policy will be updated when:
- New telemetry event types are added
- Collection methods change
- Data retention policies change
- Server infrastructure is implemented
- Legal requirements change

### Significant Changes

For significant changes (new data types, network transmission):
- **Advance notice** in release notes
- **Separate opt-in** if adding new collection
- **Migration guide** for users
- **Community feedback period** before implementation

---

## Contact

### Questions or Concerns

- **GitHub Issues**: https://github.com/DollhouseMCP/mcp-server/issues
- **GitHub Discussions**: https://github.com/DollhouseMCP/mcp-server/discussions
- **Email**: privacy@dollhousemcp.com

### Security Issues

- **Email**: security@dollhousemcp.com
- **GitHub Security Advisory**: https://github.com/DollhouseMCP/mcp-server/security/advisories/new

### General Support

- **Documentation**: https://github.com/DollhouseMCP/mcp-server/tree/main/docs
- **Discord**: (coming soon)
- **Website**: https://dollhousemcp.com

---

## Open Source Commitment

### AGPL-3.0 License

Under the AGPL-3.0 license:

1. **All telemetry code is open source**
   - You can audit every line of telemetry code
   - Location: `src/utils/telemetry.ts` (when implemented)
   - No hidden or proprietary telemetry

2. **Telemetry server will be open source**
   - When server infrastructure is implemented
   - Repository: https://github.com/DollhouseMCP/telemetry-server (planned)
   - Self-hosting documentation included

3. **You can modify or remove telemetry**
   - Fork the project
   - Remove telemetry code entirely
   - Distribute your modified version
   - Share modifications (AGPL requirement)

4. **Full control over your data**
   - Local-only by default
   - Optional self-hosted server
   - Environment variable opt-out
   - File-based storage you control

### Dual-License Considerations

DollhouseMCP offers dual licensing (AGPL-3.0 + Commercial):

- **AGPL users**: Full control, self-hosting, modification rights
- **Commercial license users**: May have different terms (see license agreement)

This privacy policy applies to **AGPL-3.0 users**. Commercial license users should consult their license agreement.

---

## Summary

### Quick Facts

- **What we collect**: One installation event with platform info and anonymous UUID
- **What we don't collect**: Personal information, user content, file paths, IP addresses
- **Where it's stored**: `~/.dollhouse/telemetry.log` (local only)
- **Network transmission**: None in v1.9.18 (future: separate opt-in)
- **How to opt-out**: `export DOLLHOUSE_TELEMETRY=false`
- **How to inspect**: `cat ~/.dollhouse/telemetry.log`
- **How to delete**: `rm ~/.dollhouse/telemetry.log ~/.dollhouse/.telemetry-id`

### Privacy Principles

1. ✅ **Anonymous by design** - Random UUIDs, no PII
2. ✅ **Minimal collection** - Installation event only
3. ✅ **Local-first** - All data stored locally
4. ✅ **Transparent** - Full disclosure, open source code
5. ✅ **User control** - Easy opt-out, inspection, deletion
6. ✅ **No surprises** - Clear communication of changes

### Trust but Verify

We encourage you to:
- Read the telemetry implementation code
- Inspect your local log files
- Monitor network traffic (will be none in v1.9.18)
- Ask questions in GitHub Issues
- Report privacy concerns
- Fork and modify if desired

**Our goal**: Build trust through transparency, not through obscurity.

---

**Document Version**: 1.0
**Last Updated**: October 15, 2025
**Next Review**: January 15, 2026
**Effective Version**: 1.9.18+

For the most current version of this policy, see:
https://github.com/DollhouseMCP/mcp-server/blob/main/docs/privacy/OPERATIONAL_TELEMETRY.md

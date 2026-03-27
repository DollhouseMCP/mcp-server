# Environment Variables Guide

**Last Updated:** 2026-03-18
**Version:** 2.0.0-beta
**Purpose:** Complete guide to configuring DollhouseMCP environment variables

---

## Quick Start

### Production Setup (5 minutes)

DollhouseMCP uses three configuration files:
- **`.env`** (committed) - Shared defaults for the whole team (already configured)
- **`.env.local`** (gitignored) - Your personal secrets (you create this)
- **`.env.example`** (committed) - Template showing what goes in .env.local

1. **Copy the example file:**
   ```bash
   cp .env.example .env.local
   ```

2. **Get your GitHub token:**
   - Go to https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Select scope: `repo` (Full control of private repositories)
   - Generate and copy the token

3. **Edit .env.local with your credentials:**
   ```bash
   GITHUB_TOKEN=ghp_your_actual_token_here
   GITHUB_USERNAME=your-github-username
   GITHUB_REPOSITORY=dollhouse-portfolio
   ```

   **Note:** `GITHUB_REPOSITORY` should be JUST the repository name (not "owner/repo"). The username is specified separately in `GITHUB_USERNAME`.

4. **Verify setup:**
   ```bash
   npm run build
   npm test
   ```

That's it! The `.env` file already has all the defaults configured.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Production Configuration](#production-configuration)
- [Testing & Development Configuration](#testing--development-configuration)
- [All Environment Variables](#all-environment-variables)
  - [GitHub Authentication](#github-authentication)
  - [Server Configuration](#server-configuration)
  - [MCP Interface Configuration](#mcp-interface-configuration)
  - [Security & Gatekeeper](#security--gatekeeper)
  - [Permission Prompt Configuration](#permission-prompt-configuration)
  - [Encryption & Memory Security](#encryption--memory-security)
  - [Activation Persistence](#activation-persistence)
  - [Autonomy Evaluation](#autonomy-evaluation)
  - [Active Element Limits](#active-element-limits)
  - [Storage Layer & Caching](#storage-layer--caching)
  - [Cache Memory Limits](#cache-memory-limits)
  - [File Locking](#file-locking)
  - [Backup Configuration](#backup-configuration)
  - [Memory Save Throttling](#memory-save-throttling)
  - [Metrics](#metrics)
  - [GitHub API & Portfolio](#github-api--portfolio)
  - [Search & Similarity](#search--similarity)
  - [Unified Logging](#unified-logging)
  - [Status Indicator](#status-indicator)
  - [Telemetry](#telemetry)
  - [Runtime Identity & Paths](#runtime-identity--paths)
  - [Feature Flags](#feature-flags)
  - [Test Configuration](#test-configuration)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

---

## Production Configuration

### Required Variables

DollhouseMCP runs with **zero required environment variables**. The server starts with sensible defaults — local portfolio at `~/.dollhouse/portfolio/`, MCP-AQL CRUDE mode, Gatekeeper enabled.

Set these only if you need GitHub features (portfolio sync, community collection submission):

```bash
# GitHub credentials (only needed for GitHub portfolio sync and community submission)
GITHUB_TOKEN=ghp_your_token_here
GITHUB_USERNAME=your-github-username

# Portfolio repository name (only needed for GitHub sync)
PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio  # Just repo name, not "owner/repo"
```

### Optional Variables

```bash
# Server configuration
PORT=3000                    # Server port (default: 3000)
LOG_LEVEL=info              # Log level: error | warn | info | debug
NODE_ENV=development        # Environment: development | test | production

# Feature flags
DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=false  # Auto-submit to community
ENABLE_DEBUG=false                         # Enable debug logging
```

### Configuration File Structure

DollhouseMCP uses a layered configuration approach:

**.env** (committed to git)
- Contains all default values
- Safe to share with team
- NO secrets
- Already configured with sensible defaults

**.env.local** (gitignored)
- Your personal secrets and overrides
- Created by copying .env.example
- Overrides anything in .env
- NEVER commit this file

**.env.example** (committed to git)
- Template showing what to put in .env.local
- Documents required personal configuration
- Safe to commit (has placeholders only)

### Setup Methods

**Method 1: .env.local file (Recommended)**

```bash
# Create .env.local from template
cp .env.example .env.local

# Edit with your actual values
nano .env.local

# Add your credentials:
GITHUB_TOKEN=ghp_your_token_here
GITHUB_USERNAME=your-github-username
PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio  # Just repo name
```

Benefits:
- Simple and straightforward
- All config in one place
- Overrides team defaults from .env
- Already gitignored

**Method 2: Shell Environment (Alternative)**

```bash
# Add to ~/.bashrc or ~/.zshrc
export GITHUB_TOKEN='ghp_your_token_here'
export GITHUB_USERNAME='your-github-username'
export PORTFOLIO_REPOSITORY_NAME='dollhouse-portfolio'  # Just repo name

# Reload shell
source ~/.bashrc  # or source ~/.zshrc
```

**Method 3: Secure File Storage (Most Secure)**

```bash
# Store token in secure file
mkdir -p ~/.config/dollhouse
echo 'ghp_your_token_here' > ~/.config/dollhouse/github-token
chmod 600 ~/.config/dollhouse/github-token

# Reference in .env.local
echo "GITHUB_TOKEN=$(cat ~/.config/dollhouse/github-token)" > .env.local
echo "GITHUB_USERNAME=your-username" >> .env.local
echo "PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio" >> .env.local  # Just repo name
```

---

## Testing & Development Configuration

### For Running Tests

Tests require a **separate** GitHub account to avoid polluting your production data.

**Step 1: Create Test Account**

1. Create a new GitHub account for testing (e.g., `your-username-test`)
2. Generate a token at https://github.com/settings/tokens
3. Create a test repository (e.g., `dollhouse-test-sandbox`)

**Step 2: Configure Test Credentials**

Add these to your `.env.local`:

```bash
# Test credentials (DIFFERENT account from production!)
GITHUB_TEST_TOKEN=ghp_your_test_account_token
GITHUB_TEST_USERNAME=your-test-username
GITHUB_TEST_REPOSITORY=dollhouse-test-sandbox  # Just repo name
```

**Step 3: Run Tests**

```bash
# Run all tests
npm test

# Run E2E tests (requires test credentials)
npm run test:e2e

# Run specific test suite
npm test -- --testPathPattern=persona
```

### Test Behavior

- **With test credentials:** Full test suite runs, including GitHub operations
- **Without test credentials:** Tests skip gracefully with helpful messages
- **Safety:** Tests NEVER use production credentials or access production data

### Test Configuration Variables

These are automatically configured by the test framework and should **NOT** be set manually:

```bash
# DO NOT SET THESE - Auto-configured by test framework
# TEST_BASE_DIR=...
# TEST_PERSONAS_DIR=...
# TEST_CACHE_DIR=...
# TEST_CONFIG_DIR=...

# Test behavior (optional overrides)
# TEST_VERBOSE_LOGGING=false    # Enable verbose test output
# TEST_CLEANUP_AFTER=true       # Clean up test files after completion
# TEST_TIMEOUT=60000           # Test timeout in milliseconds
```

**Note:** The test framework automatically sets these directories to absolute paths at runtime. Setting them manually (especially with relative paths) will cause test failures.

---

## All Environment Variables

### GitHub Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes (for GitHub features) | _(none)_ | Production GitHub Personal Access Token |
| `GITHUB_USERNAME` | Recommended | _(none)_ | Your GitHub username |
| `PORTFOLIO_REPOSITORY_NAME` | Recommended | _(none)_ | Portfolio repository name (just name, not "owner/repo") -- **PREFERRED** |
| `GITHUB_REPOSITORY` | Legacy | _(none)_ | DEPRECATED: Use `PORTFOLIO_REPOSITORY_NAME` instead to avoid conflicts with GitHub Actions |
| `GITHUB_TEST_TOKEN` | No (for tests) | _(none)_ | Test account GitHub token |
| `GITHUB_TEST_USERNAME` | No (for tests) | _(none)_ | Test account username |
| `GITHUB_TEST_REPOSITORY` | No (for tests) | _(none)_ | Test repository name (just name, not "owner/repo") |

**Important Note on `PORTFOLIO_REPOSITORY_NAME`:**
- Use `PORTFOLIO_REPOSITORY_NAME` instead of `GITHUB_REPOSITORY` for portfolio configuration
- GitHub Actions automatically sets `GITHUB_REPOSITORY='owner/repo'`, which conflicts with portfolio config
- `PORTFOLIO_REPOSITORY_NAME` avoids this conflict by using a dedicated variable
- Must be just the repository name (e.g., `dollhouse-portfolio`), not `owner/repo` format
- The username should be specified separately in `GITHUB_USERNAME`

**Token Requirements:**
- Scope: `repo` (Full control of private repositories)
- Optional scope: `read:org` (for organization features)
- Format: Must be a valid GitHub token (starts with `ghp_`, `github_pat_`, or `gho_`)

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port number |
| `LOG_LEVEL` | `info` | Logging level: `error`, `warn`, `info`, `debug` |
| `NODE_ENV` | `development` | Environment: `development`, `test`, `production` |

### MCP Interface Configuration

DollhouseMCP uses two hierarchical environment variables to control the tool interface exposed to LLMs.

#### Level 1: Interface Mode

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `MCP_INTERFACE_MODE` | `mcpaql`, `discrete` | `mcpaql` | Tool interface style |

- **`mcpaql`** (default): MCP-AQL consolidated interface -- uses `MCP_AQL_ENDPOINT_MODE` for grouping
- **`discrete`**: ~40 individual tools (legacy) -- ~29,600 tokens

#### Level 2: Endpoint Mode (MCP-AQL only)

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `MCP_AQL_ENDPOINT_MODE` | `crude`, `single` | `crude` | MCP-AQL endpoint grouping |
| `MCP_AQL_MODE` | `crude`, `single` | _(none)_ | DEPRECATED: backward-compatibility alias for `MCP_AQL_ENDPOINT_MODE` |

**Only applies when `MCP_INTERFACE_MODE=mcpaql` (the default)**

- **`crude`** (default): 5 CRUDE endpoints (Create, Read, Update, Delete, Execute) -- ~4,300 tokens
- **`single`**: 1 unified endpoint -- ~1,100 tokens, ideal for constrained contexts

#### Examples

```bash
# Default: MCP-AQL with CRUDE endpoints (recommended)
# No environment variables needed

# Minimal tokens: MCP-AQL with single endpoint
MCP_AQL_ENDPOINT_MODE=single

# Legacy: Discrete individual tools
MCP_INTERFACE_MODE=discrete
```

#### Claude Desktop Configuration

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {
        "MCP_AQL_ENDPOINT_MODE": "crude"
      }
    }
  }
}
```

### Security & Gatekeeper

These variables control the Gatekeeper policy enforcement engine that protects all MCP-AQL operations. These are **operator/infrastructure settings** -- the LLM cannot bypass them.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_GATEKEEPER_ENABLED` | `true` | Master switch for Gatekeeper. When `true`, all MCP-AQL operations pass through the 4-layer Gatekeeper `enforce()` pipeline. When `false`, falls back to route validation only. |
| `DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES` | `true` | Element policy layer (Layer 2) kill switch. When `true`, active element policies (allow/confirm/deny/scopeRestrictions) can override default operation permission levels. When `false`, Layer 2 is bypassed entirely -- only route validation and default permission levels apply. Use for emergency lockdown, hardened deployments, or policy debugging. |
| `DOLLHOUSE_POLICY_EXPORT_ENABLED` | `true` | Policy export opt-in. When `true`, `PolicyExportService` writes the security policy blueprint to `~/.dollhouse/bridge/imports/policies/` on activation changes. The DollhouseBridge permission-prompt server watches this file to evaluate permissions locally. Set to `false` to disable policy file export. |
| `DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN` | _(none)_ | Admin token for DangerZone operations. When set, provides an alternative authentication path for danger zone verification. |
| `DOLLHOUSE_SECURITY_ALERTS` | `false` | When `true`, enables security alert notifications in the security monitor. |

### Permission Prompt Configuration

These variables tune the permission prompt system introduced in v2.0.0 (Issue #625) for headless session approval workflows.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_CLI_APPROVAL_MAX` | `50` | Maximum CLI approval records before LRU eviction. |
| `DOLLHOUSE_CLI_APPROVAL_TTL_MS` | `300000` (5 min) | Default TTL for CLI approval records in milliseconds. |
| `DOLLHOUSE_CLI_APPROVAL_POLICY` | _(none)_ | Comma-separated list of risk levels requiring CLI approval. Values: `moderate`, `dangerous`. Fallback when no active element policies define approval requirements. |
| `DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT` | `100` | Maximum permission prompt requests per rate window. |
| `DOLLHOUSE_CLI_APPROVAL_RATE_LIMIT` | `20` | Maximum CLI approval creation requests per rate window. |
| `DOLLHOUSE_PERMISSION_RATE_WINDOW_MS` | `60000` (60s) | Rate limit window in milliseconds for permission prompt and CLI approval operations. |

### Encryption & Memory Security

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_DISABLE_ENCRYPTION` | `false` | When `true`, disables pattern encryption for memory security (Issue #1321). |
| `DOLLHOUSE_ENCRYPTION_SECRET` | _(none)_ | Custom encryption secret for memory pattern encryption. If unset, a default derivation is used. |
| `DOLLHOUSE_ENCRYPTION_SALT` | _(none)_ | Custom salt for encryption key derivation. If unset, a default salt is used. |

### Activation Persistence

Per-session element activation state persistence, introduced in v2.0.0 (Issue #598). Stores activation state at `~/.dollhouse/state/activations-{sessionId}.json`.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_SESSION_ID` | `default` | Session identifier for activation persistence scoping. Must start with a letter, then alphanumeric/hyphens/underscores, 1-64 chars. Examples: `claude-code`, `zulip-bridge`, `dev-local`. |
| `DOLLHOUSE_ACTIVATION_PERSISTENCE` | `true` | Enable/disable activation persistence. Set to `false`, `0`, or `no` to disable. When disabled, element activations are not saved to or restored from disk. |

### Autonomy Evaluation

Controls the autonomy evaluator's risk thresholds and step limits for agent execution. Values are clamped between safety floors and security ceilings.

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE` | `25` | `5` | `50` | Risk score threshold for conservative agents. Actions above this score require human approval. |
| `DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE` | `50` | `20` | `80` | Risk score threshold for moderate agents. Default for most agents. |
| `DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE` | `75` | `40` | `95` | Risk score threshold for aggressive agents. Only pauses on high-risk actions. |
| `DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT` | `10` | `1` | `100` | Default maximum autonomous steps before requiring human check-in (when agent does not specify its own limit). |

### Active Element Limits

Soft limits controlling how many elements can be active at once. When the active set reaches 90% of the limit, stale entries are cleaned up. Values are clamped between a safety floor and a security ceiling.

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_MAX_ACTIVE_SKILLS` | `200` | `5` | `1000` | Max active skills |
| `DOLLHOUSE_MAX_ACTIVE_AGENTS` | `100` | `5` | `500` | Max active agents |
| `DOLLHOUSE_MAX_ACTIVE_MEMORIES` | `100` | `5` | `500` | Max active memories |
| `DOLLHOUSE_MAX_ACTIVE_ENSEMBLES` | `50` | `2` | `200` | Max active ensembles |
| `DOLLHOUSE_MAX_ACTIVE_PERSONAS` | `20` | `2` | `100` | Max active personas |

### Storage Layer & Caching

Centralizes TTL, cooldown, debounce, and global memory budget values used by the storage layer and element managers.

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_SCAN_COOLDOWN_MS` | `1000` | `100` | `60000` | Minimum interval between full directory scans (ms). Prevents excessive I/O on rapid `list()` calls. Legacy alias: `ELEMENT_SCAN_COOLDOWN_MS`. |
| `DOLLHOUSE_INDEX_DEBOUNCE_MS` | `2000` | `100` | `30000` | Debounce interval for persisting `_index.json` in MemoryStorageLayer (ms). Legacy alias: `MEMORY_INDEX_DEBOUNCE_MS`. |
| `DOLLHOUSE_ELEMENT_CACHE_TTL_MS` | `3600000` (1h) | `0` | `3600000` | TTL for element LRU caches in BaseElementManager (ms). Set to `0` to disable TTL. Legacy alias: `ELEMENT_CACHE_TTL_MS`. |
| `DOLLHOUSE_PATH_CACHE_TTL_MS` | `3600000` (1h) | `0` | `3600000` | TTL for file-path-to-ID reverse index caches (ms). Legacy alias: `ELEMENT_PATH_CACHE_TTL_MS`. |
| `DOLLHOUSE_TOOL_CACHE_TTL_MS` | `60000` (1min) | `5000` | `600000` | TTL for tool discovery cache in ServerSetup (ms). |
| `DOLLHOUSE_GLOBAL_CACHE_MEMORY_MB` | `150` | `20` | `1000` | Global memory budget for all registered LRU caches (MB). Triggers eviction from least-active cache when aggregate usage exceeds this limit. |

### Cache Memory Limits

Per-cache-type size and memory limits to prevent unbounded memory growth.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_MAX_PERSONA_CACHE_SIZE` | `50` | Max cached persona entries |
| `DOLLHOUSE_MAX_PERSONA_CACHE_MEMORY` | `25` | Max persona cache memory (MB) |
| `DOLLHOUSE_MAX_METRICS_CACHE_SIZE` | `100` | Max cached metrics entries |
| `DOLLHOUSE_MAX_METRICS_CACHE_MEMORY` | `1` | Max metrics cache memory (MB) |
| `DOLLHOUSE_MAX_SEARCH_CACHE_SIZE` | `100` | Max cached search results |
| `DOLLHOUSE_MAX_SEARCH_CACHE_MEMORY` | `10` | Max search cache memory (MB) |
| `DOLLHOUSE_MAX_INDEX_CACHE_SIZE` | `50` | Max cached index entries |
| `DOLLHOUSE_MAX_INDEX_CACHE_MEMORY` | `25` | Max index cache memory (MB) |
| `DOLLHOUSE_MAX_API_CACHE_SIZE` | `200` | Max cached API responses |
| `DOLLHOUSE_MAX_API_CACHE_MEMORY` | `5` | Max API cache memory (MB) |
| `DOLLHOUSE_CACHE_SAMPLE_SIZE` | `10` | Number of elements sampled in balanced cache size estimation mode (min: 1, max: 100) |

### File Locking

Concurrency control for file operations. Lock timeout is based on p95 operation time analysis (2.5s measured, 4x safety buffer).

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_LOCK_TIMEOUT` | `10000` (10s) | `1000` | `60000` | Default lock acquisition timeout (ms) |
| `DOLLHOUSE_LOCK_STALE_THRESHOLD` | `60000` (60s) | -- | -- | Locks older than this are considered abandoned and can be forcibly released (ms) |
| `DOLLHOUSE_LOCK_MAX_RETRIES` | `3` | -- | -- | Maximum retry attempts for lock acquisition |
| `DOLLHOUSE_LOCK_RETRY_DELAY` | `100` | -- | -- | Initial retry delay (ms); uses exponential backoff from this base |

### Backup Configuration

Controls automatic pre-save and pre-delete element backups.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_BACKUPS_ENABLED` | `true` | Master switch for element backups. Set to `false` to disable automatic pre-save and pre-delete backups. |
| `DOLLHOUSE_MAX_BACKUPS_PER_MEMORY` | `3` | Max backup files per memory name per date folder (min: 1, max: 50). |
| `DOLLHOUSE_MAX_BACKUPS_PER_ELEMENT` | `3` | Max backup files per element per date folder for all non-memory types (min: 1, max: 50). |
| `DOLLHOUSE_BACKUP_RETENTION_DAYS` | `7` | Max age in days for backup date folders before cleanup (min: 1, max: 365). Set to `0` to disable age-based cleanup. |

### Memory Save Throttling

Prevents file descriptor exhaustion from high-frequency memory updates (Issue #656/#657).

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_MEMORY_SAVE_DEBOUNCE_MS` | `2000` | `500` | `30000` | Debounce window for memory saves (ms). Rapid `addEntry` calls are coalesced. |
| `DOLLHOUSE_MEMORY_SAVE_MONITOR_WINDOW_MS` | `60000` (1min) | `5000` | `300000` | Save frequency monitoring window (ms). Tracks `addEntry` calls per memory. |
| `DOLLHOUSE_MEMORY_SAVE_FREQUENCY_WARN` | `50` | `5` | `10000` | Warning threshold: `addEntry` calls per memory per monitor window. |
| `DOLLHOUSE_MEMORY_SAVE_FREQUENCY_CRITICAL` | `200` | `10` | `50000` | Critical threshold: `addEntry` calls per memory per monitor window. Logs error-level alert. |

### Metrics Collection (6 variables)

Controls the built-in metrics collection system: enable/disable, collection interval, snapshot capacity, size limits, failure thresholds, and duration warnings. See `docs/reference/environment-vars.md` for the full table.

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `DOLLHOUSE_METRICS_BATCH_SIZE` | `10` | `1` | `1000` | Number of metrics to batch before flushing to disk |
| `DOLLHOUSE_METRICS_FLUSH_INTERVAL` | `5000` (5s) | `100` | `300000` | Time interval to force flush even if batch not full (ms) |

### GitHub API & Portfolio

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_GITHUB_API_TIMEOUT` | `30000` (30s) | Timeout for GitHub API requests (ms). Min: 5000, max: 300000. |
| `DOLLHOUSE_MAX_FILE_SIZE` | `10485760` (10MB) | Max file size for portfolio submissions (bytes). |
| `DOLLHOUSE_MAX_RETRY_ATTEMPTS` | `3` | Max retry attempts for API operations. |
| `DOLLHOUSE_INITIAL_RETRY_DELAY` | `1000` (1s) | Initial delay between retries (ms). Uses exponential backoff. |
| `DOLLHOUSE_MAX_RETRY_DELAY` | `5000` (5s) | Maximum delay between retries (ms). |
| `DOLLHOUSE_GITHUB_RATE_LIMIT_AUTH` | `5000` | Client-side rate limit for authenticated GitHub API requests (per hour). |
| `DOLLHOUSE_GITHUB_RATE_LIMIT_UNAUTH` | `60` | Client-side rate limit for unauthenticated GitHub API requests (per hour). |
| `DOLLHOUSE_GITHUB_MIN_DELAY` | `1000` (1s) | Minimum delay between GitHub API calls (ms). |
| `DOLLHOUSE_GITHUB_RATE_BUFFER` | `0.9` | Buffer percentage -- stay below actual rate limits to avoid hitting them (0.0-1.0). |
| `DOLLHOUSE_GITHUB_GRAPHQL` | _(none)_ | When set to a truthy value, enables GitHub GraphQL API usage for portfolio indexing. |
| `DOLLHOUSE_GITHUB_CLIENT_ID` | _(none)_ | OAuth client ID override for GitHub authentication. |

### Search & Similarity

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_MIN_SIMILARITY` | `0.3` | Minimum similarity score for name suggestions (0.0 to 1.0). |
| `DOLLHOUSE_MAX_SUGGESTIONS` | `5` | Maximum number of name suggestions to return. |

### Unified Logging

Comprehensive logging system configuration. See `docs/LOGGING-DESIGN.md` for architecture details.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_LOG_DIR` | `~/.dollhouse/logs/` | Base directory for log files. |
| `DOLLHOUSE_LOG_FORMAT` | `text` | Log file format: `text` or `jsonl`. |
| `DOLLHOUSE_LOG_RETENTION_DAYS` | `30` | Days to retain general log files before cleanup. |
| `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS` | `7` | Days to retain security log files. |
| `DOLLHOUSE_LOG_FLUSH_INTERVAL_MS` | `5000` (5s) | Interval between log buffer flushes to disk (ms). |
| `DOLLHOUSE_LOG_BUFFER_SIZE` | `100` | Number of log entries to buffer before flush. |
| `DOLLHOUSE_LOG_MEMORY_CAPACITY` | `5000` | In-memory log ring buffer capacity (general). |
| `DOLLHOUSE_LOG_MEMORY_APP_CAPACITY` | `5000` | In-memory log ring buffer capacity (application). |
| `DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY` | `3000` | In-memory log ring buffer capacity (security). |
| `DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY` | `2000` | In-memory log ring buffer capacity (performance). |
| `DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY` | `1000` | In-memory log ring buffer capacity (telemetry). |
| `DOLLHOUSE_LOG_MAX_ENTRY_SIZE` | `16384` (16KB) | Maximum size of a single log entry (bytes). |
| `DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE` | `50` | Threshold rate that triggers immediate flush instead of buffered flush. |
| `DOLLHOUSE_LOG_FILE_MAX_SIZE` | `104857600` (100MB) | Maximum size per log file before rotation (bytes). |
| `DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES` | `0` (unlimited) | Maximum total size for the log directory (bytes). Set to `0` for unlimited. |
| `DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY` | `100` | Maximum log files per category before oldest are pruned. |
| `DOLLHOUSE_LOG_VIEWER` | `false` | When `true`, enables the built-in log viewer HTTP endpoint. |
| `DOLLHOUSE_LOG_VIEWER_PORT` | `9100` | Port for the log viewer HTTP server. |

### Status Indicator

Customize how persona information is displayed in AI responses. All variables are optional overrides.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_INDICATOR_ENABLED` | `true` | Whether to show the persona indicator. |
| `DOLLHOUSE_INDICATOR_STYLE` | `full` | Format style: `full`, `minimal`, `compact`, `custom`. |
| `DOLLHOUSE_INDICATOR_FORMAT` | _(none)_ | Custom format template (auto-sets style to `custom`). Placeholders: `{emoji}`, `{name}`, `{version}`, `{author}`, `{category}`. |
| `DOLLHOUSE_INDICATOR_EMOJI` | (theatre masks) | Emoji to use in the indicator. |
| `DOLLHOUSE_INDICATOR_BRACKETS` | `square` | Bracket style: `square`, `round`, `curly`, `angle`, `none`. |
| `DOLLHOUSE_INDICATOR_SHOW_VERSION` | `true` | Whether to include version in the indicator. |
| `DOLLHOUSE_INDICATOR_SHOW_AUTHOR` | `true` | Whether to include author in the indicator. |
| `DOLLHOUSE_INDICATOR_SHOW_CATEGORY` | `false` | Whether to include category in the indicator. |

### Telemetry

Analytics and telemetry. Opt-in only -- disabled by default.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_TELEMETRY` | `false` | Master switch for operational telemetry. Set to `true` or `1` to enable. |
| `DOLLHOUSE_TELEMETRY_OPTIN` | `false` | Opt-in to remote telemetry via default PostHog project. |
| `DOLLHOUSE_TELEMETRY_NO_REMOTE` | `false` | When `true`, disables all remote telemetry (local-only mode). |
| `DOLLHOUSE_TELEMETRY_ENABLED` | `false` | Alternative flag checked by portfolio indexer for telemetry enablement. |
| `POSTHOG_API_KEY` | _(none)_ | Custom PostHog API key. Takes precedence over the default project key when `DOLLHOUSE_TELEMETRY_OPTIN=true`. PostHog keys are write-only and safe to expose publicly. |

### Runtime Identity & Paths

These variables configure the runtime identity and filesystem paths used by the server. Most are auto-detected but can be overridden.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_USER` | _(auto-detected)_ | Override the current user identity. Used for element authorship metadata. Falls back to OS username. |
| `DOLLHOUSE_EMAIL` | _(none)_ | User email, typically set by PersonaManager when a persona specifies an email. |
| `DOLLHOUSE_PORTFOLIO_DIR` | `~/.dollhouse/portfolio/` | Override the local portfolio directory path. |
| `DOLLHOUSE_PORTFOLIO_URL` | _(none)_ | Override the GitHub portfolio repository URL. |
| `DOLLHOUSE_HOME_DIR` | `~` (os.homedir) | Override the home directory for telemetry and auth file storage. |
| `DOLLHOUSE_CACHE_DIR` | _(auto)_ | Override the collection cache directory path. |
| `DOLLHOUSE_OAUTH_HELPER` | _(none)_ | Override the OAuth helper binary path for GitHub authentication. |
| `DOLLHOUSE_DEBUG` | _(none)_ | Enable extra debug output at server startup. When set, additional diagnostic info is logged. |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION` | `false` | Auto-submit new elements to community collection. |
| `ENABLE_DEBUG` | `false` | Enable debug mode and verbose logging. |
| `DOLLHOUSE_ENABLE_FILE_WATCHER` | `false` | Enable filesystem watchers for automatic element reloading on file changes. |
| `DOLLHOUSE_DISABLE_AUTOLOAD` | `false` | Emergency switch to disable automatic element loading on startup. Prevents autoload of memories and other elements. |
| `DOLLHOUSE_LOAD_TEST_DATA` | _(none)_ | When set, controls whether bundled test/default data elements are loaded by `DefaultElementProvider`. |

### Test Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_BASE_DIR` | _(auto)_ | Auto-configured -- DO NOT SET manually |
| `TEST_PERSONAS_DIR` | _(auto)_ | Auto-configured -- DO NOT SET manually |
| `TEST_CACHE_DIR` | _(auto)_ | Auto-configured -- DO NOT SET manually |
| `TEST_CONFIG_DIR` | _(auto)_ | Auto-configured -- DO NOT SET manually |
| `TEST_VERBOSE_LOGGING` | `false` | Enable verbose test output (optional) |
| `TEST_TIMEOUT` | `60000` | Test timeout in milliseconds (optional) |
| `DOLLHOUSE_TEST_DEFERRED_DELAY_MS` | `0` | Artificial delay for deferred tool registration in tests (ms). For testing only. |

---

## Security Best Practices

### DO

- **Store tokens securely:** Use external files with proper permissions (chmod 600)
- **Use separate test accounts:** Never test with production credentials
- **Add .env.local to .gitignore:** Already configured, but verify
- **Rotate tokens regularly:** Generate new tokens every 90 days
- **Use minimal scopes:** Only request the permissions you need
- **Keep Gatekeeper enabled:** Do not set `DOLLHOUSE_GATEKEEPER_ENABLED=false` in production

### DON'T

- **Never commit secrets:** Don't commit `.env`, `.env.local`, or token files
- **Never hardcode tokens:** Don't put tokens directly in source code
- **Never share tokens:** Each developer should have their own token
- **Never use production for testing:** Always use a separate test account
- **Never commit shell scripts with tokens:** Add them to .gitignore
- **Never disable the Gatekeeper in production:** `DOLLHOUSE_GATEKEEPER_ENABLED=false` removes the policy enforcement layer
- **Never set `DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN` in `.env`:** Use `.env.local` or a secrets manager

### Token Storage Security

**Secure file permissions:**
```bash
# Create token file with restricted permissions
touch ~/.config/dollhouse/github-token
chmod 600 ~/.config/dollhouse/github-token
echo 'your_token' > ~/.config/dollhouse/github-token

# Verify permissions
ls -l ~/.config/dollhouse/github-token
# Should show: -rw------- (only owner can read/write)
```

### What's Safe to Commit

**Safe to commit:**
- `.env.example` - Template with placeholder values
- Documentation mentioning variable names
- Shell scripts that READ from environment (not set values)

**Never commit:**
- `.env` - May contain real values
- `.env.local` - Personal secrets
- `.env.*.local` - Environment-specific secrets
- Shell scripts with actual token values
- Any file containing `ghp_`, `github_pat_`, or `gho_` tokens
- Files containing `DOLLHOUSE_ENCRYPTION_SECRET` or `DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN` values

---

## Troubleshooting

### Tests Are Skipping

**Symptom:**
```
Skipping E2E tests - GITHUB_TEST_TOKEN not available
```

**Solution:**
```bash
# Check if token is set
echo $GITHUB_TOKEN

# If empty, load it:
export GITHUB_TOKEN=$(cat ~/.config/dollhouse/github-token)

# Or add to .env.local:
echo "GITHUB_TOKEN=ghp_your_token" >> .env.local
```

### Invalid Token Format Error

**Symptom:**
```
Invalid GitHub token format
Expected: ghp_* or github_pat_* or gho_*
Received: $(cat ~/.config/dollhouse/github-token)
```

**Cause:** Shell command stored as literal string, not evaluated

**Solution:**
```bash
# WRONG - stores command as string
export GITHUB_TOKEN='$(cat ~/.config/dollhouse/github-token)'

# CORRECT - evaluates command
export GITHUB_TOKEN=$(cat ~/.config/dollhouse/github-token)
```

### Tests Accessing Production Data

**Symptom:**
```
SECURITY ERROR: Test environment is pointing to production portfolio
Path: /home/user/.dollhouse/portfolio
```

**Cause:** Test trying to access real user data

**Solution:**
```bash
# Remove production directory override
unset DOLLHOUSE_PORTFOLIO_DIR

# Tests will automatically use .test-tmp/ instead
```

### Build Errors

**Symptom:**
```
Error: GITHUB_TOKEN is required
```

**Solution:**

GITHUB_TOKEN is now optional for building. If you see this error:

1. Check that you're using the latest code
2. Set the token in your environment:
   ```bash
   export GITHUB_TOKEN='ghp_your_token'
   ```
3. Or add to `.env.local`

### Permission Denied

**Symptom:**
```
Error: EACCES: permission denied, open '~/.config/dollhouse/github-token'
```

**Solution:**
```bash
# Fix file permissions
chmod 600 ~/.config/dollhouse/github-token

# Fix directory permissions
chmod 700 ~/.config/dollhouse
```

### Gatekeeper Blocking Operations

**Symptom:**
```
Operation denied by Gatekeeper policy
```

**Solution:**
1. Check that your element policies are correct (not overly restrictive)
2. For debugging, temporarily set `DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES=false` to isolate whether the issue is from element policies or route defaults
3. Do NOT disable `DOLLHOUSE_GATEKEEPER_ENABLED` in production

### Activation State Not Restoring

**Symptom:** Elements activated in a previous session are not restored on restart.

**Solution:**
1. Check that `DOLLHOUSE_ACTIVATION_PERSISTENCE` is not set to `false`
2. Verify `DOLLHOUSE_SESSION_ID` matches between sessions (defaults to `default`)
3. Check `~/.dollhouse/state/activations-{sessionId}.json` exists and is valid JSON

---

## Example Configurations

### Minimal Production Setup

```bash
# .env.local
GITHUB_TOKEN=ghp_abc123xyz789
GITHUB_USERNAME=john-doe
PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio  # Just repo name
```

### Full Development Setup

```bash
# .env.local

# Production credentials
GITHUB_TOKEN=ghp_abc123xyz789
GITHUB_USERNAME=john-doe
PORTFOLIO_REPOSITORY_NAME=dollhouse-portfolio  # Just repo name

# Test credentials (different account!)
GITHUB_TEST_TOKEN=ghp_test456uvw321
GITHUB_TEST_USERNAME=john-doe-test
GITHUB_TEST_REPOSITORY=dollhouse-test-sandbox  # Just repo name

# Server config
PORT=3000
LOG_LEVEL=debug
NODE_ENV=development

# Features
ENABLE_DEBUG=true
TEST_VERBOSE_LOGGING=true
```

### Bridge / Headless Session Setup

```bash
# .env.local for bridge deployments

# Session identity (used by activation persistence)
DOLLHOUSE_SESSION_ID=zulip-bridge

# Security: keep Gatekeeper fully enabled
DOLLHOUSE_GATEKEEPER_ENABLED=true
DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES=true

# Policy export for bridge permission-prompt integration
DOLLHOUSE_POLICY_EXPORT_ENABLED=true

# Autonomy: conservative for headless operation
DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE=20
DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT=5
```

### CI/CD Configuration (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        env:
          GITHUB_TEST_TOKEN: ${{ secrets.TEST_GITHUB_TOKEN }}
          GITHUB_TEST_USERNAME: ${{ secrets.TEST_GITHUB_USERNAME }}
          GITHUB_TEST_REPOSITORY: ${{ secrets.TEST_GITHUB_REPOSITORY }}
          NODE_ENV: test
        run: npm test
```

---

## Additional Resources

- **Default Configuration:** `.env` file in project root
- **Personal Configuration Template:** `.env.example` in project root
- **Security Guide:** `docs/security/measures.md`
- **Logging Design:** `docs/LOGGING-DESIGN.md`
- **Testing Guide:** `docs/developer-guide/testing-strategy.md`
- **Remote Agent Approval:** `docs/guides/remote-agent-approval-pattern.md`
- **GitHub Token Setup:** https://github.com/settings/tokens

---

**Need Help?**

- Check existing issues: https://github.com/DollhouseMCP/mcp-server/issues
- Review test setup: `tests/jest.setup.ts`
- Consult team documentation in `docs/`
- See all available options in `.env` file

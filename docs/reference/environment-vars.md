# Environment Variables

Environment variables allow you to tweak runtime behavior without editing the YAML configuration file. This page groups commonly used variables by purpose. Unless noted, all variables are optional and default to sane values.

> Many of these settings can also be managed through `dollhouse_config`. Use environment variables when you need one-off overrides (CI, tests, container deployments).

---

## Core Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `DOLLHOUSE_GITHUB_CLIENT_ID` | Overrides the OAuth client ID used by `setup_github_auth`. If unset, the bundled public client is used. | Bundled client |
| `DOLLHOUSE_PORTFOLIO_DIR` | Forces the portfolio base directory (instead of `~/.dollhouse/portfolio`). Must be an absolute path. | `~/.dollhouse/portfolio` |
| `DOLLHOUSE_CACHE_DIR` | Custom cache directory for collection/index caches. | `<cwd>/.dollhousemcp/cache` |
| `DOLLHOUSE_DEBUG` | Enables verbose logging when set to a truthy value. | Disabled |

---

## Portfolio & GitHub Tweaks

Defined in `src/config/portfolio-constants.ts` and related modules.

| Variable | Description | Default |
|----------|-------------|---------|
| `DOLLHOUSE_GITHUB_API_TIMEOUT` | Request timeout (ms) for GitHub API calls. | `30000` |
| `DOLLHOUSE_MAX_FILE_SIZE` | Maximum element file size accepted for uploads (bytes). | `10 * 1024 * 1024` |
| `DOLLHOUSE_MAX_RETRY_ATTEMPTS` / `DOLLHOUSE_INITIAL_RETRY_DELAY` / `DOLLHOUSE_MAX_RETRY_DELAY` | Retry strategy for GitHub operations. | `3`, `1000`, `5000` |
| `DOLLHOUSE_MIN_SIMILARITY` | Similarity threshold used during duplicate detection. | `0.3` |
| `DOLLHOUSE_MAX_SUGGESTIONS` | Max number of name suggestions when detection fails. | `5` |
| `DOLLHOUSE_GITHUB_RATE_LIMIT_AUTH` / `DOLLHOUSE_GITHUB_RATE_LIMIT_UNAUTH` | Rate-limit ceilings used by the throttler. | `5000`, `60` |
| `DOLLHOUSE_GITHUB_MIN_DELAY` / `DOLLHOUSE_GITHUB_RATE_BUFFER` | Delay and buffer applied near rate limits. | `1000`, `0.9` |
| `DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION` | Internal flag used during auto submit flows (normally managed by `portfolio_config`). | _Unset_ |

---

## Indicator Customization

`src/config/indicator-config.ts` reads these variables before falling back to the YAML config.

| Variable | Effect |
|----------|--------|
| `DOLLHOUSE_INDICATOR_ENABLED` (`true` / `false`) |
| `DOLLHOUSE_INDICATOR_STYLE` (`full`, `minimal`, `compact`, `custom`) |
| `DOLLHOUSE_INDICATOR_FORMAT` (custom template when style is `custom`) |
| `DOLLHOUSE_INDICATOR_EMOJI` |
| `DOLLHOUSE_INDICATOR_BRACKETS` (`square`, `round`, `none`) |
| `DOLLHOUSE_INDICATOR_SHOW_VERSION` / `_AUTHOR` / `_CATEGORY` (`true` / `false`) |

Use these for quick experimentation; persist long-term preferences via `dollhouse_config`.

---

## Active Element Limits

`src/config/active-element-limits.ts` reads these variables to control how many elements of each type can be active simultaneously. These are **soft limits** — when the active set reaches 90% of the limit, stale entries (elements that no longer exist on disk) are proactively cleaned up. A warning is logged if the active set reaches the full limit.

| Variable | Default | Min | Max (Hard Limit) |
|----------|---------|-----|-------------------|
| `DOLLHOUSE_MAX_ACTIVE_SKILLS` | `200` | `5` | `1000` |
| `DOLLHOUSE_MAX_ACTIVE_AGENTS` | `100` | `5` | `500` |
| `DOLLHOUSE_MAX_ACTIVE_MEMORIES` | `100` | `5` | `500` |
| `DOLLHOUSE_MAX_ACTIVE_ENSEMBLES` | `50` | `2` | `200` |
| `DOLLHOUSE_MAX_ACTIVE_PERSONAS` | `20` | `2` | `100` |

Values outside the min/max range are clamped with a warning. Non-numeric values fall back to the default. The cleanup threshold is calculated as `floor(max * 0.9)`.

```bash
# Example: lower persona limit for testing
DOLLHOUSE_MAX_ACTIVE_PERSONAS=5

# Example: raise skills limit for large portfolios
DOLLHOUSE_MAX_ACTIVE_SKILLS=500
```

---

## Permission Prompt & CLI Approvals (Issue #625)

Controls for the `permission_prompt` operation, which delegates CLI-level permission decisions when Claude Code is launched with `--permission-prompt-tool`. These tune rate limiting, approval record capacity, and TTL.

| Variable | Purpose | Default |
|----------|---------|---------|
| `DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT` | Max `permission_prompt` evaluations per rate window. Increase for high-throughput agent sessions. | `100` |
| `DOLLHOUSE_CLI_APPROVAL_RATE_LIMIT` | Max CLI approval record creations per rate window. Prevents approval request flooding. | `20` |
| `DOLLHOUSE_PERMISSION_RATE_WINDOW_MS` | Rate window duration (ms) for both limiters above. | `60000` (60s) |
| `DOLLHOUSE_CLI_APPROVAL_MAX` | Maximum pending CLI approval records before LRU eviction. | `50` |
| `DOLLHOUSE_CLI_APPROVAL_TTL_MS` | Default TTL (ms) for unapproved CLI approval records. Per-record TTL from element policies overrides this. Clamped to 1s–24h. | `300000` (5 min) |

```bash
# Example: higher throughput for automated bridge sessions
DOLLHOUSE_PERMISSION_PROMPT_RATE_LIMIT=500
DOLLHOUSE_PERMISSION_RATE_WINDOW_MS=60000

# Example: longer approval window for async human review
DOLLHOUSE_CLI_APPROVAL_TTL_MS=900000  # 15 minutes
```

---

## Gatekeeper Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `DOLLHOUSE_GATEKEEPER_ENABLED` | Enable/disable the 4-layer Gatekeeper enforce() pipeline. When false, falls back to route validation only. | `true` |

---

## Metrics Collection

`src/config/env.ts` reads these variables to control the built-in metrics collection system. All variables are optional — metrics are enabled by default with sensible defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_METRICS_ENABLED` | `true` | Enable/disable the metrics collection system. When false, no collectors run and no snapshots are stored. |
| `DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS` | `15000` | Interval (ms) between collection cycles. Clamped to 1000–300000. |
| `DOLLHOUSE_METRICS_MEMORY_SNAPSHOT_CAPACITY` | `240` | Max snapshots retained in the in-memory ring buffer. Clamped to 10–10000. At default interval, 240 = ~1 hour of history. |
| `DOLLHOUSE_METRICS_MAX_SNAPSHOT_SIZE` | `102400` | Max serialized snapshot size (bytes) accepted by sinks. Snapshots exceeding this are dropped with a warning. |
| `DOLLHOUSE_METRICS_COLLECTOR_FAILURE_THRESHOLD` | `10` | Consecutive failures before a collector is disabled. Clamped to 1–100. |
| `DOLLHOUSE_METRICS_COLLECTION_DURATION_WARN_MS` | `5000` | Log a warning if a collection cycle exceeds this duration (ms). Clamped to 100–60000. |

```bash
# Example: disable metrics in CI
DOLLHOUSE_METRICS_ENABLED=false

# Example: faster collection for debugging
DOLLHOUSE_METRICS_COLLECTION_INTERVAL_MS=5000
```

---

## Testing & CI

| Variable | Purpose |
|----------|---------|
| `TOOLCACHE_THRESHOLD_MS` | Adjusts performance thresholds for ToolCache tests (slow CI runners). |
| `TEST_GITHUB_REPO` | Points tests at a specific GitHub repo (used in CI fixtures). |
| `TEST_MODE` | Enables test-specific behavior in managers and configuration loaders. |
| `NODE_ENV` | Standard Node toggle (`test`, `development`, `production`). |

CI pipelines usually set these via workflow files (GitHub Actions, etc.).

---

## Other Development Flags

| Variable | Purpose |
|----------|---------|
| `PERSONAS_DIR` (legacy) | Used by `PathValidator` fallbacks; prefer `DOLLHOUSE_PORTFOLIO_DIR`. |
| `DOLLHOUSE_CACHE_DIR` | Shared cache location for collection/index data. |
| `DOLLHOUSE_MEMORY_*` | (When implemented) memory-system storage options. |

---

## Tips

- Environment variables generally win over the YAML config. If something isn’t behaving as expected, run `env | grep DOLLHOUSE` to ensure you’re not unintentionally overriding a setting.
- Document any project-specific environment requirements in your team README or CI configuration for reproducibility.
- For quick overrides during development, you can prefix commands:  
  `DOLLHOUSE_DEBUG=true npm run inspector`

Keep this list updated as new tunables are added or deprecated.

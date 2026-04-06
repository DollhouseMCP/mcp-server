# Logging Configuration Guide

**Version**: 1.0
**Last Updated**: February 2026
**Purpose**: Configure, query, and read DollhouseMCP server logs

---

## Table of Contents

- [Quick Start](#quick-start)
- [How Logging Works](#how-logging-works)
- [Log Levels](#log-levels)
- [Log Categories](#log-categories)
- [Output Destinations](#output-destinations)
  - [Disk Files](#disk-files-filelogsink)
  - [In-Memory Buffer](#in-memory-buffer-memorylogsink)
  - [Browser Viewer](#browser-viewer-sselogsink)
- [Disk Format](#disk-format)
  - [Plain Text](#plain-text-default)
  - [JSONL](#jsonl)
- [Querying Logs](#querying-logs)
  - [MCP Tool: query_logs](#mcp-tool-query_logs)
  - [HTTP Viewer Endpoints](#http-viewer-endpoints)
  - [Command-Line](#command-line-grep-jq)
- [Correlation IDs](#correlation-ids)
- [Automatic Redaction](#automatic-redaction)
- [Environment Variable Reference](#environment-variable-reference)
- [Example Configurations](#example-configurations)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

Logging works out of the box with zero configuration. By default the server logs to `~/.dollhouse/logs/` at the `info` level using plain text format.

**1. Set the log level** (optional — defaults to `info`):

```bash
export LOG_LEVEL=debug
```

**2. Check your log files:**

```bash
ls ~/.dollhouse/logs/
# application-2026-02-11.log
# security-2026-02-11.log
# performance-2026-02-11.log
# telemetry-2026-02-11.log
```

**3. Enable the browser viewer** (optional):

```bash
export DOLLHOUSE_WEB_CONSOLE=true
# Open http://dollhouse.localhost:41715 and click the Logs tab
```

**4. Query logs via MCP:**

```
query_logs category="security" level="warn"
```

> **Note on `~` expansion**: The default `DOLLHOUSE_LOG_DIR` is `~/.dollhouse/logs/`. The `~` is expanded at runtime via `os.homedir()` (Node.js), which resolves to:
> - **Linux**: `/home/<user>/.dollhouse/logs/`
> - **macOS**: `/Users/<user>/.dollhouse/logs/`
> - **Windows**: `C:\Users\<user>\.dollhouse\logs\`
>
> You can override this entirely by setting `DOLLHOUSE_LOG_DIR` to an absolute path (e.g., `/var/log/dollhouse/`). The `~` prefix is only expanded if the path starts with `~`; absolute paths are used as-is.

---

## How Logging Works

All server subsystems emit structured log entries that flow through a central `LogManager`, which routes them to three output destinations:

```
┌──────────────────────┐
│   Server Systems     │
│                      │
│  MCPLogger           │
│  SecurityMonitor     │
│  SecurityTelemetry   │    ┌───────────────────┐
│  SecurityAuditor     │───▶│    LogManager      │
│  PerformanceMonitor  │    │                    │
│  ElementEvent-       │    │  Level filtering   │
│    Dispatcher        │    │  Size enforcement  │
│  OperationalTelemetry│    │  Flush scheduling  │
│  FileLockManager     │    └─────┬───┬───┬──────┘
│  DefaultElement-     │          │   │   │
│    Provider          │          ▼   ▼   ▼
│  LRUCache            │   ┌────┐ ┌────┐ ┌────────┐
│  StateChangeNotifier │   │Disk│ │Mem │ │Browser │
│  TriggerMetrics-     │   │    │ │    │ │Viewer  │
│    Tracker           │   └────┘ └────┘ └────────┘
└──────────────────────┘
```

**Flush strategy**: Security `warn`/`error` entries trigger an immediate flush (rate-limited to 50/second — excess entries fall back to the normal buffered path). All other entries are buffered — a flush occurs when the buffer reaches 100 entries or every 5 seconds, whichever comes first. Graceful shutdown flushes all pending entries before the process exits.

---

## Log Levels

| Level | Priority | Description | Example |
|-------|----------|-------------|---------|
| `debug` | 0 | Verbose diagnostics | Cache eviction, lock timing, element load start |
| `info` | 1 | Normal operations | Element loaded, state change, telemetry checkpoint |
| `warn` | 2 | Recoverable issues | Cache >90% full, lock timeout, entry truncated |
| `error` | 3 | Failures requiring attention | Path traversal blocked, element save error |

`LOG_LEVEL` sets the minimum level — entries below this level are discarded before reaching any sink. Setting `LOG_LEVEL=warn` shows only `warn` and `error` entries.

---

## Log Categories

| Category | Purpose | Key Sources | Retention |
|----------|---------|-------------|-----------|
| `application` | General server operations | MCPLogger, ElementEventDispatcher, StateChangeNotifier | 30 days |
| `security` | Security events and audit trail | SecurityMonitor, SecurityTelemetry, SecurityAuditor | 7 days |
| `performance` | Metrics, cache, and contention | PerformanceMonitor, FileLockManager, LRUCache, DefaultElementProvider | 30 days |
| `telemetry` | Installation health | OperationalTelemetry, TriggerMetricsTracker | 30 days |

> Telemetry log entries record server health metrics — see the [Telemetry Guide](telemetry.md) for privacy controls and opt-in details.

Each category gets its own file on disk and its own in-memory queue with independent capacity.

---

## Output Destinations

### Disk Files (FileLogSink)

Log files are written to disk automatically. This is the durable store — in-memory buffers are lost on restart, but disk files persist.

**Directory**: `~/.dollhouse/logs/` by default, created automatically with `0700` permissions (owner-only access).

**Platform-specific paths:**

| Platform | Default Path |
|----------|-------------|
| Linux | `/home/<user>/.dollhouse/logs/` |
| macOS | `/Users/<user>/.dollhouse/logs/` |
| Windows | `C:\Users\<user>\.dollhouse\logs\` |

**File naming**: `{category}-{YYYY-MM-DD}[.{seq}]{.log|.jsonl}`

```
~/.dollhouse/logs/
├── application-2026-02-11.log
├── security-2026-02-11.log
├── performance-2026-02-11.log
├── telemetry-2026-02-11.log
└── security-2026-02-10.log
```

**Rotation**:
- **Date-based**: A new file is created at UTC midnight each day.
- **Size-based**: When a file exceeds 100 MB (default), a sequence suffix is appended: `application-2026-02-11.1.log`, `application-2026-02-11.2.log`, etc.

**Retention**: Expired files are automatically cleaned up on startup and once every 24 hours. Security logs are retained for 7 days by default; all other categories for 30 days. Set `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS` to a higher value for compliance deployments.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_LOG_DIR` | `~/.dollhouse/logs/` | Log file directory |
| `DOLLHOUSE_LOG_FORMAT` | `text` | Disk format: `text` or `jsonl` |
| `DOLLHOUSE_LOG_RETENTION_DAYS` | `30` | Retention for non-security logs (days) |
| `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS` | `7` | Retention for security logs (days) — increase for compliance deployments |
| `DOLLHOUSE_LOG_FILE_MAX_SIZE` | `104857600` | Max file size before rotation (bytes, default 100 MB) |
| `DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY` | `100` | Max rotated files per category; oldest deleted first (`0` = disabled) |
| `DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES` | `0` | Total log directory size cap in bytes; oldest deleted by mtime (`0` = disabled) |

### In-Memory Buffer (MemoryLogSink)

The in-memory buffer stores recent entries in four ring-buffer queues — one per category. This is what `query_logs` searches against.

| Queue | Default Capacity |
|-------|-----------------|
| `application` | 5,000 entries |
| `security` | 3,000 entries |
| `performance` | 2,000 entries |
| `telemetry` | 1,000 entries |

When a queue reaches capacity, the oldest entry is evicted to make room. These entries are **lost on restart** — use disk files for historical data.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_LOG_MEMORY_APP_CAPACITY` | `5000` | Application queue capacity |
| `DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY` | `3000` | Security queue capacity |
| `DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY` | `2000` | Performance queue capacity |
| `DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY` | `1000` | Telemetry queue capacity |

### Browser Viewer (Web Console)

The management console at `http://dollhouse.localhost:41715` includes a real-time log viewer under the **Logs** tab. It is enabled by default via `DOLLHOUSE_WEB_CONSOLE=true`.

**API Endpoints (on port 41715):**

| Path | Method | Description |
|------|--------|-------------|
| `/api/logs` | GET | JSON query endpoint (same filters as `query_logs`) |
| `/api/logs/stream` | GET | Server-Sent Events (SSE) stream — real-time entries |
| `/api/logs/stats` | GET | Queue sizes and capacities |
| `/api/health` | GET | Health check — uptime, sink stats, SSE client counts |

**Features**: Virtual-scrolling log viewer (10K entry buffer), color-coded log levels, category/level/source filters, text search, pause/resume streaming, expandable entry detail, automatic backfill on connect.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLLHOUSE_WEB_CONSOLE` | `true` | Enable the unified web console (logs + metrics) |
| `DOLLHOUSE_LOG_VIEWER` | `false` | **Deprecated** — use `DOLLHOUSE_WEB_CONSOLE` instead |
| `DOLLHOUSE_LOG_VIEWER_PORT` | `9100` | **Deprecated** — console uses port 41715 |

---

## Disk Format

### Plain Text (default)

File extension: `.log`

Format:
```
[timestamp] [LEVEL] [Source] [correlationId?] message
  key: value
  key: value

```

Example:
```
[2026-02-11 14:32:01.123] [INFO] [MCPLogger] Server initialized
  version: 1.9.20

[2026-02-11 14:32:01.456] [WARN] [SecurityMonitor] [1707654321000-a1b2c3d4] [RATE_LIMIT] Rate limit threshold approaching
  eventType: RATE_LIMIT
  severity: MEDIUM
  sourceComponent: RequestHandler

[2026-02-11 14:32:02.789] [ERROR] [ElementEventDispatcher] [1707654321000-a1b2c3d4] element:save:error [persona:MyPersona]
  Error: EACCES: permission denied
    at Object.openSync (fs.js:498:3)
    at writeFileSync (fs.js:1524:35)
```

### JSONL

File extension: `.jsonl`

One JSON object per line with abbreviated field names for compactness:

| Full Name | JSONL Key |
|-----------|-----------|
| `id` | `id` |
| `timestamp` | `ts` |
| `level` | `level` |
| `category` | `cat` |
| `source` | `src` |
| `message` | `msg` |
| `data` | `data` |
| `error` | `error` |
| `correlationId` | `correlationId` |

Example:
```json
{"id":"LOG-1707654321000-0","ts":"2026-02-11T14:32:01.123Z","level":"info","cat":"application","src":"MCPLogger","msg":"Server initialized","data":{"version":"1.9.20"}}
{"id":"LOG-1707654321000-1","ts":"2026-02-11T14:32:01.456Z","level":"warn","cat":"security","src":"SecurityMonitor","msg":"[RATE_LIMIT] Rate limit threshold approaching","correlationId":"1707654321000-a1b2c3d4"}
```

> **Recommendation**: Use `text` format for human reading and `jsonl` for automation, `jq` queries, and log aggregation pipelines.

---

## Querying Logs

### MCP Tool: `query_logs`

The `query_logs` tool searches the in-memory buffer. All filters are optional and applied conjunctively (AND logic). Results are sorted newest-first.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `category` | `string` | Filter by category: `application`, `security`, `performance`, `telemetry`, or `all` (default) |
| `level` | `string` | Minimum level: `debug`, `info`, `warn`, `error` |
| `source` | `string` | Substring match on source name (case-insensitive) |
| `message` | `string` | Substring match on message text (case-insensitive) |
| `since` | `string` | ISO 8601 timestamp — entries after this time |
| `until` | `string` | ISO 8601 timestamp — entries before this time |
| `correlationId` | `string` | Exact match on correlation ID |
| `limit` | `number` | Max results (1–500, default 50) |
| `offset` | `number` | Skip N results for pagination (default 0) |

**Example queries:**

```
# Recent security warnings
query_logs category="security" level="warn"

# Errors from a specific source
query_logs level="error" source="FileLockManager"

# All entries for a specific request
query_logs correlationId="1707654321000-a1b2c3d4"

# Performance entries in the last hour
query_logs category="performance" since="2026-02-11T13:00:00Z"
```

> **Note**: `query_logs` searches only the in-memory buffer — it covers recent activity (typically the last few hours depending on volume). For production debugging of past events, query the disk files directly using `grep` or `jq` (see [Command-Line](#command-line-grep-jq)).

### HTTP Viewer Endpoints

When the browser viewer is enabled (`DOLLHOUSE_LOG_VIEWER=true`):

```bash
# JSON query (same parameters as query_logs)
curl "http://127.0.0.1:41715/api/logs?category=security&level=warn&limit=10"

# SSE stream with filters (-N disables output buffering for real-time streaming)
curl -N "http://127.0.0.1:41715/api/logs/stream?category=security&level=error"

# Health check
curl "http://127.0.0.1:41715/api/health"
```

### Command-Line (grep, jq)

**Plain text files:**

```bash
# Find all errors
grep '^\[.*\] \[ERROR\]' ~/.dollhouse/logs/application-2026-02-11.log

# Find entries with a specific correlation ID
grep 'a1b2c3d4' ~/.dollhouse/logs/security-2026-02-11.log

# Tail security logs in real time
tail -f ~/.dollhouse/logs/security-$(date -u +%Y-%m-%d).log
```

**JSONL files:**

```bash
# Filter errors
cat ~/.dollhouse/logs/application-2026-02-11.jsonl | jq 'select(.level == "error")'

# Find entries by correlation ID
cat ~/.dollhouse/logs/security-2026-02-11.jsonl | jq 'select(.correlationId == "1707654321000-a1b2c3d4")'

# Count entries by level
cat ~/.dollhouse/logs/application-2026-02-11.jsonl | jq -s 'group_by(.level) | map({level: .[0].level, count: length})'

# Extract messages from warnings
cat ~/.dollhouse/logs/performance-2026-02-11.jsonl | jq 'select(.level == "warn") | .msg'
```

---

## Correlation IDs

Every MCP tool call is assigned a unique correlation ID with the format `{timestamp}-{randomHex}` (e.g., `1707654321000-a1b2c3d4`). All log entries produced while handling that request share the same correlation ID, making it easy to trace a complete request lifecycle.

**Tracing a request:**

1. Find the entry you're interested in — note its `correlationId`:
   ```
   [2026-02-11 14:32:02.789] [ERROR] [ElementEventDispatcher] [1707654321000-a1b2c3d4] element:save:error [persona:MyPersona]
   ```

2. Query all entries with that ID:
   ```
   query_logs correlationId="1707654321000-a1b2c3d4"
   ```

3. Review the full timeline — from request start through each subsystem to completion:
   ```
   14:32:01.000 [INFO]  [MCPLogger]               Request received: create_element
   14:32:01.100 [DEBUG] [FileLockManager]          Lock acquired: persona/MyPersona
   14:32:02.789 [ERROR] [ElementEventDispatcher]   element:save:error [persona:MyPersona]
   14:32:02.800 [DEBUG] [FileLockManager]          Lock released: persona/MyPersona
   ```

> **Note**: Background tasks (cleanup timers, retention enforcement) run outside any request context and may not have a correlation ID.

---

## Automatic Redaction

Sensitive data is redacted **before** it reaches any sink — all three destinations (disk, memory, browser viewer) see the sanitized version.

**Field-name matching** (exact, case-insensitive):
`password`, `token`, `secret`, `key`, `authorization`, `auth`, `credential`, `private`, `session`, `cookie`

**Substring patterns** (matches anywhere in field name):
`api_key`, `apikey`, `access_token`, `refresh_token`, `client_secret`, `client_id`, `bearer`, `oauth`

**Message patterns** (regex-based):
- Key-value: `token=abc123` → `token=[REDACTED]`
- Bearer tokens: `Bearer eyJhbG...` → `Bearer [REDACTED]`
- API keys: `sk-proj-abc123` → `sk-[REDACTED]`

If you see `[REDACTED]` in your logs, this is expected and intentional. The original sensitive values are never written to any log destination.

---

## Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| **General** | | |
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error` |
| `DOLLHOUSE_LOG_DIR` | `~/.dollhouse/logs/` | Log file directory (`~` expanded via `os.homedir()`) |
| `DOLLHOUSE_LOG_FORMAT` | `text` | Disk format: `text` or `jsonl` |
| **Disk** | | |
| `DOLLHOUSE_LOG_RETENTION_DAYS` | `30` | Retention for non-security logs (days) |
| `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS` | `7` | Retention for security logs (days) |
| `DOLLHOUSE_LOG_FILE_MAX_SIZE` | `104857600` | Max file size before rotation (bytes, 100 MB) |
| `DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY` | `100` | Max rotated files per category (`0` = disabled) |
| `DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES` | `0` | Total log dir size cap in bytes (`0` = disabled) |
| **Flush** | | |
| `DOLLHOUSE_LOG_FLUSH_INTERVAL_MS` | `5000` | Periodic flush interval (milliseconds) |
| `DOLLHOUSE_LOG_BUFFER_SIZE` | `100` | Buffer threshold — flush when this many entries buffered |
| `DOLLHOUSE_LOG_IMMEDIATE_FLUSH_RATE` | `50` | Max immediate flushes per second (security warn/error) |
| **Memory** | | |
| `DOLLHOUSE_LOG_MEMORY_CAPACITY` | `5000` | Legacy total memory capacity (unused when per-category vars are set) |
| `DOLLHOUSE_LOG_MEMORY_APP_CAPACITY` | `5000` | Application queue capacity |
| `DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY` | `3000` | Security queue capacity |
| `DOLLHOUSE_LOG_MEMORY_PERF_CAPACITY` | `2000` | Performance queue capacity |
| `DOLLHOUSE_LOG_MEMORY_TELEMETRY_CAPACITY` | `1000` | Telemetry queue capacity |
| **Entry Size** | | |
| `DOLLHOUSE_LOG_MAX_ENTRY_SIZE` | `16384` | Max serialized entry size (bytes, 16 KB); oversized `data` is truncated |
| **Web Console** | | |
| `DOLLHOUSE_WEB_CONSOLE` | `true` | Enable the unified web console (logs + metrics on port 41715) |
| `DOLLHOUSE_LOG_VIEWER` | `false` | **Deprecated** — use `DOLLHOUSE_WEB_CONSOLE` instead |
| `DOLLHOUSE_LOG_VIEWER_PORT` | `9100` | **Deprecated** — console uses port 41715 |

---

## Example Configurations

### 1. Development

Verbose logging with the browser viewer enabled for real-time monitoring.

```bash
export LOG_LEVEL=debug
export DOLLHOUSE_LOG_FORMAT=text
export DOLLHOUSE_LOG_VIEWER=true
```

### 2. Production

Standard production settings — `info` level, machine-readable format, default retention.

```bash
export LOG_LEVEL=info
export DOLLHOUSE_LOG_FORMAT=jsonl
```

### 3. High-Volume / Constrained Disk

Reduce noise and disk usage for busy servers or limited storage.

```bash
export LOG_LEVEL=warn
export DOLLHOUSE_LOG_FORMAT=jsonl
export DOLLHOUSE_LOG_FILE_MAX_SIZE=52428800         # 50 MB rotation
export DOLLHOUSE_LOG_RETENTION_DAYS=7
export DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS=30
```

> **See also**: Large log directories can compound startup variability alongside large memory portfolios. See [Memory System — Startup Performance](memory-system.md#startup-performance) for guidance on diagnosing and tuning startup with many auto-load memories.

### 4. Security Audit Focus

Extended security retention with a larger in-memory security buffer.

```bash
export LOG_LEVEL=info
export DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS=365
export DOLLHOUSE_LOG_MEMORY_SECURITY_CAPACITY=10000
```

### 5. Claude Desktop

Add environment variables to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["path/to/dollhousemcp/dist/index.js"],
      "env": {
        "LOG_LEVEL": "info",
        "DOLLHOUSE_LOG_FORMAT": "jsonl",
        "DOLLHOUSE_LOG_VIEWER": "true"
      }
    }
  }
}
```

---

## Troubleshooting

### No log files appearing

**Cause**: The log directory doesn't exist or the process lacks write permissions.
**Solution**: Check that `DOLLHOUSE_LOG_DIR` (or the default `~/.dollhouse/logs/`) is writable. The directory is created automatically with `0700` permissions, but parent directories must already exist. If using a custom path, verify it with `ls -la`.

### `query_logs` returns empty results

**Cause**: The in-memory buffer has been cleared (server restart) or entries were evicted from the ring buffer.
**Solution**: The memory buffer is volatile. After a restart, queries will only show entries logged since startup. For historical data, search the disk files directly using `grep` or `jq`.

### Log files growing too large

**Cause**: High log volume with `debug` level, a large `DOLLHOUSE_LOG_FILE_MAX_SIZE`, or an absent directory size cap.
**Solution**: Raise `LOG_LEVEL` to `info` or `warn`. Reduce `DOLLHOUSE_LOG_FILE_MAX_SIZE` (default 100 MB) to trigger rotation sooner. Shorten `DOLLHOUSE_LOG_RETENTION_DAYS` and `DOLLHOUSE_LOG_SECURITY_RETENTION_DAYS`. For high-throughput deployments, set `DOLLHOUSE_LOG_MAX_DIR_SIZE_BYTES` to an absolute byte cap (e.g., `1073741824` for 1 GB) or `DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY` to limit rotated file count.

### Browser viewer not loading

**Cause**: The web console is not enabled, or the port is in use.
**Solution**: Ensure `DOLLHOUSE_WEB_CONSOLE=true` is set (default). Check that port 41715 is not already in use: `lsof -i :41715`. The console binds to `127.0.0.1` only — access it from the same machine. The Logs tab provides real-time log streaming.

### `[REDACTED]` appearing in log data

**Cause**: The automatic redaction system detected a sensitive field name or message pattern.
**Solution**: This is intentional — sensitive data (tokens, passwords, API keys) is never written to logs. If a non-sensitive field is being redacted, check whether its name matches one of the [redaction patterns](#automatic-redaction). Rename the field to avoid false positives.

### "Backpressure: N entries evicted" warning

**Cause**: Log entries are being produced faster than they can be flushed. The buffer filled up and older entries were evicted.
**Solution**: Increase `DOLLHOUSE_LOG_BUFFER_SIZE` (default 100) or decrease `DOLLHOUSE_LOG_FLUSH_INTERVAL_MS` (default 5000 ms) for more frequent flushing. Alternatively, raise `LOG_LEVEL` to reduce the volume of entries.

### Entry truncated warning

**Cause**: A log entry's serialized size exceeded `DOLLHOUSE_LOG_MAX_ENTRY_SIZE` (default 16 KB). The `data` field was replaced with a truncation marker.
**Solution**: Increase `DOLLHOUSE_LOG_MAX_ENTRY_SIZE` if you need to log large payloads. Alternatively, reduce the size of data being passed to log calls.

### Multiple server instances sharing a log directory

**Cause**: `FileLogSink` has no inter-process locking. On startup and at each UTC midnight rollover, each instance scans the log directory to find the highest existing sequence number. If two instances run concurrently with the same log directory, both scans may return the same max sequence, and both instances will then write to the same file — mixing data from two processes and bypassing the per-file size rotation.

**Solution**: Give each server instance its own log directory:

```bash
# Instance A
DOLLHOUSE_LOG_DIR=~/.dollhouse/logs/instance-a/

# Instance B
DOLLHOUSE_LOG_DIR=~/.dollhouse/logs/instance-b/
```

The scan is O(n) over files in the directory and runs at most once per category per calendar day (on process start or UTC midnight rollover). For deployments generating large numbers of rotated files, set `DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY` (default `100`) to keep the directory small and the scan fast.

---

## See Also

- [Configuration Basics](configuration-basics.md) — general server configuration
- [Environment Variables Reference](../reference/environment-vars.md) — complete env var listing
- [Telemetry Guide](telemetry.md) — operational telemetry privacy and controls
- [Troubleshooting Guide](troubleshooting.md) — general server troubleshooting
- [Logging Design Document](../LOGGING-DESIGN.md) — internal architecture and RFC
- [Memory System — Startup Performance](memory-system.md#startup-performance) — large-portfolio startup tuning and `get_build_info` diagnostics

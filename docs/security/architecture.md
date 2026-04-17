# DollhouseMCP Security Architecture

> **Version:** 2.0.0
> **Updated:** April 2026
> **Covers:** MCP Server v2.0 security stack (Gatekeeper, Autonomy Evaluator, Danger Zone, CLI permission delegation, content/filesystem/activation security)

---

## Overview

DollhouseMCP v2.0 takes a defense-in-depth approach to security. The architecture combines **DollhouseMCP-specific security systems** (Gatekeeper, Autonomy Evaluator, Danger Zone, element-driven policies) with **standard security engineering practices** (input validation, path traversal prevention, file locking, token encryption) that any well-built server should implement.

The core principle: **LLM instructions are suggestions; server policies are enforcement.** No amount of prompt engineering can bypass programmatic security controls.

### What's Unique to DollhouseMCP

The first three layers are DollhouseMCP innovations — they don't exist in standard MCP servers:

- **Gatekeeper** — element-driven permission policies that dynamically shape what the LLM can do
- **Danger Zone** — persistent agent blocking with verification challenges
- **Autonomy Evaluator** — risk scoring and human-in-the-loop gating for agent execution
- **External Tool Policies** — element-declared allow/deny patterns for CLI tool access

### Standard Security Engineering

The remaining areas are rigorous implementations of established security practices — important, but not novel:

- **Content security** — injection detection, Unicode validation, DOMPurify sanitization, YAML bomb protection
- **Filesystem security** — path traversal prevention, file locking, atomic writes, portfolio directory isolation
- **OAuth & API security** — AES-256-GCM token encryption, rate limiting, scope validation
- **Activation store security** — session isolation, atomic persistence, input validation

### Security Invariants

1. **Session isolation**: Each MCP client connection gets a separate Gatekeeper session. Confirmations are in-memory only -- crash equals fresh session.
2. **Fail-closed**: Unknown operations default to `CONFIRM_SINGLE_USE`. Safety evaluation failures pause the agent. Corrupt persistence files start fresh.
3. **Non-elevatable destructive operations**: `delete_element`, `execute_agent`, `abort_execution`, and `clear` have `canBeElevated: false` -- no element policy can auto-approve them.
4. **Verification codes never reach the LLM**: Display codes are shown via OS-native dialog and stripped before the directive is returned.
5. **Element policies cannot gate infrastructure operations**: `verify_challenge`, `permission_prompt`, and `approve_cli_permission` are stripped from element policy lists during deserialization.

---

## Layer 1: MCP-AQL Gatekeeper

The Gatekeeper is the centerpiece of the v2.0 security stack. It is a centralized access control engine that evaluates every MCP-AQL operation through a four-stage pipeline.

**Source files:**
- `src/handlers/mcp-aql/Gatekeeper.ts` -- main enforcement class
- `src/handlers/mcp-aql/GatekeeperTypes.ts` -- type definitions (PermissionLevel, GatekeeperDecision, etc.)
- `src/handlers/mcp-aql/GatekeeperConfig.ts` -- configuration with defaults
- `src/handlers/mcp-aql/GatekeeperSession.ts` -- per-connection session state
- `src/handlers/mcp-aql/policies/OperationPolicies.ts` -- default permission levels and overrides
- `src/handlers/mcp-aql/policies/ElementPolicies.ts` -- element-based policy resolution
- `src/handlers/mcp-aql/policies/AgentToolPolicyTranslator.ts` -- agent tool config to policy translation

### 1.1 Permission Levels

The `PermissionLevel` enum defines four access tiers:

| Level | Behavior | Use Case |
|-------|----------|----------|
| `AUTO_APPROVE` | Immediate execution, no confirmation | Read operations, verification flows |
| `CONFIRM_SESSION` | Confirm once, auto-approve for session | Create operations, execution lifecycle |
| `CONFIRM_SINGLE_USE` | Confirm every instance | Delete, update, execute_agent |
| `DENY` | Blocked entirely | Element policy violations, scope restrictions |

### 1.2 Enforcement Pipeline

The `Gatekeeper.enforce()` method processes each request through four layers:

**Layer 1 -- Route Validation:** Verifies the operation exists in the routing table and is called via the correct CRUD endpoint. Calling `delete_element` via `mcp_aql_read` is a security violation.

**Layer 2 -- Element Policy Resolution:** Evaluates active elements' `gatekeeper` metadata policies. Resolution order: deny (highest) > confirm > allow > route default. The `allowElementPolicyOverrides` config flag provides an operator kill switch to bypass this layer entirely.

**Layer 3 -- Session Confirmations:** Checks cached approvals from prior `confirm_operation` calls. `CONFIRM_SESSION` approvals persist for the connection lifetime. `CONFIRM_SINGLE_USE` approvals are consumed after one use (check-then-delete, safe due to Node.js single-threaded model).

**Layer 4 -- Default Policy:** Falls back to the operation's default permission level derived from its endpoint routing or explicit override.

### 1.3 Endpoint Default Levels

Default permission levels are derived from the operation's CRUD endpoint:

| Endpoint | Default Level | Rationale |
|----------|---------------|-----------|
| `READ` | `AUTO_APPROVE` | Read-only, no side effects |
| `CREATE` | `CONFIRM_SESSION` | Additive, safe once approved |
| `UPDATE` | `CONFIRM_SINGLE_USE` | Modifies existing data |
| `DELETE` | `CONFIRM_SINGLE_USE` | Destructive |
| `EXECUTE` | `CONFIRM_SINGLE_USE` | Unpredictable side effects |

Operations that deviate from their endpoint default are listed in `OPERATION_POLICY_OVERRIDES` (in `OperationPolicies.ts`). Examples:
- `confirm_operation` and `verify_challenge` are on EXECUTE/CREATE but override to `AUTO_APPROVE` to prevent infinite confirmation loops.
- `delete_element` matches its endpoint default but sets `canBeElevated: false`.
- `execute_agent` is `CONFIRM_SINGLE_USE` with `canBeElevated: false` -- no element can auto-approve agent execution.

### 1.4 Element Gatekeeper Policies

Any DollhouseMCP element (persona, skill, agent, memory, ensemble) can define a `gatekeeper` section in its metadata:

```yaml
gatekeeper:
  allow:
    - create_element
    - activate_element
  confirm:
    - edit_element
  deny:
    - delete_element
  scopeRestrictions:
    allowedTypes: [skill, template]
    blockedTypes: [agent]
  externalRestrictions:
    description: "Restrict CLI tools to safe operations"
    allowPatterns: ["Read:*", "Glob:*", "Bash:git status*"]
    confirmPatterns: ["Edit:*", "Write:*", "Bash:git push*"]
    denyPatterns: ["Bash:rm *", "Bash:sudo *"]
    approvalPolicy:
      requireApproval: [moderate, dangerous]
      defaultScope: single
      ttlSeconds: 300
```

Policy resolution across multiple active elements:
- **Deny always wins**: If any active element denies an operation, it is blocked.
- **Confirm overrides allow**: An element's `confirm` policy takes priority over another element's `allow` (Issue #674).
- **Allow overrides route default**: An element can elevate an operation from `CONFIRM_SESSION` to `AUTO_APPROVE`, but only if `canBeElevated` is true.
- **Scope restrictions**: Operations can be limited to specific element types via `allowedTypes`/`blockedTypes`.

### 1.5 Nuclear Sandbox

When an element places `confirm_operation` in its `deny` list, it creates a "nuclear sandbox" -- the human-in-the-loop confirmation path is itself blocked, preventing any confirmation from being recorded. This effectively locks the session to read-only operations for any operation that requires confirmation. The `findConfirmDenyingElement()` function detects this state.

### 1.6 Agent Tool Policy Translation

The `AgentToolPolicyTranslator` (in `policies/AgentToolPolicyTranslator.ts`) bridges an agent's `tools` configuration (allowed/denied endpoint names) into an `ElementGatekeeperPolicy`. When an agent specifies `tools.allowed: [mcp_aql_read]`, all operations from other endpoints are synthesized into a deny list. Lifecycle and safety operations (`execute_agent`, `confirm_operation`, `verify_challenge`, `permission_prompt`, etc.) are exempt from this synthesis.

### 1.7 CLI Approval Delegation (Issue #625)

The Gatekeeper manages CLI-level permission delegation through three operations:
- `permission_prompt` -- evaluates `--permission-prompt-tool` requests from Claude Code CLI
- `approve_cli_permission` -- human approves a pending tool call
- `get_pending_cli_approvals` -- lists unapproved requests

Approval records are stored in `GatekeeperSession` with:
- Per-record TTL (clamped to 1s--24h range)
- LRU eviction at capacity (configurable via `DOLLHOUSE_CLI_APPROVAL_MAX`)
- Throttled expiry sweeps every 10 seconds
- Two approval scopes: `single` (consumed after one use) and `tool_session` (all uses of that tool for the session)

### 1.8 Gatekeeper Configuration

`GatekeeperConfig` (in `GatekeeperConfig.ts`) provides tunable settings:

| Setting | Default | Purpose |
|---------|---------|---------|
| `strictness` | `STANDARD` | Verification strictness level (MINIMAL/STANDARD/ELEVATED/MAXIMUM) |
| `verificationTimeoutMs` | 60000 | Timeout for verification prompts |
| `enableAuditLogging` | `true` | Whether decisions are logged to SecurityMonitor |
| `maxSessionConfirmations` | 100 | LRU cap for cached confirmations |
| `allowElementPolicyOverrides` | `true` | Operator kill switch for element policy layer |
| `requireDangerZoneVerification` | `true` | Whether danger zone operations need extra verification |

### 1.9 Infrastructure Operation Protection (Issue #758)

Certain operations must never be gated by element policies to prevent cascading confirmation loops. Two related sets enforce this:

- **Ungatable operations** (`verify_challenge`, `approve_cli_permission`, `permission_prompt`): Stripped from all element policy lists (allow, confirm, deny) during deserialization by `sanitizeGatekeeperPolicy()`.
- **Gatekeeper infrastructure operations** (ungatable + `confirm_operation`): Skip Layer 2 (element policy resolution) during `enforce()` via the `skipElementPolicies` flag. `confirm_operation` is preserved in deny lists because it enables the nuclear sandbox pattern.

---

## Layer 2: Danger Zone Enforcement

The `DangerZoneEnforcer` provides programmatic blocking for the highest-risk safety tier. Unlike semantic warnings that a compromised LLM can ignore, this enforcer physically prevents tool execution.

**Source file:** `src/security/DangerZoneEnforcer.ts`

### 2.1 How It Works

1. The Autonomy Evaluator detects a `DANGER_ZONE` safety tier.
2. A verification challenge is created with a display code and UUID challenge ID.
3. `DangerZoneEnforcer.block()` adds the agent to the blocked list with the challenge ID.
4. The display code is shown via OS-native dialog (AppleScript on macOS, zenity on Linux, PowerShell on Windows) and is **never** included in the LLM-facing response.
5. The human reads the code from the dialog and tells the LLM.
6. The LLM calls `verify_challenge` with the challenge ID and code.
7. On successful verification, `DangerZoneEnforcer.unblock()` removes the block.

### 2.2 Persistence

Blocks are persisted to `~/.dollhouse/security/blocked-agents.json` using fire-and-forget writes. Blocks survive server restarts. The in-memory Map is the hot path; disk is the durable backing store. Disk failure does not prevent enforcement.

### 2.3 Security Properties

- Agent name validation prevents path traversal and control characters
- Verification ID mismatch is logged as a HIGH severity security event
- `clearAll()` requires an admin token when `DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN` is set
- Metrics tracking: block counts, durations, clear operations (rolling window via `EvictingQueue`)

---

## Layer 3: Autonomy Evaluator

The Autonomy Evaluator determines whether an agent should continue autonomously or pause for human input after each execution step.

**Source file:** `src/elements/agents/autonomyEvaluator.ts`

### 3.1 Five-Stage Evaluation Pipeline

`evaluateAutonomy()` runs five checks in order (first failure pauses):

1. **Step count limit**: Compares current step against `maxAutonomousSteps` (0 = unlimited). Configurable per-agent and via `DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT` env var.
2. **Step outcome**: If the previous step failed, pause for human review.
3. **Action pattern matching**: Matches `nextActionHint` against `requiresApproval` patterns (force pause) and `autoApprove` patterns (force continue). `requiresApproval` takes precedence.
4. **Safety tier evaluation**: Calls `determineSafetyTier()` from `@dollhousemcp/safety`. Tiers escalate: `advisory` (continue) > `confirm` (pause unless aggressive tolerance) > `verify` (create verification challenge) > `danger_zone` (hard block via DangerZoneEnforcer).
5. **Risk score threshold**: Compares numeric risk score (0-100) against tolerance thresholds. Configurable via `DOLLHOUSE_AUTONOMY_RISK_THRESHOLD_*` env vars.

### 3.2 Autonomy Configuration

Per-agent configuration via frontmatter metadata:

```yaml
autonomy:
  riskTolerance: moderate    # conservative | moderate | aggressive
  maxAutonomousSteps: 10     # 0 = unlimited
  requiresApproval:          # Glob patterns that force pause
    - "*delete*"
    - "*production*"
  autoApprove:               # Glob patterns that force continue
    - "read*"
    - "list*"
  verificationTimeoutMinutes: 5
```

### 3.3 Verification Flow (Issue #142)

When the safety tier is `verify` or `danger_zone`:
1. `createVerificationChallenge()` generates a challenge with UUID v4 ID and human-readable display code.
2. `storeAndDisplayChallenge()` stores the code in `VerificationStore` (server-side, one-time use) and shows it via OS-native dialog.
3. The display code is stripped from the directive returned to the LLM.
4. Rate limiting: max 10 failed verification attempts per 60-second sliding window.
5. Expired challenges return `VERIFICATION_EXPIRED` (distinct from wrong code `VERIFICATION_FAILED`).

### 3.4 Metrics (Issue #391)

The `AutonomyMetricsTracker` provides in-memory counters: total evaluations, continue/pause counts, pause reason distribution, danger zone triggers, verification requests, and average step count at pause. Accessible via `getAutonomyMetrics()`.

---

## Layer 4: Content Security

Multiple validators protect against injection attacks, Unicode exploits, and malicious content.

### 4.1 Content Validator

**Source file:** `src/security/contentValidator.ts`

The `ContentValidator` class detects prompt injection attacks using deterministic pattern matching (not AI-based detection). This was a deliberate design choice -- pattern matching cannot be socially engineered. Detection covers:
- System/admin/assistant prompt overrides (`[SYSTEM: ...]`, `[ADMIN: ...]`)
- Role impersonation attempts (specific dangerous roles: admin, root, system, sudo, superuser, DAN)
- Instruction override patterns
- Code execution directives
- External command execution (`curl`/`wget` with any URL, not just specific TLDs — #1782-1)
- Jailbreak and guideline bypass patterns (`DAN mode`, `do anything now`, `pretend you have no guidelines` — #1782-4)

Context-aware validation: Skills may legitimately contain code patterns (eval, exec, require) that would be blocked in other element types (Issue #456). Pattern maintenance guidance and false-positive regression tests are in `tests/integration/security-audit-batch-a.integration.test.ts`.

### 4.2 Unicode Validator

**Source file:** `src/security/validators/unicodeValidator.ts`

The `UnicodeValidator` prevents Unicode-based bypass attacks:
- **Direction override attacks**: Strips RLO/LRO/RLE/LRE and isolate formatting characters (U+202A-U+202E, U+2066-U+2069)
- **Zero-width injection**: Removes zero-width spaces, joiners, and BOM characters
- **Homograph attacks**: Maps ~110 confusable characters (Cyrillic-to-Latin, Greek lowercase and uppercase to Latin — #1782-2, fullwidth, mathematical) via `CONFUSABLE_MAPPINGS`
- **Mixed script detection**: Identifies strings mixing multiple Unicode scripts
- **Non-printable character stripping**: Removes C0/C1 control codes and non-characters

### 4.3 Input Normalizer

**Source file:** `src/security/InputNormalizer.ts`

Implements "normalize once at the boundary" pattern. Recursively normalizes all string values in input objects using `UnicodeValidator.normalize()`. Used by `GenericElementValidator` at the validation boundary so downstream validators receive pre-cleaned data.

### 4.4 Input Validator

**Source file:** `src/security/InputValidator.ts`

The `MCPInputValidator` class provides field-specific validation:
- Persona identifier validation (length, sanitization)
- Search query validation (min/max length, character stripping)
- Collection path validation
- URL validation with IP address blocking (prevents SSRF via decimal, hex, octal IP formats)
- Pre-compiled regex patterns for performance

### 4.5 Secure YAML Parser

**Source file:** `src/security/secureYamlParser.ts`

The `SecureYamlParser` class provides safe YAML deserialization for markdown files with YAML frontmatter:
- Uses `yaml.CORE_SCHEMA` (safe subset, no custom types)
- Size limits: 64KB for YAML, 1MB for content
- Field-specific validators for metadata (name, version, author, etc.)
- Content context parameter exempts legitimate patterns (e.g., `<script>` in templates)
- Bomb detection for nested/recursive structures

### 4.6 DoS Protection

**Source files:** `src/security/dosProtection.ts`, `src/security/regexValidator.ts`

The `SafeRegex` class provides ReDoS protection:
- Configurable execution timeouts (default 100ms for user input)
- Pattern caching with size limits (max 1,000 cached patterns)
- Rate limiting with automatic reset

The `RegexValidator` class adds complexity-aware content length limits:
- **Low complexity** (no quantifiers, O(n)): 500KB — matches MAX_CONTENT_LENGTH
- **Medium complexity** (1-3 simple quantifiers, O(n)): 500KB — linear time, safe at any content size
- **High complexity** (nested quantifiers, O(2^n) ReDoS risk): 1KB hard cap
- Patterns exceeding 50ms execution are logged as slow for monitoring
- Complexity classification is retained for diagnostics even when low/medium share the same limit

### 4.7 Field Validator

**Source file:** `src/utils/validation/FieldValidator.ts`

Reusable validation rules for element metadata: required, type, enum, array, semver, length, and pattern validators.

---

## Layer 5: Filesystem Security

### 5.1 Path Validator

**Source file:** `src/security/pathValidator.ts`

The `PathValidator` class prevents path traversal attacks:
- Resolves symlinks to their real paths (security fix #1290)
- Enforces allowed directory list (portfolio directories only)
- Restricts file extensions (`.md`, `.markdown`, `.txt`, `.yml`, `.yaml`)
- Caches resolved directory paths for performance
- Parent directory resolution for new file creation

### 5.2 File Lock Manager

**Source file:** `src/security/fileLockManager.ts`

The `FileLockManager` prevents race conditions in concurrent file operations:
- Resource-based locking with automatic cleanup
- Configurable timeouts to prevent deadlocks (centralized via `performance-constants.ts`)
- Atomic file operations with write-to-temp-then-rename pattern
- Lock queueing for concurrent requests
- Metrics tracking (total requests, wait times, timeouts, concurrent waits)

### 5.3 Command Validator

**Source file:** `src/security/commandValidator.ts`

The `CommandValidator` class restricts shell command execution:
- Allowlisted commands only: `git`, `npm`, `node`, `npx`
- Allowlisted arguments per command
- Restricted `PATH` environment variable (`/usr/bin:/bin:/usr/local/bin`)
- 30-second default timeout
- Safe argument validation via regex

### 5.4 Encryption Services

**Source directory:** `src/security/encryption/`

- `PatternEncryptor.ts` -- Encrypts sensitive patterns
- `PatternDecryptor.ts` -- Decrypts patterns for validation
- `ContextTracker.ts` -- Tracks encryption context

### 5.5 Background Validation

**Source directory:** `src/security/validation/`

- `BackgroundValidator.ts` -- Asynchronous validation for non-blocking checks
- `PatternExtractor.ts` -- Extracts patterns for security analysis

---

## Layer 6: External Tool Policies

The `ToolClassification` module provides static classification and risk assessment for CLI tool calls, used by the `permission_prompt` operation (Issue #625).

**Source file:** `src/handlers/mcp-aql/policies/ToolClassification.ts`

### 6.1 Static Tool Classification

The `classifyTool()` function classifies CLI tools into four risk levels:

| Risk Level | Behavior | Examples |
|------------|----------|---------|
| `safe` | Auto-allow | Read, Grep, Glob, WebFetch, git status, npm test |
| `moderate` | Evaluate against policies | Edit, Write, Agent, unclassified bash |
| `dangerous` | Auto-deny | rm -rf, sudo, eval, curl pipe to shell, `python3 -c`, `node -e`, `perl -e`, `ruby -e` (#1782-3) |
| `blocked` | Always denied | mkfs, dd if=, fork bombs |

### 6.2 Bash Command Classification

Bash commands are sub-classified against three pattern lists:
- **Safe patterns** (29 patterns): git read-only commands, ls, cat, npm test/lint/build, gh issue/pr view
- **Dangerous patterns** (55+ patterns): rm -rf, git push --force, chmod 777, sudo, pipe-to-shell, env manipulation, process control, network tools, base64-decode-to-shell
- **Blocked patterns** (5 patterns): mkfs, dd, fork bombs

### 6.3 Risk Assessment

The `assessRisk()` function computes a 0-100 risk score with contributing factors:

| Score Range | Level | Description |
|-------------|-------|-------------|
| 0 | safe | Read-only, no side effects |
| 1-39 | low | Minor side effects, easily reversible |
| 40-59 | moderate | File writes, unclassified commands |
| 60-79 | elevated | Moderate + network/file creation factors |
| 80-99 | dangerous | Destructive commands, privilege escalation |
| 100 | blocked | Always denied |

Adjustments: irreversible pattern (+10), network operation (+10), out-of-scope read path (+10), file creation (+5). Sensitive path detection covers `~/.ssh/`, `~/.aws/`, `/etc/shadow`, etc.

### 6.4 Irreversibility Detection

Risk assessment distinguishes between operations that are **risky** and operations that are **irreversible**. Most security systems treat these the same — DollhouseMCP tracks them separately.

The `assessRisk()` function returns an `irreversible: boolean` flag alongside the numeric score. This flag is set when the command matches known irreversible patterns:

- `rm -rf`, `rm -r` — recursive deletion
- `git push --force`, `git reset --hard` — history destruction
- `DROP TABLE`, `DELETE FROM` — database data loss
- `mkfs`, `dd if=` — disk-level operations

**Why this matters**: Risk and irreversibility are different dimensions. `git checkout -b feature` scores as moderate risk (it modifies repo state) but is trivially reversible. `git stash drop` sounds routine but is completely irreversible — that stash is gone, no recovery. A single risk score conflates these. The separate `irreversible` flag lets the Gatekeeper's confirmation records (`GatekeeperSession.ts`) and the Autonomy Evaluator make better decisions — an irreversible operation at any risk level deserves more scrutiny than a reversible one.

**Source files:** `src/handlers/mcp-aql/policies/ToolClassification.ts` (pattern matching, `IRREVERSIBLE_BASH_PATTERNS`), `src/handlers/mcp-aql/GatekeeperSession.ts` (confirmation tracking), `src/handlers/mcp-aql/GatekeeperTypes.ts` (type definitions)

### 6.5 Element Policy Evaluation (External Tools)

The `evaluateCliToolPolicy()` function evaluates CLI tool calls against active element `externalRestrictions`:
- **denyPatterns** (highest priority): First pattern match = immediate deny
- **allowPatterns**: Union semantics across elements -- tool must match at least one element's allowlist
- Pattern matching uses `buildMatchTargets()`: tool name, `Bash:<command>`, `Edit:<file_path>`, or full MCP tool name
- Input sanitization: Unicode NFC normalization, control character stripping, length truncation (1000 chars) to prevent DoS

### 6.6 Gatekeeper-Essential Operations

MCP-AQL operations that can never be blocked by `permission_prompt`, even if element denyPatterns would match the MCP tool name: `confirm_operation`, `verify_challenge`, `permission_prompt`, `introspect`, `get_active_elements`, `approve_cli_permission`, and read-only state operations.

---

## Layer 7: OAuth & API Security

### 7.1 Token Manager

**Source file:** `src/security/tokenManager.ts`

The `TokenManager` class provides secure GitHub token management:
- Token format validation for all GitHub token types (PAT, fine-grained PAT, installation, OAuth, refresh)
- AES-256-GCM encryption for token storage at `~/.dollhouse/.auth/github_token.enc`
- Key derivation: PBKDF2 with 100,000 iterations, 32-byte salt
- Rate-limited token validation to prevent brute force attacks
- Token scope validation against required/optional scopes
- Unicode validation on token strings via `UnicodeValidator`

### 7.1b Console Session Token (#1780)

**Source files:** `src/web/console/consoleToken.ts`, `src/web/middleware/authMiddleware.ts`

The management console on port 41715 protects its API with a Bearer token stored at `~/.dollhouse/run/console-token.auth.json` (0600 permissions, owner-only). The token is 32 bytes of cryptographic randomness (64 hex chars), generated on first leader election and persisted across restarts. Rotation is explicit-only — restarts do not cycle the token.

**Middleware behavior:**
- Gated on `DOLLHOUSE_WEB_AUTH_ENABLED` (default `false` during Phase 1 rollout, will flip to `true` in a follow-up PR)
- Checks `Authorization: Bearer <token>` header, with a `?token=<token>` query fallback for SSE streams (EventSource cannot set headers)
- Uses `crypto.timingSafeEqual` to prevent side-channel attacks on token comparison
- Public path allowlist exempts `/api/health`, `/api/setup/version`, `/api/setup/mcpb`, `/api/setup/detect` — metadata endpoints that have no sensitive state

**Forward-compatible schema:** Token entries include `scopes`, `elementBoundaries`, `tenant`, `platform`, and `labels` fields from day one. Phase 1 treats all tokens as admin-scoped; Phase 2 flips real scope enforcement on without schema migration. Phase 3 adds multi-tenant element boundary filtering for enterprise deployments.

**Browser token delivery:** The server injects the current token into `index.html` via a `<meta name="dollhouse-console-token">` tag at request time. The client-side helper (`public/consoleAuth.js`) reads the tag and wraps all fetch/EventSource calls to attach the token automatically.

**Follower token delivery:** Non-leader MCP processes read the token file directly on startup (`getPrimaryTokenFromFile`) and attach it to their ingest POSTs. The leader owns the file; followers are read-only consumers.

**See also:** [Console Authentication guide](../guides/console-auth.md), [External API Access guide](../guides/external-api-access.md)

### 7.2 Rate Limiting

Rate limiting is applied at multiple points:
- Token validation operations (via `RateLimiter`)
- Verification challenge attempts (max 10 failures per 60s sliding window)
- CLI approval expiry sweeps (throttled to every 10 seconds)

### 7.3 Security Monitoring

**Source file:** `src/security/securityMonitor.ts`

The `SecurityMonitor` class provides centralized security event logging:
- 60+ event types covering all security-relevant operations
- Four severity levels: LOW, MEDIUM, HIGH, CRITICAL
- In-memory event buffer (1,000 events via `EvictingQueue`)
- Security report generation (by severity, by type, recent critical events)
- CRITICAL events trigger alert pipeline (configurable via `DOLLHOUSE_SECURITY_ALERTS`)
- Log listener support for external monitoring integration

### 7.4 Security Audit Framework

**Source directory:** `src/security/audit/`

The `SecurityAuditor` provides automated security scanning:
- Configurable rule-based scanning
- Multiple reporter formats
- Integration with CI/CD via `npm run security:audit`

---

## Layer 8: Activation Store Security

The `ActivationStore` persists per-session element activation state with security controls.

**Source file:** `src/services/ActivationStore.ts`

### 8.1 Session Isolation

- Each session identified by `DOLLHOUSE_SESSION_ID` env var (default: `"default"`)
- Session ID validation: must match `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/` (prevents path injection)
- Separate activation file per session: `~/.dollhouse/state/activations-{sessionId}.json`
- No cross-session state leakage

### 8.2 Data Integrity

- Versioned file format (`version: 1`) for forward compatibility
- Only known element types loaded (`persona`, `skill`, `agent`, `memory`, `ensemble`)
- Activation identifiers normalized via `UnicodeValidator.normalize()`
- Deduplication on record (same element cannot be activated twice)
- Fire-and-forget persistence with retry (up to 2 retries, 100ms delay)
- Corrupt/missing files start fresh with security event logging

### 8.3 Opt-Out

Persistence can be disabled via `DOLLHOUSE_ACTIVATION_PERSISTENCE=false` for ephemeral sessions.

---

## Threat Matrix

| Threat | Layer | Mitigation | Source File |
|--------|-------|------------|-------------|
| Prompt injection via element content | 4 | Pattern-based detection in `ContentValidator`, context-aware exemptions | `src/security/contentValidator.ts` |
| Unicode bypass attacks (homograph, RTL, zero-width) | 4 | `UnicodeValidator` normalization at boundary, ~110 confusable mappings (Cyrillic, Greek, fullwidth, math) | `src/security/validators/unicodeValidator.ts` |
| Unicode homograph path traversal | 4, 5 | NFC normalization on `name` param before `..` / `\` checks (#1736) | `src/web/routes.ts` |
| Consumed approval memory leak | 1 | `expireStaleApprovals` evicts consumed single-use records (#1782-5) | `src/handlers/mcp-aql/GatekeeperSession.ts` |
| Inline interpreter code execution | 6 | `python -c`, `node -e`, `perl -e`, `ruby -e` classified as dangerous (#1782-3) | `src/handlers/mcp-aql/policies/ToolClassification.ts` |
| YAML deserialization attacks | 4 | `CORE_SCHEMA` only, size limits, bomb detection | `src/security/secureYamlParser.ts` |
| Path traversal / symlink attacks | 5 | `PathValidator` with symlink resolution, allowed directory list | `src/security/pathValidator.ts` |
| Token exposure in logs/errors | 7 | AES-256-GCM encryption, token redaction, sanitized errors | `src/security/tokenManager.ts` |
| Unauthenticated access to web console API | 7 | Bearer token auth middleware, 0600 token file, localhost binding (#1780) | `src/web/middleware/authMiddleware.ts`, `src/web/console/consoleToken.ts` |
| Brute force token validation | 7 | Rate-limited validation operations | `src/security/tokenManager.ts` |
| ReDoS (regex denial of service) | 4 | `SafeRegex` with timeouts, input length limits, pattern caching | `src/security/dosProtection.ts` |
| Unauthorized agent execution | 1 | `execute_agent` is `CONFIRM_SINGLE_USE` + `canBeElevated: false` | `src/handlers/mcp-aql/policies/OperationPolicies.ts` |
| Compromised LLM ignoring safety warnings | 2 | `DangerZoneEnforcer` programmatic blocking, file-backed persistence | `src/security/DangerZoneEnforcer.ts` |
| Verification code theft by LLM | 3 | Display code shown via OS dialog only, never in LLM-facing response | `src/elements/agents/autonomyEvaluator.ts` |
| Element policy escalation | 1 | `canBeElevated: false` on destructive ops, deny > confirm > allow hierarchy | `src/handlers/mcp-aql/policies/ElementPolicies.ts` |
| Cascading confirmation loops | 1 | Infrastructure operations skip element policy layer (Issue #758) | `src/handlers/mcp-aql/policies/ElementPolicies.ts` |
| Dangerous CLI tool execution | 6 | Static classification, dangerous/blocked pattern lists, risk scoring | `src/handlers/mcp-aql/policies/ToolClassification.ts` |
| Shell injection via bash commands | 5, 6 | `CommandValidator` allowlists, `classifyBashCommand()` pattern matching | `src/security/commandValidator.ts` |
| Cross-session confirmation leakage | 1 | In-memory only session state, no disk persistence of confirmations | `src/handlers/mcp-aql/GatekeeperSession.ts` |
| Activation store path injection | 8 | Session ID regex validation, Unicode normalization, type allowlist | `src/services/ActivationStore.ts` |
| Race conditions in file operations | 5 | Resource-based file locking, atomic write-rename, timeout protection | `src/security/fileLockManager.ts` |
| Runaway agent execution | 3 | Step limits, risk thresholds, safety tier escalation, pattern matching | `src/elements/agents/autonomyEvaluator.ts` |
| API rate limit abuse | 7 | Rate limiter with exponential backoff, `DOLLHOUSE_GITHUB_*` env vars | `src/security/tokenManager.ts` |
| Agent tool scope violation | 1 | `AgentToolPolicyTranslator` synthesizes deny lists from tool config | `src/handlers/mcp-aql/policies/AgentToolPolicyTranslator.ts` |

---

## Security Testing

### Test Suites

| Suite | Command | Coverage |
|-------|---------|----------|
| Security regression (fast) | `npm run security:rapid` | Command injection, path traversal, YAML deser, token leakage |
| Full security suite | `npm run security:all` | All security test files under `tests/security/` |
| Security audit | `npm run security:audit` | Automated rule-based scanning via `SecurityAuditor` |
| Pre-commit checks | `npm run pre-commit` | Security tests + dependency audit |
| Unit tests (Gatekeeper) | `npm test -- --testPathPattern=Gatekeeper` | Route validation, permission levels, policy resolution |
| Unit tests (DangerZone) | `npm test -- --testPathPattern=DangerZone` | Block/unblock, persistence, admin token |
| Unit tests (Autonomy) | `npm test -- --testPathPattern=autonomyEvaluator` | Step limits, risk scoring, safety tiers, verification |
| Unit tests (ToolClassification) | `npm test -- --testPathPattern=ToolClassification` | Tool classification, bash patterns, risk assessment |
| Unit tests (ActivationStore) | `npm test -- --testPathPattern=ActivationStore` | Session isolation, persistence, deduplication |
| Unit tests (CLI Approvals) | `npm test -- --testPathPattern=cliApprovals` | Approval lifecycle, TTL, LRU eviction |
| Integration (Gatekeeper) | `npm run test:integration -- --testPathPattern=gatekeeper` | Element policy overrides, persona policy flow |
| Integration (Policy roundtrip) | `npm run test:integration -- --testPathPattern=roundtrip` | Gatekeeper policy serialization/deserialization |

### Key Test Files

- `tests/unit/handlers/mcp-aql/Gatekeeper.test.ts` -- Gatekeeper unit tests
- `tests/unit/handlers/mcp-aql/GatekeeperSession.cliApprovals.test.ts` -- CLI approval tests
- `tests/unit/handlers/mcp-aql/policies/ToolClassification.test.ts` -- Tool classification tests
- `tests/unit/security/DangerZoneEnforcer.test.ts` -- Danger zone tests
- `tests/unit/elements/agents/autonomyEvaluator.test.ts` -- Autonomy evaluator tests
- `tests/unit/services/ActivationStore.test.ts` -- Activation store tests
- `tests/unit/elements/gatekeeper-policy-roundtrip.test.ts` -- Policy serialization tests
- `tests/integration/mcp-aql/gatekeeper-element-policy-overrides.test.ts` -- Integration tests
- `tests/integration/mcp-aql/persona-gatekeeper-policy.test.ts` -- Persona policy integration
- `tests/security/` -- 20+ security-specific test files covering injection, traversal, Unicode, ReDoS, etc.

### Security Test Categories (under `tests/security/`)

| Test File | Covers |
|-----------|--------|
| `contentValidator.test.ts` | Prompt injection pattern detection |
| `persona-unicode-attack.test.ts` | Unicode bypass attacks |
| `secureYamlParser.test.ts` | YAML deserialization attacks |
| `pathValidator-symlink.test.ts` | Symlink-based path traversal |
| `persona-content-injection.test.ts` | Content injection attempts |
| `persona-input-validation.test.ts` | Input sanitization |
| `redos-pathological-inputs.test.ts` | ReDoS attack patterns |
| `RateLimiterSecurity.test.ts` | Rate limiting effectiveness |
| `securityMonitor.test.ts` | Security event logging |
| `metadata-security.test.ts` | Metadata injection |
| `security-audit-batch-a.integration.test.ts` | End-to-end: curl/wget bypass, Greek confusables, interpreter patterns, injection precision + false positives |
| `ensemble-security-audit.test.ts` | Ensemble security |
| `mcp-sdk-security.test.ts` | MCP protocol security |

---

## Related Documents

- [Security Measures](measures.md) -- detailed listing of individual protections
- [Security Testing](testing.md) -- automated security test framework
- [Testing Quick Start](testing-quick-start.md) -- fast checks for developers
- [Security Checklist](security-checklist.md) -- pre-merge security review checklist
- [Gatekeeper Confirmation Model](gatekeeper-confirmation-model.md) -- detailed confirmation flow documentation
- [Memory Injection Protection](memory-injection-protection.md) -- memory-specific security measures
- [Contributor Security Guide](CONTRIBUTOR-SECURITY-GUIDE.md) -- security guidelines for contributors
- [Documentation Guide](documentation-guide.md) -- managing public vs. private security docs

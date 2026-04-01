# Agentic Execution Loop: Complete Check Reference

> All checks, validations, evaluations, and gates that fire during agent execution in the MCP-AQL EXECUTE pipeline.

**Last updated:** 2026-02-21
**Applies to:** v2.0.0

---

## Overview

The agentic execution loop runs from `execute_agent` through repeated `record_execution_step` calls to `complete_execution` (or `abort_execution`). At every phase, multiple defense-in-depth checks evaluate whether the agent should continue, pause for human review, or be hard-stopped.

**Total distinct checks:** 30
**Source of truth:** `src/handlers/mcp-aql/MCPAQLHandler.ts` (dispatch), `src/elements/agents/autonomyEvaluator.ts` (decision engine), `packages/safety/src/TieredSafetyService.ts` (safety tiers)

---

## Phase 1: `execute_agent` -- Agent Initialization

### 1.1 Gatekeeper 4-Layer Policy Enforcement

**Source:** `MCPAQLHandler.executeOperation()` -> `gatekeeper.enforce()`
**Can block:** Yes

Four layers evaluated in sequence:

| Layer | What It Checks | Decision |
|-------|---------------|----------|
| 1. Route validation | Operation exists, endpoint type matches | Reject if invalid |
| 2. Element policy | Active element `allow`/`deny`/`confirm` lists | Deny or require confirmation |
| 3. Session confirmation | Previously approved in this session? | Skip confirmation if cached |
| 4. Default operation policy | `AUTO_APPROVE`, `CONFIRM`, or `DENY` per operation | Final fallback |

**Security events:** `UPDATE_SECURITY_VIOLATION` on deny, `GATEKEEPER_DECISION` on allow

### 1.2 Danger Zone Enforcer Block Check

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2264-2283)
**Can block:** Yes

Queries `DangerZoneEnforcer` to check if the agent is currently blocked from execution. Only read-only operations (`getState`) are allowed for blocked agents. Returns an actionable error with verification instructions if blocked.

### 1.3 Aborted Goal Rejection

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2286-2299)
**Can block:** Yes

Checks if any of the agent's active goal IDs exist in the `abortedGoals` Set. Rejects new state modifications for aborted agents. Only applies to state-modifying operations, not `execute_agent`/`getState`/`abort`.

### 1.4 maxAutonomousSteps Runtime Override Validation

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2309-2315)
**Can block:** Yes

Validates the optional runtime override:
- Must be a number (not string)
- Must be a non-negative integer
- Rejects NaN, null, non-integer values

### 1.5 Executing Agent Tracking Setup

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2317-2359)
**Can block:** No (non-fatal)

Reads the agent element from disk and initializes the `executingAgents` Map with:
- **Gatekeeper policy** from agent metadata (or synthesized from `tools.allowed/denied` via `AgentToolPolicyTranslator`)
- **Resilience policy** from agent metadata
- **maxAutonomousSteps** override
- **Tracking state:** `continuationCount: 0`, `retryCount: 0`, `originalParameters`, `startedAt` timestamp

### 1.6 Server-Side Risk Assessment

**Source:** `AgentManager.executeAgent()` -> `Agent.assessRisk()`
**File:** `src/elements/agents/Agent.ts` (line ~313-380)
**Can block:** No (informational, feeds into safety tier)

Computes a **programmatic risk score (0-100)** from five factors:

| Factor | Points | Condition |
|--------|--------|-----------|
| High-risk goal content | +30 | Goal text matches risk keywords |
| Low confidence decision | +20 | Confidence score below threshold |
| Complex dependency chains | +15 | More than 3 dependencies |
| Aggressive tolerance + high-risk goal | +25 | Agent configured aggressive AND goal is high-risk |
| High concurrent goal load | +10 | Multiple goals active simultaneously |

**Score mapping:** >= 50 = "high", >= 25 = "medium", < 25 = "low"
**Output:** `{ level, score, factors[], mitigations[] }`

This score feeds directly into `determineSafetyTier()` at agent initialization.

### 1.7 Initial Safety Tier Evaluation

**Source:** `AgentManager.executeAgent()` (line ~997-1003)
**Can block:** Yes (if danger_zone tier)

Calls `determineSafetyTier()` with the server-computed risk score before any LLM interaction occurs. See [Safety Tier Evaluation](#safety-tier-evaluation-determineSafetyTier) for full details.

---

## Phase 2: `record_execution_step` -- Recording Agent Steps

### 2a. Input Validation

#### 2.1 nextActionHint Parameter Validation

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2385-2388)
**Can block:** Yes

Type validation: must be a string if provided. Rejects non-string values.

#### 2.2 riskScore Parameter Validation

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2390-2398)
**Can block:** Yes

- Type: must be a number
- NaN check: rejects NaN
- Range: must be 0-100 inclusive
- Rejects Infinity and out-of-range values

**Note:** This is the **LLM-provided** risk score, passed as an optional parameter by the calling agent. It is separate from the server-computed risk score in Phase 1.

### 2b. Step Recording

#### 2.3 Active Goal Check

**Source:** `AgentManager.recordAgentStep()` (line ~2066-2195)
**Can block:** Yes

Loads agent from disk, finds the active in-progress goal. Rejects if no active goal exists.

### 2c. Autonomy Evaluation -- The Core Decision Engine

**Source:** `src/elements/agents/autonomyEvaluator.ts`, function `evaluateAutonomy()`
**Entry point:** Called from `AgentManager.recordAgentStep()` (line ~2159-2171)

The autonomy evaluator runs **5 sequential checks**. Each check can independently decide to pause the agent. The first pause wins (early exit).

#### 2.4 Check 1: Step Limit

**Source:** `checkStepLimit()` (autonomyEvaluator.ts line ~546-566)
**Can block:** Yes

| Condition | Result |
|-----------|--------|
| `maxSteps === 0` | Unlimited, continue |
| `stepCount >= maxSteps` | Pause: "Maximum autonomous steps reached" |
| `stepCount < maxSteps` | Continue |

**Configuration:** `AgentAutonomyConfig.maxAutonomousSteps` (default: 10, env-configurable via `DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT`)

#### 2.5 Check 2: Previous Step Outcome

**Source:** `evaluateAutonomy()` (line ~381-385)
**Can block:** Yes

If the previous step had `outcome: 'failure'`, the agent is **immediately paused** with reason "Previous step failed -- human review recommended". No other factors considered.

#### 2.6 Check 3: Action Pattern Matching

**Source:** `checkActionPatterns()` (autonomyEvaluator.ts line ~579-609)
**Pattern engine:** `src/utils/patternMatcher.ts`
**Can block:** Yes

Matches the `nextActionHint` string (provided by the LLM) against two sets of glob patterns defined in the agent's autonomy config:

**Pattern matching implementation:**
- Custom glob-to-regex converter (NOT minimatch, NOT a third-party library)
- Supports `*` (any sequence) and `?` (single character)
- Case-insensitive matching
- **DoS protection:** Max pattern length 500 chars, max text length 10,000 chars
- Special regex characters escaped before conversion

**Precedence rules:**

| Priority | Pattern Set | Match Result |
|----------|------------|--------------|
| 1 (highest) | `requiresApproval` | Pause -- "Action matches requires-approval pattern: {pattern}" |
| 2 | `autoApprove` | Continue -- "Action matches auto-approve pattern: {pattern}" |
| 3 (default) | No match | Continue |

**Example patterns:**
```yaml
autonomy:
  requiresApproval:
    - "*delete*"
    - "*drop*"
    - "deploy*"
  autoApprove:
    - "read*"
    - "list*"
    - "search*"
```

**Conflict detection:** `detectPatternConflict()` and `findPatternConflicts()` utilities exist for validation but are not applied at runtime.

#### 2.7 Check 4: Safety Tier Evaluation

**Source:** `checkSafetyTier()` (autonomyEvaluator.ts line ~629-723)
**Can block:** Yes (up to and including hard-stop)

Calls `determineSafetyTier()` from `@dollhousemcp/safety`. This is the most complex check -- see [full details below](#safety-tier-evaluation-determineSafetyTier).

**Tier-to-decision mapping:**

| Tier | Decision | Additional Action |
|------|----------|-------------------|
| `advisory` | Continue | None |
| `confirm` | Pause (unless aggressive tolerance) | None |
| `verify` | Pause | Creates verification challenge, shows display code via OS dialog |
| `danger_zone` | **Hard stop** (`stopped: true`) | Blocks agent via DangerZoneEnforcer, creates verification challenge, security event logged |

**Fail-safe (Issue #389):** If `determineSafetyTier()` throws an error, the evaluator returns a **conservative pause** rather than continuing. Logged as `SAFETY_EVALUATION_FAILURE`.

#### 2.8 Check 5: Risk Threshold

**Source:** `checkRiskThreshold()` (autonomyEvaluator.ts line ~735-754)
**Can block:** Yes

Compares the risk score against the agent's configured tolerance threshold:

| Tolerance | Default Threshold | Safety Floor | Security Ceiling | Env Variable |
|-----------|-------------------|-------------|-----------------|--------------|
| Conservative | 25 | 5 | 50 | `DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE` |
| Moderate | 50 | 20 | 80 | `DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE` |
| Aggressive | 75 | 40 | 95 | `DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE` |

**Comparison:** Strict greater-than: `riskScore > threshold` triggers pause.

### 2d. Resilience Policy Evaluation

**Source:** `MCPAQLHandler.evaluateResilience()` (line ~2673-2807)
**Triggers:** Only when autonomy evaluation returns `continue: false`
**Can override pause:** Yes (resilience can turn a pause back into a continue)

#### 2.9 Circuit Breaker Check

**Source:** `CircuitBreakerState` class in `src/elements/agents/resilienceEvaluator.ts`
**Can block:** Yes (overrides resilience)

Checks if the agent has been "tripped" (previously exhausted resilience limits). If tripped within the 5-minute cooldown (`CIRCUIT_BREAKER_COOLDOWN_MS = 300000`), returns pause immediately. Prevents infinite re-execution loops.

#### 2.10 Step Limit Resilience Branch

**Evaluates:** `onStepLimitReached` policy field

| Policy | Behavior |
|--------|----------|
| `pause` | Default -- returns original autonomy result (agent pauses) |
| `continue` | Auto-continues if `continuationCount < maxContinuations`. Increments counter, logs `AGENT_AUTO_CONTINUED` event |
| `restart` | Auto-restarts fresh execution. Increments counter, logs `AGENT_AUTO_RESTARTED` event |

#### 2.11 Execution Failure Resilience Branch

**Evaluates:** `onExecutionFailure` policy field

| Policy | Behavior |
|--------|----------|
| `pause` | Default -- returns original autonomy result |
| `retry` | Retries current step if `retryCount < maxRetries`. Calculates backoff delay, logs `AGENT_STEP_RETRIED` event |
| `restart-fresh` | Restarts execution from scratch |

**Backoff calculation:**
- `none`: No delay
- `linear`: `BACKOFF_BASE_MS (1000) * retryCount`
- `exponential`: `BACKOFF_BASE_MS * (EXPONENTIAL_BASE (2) ^ retryCount)` with optional jitter
- **Cap:** `BACKOFF_MAX_MS = 30000` (30 seconds)

#### 2.12 Limit Exhaustion Handling

When `maxContinuations` or `maxRetries` is exhausted:
- Trips the circuit breaker for this agent
- Logs `AGENT_RESILIENCE_LIMIT_REACHED` security event
- Forces pause with descriptive reason
- Future resilience evaluations blocked for 5 minutes

### 2e. Autonomy Metrics Recording

**Source:** `AutonomyMetricsTracker` class (autonomyEvaluator.ts line ~175-246)

Records throughout all checks:
- `totalEvaluations` (incremented each call)
- `continueCount` / `pauseCount`
- `pauseReasons` distribution map
- `dangerZoneTriggered` count
- `verificationRequired` count
- `averageStepCountAtPause` (rolling window of 1000)
- Logs snapshot every 50 evaluations

---

## Phase 3: `complete_execution` -- Finalizing Agent Goal

### 3.1 Gatekeeper Enforcement
Same 4-layer check as Phase 1.

### 3.2 Danger Zone Block Check
Same as Phase 1.

### 3.3 Aborted Goal Rejection
Same as Phase 1.

### 3.4 Resilience Outcome Tracking

**Source:** `MCPAQLHandler.dispatchExecute()` (line ~2438-2446)

If the agent had a resilience policy AND used continuations or retries:
- Records `resilienceMetrics.recordCompletionAfterResilience(isSuccess)`
- **If success:** Calls `circuitBreaker.reset(agentName)` -- clears trip state, agent can resume normal operation
- **If failure:** Circuit breaker remains tripped

### 3.5 Executing Agent Map Cleanup

Removes agent from `executingAgents` Map. Stops Gatekeeper Layer 2 policy enforcement for this agent. Clears all resilience tracking state.

---

## Phase 4: `continue_execution` -- Resuming Paused Execution

### 4.1 Pre-continue Checks
- Gatekeeper 4-layer enforcement
- Danger zone enforcer block check
- Aborted goal rejection check

### 4.2 Continue Parameters
- `previousStepResult`: Optional string for context
- `parameters`: Optional object for resuming with new context
- Both pass through as-is to AgentManager

---

## Phase 5: `abort_execution` -- Terminating Agent

### 5.1 Active Goal Lookup
Calls `getActiveGoalIds()`. Rejects if no active goals found.

### 5.2 Goal ID Poisoning
Adds all active goal IDs to `abortedGoals` Set. All subsequent execution operations rejected until a new execution starts.

### 5.3 Resilience Failure Recording
Records `resilienceMetrics.recordCompletionAfterResilience(false)`. Does NOT reset circuit breaker (failure keeps it tripped).

### 5.4 Executing Agent Cleanup
Removes from `executingAgents` Map. Calls `dangerZoneEnforcer.unblock(agentName)` if blocked (non-fatal).

### 5.5 Security Event Logging
Logs `AGENT_EXECUTED` event (severity MEDIUM) with agent name, aborted goal IDs, and abort reason.

---

## Safety Tier Evaluation: `determineSafetyTier()`

**Source:** `packages/safety/src/TieredSafetyService.ts` (line ~122-248)
**Called from:** `checkSafetyTier()` in autonomyEvaluator.ts AND `AgentManager.executeAgent()`

This is the core safety classification engine. It takes a risk score, security warnings, goal description, config, and optional execution context, and returns a safety tier.

### Input Parameters

```typescript
determineSafetyTier(
  riskScore: number,          // 0-100, from server or LLM
  securityWarnings: string[], // Flagged issues
  goal: string,               // Current action/goal description
  config: SafetyConfig,       // Threshold configuration
  executionContext?: ExecutionContext,  // Agent chain depth
  logger: AuditLogger         // Audit trail
): SafetyTierResult
```

### Evaluation Steps (in order)

#### Step 1: Danger Zone Pattern Matching (Highest Priority)

**Hard-coded regex patterns** that trigger immediate `danger_zone` regardless of risk score:

| Pattern | Catches |
|---------|---------|
| `rm\s+-rf` | Recursive force delete |
| `DROP\s+TABLE` | SQL table destruction |
| `DELETE.*WHERE\s+1\s*=\s*1` | SQL mass deletion |
| `eval\s*\(` | Dynamic code evaluation |
| `exec\s*\(` | Process execution |
| `child_process` | Node.js process spawning |
| `process\.exit` | Process termination |

**Performance:** Compiled regexes are cached to avoid repeated compilation.
**Result:** If any pattern matches the goal string, returns `tier: 'danger_zone'` immediately with the matching pattern as a factor.

#### Step 2: Critical Security Violation Escalation

Scans `securityWarnings[]` for critical keywords:
- `code injection`
- `credential`
- `destructive action`
- `system() call`
- `exec() call`
- `eval() call`

**If found:** Sets base tier to `verify`. If combined with high risk score (>= `dangerZone` threshold), escalates to `danger_zone`.

#### Step 3: Risk Score-Based Tier Mapping

**Default thresholds:**

| Risk Score | Tier |
|-----------|------|
| 0-30 | `advisory` |
| 31-60 | `confirm` |
| 61-85 | `verify` |
| 86-100 | `danger_zone` |

#### Step 4: Agent Chain Depth Escalation

Only applies when `executionContext` is provided AND `depth >= maxAutonomousDepth`.

Each tier bumps up one level:
- `advisory` -> `confirm`
- `confirm` -> `verify`
- `verify` -> `danger_zone`
- `danger_zone` -> stays `danger_zone`

Sets `escalatedDueToDepth: true` and `originalTier` in the result.

### Output

```typescript
{
  tier: SafetyTier,                // Final tier
  riskScore: number,               // Original score
  factors: string[],               // All decision factors (human-readable)
  escalatedDueToDepth: boolean,    // Was depth escalation applied?
  originalTier?: SafetyTier        // Pre-escalation tier if applicable
}
```

---

## Risk Score: Sources and Flow

Risk scores flow through the system from **two independent sources:**

### Source 1: Server-Side Computation (Programmatic)

**When:** At `execute_agent` time, before any LLM interaction
**How:** `Agent.assessRisk()` evaluates 5 programmatic factors (see [Phase 1.6](#16-server-side-risk-assessment))
**Feeds into:** `determineSafetyTier()` for initial safety classification

This is the server's own risk analysis. It does not depend on the LLM's judgment.

### Source 2: LLM-Provided (Per-Step)

**When:** At `record_execution_step` time, passed as optional `riskScore` parameter
**How:** The LLM client assesses risk for the step it just took or is about to take
**Feeds into:** `evaluateAutonomy()` -> both `checkSafetyTier()` and `checkRiskThreshold()`

This is the LLM's self-reported risk assessment. The server validates it (0-100 range, numeric) and sanitizes edge cases, but the score itself originates from the LLM.

### What the Server Does NOT Do (Current Gaps)

The server does **not** currently:
- Analyze the `stepDescription` text for risk indicators at `record_execution_step` time
- Cross-reference `nextActionHint` against known dangerous operations beyond glob patterns
- Compute an independent risk score for each step (only at initial `execute_agent`)
- Use historical step patterns to detect risk escalation across multiple steps

The per-step risk assessment relies on the LLM providing an honest `riskScore`. The server's programmatic analysis only runs at agent initialization.

---

## Verification Challenge System

When the safety tier evaluation returns `verify` or `danger_zone`, the system creates a verification challenge:

### Challenge Creation

**Source:** `packages/safety/src/TieredSafetyService.ts`

1. Generates UUID v4 `challengeId`
2. Generates display code: 6 characters from `0-9A-HJ-NP-Z` (excludes I, O for readability) using `crypto.randomBytes()`
3. Sets `expiresAt` (default 5 minutes, configurable via `verificationTimeoutMinutes`)

### Display Code Isolation (Security Critical)

The display code is **never returned to the LLM**. It is:
1. Stored server-side in `VerificationStore` (in-memory, one-time-use)
2. Shown to the human operator via OS-native dialog (fire-and-forget):
   - **macOS:** `osascript` with AppleScript
   - **Linux:** `zenity` -> `kdialog` -> `xmessage` fallback chain
   - **Windows:** PowerShell with Base64 encoding
3. Stripped from the `AutonomyDirective` before it reaches the LLM

The LLM receives the `challengeId` and instructions to ask the operator for the code, but cannot see the code itself.

### Verification Flow

1. Operator reads code from OS dialog
2. Operator tells LLM the code
3. LLM calls `verify_challenge` with the code
4. Server validates against `VerificationStore` (one-time use, auto-deleted after any attempt)
5. If valid: `DangerZoneEnforcer.unblock()` releases the agent

---

## Configuration Reference

### AgentAutonomyConfig (per-agent)

```typescript
interface AgentAutonomyConfig {
  riskTolerance?: 'conservative' | 'moderate' | 'aggressive';
  maxAutonomousSteps?: number;       // 0 = unlimited, default: 10
  requiresApproval?: string[];       // Glob patterns that force pause
  autoApprove?: string[];            // Glob patterns that auto-continue
  verificationTimeoutMinutes?: number; // Challenge expiry, default: 5
}
```

### AgentResiliencePolicy (per-agent)

```typescript
interface AgentResiliencePolicy {
  onStepLimitReached?: 'pause' | 'continue' | 'restart';
  onExecutionFailure?: 'pause' | 'retry' | 'restart-fresh';
  maxContinuations?: number;         // Max auto-continues before circuit breaker
  maxRetries?: number;               // Max retries before circuit breaker
  backoffStrategy?: 'none' | 'linear' | 'exponential';
  backoffJitter?: boolean;           // Add randomness to backoff
}
```

### SafetyConfig (system-wide)

```typescript
interface SafetyConfig {
  thresholds: {
    advisory: number;      // Upper bound, default: 30
    confirm: number;       // Upper bound, default: 60
    verify: number;        // Upper bound, default: 85
    dangerZone: number;    // Lower bound, default: 86
  };
  dangerZone: {
    enabled: boolean;
    requiresVerify: boolean;
    requiresAuthenticator: boolean;
    patterns: string[];    // Regex patterns for hard-coded dangerous operations
  };
  agentChain: {
    maxAutonomousDepth: number;
    requireOriginatingHuman: boolean;
  };
  verificationMethods: ('authenticator' | 'display_code' | 'passphrase')[];
}
```

### Environment Variable Overrides

| Variable | Default | Floor | Ceiling | Purpose |
|----------|---------|-------|---------|---------|
| `DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE` | 25 | 5 | 50 | Risk pause threshold for conservative agents |
| `DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE` | 50 | 20 | 80 | Risk pause threshold for moderate agents |
| `DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE` | 75 | 40 | 95 | Risk pause threshold for aggressive agents |
| `DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT` | 10 | -- | 100 | Default step limit when not specified |
| `DOLLHOUSE_GATEKEEPER_ENABLED` | true | -- | -- | Master switch for Gatekeeper system |

---

## Security Events Reference

| Event Type | Severity | Trigger |
|------------|----------|---------|
| `DANGER_ZONE_TRIGGERED` | HIGH | Safety tier = danger_zone |
| `SAFETY_EVALUATION_FAILURE` | MEDIUM | determineSafetyTier() threw error |
| `VERIFICATION_ATTEMPTED` | MEDIUM | verify_challenge called |
| `VERIFICATION_SUCCEEDED` | LOW | Challenge code valid |
| `VERIFICATION_FAILED` | MEDIUM | Wrong code or expired |
| `VERIFICATION_EXPIRED` | LOW | Challenge timed out |
| `AGENT_AUTO_CONTINUED` | MEDIUM | Resilience override to continue |
| `AGENT_STEP_RETRIED` | MEDIUM | Resilience retry with backoff |
| `AGENT_AUTO_RESTARTED` | MEDIUM | Resilience restart fresh |
| `AGENT_RESILIENCE_LIMIT_REACHED` | MEDIUM | Circuit breaker tripped |
| `AGENT_EXECUTED` | MEDIUM | Agent aborted |
| `UPDATE_SECURITY_VIOLATION` | HIGH/MEDIUM | Policy denied or validation failed |
| `GATEKEEPER_DECISION` | LOW | Permission decision logged |
| `OPERATION_COMPLETED` | LOW | Successful operation |
| `VERIFY_REQUIRED` | MEDIUM | Verify tier triggered verification challenge |

---

## Summary: What Fires When

| Phase | Operation | # Checks | Key Decisions |
|-------|-----------|----------|---------------|
| 1 | `execute_agent` | 7 | Gatekeeper, danger zone block, server risk assessment, initial safety tier |
| 2a | Input validation | 2 | nextActionHint type, riskScore range |
| 2b | Step recording | 1 | Active goal exists |
| 2c | Autonomy evaluation | 5 | Step limit, failure check, pattern matching, safety tier, risk threshold |
| 2d | Resilience evaluation | 4 | Circuit breaker, step limit policy, failure policy, limit exhaustion |
| 2e | Metrics | 1 | Rolling metrics snapshot |
| 3 | `complete_execution` | 5 | Gatekeeper, danger zone, aborted goal, resilience cleanup, map cleanup |
| 4 | `continue_execution` | 3 | Gatekeeper, danger zone, aborted goal |
| 5 | `abort_execution` | 5 | Goal lookup, goal poisoning, resilience recording, cleanup, security event |
| **Total** | | **33** | |

---

## File Index

| File | Role |
|------|------|
| `src/handlers/mcp-aql/MCPAQLHandler.ts` | Execute dispatch, resilience evaluation, tracking |
| `src/elements/agents/autonomyEvaluator.ts` | Core 5-check decision engine, metrics, risk sanitization |
| `src/elements/agents/resilienceEvaluator.ts` | Circuit breaker, backoff calculation, resilience actions |
| `src/elements/agents/resilienceMetrics.ts` | 7 in-memory counters, periodic logging |
| `src/elements/agents/safetyTierService.ts` | DollhouseMCP wrapper for @dollhousemcp/safety |
| `src/elements/agents/Agent.ts` | `assessRisk()` server-side risk computation |
| `src/elements/agents/AgentManager.ts` | `recordAgentStep()`, `executeAgent()` orchestration |
| `src/elements/agents/types.ts` | `AgentAutonomyConfig`, `AgentResiliencePolicy`, `AutonomyDirective` |
| `src/utils/patternMatcher.ts` | Custom glob matching with DoS protection |
| `src/config/autonomy-config.ts` | Environment-backed thresholds and defaults |
| `src/security/Gatekeeper.ts` | 4-layer policy enforcement |
| `src/security/DangerZoneEnforcer.ts` | Agent blocking/unblocking |
| `packages/safety/src/TieredSafetyService.ts` | `determineSafetyTier()` core logic |
| `packages/safety/src/config.ts` | Default safety thresholds |
| `packages/safety/src/VerificationStore.ts` | One-time-use challenge storage |
| `packages/safety/src/DisplayService.ts` | Cross-platform OS dialog for verification codes |
| `packages/safety/src/AuditLogger.ts` | Audit event logging interface |
| `packages/safety/src/types.ts` | `SafetyTier`, `SafetyConfig`, `VerificationChallenge` types |

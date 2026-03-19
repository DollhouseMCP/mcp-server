# Agent Verification Tool Specification

**Version:** 1.0.0 (Walking Skeleton)
**Date:** 2025-12-09
**Status:** Draft
**Related:** RFC #97 - Tiered Safety System

---

## Overview

The Agent Verification Tool enables human operators to respond to verification challenges returned by the Tiered Safety System when executing agents at VERIFY or DANGER_ZONE safety tiers.

### Context

When `execute_agent` determines an operation requires human verification (safety tier: VERIFY or DANGER_ZONE), it returns a `VerificationChallenge` object containing:

```typescript
{
  challengeId: string;           // Unique challenge identifier
  challengeType: 'display_code'; // Type of verification (walking skeleton: display_code only)
  prompt: string;                // Human-readable instruction
  expiresAt: string;             // ISO 8601 expiration timestamp
  reason: string;                // Why verification is required
  displayCode?: string;          // The code (LLM cannot see this - logged to console)
}
```

The LLM receives this challenge but **cannot proceed** without human verification. This spec defines the tool that submits the verification response.

---

## 1. New MCP Tool: `verify_agent_execution`

### Tool Definition

```typescript
{
  name: "verify_agent_execution",
  description: "Submit verification response for a pending agent execution challenge. Required when execute_agent returns verificationRequired (VERIFY or DANGER_ZONE tier).",
  inputSchema: {
    type: "object",
    properties: {
      challengeId: {
        type: "string",
        description: "The unique challenge ID from verificationRequired.challengeId"
      },
      verificationCode: {
        type: "string",
        description: "The verification code (display code shown on terminal, or authenticator code)"
      },
      agentName: {
        type: "string",
        description: "Name of the agent to execute after successful verification"
      },
      parameters: {
        type: "object",
        description: "Agent parameters (same as passed to original execute_agent call)",
        additionalProperties: true
      }
    },
    required: ["challengeId", "verificationCode", "agentName", "parameters"]
  }
}
```

### Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `challengeId` | string | Yes | Unique challenge ID returned by `execute_agent` |
| `verificationCode` | string | Yes | Code entered by human (display code from terminal) |
| `agentName` | string | Yes | Name of agent to execute after verification |
| `parameters` | object | Yes | Agent parameters (must match original call) |

### Tool Response

**Success:**
```typescript
{
  success: true,
  message: "Verification successful. Executing agent...",
  result: ExecuteAgentResult  // Full agent execution result (as if no verification was required)
}
```

**Failure - Invalid Code:**
```typescript
{
  success: false,
  error: "VERIFICATION_FAILED",
  message: "Invalid verification code. Please try again.",
  remainingAttempts?: number  // Optional: track retry limit
}
```

**Failure - Expired Challenge:**
```typescript
{
  success: false,
  error: "CHALLENGE_EXPIRED",
  message: "Verification challenge expired at 2025-12-09T18:30:00Z. Please re-run execute_agent to generate a new challenge.",
  expiresAt: string
}
```

**Failure - Challenge Not Found:**
```typescript
{
  success: false,
  error: "CHALLENGE_NOT_FOUND",
  message: "Challenge ID not found. It may have expired or been completed.",
  challengeId: string
}
```

**Failure - Danger Zone Blocked:**
```typescript
{
  success: false,
  error: "DANGER_ZONE_BLOCKED",
  message: "This operation is blocked by danger zone settings. Enable danger zone operations in configuration to proceed.",
  howToEnable: string
}
```

---

## 2. Challenge Storage (Walking Skeleton)

### In-Memory Storage

For the walking skeleton, challenges are stored in an in-memory `Map`:

```typescript
interface StoredChallenge {
  challengeId: string;
  challengeType: VerificationChallengeType;
  displayCode?: string;           // The actual code to verify against
  agentName: string;              // Agent being executed
  parameters: Record<string, any>; // Original parameters
  createdAt: Date;
  expiresAt: Date;
  reason: string;
  attempts?: number;              // Track failed attempts (optional)
}

// In-memory storage (singleton)
private pendingChallenges: Map<string, StoredChallenge> = new Map();
```

### Storage Location

Create new file: `src/elements/agents/VerificationChallengeStore.ts`

```typescript
export class VerificationChallengeStore {
  private static instance: VerificationChallengeStore;
  private challenges: Map<string, StoredChallenge> = new Map();

  private constructor() {}

  static getInstance(): VerificationChallengeStore {
    if (!VerificationChallengeStore.instance) {
      VerificationChallengeStore.instance = new VerificationChallengeStore();
    }
    return VerificationChallengeStore.instance;
  }

  // Methods: store, retrieve, validate, expire, cleanup
}
```

### Challenge Lifecycle

1. **Creation:** When `executeAgent()` creates a verification challenge, store it
2. **Retrieval:** When `verify_agent_execution` is called, retrieve by ID
3. **Validation:** Check expiration, verify code, check attempts
4. **Cleanup:** Remove challenge after successful verification
5. **Expiration:** Periodic cleanup of expired challenges (optional for walking skeleton)

---

## 3. Verification Flow

### Step-by-Step Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. LLM calls execute_agent(name: "deploy-prod", {...})     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. AgentManager.executeAgent() runs                         │
│    - Evaluates risk: score = 75 (VERIFY tier)              │
│    - Creates VerificationChallenge                          │
│      - challengeId: "challenge_1733781234567_abc123"       │
│      - displayCode: "H4K2P9" (generated randomly)          │
│      - expiresAt: 5 minutes from now                       │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Store challenge in VerificationChallengeStore            │
│    - Key: challengeId                                       │
│    - Value: StoredChallenge with displayCode + context     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Display code to terminal (console.log)                  │
│    ┌─────────────────────────────────────────────────┐    │
│    │ ⚠️  VERIFICATION REQUIRED                        │    │
│    │                                                   │    │
│    │ Enter this code to verify agent execution:      │    │
│    │                                                   │    │
│    │         H4K2P9                                   │    │
│    │                                                   │    │
│    │ Challenge ID: challenge_1733781234567_abc123    │    │
│    │ Expires: 2025-12-09T18:30:00Z                   │    │
│    └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Return ExecuteAgentResult with verificationRequired      │
│    {                                                        │
│      safetyTier: "verify",                                 │
│      verificationRequired: {                               │
│        challengeId: "challenge_1733781234567_abc123",     │
│        challengeType: "display_code",                      │
│        prompt: "Enter verification code...",               │
│        expiresAt: "2025-12-09T18:30:00Z",                 │
│        reason: "Risk score 75 >= verify threshold"        │
│        // displayCode NOT included (LLM can't see it)     │
│      },                                                     │
│      ...                                                    │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. LLM informs user and prompts for code                   │
│    "I need verification to proceed. Please enter the       │
│     code displayed on your terminal."                      │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 7. Human reads code from terminal: "H4K2P9"               │
│    Human tells LLM: "The code is H4K2P9"                  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 8. LLM calls verify_agent_execution(                       │
│      challengeId: "challenge_1733781234567_abc123",       │
│      verificationCode: "H4K2P9",                           │
│      agentName: "deploy-prod",                             │
│      parameters: { ... }                                   │
│    )                                                        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 9. Verification handler validates                           │
│    - Retrieve challenge from store                         │
│    - Check not expired (expiresAt > now)                   │
│    - Compare codes (case-insensitive)                      │
│    - Match: H4K2P9 == H4K2P9 ✓                            │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 10. Execute agent (bypass safety checks - already verified)│
│     - Call AgentManager.executeAgent() with bypass flag    │
│     - Return full ExecuteAgentResult                       │
│     - Remove challenge from store                          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 11. LLM proceeds with agent execution using result         │
└─────────────────────────────────────────────────────────────┘
```

### Display Code Output (Terminal)

The `createVerificationChallenge()` function in `safetyTierService.ts` should log the display code:

```typescript
if (challengeType === 'display_code') {
  displayCode = generateDisplayCode();

  // Log to console (stderr) so LLM cannot see it
  console.error('\n' + '='.repeat(50));
  console.error('⚠️  VERIFICATION REQUIRED');
  console.error('='.repeat(50));
  console.error('');
  console.error('Enter this code to verify agent execution:');
  console.error('');
  console.error(`    ${displayCode}`);
  console.error('');
  console.error(`Challenge ID: ${challengeId}`);
  console.error(`Expires: ${expiresAt}`);
  console.error('='.repeat(50));
  console.error('\n');
}
```

**Why stderr?** MCP protocol uses stdout for JSON-RPC messages. Logging to stderr ensures the display code reaches the user's terminal without interfering with protocol messages.

---

## 4. Error Cases

### Error Case 1: Expired Challenge

**Scenario:** User provides code after expiration time (5 minutes default)

**Detection:**
```typescript
const challenge = store.retrieve(challengeId);
if (new Date() > challenge.expiresAt) {
  throw new Error('CHALLENGE_EXPIRED');
}
```

**Response:**
```json
{
  "success": false,
  "error": "CHALLENGE_EXPIRED",
  "message": "Verification challenge expired at 2025-12-09T18:30:00Z. Please re-run execute_agent to generate a new challenge.",
  "expiresAt": "2025-12-09T18:30:00Z"
}
```

**Next Action:** LLM must call `execute_agent` again to generate a fresh challenge.

---

### Error Case 2: Wrong Code

**Scenario:** User provides incorrect verification code

**Detection:**
```typescript
const storedCode = challenge.displayCode?.toUpperCase();
const providedCode = verificationCode.toUpperCase();

if (storedCode !== providedCode) {
  challenge.attempts = (challenge.attempts || 0) + 1;
  throw new Error('VERIFICATION_FAILED');
}
```

**Response:**
```json
{
  "success": false,
  "error": "VERIFICATION_FAILED",
  "message": "Invalid verification code. Please try again.",
  "remainingAttempts": 2
}
```

**Walking Skeleton:** No attempt limit (user can retry indefinitely until expiration)
**Future Enhancement:** Lock after 3 failed attempts

---

### Error Case 3: Challenge Not Found

**Scenario:** Challenge ID doesn't exist (expired and cleaned up, or never existed)

**Detection:**
```typescript
const challenge = store.retrieve(challengeId);
if (!challenge) {
  throw new Error('CHALLENGE_NOT_FOUND');
}
```

**Response:**
```json
{
  "success": false,
  "error": "CHALLENGE_NOT_FOUND",
  "message": "Challenge ID not found. It may have expired or been completed.",
  "challengeId": "challenge_1733781234567_abc123"
}
```

**Next Action:** LLM must call `execute_agent` again.

---

### Error Case 4: Danger Zone Blocked

**Scenario:** Verification succeeds but danger zone operations are disabled

**Detection:**
```typescript
// After successful verification, check if this was a danger_zone tier
if (challenge.safetyTier === 'danger_zone' && !DEFAULT_SAFETY_CONFIG.dangerZone.enabled) {
  throw new Error('DANGER_ZONE_BLOCKED');
}
```

**Response:**
```json
{
  "success": false,
  "error": "DANGER_ZONE_BLOCKED",
  "message": "This operation is blocked by danger zone settings. Enable danger zone operations in configuration to proceed.",
  "howToEnable": "Set safety.dangerZone.enabled = true in your configuration"
}
```

**Next Action:** Operator must enable danger zone in config before this operation can proceed.

---

## 5. Implementation Details

### 5.1 File Structure

```
src/elements/agents/
├── VerificationChallengeStore.ts   # NEW - Challenge storage singleton
├── AgentManager.ts                 # MODIFY - Store challenges on creation
└── safetyTierService.ts            # MODIFY - Add console logging for display codes

src/handlers/
└── AgentHandler.ts                 # NEW - Handler for verify_agent_execution tool

src/server/tools/
└── AgentTools.ts                   # NEW - Tool definition for verify_agent_execution
```

### 5.2 Integration Points

**AgentManager.executeAgent() modifications:**

```typescript
// After creating verification challenge (line ~744)
if (safetyTierResult.tier === 'verify' || safetyTierResult.tier === 'danger_zone') {
  const challenge = createVerificationChallenge(...);

  // Store challenge with full context
  VerificationChallengeStore.getInstance().store({
    challengeId: challenge.challengeId,
    challengeType: challenge.challengeType,
    displayCode: challenge.displayCode,
    agentName: name,
    parameters: parameters,
    createdAt: new Date(),
    expiresAt: new Date(challenge.expiresAt),
    reason: challenge.reason,
    safetyTier: safetyTierResult.tier
  });

  result.verificationRequired = challenge;
}
```

**New handler: AgentHandler.verifyAgentExecution()**

```typescript
async verifyAgentExecution(args: VerifyAgentExecutionArgs): Promise<VerifyAgentExecutionResult> {
  const store = VerificationChallengeStore.getInstance();

  // 1. Retrieve challenge
  const challenge = store.retrieve(args.challengeId);
  if (!challenge) {
    return { success: false, error: 'CHALLENGE_NOT_FOUND', ... };
  }

  // 2. Check expiration
  if (new Date() > challenge.expiresAt) {
    store.remove(args.challengeId); // Cleanup
    return { success: false, error: 'CHALLENGE_EXPIRED', ... };
  }

  // 3. Verify code (case-insensitive)
  const storedCode = challenge.displayCode?.toUpperCase();
  const providedCode = args.verificationCode.toUpperCase();

  if (storedCode !== providedCode) {
    // Track attempts (optional)
    challenge.attempts = (challenge.attempts || 0) + 1;
    return { success: false, error: 'VERIFICATION_FAILED', ... };
  }

  // 4. Check danger zone blocking
  if (challenge.safetyTier === 'danger_zone' && !DEFAULT_SAFETY_CONFIG.dangerZone.enabled) {
    return { success: false, error: 'DANGER_ZONE_BLOCKED', ... };
  }

  // 5. Execute agent (bypass verification - already verified)
  const result = await this.agentManager.executeAgent(
    args.agentName,
    args.parameters,
    { bypassVerification: true, verifiedChallengeId: args.challengeId }
  );

  // 6. Remove challenge (one-time use)
  store.remove(args.challengeId);

  // 7. Return success with full agent result
  return {
    success: true,
    message: 'Verification successful. Agent execution complete.',
    result: result
  };
}
```

### 5.3 Bypass Verification Flag

Add optional bypass parameter to `AgentManager.executeAgent()`:

```typescript
async executeAgent(
  name: string,
  parameters: Record<string, unknown>,
  options?: {
    bypassVerification?: boolean;
    verifiedChallengeId?: string;
    executionContext?: ExecutionContext; // For agent chains
  }
): Promise<ExecuteAgentResult>
```

When `bypassVerification: true`, skip safety tier checks and proceed directly to execution.

### 5.4 Security Logging

Log all verification attempts:

```typescript
SecurityMonitor.logSecurityEvent({
  type: 'VERIFICATION_ATTEMPT',
  severity: success ? 'LOW' : 'MEDIUM',
  source: 'AgentHandler.verifyAgentExecution',
  details: `Verification ${success ? 'succeeded' : 'failed'} for agent '${agentName}'`,
  additionalData: {
    challengeId,
    agentName,
    success,
    failureReason: success ? undefined : error
  }
});
```

---

## 6. Testing Strategy

### Unit Tests

**File:** `tests/unit/elements/agents/VerificationChallengeStore.test.ts`

Test cases:
- Store and retrieve challenge
- Retrieve non-existent challenge returns undefined
- Remove challenge
- Expired challenge detection
- Case-insensitive code comparison

**File:** `tests/unit/handlers/AgentHandler.test.ts`

Test cases:
- Successful verification flow
- Expired challenge returns error
- Wrong code returns error
- Challenge not found returns error
- Danger zone blocked returns error
- Multiple attempts tracking (optional)

### Integration Tests

**File:** `tests/integration/agents/agent-verification-flow.test.ts`

Test scenarios:
1. Full flow: execute_agent → verify_agent_execution → success
2. Expiration: execute_agent → wait 5 min → verify → expired error
3. Wrong code retry: execute_agent → wrong code → retry → correct code → success

### Manual Testing Checklist

- [ ] Display code appears on terminal (stderr)
- [ ] Display code is readable and formatted correctly
- [ ] LLM does not receive display code in ExecuteAgentResult
- [ ] Verification succeeds with correct code
- [ ] Verification fails with wrong code
- [ ] Verification fails after expiration
- [ ] Challenge removed after successful verification
- [ ] Security events logged correctly

---

## 7. Future Enhancements (Out of Scope for Walking Skeleton)

### Authenticator Code Support (TOTP)

- Secret storage and QR code generation
- Time-based one-time password validation
- Recovery codes for backup
- Per-user TOTP secrets

### Passphrase Support

- User-configured passphrase verification
- Encrypted storage of passphrase hash
- Passphrase complexity requirements

### Persistent Challenge Storage

- Database storage instead of in-memory Map
- Survive server restarts
- Audit trail of all verifications

### Retry Limits

- Lock challenge after 3 failed attempts
- Exponential backoff on retries
- Rate limiting per user/IP

### Multi-User Support

- User-specific verification challenges
- Per-user TOTP secrets
- Role-based verification requirements

---

## 8. Open Questions

1. **Challenge expiration:** 5 minutes sufficient? Configurable?
   - **Decision:** 5 minutes default, add to SafetyConfig for configurability

2. **Retry limits:** Should walking skeleton enforce attempt limits?
   - **Decision:** No limit for walking skeleton. Track attempts but don't block.

3. **Cleanup interval:** When to remove expired challenges?
   - **Decision:** Remove on retrieval if expired. Background cleanup optional.

4. **Agent chain context:** Should verification be required for each agent in chain?
   - **Decision:** Yes. Each agent evaluated independently (depth escalation applies).

5. **Bypass flag security:** How to prevent LLM from guessing bypass flag?
   - **Decision:** Bypass only accepted with valid verifiedChallengeId that exists in store.

---

## 9. Success Criteria

Walking skeleton is complete when:

- ✅ `verify_agent_execution` tool defined and registered
- ✅ `VerificationChallengeStore` stores and retrieves challenges
- ✅ Display codes appear on terminal (stderr)
- ✅ LLM cannot see display codes in ExecuteAgentResult
- ✅ Verification succeeds with correct code
- ✅ Verification fails with wrong/expired code
- ✅ Security events logged for all attempts
- ✅ Unit tests cover all error cases
- ✅ Integration test covers full flow
- ✅ Manual testing confirms display codes visible to user

---

## 10. References

- RFC #97: Tiered Safety System
- Session Notes: `docs/agent/development/SESSION_NOTES_2025-12-09_TIERED_SAFETY_SYSTEM.md`
- Safety Tier Service: `src/elements/agents/safetyTierService.ts`
- Agent Types: `src/elements/agents/types.ts`
- Agent Manager: `src/elements/agents/AgentManager.ts`

---

*End of Specification*

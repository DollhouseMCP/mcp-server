# @dollhousemcp/safety

Tiered safety infrastructure for MCP servers with zero external dependencies.

## Overview

`@dollhousemcp/safety` provides a comprehensive safety system for Model Context Protocol (MCP) servers, including:

- **Tiered Safety System**: Four safety tiers (advisory, confirm, verify, danger_zone) based on risk assessment
- **Verification Challenges**: Server-side challenge storage and LLM-proof verification codes
- **Cross-Platform Dialogs**: Native OS dialog support (macOS, Linux, Windows)
- **Audit Logging**: Pluggable audit logging for safety events
- **Agent Chain Tracking**: Context tracking for multi-agent execution chains

## Features

- **Zero Dependencies**: Uses only Node.js built-in modules
- **TypeScript**: Full type definitions included
- **ESM-Only**: Modern ES module support
- **Lightweight**: ~20KB package size
- **Cross-Platform**: Works on macOS, Linux, and Windows

## Installation

```bash
npm install @dollhousemcp/safety
```

## Usage

### Basic Safety Tier Determination

```typescript
import { determineSafetyTier, DEFAULT_SAFETY_CONFIG } from '@dollhousemcp/safety';

const result = determineSafetyTier(
  75, // risk score
  ['Potential credential exposure'], // security warnings
  'read credentials from file', // goal/operation description
  DEFAULT_SAFETY_CONFIG
);

console.log(result.tier); // 'verify'
console.log(result.factors); // ['Risk score 75 >= 61 (verify threshold)', ...]
```

### Verification Challenges

```typescript
import {
  createVerificationChallenge,
  VerificationStore,
  showVerificationDialog
} from '@dollhousemcp/safety';

// Create a verification challenge
const challenge = createVerificationChallenge(
  'High-risk operation detected',
  'display_code',
  5 // expires in 5 minutes
);

// Store the challenge
const store = new VerificationStore();
store.set(challenge.challengeId, {
  code: challenge.displayCode!,
  expiresAt: new Date(challenge.expiresAt).getTime(),
  reason: challenge.reason,
});

// Show dialog to user (LLM cannot see the code)
showVerificationDialog(
  challenge.displayCode!,
  challenge.reason,
  { title: 'Verification Required', icon: 'warning' }
);

// Later, verify user input
const isValid = store.verify(challenge.challengeId, userInput);
```

### Agent Chain Tracking

```typescript
import { createExecutionContext, DEFAULT_SAFETY_CONFIG } from '@dollhousemcp/safety';

// Direct invocation (depth 0)
const context1 = createExecutionContext('agent1');

// Nested invocation (depth 1)
const context2 = createExecutionContext('agent2', context1);

// Check for depth escalation
if (context2.depthEscalation) {
  console.log('Agent chain depth exceeded, escalating safety tier');
}
```

### Custom Audit Logging

```typescript
import {
  determineSafetyTier,
  createAuditLogger,
  SafetyAuditEvent
} from '@dollhousemcp/safety';

// Create custom audit logger
const logger = createAuditLogger((event: SafetyAuditEvent) => {
  // Send to your monitoring system
  myMonitoring.track('safety_event', {
    type: event.type,
    tier: event.tier,
    timestamp: event.timestamp,
    details: event.details,
  });
});

// Use with safety tier determination
const result = determineSafetyTier(
  50,
  [],
  'operation',
  DEFAULT_SAFETY_CONFIG,
  undefined,
  logger // Pass your custom logger
);
```

## API Reference

### Safety Tier Determination

- `determineSafetyTier(riskScore, securityWarnings, goal, config?, executionContext?, logger?)`: Determine safety tier
- `matchesDangerZonePattern(goal, patterns)`: Check for dangerous patterns
- `hasCriticalSecurityViolations(warnings)`: Check for critical security issues

### Verification

- `createVerificationChallenge(reason, type?, expirationMinutes?, logger?)`: Create verification challenge
- `generateDisplayCode(length?)`: Generate LLM-proof verification code
- `VerificationStore`: Server-side challenge storage
  - `set(challengeId, challenge)`: Store challenge
  - `get(challengeId)`: Retrieve challenge
  - `verify(challengeId, code)`: Verify code
  - `cleanup()`: Remove expired challenges

### Display Service

- `showVerificationDialog(code, reason, options?)`: Show OS-native dialog (macOS/Linux/Windows)
- `isDialogAvailable()`: Check if dialogs are available on current platform

### Confirmation & Danger Zone

- `createConfirmationRequest(reason, riskFactors)`: Create confirmation request
- `createDangerZoneOperation(operationType, reason, enabled, config?, logger?)`: Create danger zone operation
- `createExecutionContext(agentName, parentContext?, config?)`: Create execution context for agent chains

### Configuration

- `DEFAULT_SAFETY_CONFIG`: Default safety configuration
  - Thresholds: advisory (30), confirm (31), verify (61), danger_zone (86)
  - Danger zone patterns: rm -rf, DROP TABLE, eval(), etc.
  - Agent chain max depth: 2

### Audit Logging

- `defaultAuditLogger`: No-op logger (silent)
- `consoleAuditLogger`: Console-based logger for development
- `createAuditLogger(callback)`: Create custom logger

## Safety Tiers

1. **Advisory** (risk score 0-30): Low risk, informational only
2. **Confirm** (risk score 31-60): Moderate risk, simple confirmation recommended
3. **Verify** (risk score 61-85): High risk, human verification required (LLM-proof)
4. **Danger Zone** (risk score 86+): Critical risk, blocked by default unless explicitly enabled

## Platform Support

### macOS
- Uses `osascript` for native dialogs
- Always available

### Linux
- Tries `zenity`, `kdialog`, `xmessage` in order
- Graceful fallback if no GUI available

### Windows
- Uses PowerShell `MessageBox`
- Always available

## License

AGPL-3.0

## Contributing

See the main [DollhouseMCP repository](https://github.com/DollhouseMCP/mcp-server) for contribution guidelines.

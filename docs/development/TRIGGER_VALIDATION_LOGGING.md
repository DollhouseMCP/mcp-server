# Enhanced Trigger Validation Logging Pattern

## Overview

This document describes the enhanced logging pattern for trigger validation across all element managers in DollhouseMCP. This pattern provides detailed debugging information when triggers are rejected during element loading.

## Background

Initially implemented in `AgentManager` and `TemplateManager` (PRs #1137, #1138), this enhanced pattern provides more detailed logging than the basic implementation, making it easier to debug trigger validation issues.

## Implementation Pattern

### Constants

```typescript
// Validation constants for triggers
const MAX_TRIGGER_LENGTH = 50;
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_]+$/;
```

### Enhanced Validation with Detailed Logging

```typescript
// FIX #[ISSUE_NUMBER]: Extract and validate triggers for Enhanced Index support
if (typedMetadata.triggers && Array.isArray(typedMetadata.triggers)) {
  const rawTriggers = typedMetadata.triggers;
  const sanitizedTriggers = rawTriggers.map((trigger: any) => ({
    raw: trigger,
    sanitized: sanitizeInput(String(trigger), MAX_TRIGGER_LENGTH)
  }));

  // Filter valid triggers and track rejected ones
  const validTriggers: string[] = [];
  const rejectedTriggers: string[] = [];

  for (const { raw, sanitized } of sanitizedTriggers) {
    if (!sanitized) {
      rejectedTriggers.push(`"${raw}" (empty after sanitization)`);
    } else if (!TRIGGER_VALIDATION_REGEX.test(sanitized)) {
      rejectedTriggers.push(`"${sanitized}" (invalid format - must be alphanumeric with hyphens/underscores only)`);
    } else {
      validTriggers.push(sanitized);
    }
  }

  // Log warnings for rejected triggers to aid debugging
  if (rejectedTriggers.length > 0) {
    logger.warn(
      `${ElementType} "${metadata.name || 'unknown'}": Rejected ${rejectedTriggers.length} invalid trigger(s)`,
      {
        elementName: metadata.name,
        rejectedTriggers,
        acceptedCount: validTriggers.length
      }
    );
  }

  // Apply limit and warn if exceeded
  if (validTriggers.length > 20) {
    logger.warn(
      `${ElementType} "${metadata.name || 'unknown'}": Trigger count exceeds limit (${validTriggers.length} > 20), truncating`,
      {
        elementName: metadata.name,
        totalTriggers: validTriggers.length,
        truncatedTriggers: validTriggers.slice(20)
      }
    );
  }

  metadata.triggers = validTriggers.slice(0, 20);
}
```

## Benefits of Enhanced Pattern

### 1. Detailed Rejection Reasons
Each rejected trigger includes the specific reason for rejection:
- `"   " (empty after sanitization)` - Whitespace-only triggers
- `"invalid@trigger" (invalid format - must be alphanumeric with hyphens/underscores only)` - Invalid characters

### 2. Comprehensive Logging Context
Log entries include:
- Element name for easy identification
- Complete list of rejected triggers
- Count of accepted triggers
- Truncated triggers when limit exceeded

### 3. Debugging Support
Example log output:
```
Agent "Task Automator": Rejected 2 invalid trigger(s)
{
  elementName: "Task Automator",
  rejectedTriggers: [
    "execute task" (invalid format - must be alphanumeric with hyphens/underscores only)",
    "@automate" (invalid format - must be alphanumeric with hyphens/underscores only)"
  ],
  acceptedCount: 3
}
```

### 4. Limit Enforcement Visibility
When trigger count exceeds the 20-trigger limit:
```
Template "Complex Template": Trigger count exceeds limit (25 > 20), truncating
{
  elementName: "Complex Template",
  totalTriggers: 25,
  truncatedTriggers: ["trigger-21", "trigger-22", "trigger-23", "trigger-24", "trigger-25"]
}
```

## Migration Guide

To update existing element managers to use the enhanced pattern:

### 1. Current Basic Pattern (SkillManager, MemoryManager)
```typescript
if (data.triggers && Array.isArray(data.triggers)) {
  metadata.triggers = data.triggers
    .map((trigger: any) => sanitizeInput(String(trigger), MAX_TRIGGER_LENGTH))
    .filter((trigger: string) => trigger && TRIGGER_VALIDATION_REGEX.test(trigger))
    .slice(0, 20);
}
```

### 2. Convert to Enhanced Pattern
Replace the basic pattern with the enhanced implementation shown above, adjusting:
- Element type name in log messages
- Property names (e.g., `agentName`, `skillName`, `templateName`)

## Testing Requirements

When implementing the enhanced pattern, ensure tests cover:

1. **Valid triggers are accepted**
   ```typescript
   expect(element.metadata.triggers).toEqual(['valid', 'triggers', 'here']);
   ```

2. **Invalid triggers are logged**
   ```typescript
   expect(loggerWarnMock).toHaveBeenCalledWith(
     expect.stringContaining('Rejected X invalid trigger(s)'),
     expect.objectContaining({
       elementName: 'Element Name',
       rejectedTriggers: expect.arrayContaining([...]),
       acceptedCount: Y
     })
   );
   ```

3. **Trigger limits are enforced and logged**
   ```typescript
   expect(loggerWarnMock).toHaveBeenCalledWith(
     expect.stringContaining('Trigger count exceeds limit'),
     expect.objectContaining({
       totalTriggers: 25,
       truncatedTriggers: expect.arrayContaining([...])
     })
   );
   ```

## Rollout Plan

### Phase 1: Documentation (Current)
- Document the enhanced pattern
- Create migration guide

### Phase 2: Gradual Migration
Priority order for updating existing managers:
1. **SkillManager** - High usage, would benefit from enhanced debugging
2. **MemoryManager** - Complex trigger scenarios benefit from detailed logging
3. **PersonaManager** - Already has triggers but could use enhanced logging

### Phase 3: Validation
- Ensure all element managers use consistent logging
- Update integration tests to verify logging behavior

## References

- PR #1137: Template trigger extraction with enhanced logging
- PR #1138: Agent trigger extraction with enhanced logging
- Issue #1120-1123: Trigger extraction for all element types
- Enhanced Capability Index documentation
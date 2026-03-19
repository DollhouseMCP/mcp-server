# Memory Auto-Load Architectures

## Overview

This document explains the two valid architectural approaches for implementing memory auto-load in DollhouseMCP, their trade-offs, and when to use each.

## Background

Issue #1430 introduced auto-load functionality to automatically activate memories marked with `autoLoad: true` during server startup. This ensures baseline knowledge is available immediately without manual activation.

## The Two Approaches

### Approach 1: MemoryManager.loadAndActivateAutoLoadMemories() (Current)

**Location**: `src/elements/memories/MemoryManager.ts`

**Called by**: `Container.preparePortfolio()` directly

**Architecture Pattern**: DI-aligned, manager-owned operations

```typescript
// In Container.preparePortfolio()
const memoryManager = this.resolve<MemoryManager>('MemoryManager');
const result = await memoryManager.loadAndActivateAutoLoadMemories();
```

**Pros:**
- Better encapsulation - all memory operations in one place
- Clearer ownership - MemoryManager owns all memory lifecycle
- No duplicate responsibility between managers and startup orchestrators
- Follows established DI pattern (managers own their element types)
- Simpler dependency graph - no intermediate orchestration layer

**Cons:**
- Less centralized startup control
- Harder to add cross-cutting startup features (metrics, rollback, etc.)
- Each manager must implement its own initialization if needed

**When to use:**
- Simple, focused auto-load without complex orchestration
- When you want minimal indirection
- When following pure DI patterns

### Approach 2: ServerStartup.initializeAutoLoadMemories() (Alternative)

**Location**: `src/server/startup.ts`

**Called by**: Can be called from Container or standalone workflows

**Architecture Pattern**: Orchestrated startup sequence

```typescript
// In Container.preparePortfolio() (alternative)
const serverStartup = new ServerStartup(
  portfolioManager,
  fileLockManager,
  configManager
);
await serverStartup.initialize();
```

**Pros:**
- Centralizes all startup concerns in one place
- Easier to add cross-cutting features (telemetry, rollback, health checks)
- Can coordinate multiple managers and phases
- Better for complex startup sequences with dependencies
- Easier to add startup-time-only features

**Cons:**
- Introduces an intermediate orchestration layer
- Can duplicate responsibility (both ServerStartup and managers know about initialization)
- More complex dependency graph
- Potential for ServerStartup to grow into a god object

**When to use:**
- Complex startup with multiple coordinated phases
- Need startup-specific orchestration (rollback, telemetry, health checks)
- Multiple managers need to coordinate during startup
- Startup workflow differs significantly from runtime operations

## Implementation Details

### MemoryManager Approach (Current)

```typescript
async loadAndActivateAutoLoadMemories(): Promise<{
  loaded: number;
  skipped: number;
  totalTokens: number;
  errors: string[];
}> {
  // 1. Check emergency disable
  if (process.env.DOLLHOUSE_DISABLE_AUTOLOAD === 'true') {
    return { loaded: 0, skipped: 0, totalTokens: 0, errors: [] };
  }

  // 2. Install seed memories
  await this.installSeedMemories();

  // 3. Get auto-load memories
  const autoLoadMemories = await this.getAutoLoadMemories();

  // 4. Activate each memory
  for (const memory of autoLoadMemories) {
    await memory.activate();
  }

  return statistics;
}
```

Called from Container:
```typescript
if (config.autoLoad.enabled) {
  const memoryManager = this.resolve<MemoryManager>('MemoryManager');
  const result = await memoryManager.loadAndActivateAutoLoadMemories();
}
```

### ServerStartup Approach (Alternative)

```typescript
class ServerStartup {
  private async initializeAutoLoadMemories(): Promise<void> {
    // 1. Check config
    const config = this.configManager.getConfig();
    if (!config.autoLoad.enabled) return;

    // 2. Install seeds
    await this.memoryManager.installSeedMemories();

    // 3. Get auto-load memories
    const autoLoadMemories = await this.memoryManager.getAutoLoadMemories();

    // 4. Process with token budgets, warnings, etc.
    for (const memory of autoLoadMemories) {
      // Token budget enforcement
      // Size warnings
      // Activation
    }

    // 5. Record telemetry
    await OperationalTelemetry.recordAutoLoadMetrics(metrics);
  }
}
```

## Feature Comparison

| Feature | MemoryManager Approach | ServerStartup Approach |
|---------|----------------------|----------------------|
| Emergency disable | Yes | Yes |
| Seed installation | Yes | Yes |
| Token estimation | Yes | Yes |
| Validation | Yes | Yes |
| Security logging | Yes | Yes |
| Config checking | Container handles | ServerStartup handles |
| Token budgets | Can add | Already implemented |
| Telemetry | Can add | Already implemented |
| Size warnings | Can add | Already implemented |
| Rollback on error | Would need Container | Can add in ServerStartup |

## Current Status (Post-Refactoring)

**Active Implementation**: MemoryManager.loadAndActivateAutoLoadMemories()

**Used by**: Container.preparePortfolio()

**ServerStartup status**: Kept for alternative workflows and future use

**Why the change**:
1. Better aligns with DI principles
2. Reduces duplicate responsibility
3. Simpler for the common case (just load memories)
4. ServerStartup can focus on complex orchestration when needed

## Migration Guide

### If you're using ServerStartup approach

Current code:
```typescript
const serverStartup = new ServerStartup(portfolioManager, fileLockManager, configManager);
await serverStartup.initialize();
```

Migrate to:
```typescript
const configManager = this.resolve<ConfigManager>('ConfigManager');
await configManager.initialize();
const config = configManager.getConfig();

if (config.autoLoad.enabled) {
  const memoryManager = this.resolve<MemoryManager>('MemoryManager');
  const result = await memoryManager.loadAndActivateAutoLoadMemories();
}
```

### If you need ServerStartup features

ServerStartup is still available and maintained. Use it when you need:
- Complex startup orchestration
- Cross-cutting startup metrics
- Coordinated initialization of multiple managers
- Startup-specific rollback or error handling

## Testing Both Approaches

Both approaches have comprehensive test coverage:

**MemoryManager tests**: `tests/unit/MemoryManager.autoLoad.test.ts`
- Tests loadAndActivateAutoLoadMemories() method
- Validates all features (emergency disable, token counting, etc.)
- Integration with seed installation

**ServerStartup tests**: `tests/unit/ServerStartup.autoload.test.ts`
- Tests full startup workflow
- Validates orchestration and coordination
- Metadata-based activation detection

## Future Considerations

As the system evolves, consider:

1. **Token Budget Enforcement**: Both approaches can implement this. MemoryManager is simpler for basic limits, ServerStartup better for complex budget policies.

2. **Telemetry**: Currently in ServerStartup. Can be added to MemoryManager or kept in Container.

3. **Rollback**: If we need to rollback failed auto-load, ServerStartup provides better control.

4. **Multi-Element Auto-Load**: If we add auto-load for Skills/Personas, ServerStartup can coordinate, or each manager can handle its own.

## Recommendation

**For most use cases**: Use MemoryManager.loadAndActivateAutoLoadMemories()

**For complex startup**: Use ServerStartup when you need:
- Multi-phase startup with dependencies
- Startup-specific telemetry and metrics
- Coordinated rollback on failure
- Cross-cutting startup features

Both approaches are valid, tested, and maintained. Choose based on your specific needs.

## References

- Issue #1430: Auto-load baseline memories feature
- PR #8: Initial implementation (ServerStartup approach)
- This refactoring: DI-aligned implementation (MemoryManager approach)
- `src/elements/memories/MemoryManager.ts`: MemoryManager implementation
- `src/server/startup.ts`: ServerStartup implementation
- `src/di/Container.ts`: Container integration

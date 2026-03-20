# Testing Strategy Overview

This document summarizes the current automated and manual testing expectations for DollhouseMCP. Use it when planning work or preparing a PR so you know which suites to run and how to interpret failures.

---

## 1. Pre-Commit Workflow (MANDATORY)

**Before every commit, run these checks IN ORDER:**

```bash
# 1. Security & Dependencies (Critical - Run First)
npm run pre-commit        # Security tests + dependency audit (~2-4s)

# 2. Code Style (Fast Fail)
npm run lint              # ESLint validation, 0 warnings policy (~1-2s)

# 3. Build Validation
npm run build             # TypeScript compilation check (~5-10s)

# 4. Test Suite
npm test                  # Unit tests (~10-30s)
```

**All checks must pass with zero failures.** This fail-fast approach catches issues before they reach CI/CD.

**Quick command:** `npm run pre-commit && npm run lint && npm run build && npm test`

---

## 2. Core Test Suites

| Command | What it covers | When to run |
|---------|----------------|-------------|
| `npm test` | Unit tests via Jest (TS→ESM pipeline) | Every commit (part of pre-commit workflow) |
| `npm run test:integration` | Integration scenarios (MCP tools, GitHub interactions using mocks) | After changes to handlers, DI, or external services |
| `npm run test:crud` | CRUD+Activate operations for all element types (277 tests, 80.5% pass rate) | After changes to element managers, CRUD handlers, or element types |
| `npm run test:integration:crud` | CRUD tests as part of integration suite | Part of full integration test run |
| `npm run test:crud:watch` | CRUD tests in watch mode | During development of element CRUD operations |
| `npm run security:rapid` | Critical security tests (injection, path traversal, YAML) | Every commit (part of pre-commit workflow) |
| `npm run security:all` | Full security regression suite | When touching security-sensitive code or before releases |
| `npm run test:e2e` | End-to-end flows using fixture repos (requires network) | Feature work that affects user workflows |
| `npm run test:performance` | Performance benchmarks for indexing/sync | When performance-sensitive areas change |

All scripts are defined in `package.json`. CI runs a subset (unit + integration) on every PR; maintainers can add additional jobs when needed.

---

## 2A. CRUD Test Suite (Element Operations)

### Overview

The CRUD test suite (`tests/integration/crud/`) provides comprehensive integration testing for all element types using a **capability-based architecture**. This suite validates create, read, update, delete, validate, and activate operations across all 6 element types:

- **Personas** - Behavioral AI profiles
- **Skills** - Discrete capability modules
- **Templates** - Reusable content structures
- **Agents** - Autonomous goal-oriented actors
- **Memories** - Persistent context storage
- **Ensembles** - Multi-element orchestration

### Key Characteristics

**Capability-Based Testing**: Tests are selected and executed based on element capabilities defined in configuration files, not hardcoded type checks. This makes the suite highly maintainable and extensible.

**Parameterized Execution**: A single test suite (277 tests) runs against all element types. Adding a new element type requires only a configuration file—no test code changes needed.

**Current Status**:
- **Total Tests**: 277
- **Pass Rate**: 80.5% (223 passing, 54 failing)
- **Coverage**: All 6 element types, all CRUD operations
- **Execution Time**: ~15-20 seconds

### Running CRUD Tests

```bash
# Run all CRUD tests (recommended after element changes)
npm run test:crud

# Run in watch mode during development
npm run test:crud:watch

# Run as part of integration suite
npm run test:integration:crud

# Run specific element type
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas"

# Run specific operation across all types
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "CREATE"
```

### When to Run CRUD Tests

Run CRUD tests when you modify:

- **Element Managers**: Any changes to `src/elements/*/Manager.ts` files
- **CRUD Handlers**: Changes to `src/handlers/ElementCRUDHandler.ts` or handlers in `src/handlers/element-crud/`
- **Element Classes**: Changes to element type definitions in `src/elements/`
- **Validation Logic**: Changes to element validation rules
- **Activation Logic**: Changes to how elements are activated
- **Base Classes**: Changes to `BaseElementManager` or `BaseElement`

### Test Structure

The suite uses a **capability-based configuration system**:

```typescript
// Element capabilities drive which tests run
capabilities: {
  supportsActivation: {       // Can element be activated?
    activationStrategy: 'behavior-change',
    requiresContext: false,
    expectedResultType: 'state-change'
  },
  supportsNesting: {          // Can element contain other elements?
    maxDepth: 10,
    allowedTypes: [...]
  },
  hasStateFile: {             // Does element maintain separate state?
    fileExtension: '.state.yaml',
    cleanupOnDelete: true
  }
}
```

Tests conditionally execute based on capabilities:

```typescript
// If element supports activation, run activation tests
if (config.capabilities.supportsActivation) {
  describe('ACTIVATE', () => {
    it('should activate element successfully', ...);
    it('should handle activation context', ...);
  });
}
```

### Architecture Benefits

1. **Extensible**: Add new element type = add config file, tests run automatically
2. **Maintainable**: No duplicate test code across element types
3. **Comprehensive**: Tests all operations for all types consistently
4. **Type-Safe**: TypeScript interfaces ensure config correctness
5. **Self-Documenting**: Configs serve as documentation of element capabilities

### Current Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| **CREATE** | ~45 | Element creation with minimal/complete/invalid data |
| **READ** | ~35 | Retrieving element details and lists |
| **UPDATE** | ~60 | Field updates (simple, nested, metadata) |
| **DELETE** | ~30 | Element deletion and cleanup |
| **VALIDATE** | ~50 | Validation rules and error detection |
| **ACTIVATE** | ~57 | Activation for types that support it |

### Expected Results

**Passing tests** should show:
```
✅ CREATE: Personas - should create minimal element
✅ CREATE: Personas - should create complete element
✅ UPDATE: Skills - should update description field
✅ ACTIVATE: Templates - should activate successfully
```

**Failing tests** (19.5% currently) are documented and tracked. Most failures are due to:
- Validation rules not yet implemented in managers
- Nested field editing for complex metadata
- State persistence for agents/memories
- Activation context propagation

### Detailed Documentation

For comprehensive documentation including:
- Configuration system details
- Adding new element types
- Extending test scenarios
- Capability system reference
- Troubleshooting guide

See: `tests/integration/crud/README.md`

---

## 3. ES Module Considerations

The project runs as native ESM. Jest runs under `ts-jest` with `useESM: true`. Key rules:

- Keep production modules as ESM-only—avoid CommonJS fallbacks to “please” Jest.
- If a test needs to be skipped due to ESM tooling gaps, add an inline comment explaining why and record it in `testing-strategy-es-modules.md`.
- Prefer integration tests under `tests/integration/` when module loader incompatibility makes unit testing impractical.

See `docs/developer-guide/testing-strategy-es-modules.md` for deeper guidance.

---

## 4. Test Data & Fixtures

- **Portfolio fixtures** live under `tests/fixtures`. Keep them small and versioned.
- **GitHub mocks** use recorded responses via `nock`/custom adapters. Update fixtures if APIs change.
- **Roundtrip tests** use dedicated test repo templates (see `tests/integration/ROUNDTRIP_*`).
- Always regenerate fixtures when API schemas change.

---

## 5. Coverage Expectations

- Unit + integration coverage should remain ≥ 96%. Run `npm run test:coverage` locally if you change widely used modules.
- For new components, include tests covering success, failure, and edge cases (e.g., duplicate detection, invalid input).
- Security-sensitive code (ConfigManager, OAuth helpers, filesystem operations) must have dedicated regression tests.

---

## 6. Manual Verification

Not everything can be automated. Perform these checks before releases or when touching the relevant areas:

- **OAuth flow** – `setup_github_auth` device flow, token persistence, and `check_github_auth`.
- **Portfolio sync** – `portfolio_element_manager` uploads/downloads, `sync_portfolio` dry-run and execution.
- **Collection install/submit** – `install_collection_content` and `submit_collection_content` end-to-end.
- **Enhanced index rebuild** – Force rebuild via `get_relationship_stats` (indirectly rebuilds) or direct manager methods to ensure no regressions in indexing.
- **MCP Inspector** – `npm run inspector` to confirm the server exposes tools as expected.

Document manual results in PRs or release notes when they replace automated coverage.

---

## 7. Flake Reporting & Quarantines

- Quarantined tests must be tagged with `test.skip` and a comment referencing a tracking issue.
- Report flaky behavior in the QA workspace (`docs/agent/QA/`) or on the project board, including repro steps.
- Aim to re-enable quarantined tests quickly; stale skips should not linger.

---

## 7A. CI-Aware Timing Thresholds

Performance and timing-sensitive tests often fail on CI due to environment variability (especially Windows runners). Use the timing threshold helpers in `tests/helpers/timing-thresholds.ts` to create environment-aware assertions.

### When to Use Timing Thresholds

Use timing thresholds when testing:
- **Parallel execution benefits** - verifying operations run concurrently
- **Performance regressions** - ensuring operations complete within bounds
- **Timeout behavior** - validating timeout configurations work correctly

### Available Helpers

```typescript
import {
  assertTiming,           // For predefined thresholds
  createTimingThreshold,  // For custom thresholds
  getTimingThreshold      // Get threshold value only
} from '../../helpers/timing-thresholds.js';
```

### Predefined Thresholds

| Threshold Name | Local | CI | Use Case |
|---------------|-------|-----|----------|
| `parallel-operations` | 100ms | 600ms | 3x50ms parallel operations |
| `container-parallel-checks` | 3500ms | 5000ms | DI container parallel checks |
| `parallel-start-diff` | 50ms | 1000ms | Time between parallel starts |
| `build-info-retrieval` | 1000ms | 15000ms | Git/Docker command execution |

### Custom Thresholds

For one-off tests, create custom thresholds:

```typescript
// Test with 100ms mocked delay, expecting parallel completion
const delay = 100;
const { threshold } = createTimingThreshold(
  delay * 2.5,  // 250ms local threshold
  2.4           // CI multiplier → 600ms CI threshold
);
expect(elapsed).toBeLessThan(threshold);
```

### Best Practices

1. **Prefer predefined thresholds** when they match your use case
2. **Document your reasoning** in comments when using custom thresholds
3. **Keep local thresholds strict** to catch regressions early
4. **Keep CI thresholds lenient** to avoid false failures from environment variance
5. **Enable `TIMING_DEBUG=true`** environment variable to see which thresholds are being used

### Example: Testing Parallel Execution

```typescript
it('should benefit from parallel execution', async () => {
  const delay = 100; // ms per operation

  // Mock operations with delays
  jest.spyOn(service, 'operationA').mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, delay));
    return 'result';
  });

  const startTime = Date.now();
  await service.runParallelOperations();
  const elapsed = Date.now() - startTime;

  // Use CI-aware threshold: 250ms local, 600ms CI
  const { threshold } = createTimingThreshold(delay * 2.5, 2.4);
  expect(elapsed).toBeLessThan(threshold);
});
```

---

## 8. Release Checklist (Testing Portion)

Before tagging a release:

1. Run the full pre-commit workflow: `npm run pre-commit && npm run lint && npm run build && npm test`
2. Execute extended test suites: `npm run test:integration`, `npm run security:all`
3. For major changes, run `npm run test:e2e` and `npm run test:performance`
4. Run security audit: `npm run security:audit:verbose`
5. Verify manual checks above (OAuth, portfolio sync, collection operations, MCP Inspector)
6. Update release notes with any known gaps and mitigation steps

---

## 9. Related Documents

- [Testing Strategy – ES Modules](testing-strategy-es-modules.md)
- [Troubleshooting Guide](../guides/troubleshooting.md)
- [Configuration Basics](../guides/configuration-basics.md)
- [Roundtrip Workflow Guide](../guides/roundtrip-workflow-user-guide.md)

Keep this guide current as new suites or tooling are introduced. If you add a test script or retire one, update the table so contributors stay aligned.***

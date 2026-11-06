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

## Full local unit qualification

Argument-free `npm test` discovers the complete Jest inventory, runs the existing
Core owner-erasure and serial-storage whole-file steps in fresh serial processes,
then runs both ordinary native Jest shards in fresh processes. This matches the
already mandatory schedule in `.github/workflows/core-build-test.yml`; ordinary
worker settings, every case, operation workload, internal batch/concurrency,
whole-case deadline and existing intentional skip stay unchanged. A missing,
duplicate or extra file, nonzero subprocess exit, missing report or failed final
assertion refuses the complete result. The runner retains private raw Jest JSON
and a complete inventory/count/outcome receipt at the printed temporary path.
Pending/todo cases remain visible separately and are never counted as passes.
Catchable parent interruption is forwarded to the active direct Node/Jest child;
the launcher awaits its close and refuses all subsequent subprocess admission.
Cancellation remains failed even if that child later exits zero. Existing test
fixture owners remain responsible for their own descendant/resource cleanup.

The earlier default command put these capacity files in competition with unrelated
suites across ordinary workers. On November 3 its corrected-Hono candidate still
failed a populated nested RENAME final-durable case at the original 10-second
limit: setup 1.482s, interrupted operation 7.876s and retry 1.235s, with owned
settlement/cleanup complete at 10.889s. That result remains failed. Host evidence
showed four logical CPUs saturated alongside WindowServer and the editor; no
production inefficiency or arbitrary-host wall-clock guarantee was established.
The local scheduler correction follows the existing CI isolation contract rather
than changing the capacity limits. It needs its own complete qualifying run.

The November 3 audit of all 101 discovered storage suites found 11 physical
fanout files omitted from the original 13-file isolation schedule. Core, Extended
and this local plan now require the same 24 whole files in 15 serial groups:
inspection (including its real timeout ownership control), adoption-recovery
capacity, volume-list capacity, and delete/archive collision capacity join the
original groups. Ordinary worker settings and existing CI job limits are retained.
Small filesystem cases and synthetic entry/byte/model vectors remain ordinary.
The launcher refuses drift in either workflow's whole-file commands or exclusions,
and still proves the serial/ordinary union against actual native Jest discovery.

The first Extended macOS Node 22 inspection run failed its flat 4,095-entry case at
its original 10-second limit; its slow phase was unobserved. Failure-only fixed-label
phase output records future failures without paths or payloads. Independently,
Core macOS RESERVED adoption recovery recorded a 13,982.790833ms setup hook before
its body could run. Its fixture callback and admitted sibling I/O must settle
before mocks or roots are removed; the existing 10-second setup/body and cleanup
budgets, 4,096 simultaneous writes and all residual proofs remain intact. A timed-out
hook stays failed even when cleanup drains safely. These corrections do not claim
a production algorithm fix or erase either failed run. Full per-file evidence and
unchanged-contract scope are recorded in issue #3172.

Explicit Jest selections/options still pass through unchanged, for example
`npm test -- --runInBand --runTestsByPath tests/unit/storage/FileMemoryOwnedRename.test.ts`.
A selected passing file is focused evidence, not complete qualification.

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
| `npm run test:performance` | Performance benchmarks for indexing/sync and persona lookup | When performance-sensitive areas change |

All scripts are defined in `package.json`. CI runs a subset (unit + integration) on every PR; maintainers can add additional jobs when needed.

Persona lookup's unchanged 10/100/1000-item absolute timing thresholds run in
`tests/performance/persona-finding.performance.test.ts` through the visible Core
performance step. Core unit checks retain exact lookup results, missing-result
behavior, no file I/O and a single-scan predicate-call bound, including a
repeated-scan negative control. Performance outcomes remain visible in the
existing non-gating step; calibrated enforcement and structured artifacts remain
separate work in #2561. Security and deterministic complexity checks remain required.

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

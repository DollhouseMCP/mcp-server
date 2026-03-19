# DollhouseMCP Test Suite

**9,800+ tests** across 401 test files, organized into 5 suites covering unit, integration, security, end-to-end, and performance testing.

## Test Inventory

### Runtime Test Counts (verified)

| Suite | Command | Tests | Suites | Config |
|-------|---------|------:|-------:|--------|
| Unit + Security + E2E | `npm test` | 8,455 | 330 | `jest.config.cjs` |
| Integration | `npm run test:integration` | 1,270 | 61 | `jest.integration.config.cjs` |
| Performance | `npm run test:performance` | 111 | 9 | `jest.performance.config.cjs` |
| **Total** | | **9,836** | **400** | |

> Runtime counts exceed source-level `it()`/`test()` counts (8,539) due to parameterized tests using `it.each()` and `test.each()`.

### CI Coverage

| Workflow | Suites Run | Platforms |
|----------|-----------|-----------|
| `core-build-test.yml` | Unit + Security + E2E, Performance | macOS, Windows, Linux (Node 20) |

Integration tests require a Docker environment with Claude Code and DollhouseMCP installed. They run locally and in Docker-based validation scripts but are not part of the standard CI pipeline.

---

## Suite Breakdown

### Unit Tests — 6,757 tests (282 files)

**Location**: `tests/unit/` | **Command**: `npm test`

Fast, isolated tests with mocked dependencies. Organized by source module:

| Area | Tests | Files | What It Covers |
|------|------:|------:|----------------|
| handlers | 1,468 | 48 | MCP tool handlers, element CRUD dispatch, MCP-AQL handler |
| services | 1,036 | 27 | Query service, validation, retention, metadata |
| elements | 1,005 | 36 | All 6 element managers (agents, ensembles, memories, personas, skills, templates) |
| security | 462 | 27 | Audit rules, encryption, telemetry, input validation |
| config | 380 | 13 | ConfigManager, portfolio config, environment detection |
| portfolio | 352 | 23 | Enhanced index, GitHub sync, relationship mapping |
| utils | 337 | 14 | Field validation, pattern matching, sanitization |
| logging | 163 | 8 | Formatters, sinks, log viewer |
| server | 159 | 8 | Server initialization, resources, tool registration, content size validation |
| storage | 132 | 9 | File transactions, locking, atomic writes |
| collection | 132 | 8 | Collection browser, search, submission |
| tools | 111 | 5 | Tool deprecation, persona tools migration |
| base | 111 | 5 | BaseElementManager CRUD primitives |
| persona | 109 | 5 | Persona activation, export/import, sharing |
| cache | 73 | 5 | Multi-layer caching, TTL, memory limits |
| telemetry | 51 | 2 | Usage metrics, opt-in telemetry |
| web | 47 | 2 | Web routes, directive rendering |
| scripts | 30 | 3 | Build scripts, version update |
| cross-platform | 30 | 1 | Windows/macOS/Linux path handling |
| sync | 23 | 2 | Portfolio sync, conflict resolution |
| auth | 22 | 1 | OAuth token management |
| transforms | 20 | 1 | ESM/CJS transform utilities |
| di | 4 | 1 | Dependency injection container |
| events | 3 | 1 | Element event dispatcher |
| data | 1 | 1 | Bundled element validation |

### Security Tests — 421 tests (28 files)

**Location**: `tests/security/` | **Command**: `npm run security:all`

Dedicated security regression tests covering OWASP Top 10 and MCP-specific attack vectors:

- Command injection (shell, argument, environment)
- Path traversal (absolute, relative, symlink, Unicode normalization)
- YAML deserialization attacks (billion laughs, merge keys, prototype pollution)
- MCP tool input validation (type coercion, oversized payloads, injection via tool args)
- Download validation (URL schemes, SSRF, redirect chains)
- Content size limits and memory exhaustion

### Integration Tests — 1,043 source / 1,270 runtime (61 files)

**Location**: `tests/integration/` | **Command**: `npm run test:integration`

Cross-module tests using real implementations with minimal mocking:

| Area | Tests | Files | What It Covers |
|------|------:|------:|----------------|
| mcp-aql | 459 | 21 | MCP-AQL query language: CRUD operations, search, permissions, agent execution, Gatekeeper policy, activation persistence |
| crud | 76 | 1 | Parameterized CRUD+Activate across all 6 element types (277 test cases with `it.each`) |
| ensembles | 49 | 3 | Ensemble lifecycle, conditional activation, element composition |
| cache | 46 | 1 | Multi-layer cache integration, invalidation cascades |
| tools | 44 | 3 | MCP tool registration, discovery, execution flow |
| server | 41 | 4 | Server startup, shutdown, reconnection, state management |
| persona | 34 | 2 | Persona activation flow, Gatekeeper policy enforcement |
| portfolio | 33 | 4 | Portfolio operations, enhanced index, trigger metrics |
| templates | 26 | 2 | Template rendering, variable substitution, section format |
| utils | 22 | 2 | YAML parser selection, utility integration |
| memories | 19 | 3 | Memory CRUD, entry management, retention |
| handlers | 19 | 1 | Handler dispatch, error propagation |
| services | 18 | 1 | ElementQueryService end-to-end |
| agents | 18 | 1 | Agent execution lifecycle, V2 field roundtrip |
| ci | 16 | 1 | CI environment detection, platform-specific behavior |
| skills | 10 | 2 | Skill activation, capability matching |
| collection | 5 | 1 | Collection access, element browsing |
| startup | 4 | 1 | Cold start, element auto-loading |

> **Note**: Integration tests require the full DollhouseMCP environment. Some tests need Docker with Claude Code installed. Run locally or via `scripts/validation/run-docker-validation.sh`.

### End-to-End Tests — 125 tests (10 files)

**Location**: `tests/e2e/` | **Command**: `npm run test:e2e`

Full workflow tests exercising the complete system:

- CRUD lifecycle (create → read → update → delete across element types)
- Ensemble workflow (multi-element activation, orchestration)
- Collection submission and installation
- OAuth GitHub integration flow
- MCP protocol compliance

### Performance Tests — 103 source / 111 runtime (9 files)

**Location**: `tests/performance/` | **Command**: `npm run test:performance`

Benchmarks with regression thresholds:

- MCP-AQL token budget analysis
- Collection search inverted index performance
- Portfolio indexing speed
- Cache hit/miss ratios under load
- Element serialization throughput

---

## Running Tests

```bash
# Core suites (required before commit)
npm test                          # Unit + Security + E2E (8,455 tests)
npm run test:integration          # Integration (1,270 tests)

# Individual suites
npm run security:all              # Security tests only
npm run test:e2e                  # End-to-end tests only
npm run test:performance          # Performance benchmarks

# Development workflow
npm run test:watch                # Watch mode
npm run test:coverage             # Generate coverage report
npm run test:crud                 # CRUD integration tests only

# Pre-commit (mandatory)
npm run pre-commit                # Security + dependency audit
npm run lint                      # ESLint
npm run build                     # TypeScript compilation
npm test                          # Full unit suite
```

## Test Configuration

| Config File | Suite | Includes | Excludes |
|------------|-------|----------|----------|
| `jest.config.cjs` | Unit + Security + E2E | `tests/**/*.test.ts` | `tests/integration/`, `tests/performance/` |
| `jest.integration.config.cjs` | Integration | `tests/integration/**/*.test.ts` | — |
| `jest.performance.config.cjs` | Performance | `tests/performance/**/*.test.ts` | — |
| `jest.e2e.config.cjs` | E2E (standalone) | `tests/e2e/**/*.test.ts` | — |
| `jest.config.compiled.cjs` | Compiled fallback | Same as unit, compiled JS | — |

## Coverage

- **Target**: ≥ 96% on core modules
- **Generate**: `npm run test:coverage`
- **Output**: `tests/coverage/` (HTML + LCOV)

## ES Module Notes

This project uses native ESM. Jest runs with `--experimental-vm-modules` and `ts-jest` in ESM mode. See `docs/developer-guide/testing-strategy-es-modules.md` for details.

## Fixtures

**Location**: `tests/fixtures/`

Shared test data including roundtrip test elements, security attack payloads, and mock configurations. Keep fixtures minimal and version-controlled.

## Contributing

1. **Choose the right suite**: Unit for isolated logic, integration for cross-module flows, e2e for complete workflows, security for attack vectors
2. **Follow existing patterns**: Mirror the structure of similar existing tests
3. **One behavior per test**: Each test validates one specific behavior
4. **Clean up**: Use `afterEach`/`afterAll` hooks for teardown
5. **Update this document**: When adding new test areas, update the inventory tables

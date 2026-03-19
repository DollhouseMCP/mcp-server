
# ES Module Testing Strategy

DollhouseMCP runs as a native ES module (`"type": "module"` in `package.json`).
While the runtime benefits are worth it, Jest's ES module support is still evolving,
so our test suite needs extra guardrails. This document explains the current
strategy, the workarounds in place, and the expectations for contributors.

## Core Principles

1. **Tests stay current even if they are temporarily skipped.** We write the test
   now and document why it cannot run inside Jest, then re-enable it when the
   blocker is resolved.
2. **Prefer building-friendly design over test hacks.** Production code should not
   carry conditional exports or CommonJS fallbacks just to satisfy Jest.
3. **Document every exception.** If a test is forced to skip or use a workaround,
   call it out in the code and in this document so the team can revisit it.

## Jest Configuration Overview

Our Jest config lives in `tests/jest.config.cjs` and is imported from the project
root `jest.config.cjs`. Key points:

```js
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        allowJs: true,
        rootDir: '.',
        isolatedModules: true,
        module: 'esnext',
        moduleResolution: 'node'
      }
    }]
  },
  moduleNameMapper: {
    '^(\.{1,2}/(?:[^/]+/)*src/.*)\.js$': '$1.ts',
    '^(\.{1,2}/(?:[^/]+/)*tests/.*)\.js$': '$1.ts',
    '^(\.{1,2}/(?:[^/]+/)*integration/.*)\.js$': '$1.ts'
  },
  setupFilesAfterEnv: [path.join(rootDir, 'tests/jest.setup.mjs')],
  resolver: 'ts-jest-resolver'
};
```

* `ts-jest/presets/default-esm` turns on ES module transforms while letting us
  continue writing tests in TypeScript.
* `moduleNameMapper` keeps import paths stable—everything in source is written as
  `.ts` while runtime code is emitted as `.js`.
* `tests/jest.setup.mjs` is a native ES module so it can run before tests execute.

### Temporary Ignore List

`testPathIgnorePatterns` contains suites that are written but currently excluded
because Jest cannot mock their dependencies cleanly in ESM mode. Examples include:

- `GitHubAuthManager.test.ts` – relies on mocking `fs/promises` and other native modules.
- `CollectionCache.test.ts` – struggles with logger/config mocks.
- `EnhancedIndexManager.*.test.ts` – depends on complex module rebinding.
- Portfolio installation tests that shell out to npm.

Each entry in the ignore list must have a comment explaining the limitation. When
updating Jest or rewriting the affected modules, revisit this list and try to
re-enable the tests.

## Writing Tests Under ESM Constraints

### Use `jest.unstable_mockModule`

Dynamic module mocking requires the `unstable_mockModule` API. The important rules:

1. **Declare mocks before the module under test is imported.**
2. **Return ES module-compatible objects** (e.g., `{ default: () => {} }` when a
   module has a default export).
3. **Use async/await** with `jest.unstable_mockModule` and `import()` to ensure Jest
   loads the mocked version.

```ts
// Example: tests/unit/utils/GitHubRateLimiter.test.ts
jest.unstable_mockModule('node:crypto', () => ({
  randomUUID: () => 'fixed-id'
}));

const { GitHubRateLimiter } = await import('../../../src/utils/GitHubRateLimiter.js');
```

Avoid `require()`, `jest.mock()`, or `jest.requireActual()`—those do not work in
ES module context.

### Prefer Dependency Injection

If you find yourself unable to mock a module, consider refactoring the code to
accept the dependency via constructor or function parameters. This keeps tests
simpler and reduces reliance on Jest internals.

### Document Skipped Tests

When a suite must be ignored:

1. Add a comment in `tests/jest.config.cjs` describing the blocker.
2. Reference any open issue or TODO in the code.
3. Optionally leave a note in the test file so future contributors understand the
   status.

## Evaluating Alternatives

We periodically evaluate whether tools like **Vitest** or **Node's built-in test
runner** would ease ESM pain. For now we stay on Jest because of its ecosystem and
existing infrastructure, but the team keeps an eye on:

- Improvements in Jest's native ESM support.
- ts-jest roadmap for ESM compatibility.
- Possibility of dual-running a smaller Vitest suite to validate compatibility.

Major tooling changes should be proposed through an ADR or architecture note.

## When to Revisit This Strategy

- Jest releases with improved ES module handling (watch release notes).
- Large refactors that rethink dependency boundaries (e.g., migrating logger or
  config managers to more injectable patterns).
- Repeated failures caused by the same mock limitations.
- Adding new test suites that duplicate existing ignore patterns.

Whenever we re-enable a test or adopt a new technique, update this document so it
remains accurate.

## Checklist for Contributors

Before submitting a PR that touches tests:

- [ ] Can the test run under current ESM and Jest constraints?
- [ ] Are mocks declared with `jest.unstable_mockModule` if needed?
- [ ] Did you add (or update) comments for any ignored tests?
- [ ] Have you verified the behavior manually if the test is skipped?
- [ ] Did you document the next step for re-enabling the test (issue link, TODO,
      or note back to this guide)?

Following this playbook keeps the suite honest while we wait for ESM support to
catch up.

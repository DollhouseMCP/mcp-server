# Post-Mortem: npx One-Liner Silent Exit Bug

**Date**: 2026-04-08
**Severity**: Critical (onboarding blocker)
**Affected versions**: v2.0.0-rc.1 through v2.0.10 (all v2.x releases)
**Fixed in**: v2.0.11 (stable), v2.0.12-rc.1 (RC)
**PR**: #1848

---

## Summary

Running `npx @dollhousemcp/mcp-server@latest --web` on a fresh machine silently exited with no output, exit code 0. The server never started. This affected every v2.x release since the platform rewrite.

## Symptoms

```
$ npx @dollhousemcp/mcp-server@latest --web
$                    # ← nothing. no output. clean exit.
```

No error message, no startup banner, no indication anything went wrong. Users on fresh machines would assume the package was broken.

## Root Cause

The server has a guard at startup that checks "am I being run directly (not imported as a library)?" using three detection methods. When `npx @dollhousemcp/mcp-server --web` runs, **all three checks failed**, so the guard evaluated to `false` and the startup code was skipped entirely.

### Why all three checks failed

When npx installs `@dollhousemcp/mcp-server`, npm creates two symlinks in `.bin/`:

```
.bin/dollhousemcp  →  ../@dollhousemcp/mcp-server/dist/index.js
.bin/mcp-server    →  ../@dollhousemcp/mcp-server/dist/index.js
```

npx chooses which bin to execute by matching the **unscoped package name**. The package is `@dollhousemcp/mcp-server`, so npx runs the `mcp-server` symlink. Node.js sets `process.argv[1]` to the **symlink path**, not the resolved target:

```
process.argv[1] = "/path/node_modules/.bin/mcp-server"
```

Here's how each check failed:

| Check | What it looked for | What it got | Result |
|---|---|---|---|
| `isDirectExecution` | `process.argv[1]` ending in `dist/index.js` | `.bin/mcp-server` (symlink, not resolved) | **false** |
| `isNpxExecution` | `process.env.npm_execpath` containing `'npx'` | `undefined` (modern npm v7+ doesn't set this) | **false** |
| `isCliExecution` | `process.argv[1]` ending in `/dollhousemcp` | `/mcp-server` (wrong bin name) | **false** |

With all three false, the `if` guard on line 810 was never entered. The module loaded, found nothing to execute, and Node exited cleanly.

## Why It Worked in v1.x

In v1.4.5, `isDirectExecution` used a completely different check:

```typescript
// v1.4.5
const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;
```

This is Node's standard ESM "am I the main module?" pattern. While this also wouldn't match the symlink path directly, in v1.x the `isNpxExecution` check worked because **older npm versions** (v6 and early v7) actually set `npm_execpath` to a path containing `'npx'`. So even though `isDirectExecution` was false, `isNpxExecution` was true and the server started.

In the **v2.0.0-rc.1 rewrite**, `isDirectExecution` was changed to:

```typescript
// v2.0.0-rc.1 onward
const scriptPath = process.argv?.[1] ? path.normalize(process.argv[1]) : '';
const isDirectExecution =
  scriptPath.endsWith(`${path.sep}dist${path.sep}index.js`) ||
  scriptPath.endsWith(`${path.sep}src${path.sep}index.ts`);
```

This checks the raw `process.argv[1]` path suffix. Since Node doesn't resolve symlinks in `argv[1]`, the `.bin/mcp-server` path doesn't end in `dist/index.js`, so this check fails.

Meanwhile, as npm evolved (v7+), `npm_execpath` stopped being set to a path containing 'npx' (npx became `npm exec` internally), so `isNpxExecution` also stopped working.

The `mcp-server` bin entry was **never** added to the `isCliExecution` check — it only looked for `dollhousemcp`.

**Result**: All three safety nets broke at different times, and the combination meant v2.x never worked via npx on a truly fresh machine.

## Why It Appeared to Work in Testing

Several factors masked the bug during our testing:

1. **Testing on machines with prior installs** — If an older DollhouseMCP version was globally installed or cached, npx might resolve through the `dollhousemcp` symlink instead of `mcp-server`, which would pass `isCliExecution`.

2. **Testing with `node dist/index.js --web`** — Running the entry point directly (not via npx) always works because `process.argv[1]` ends in `dist/index.js`.

3. **Older npm versions** — Machines with npm v6 or early v7 still set `npm_execpath` to include 'npx', so `isNpxExecution` would be true.

4. **npx cache** — Once npx has cached the package, subsequent runs may behave differently than a first-time install.

## The Fix (Three Layers of Defense)

### 1. Symlink Resolution (`realpathSync`)

```typescript
import { realpathSync } from 'node:fs';

const rawScriptPath = process.argv?.[1] ?? '';
let scriptPath = rawScriptPath ? path.normalize(rawScriptPath) : '';
try {
  scriptPath = realpathSync(scriptPath);
} catch {
  if (process.env.DOLLHOUSE_DEBUG) {
    console.error(`[DEBUG] Symlink resolution failed for ${rawScriptPath} — using original path`);
  }
}
```

Now `.bin/mcp-server` resolves to `dist/index.js`, so `isDirectExecution` matches.

### 2. Modern npx Detection

```typescript
const isNpxExecution =
  process.env.npm_execpath?.includes('npx') ||    // legacy npm
  process.env.npm_command === 'exec';               // modern npm v7+
```

npm v7+ sets `npm_command` to `'exec'` when running via npx.

### 3. Bin Name Matching

```typescript
const binName = path.basename(rawScriptPath);
const isCliExecution = binName === 'dollhousemcp' || binName === 'mcp-server';
```

Uses `path.basename` to match both registered bin entries from `package.json`.

### Bonus: Error Logging Sanitization

The startup failure error log was also fixed to not leak internal paths in production:

```typescript
console.error("[DollhouseMCP] Server startup failed",
  process.env.DOLLHOUSE_DEBUG ? error : (error as Error).message || 'unknown error');
```

## Version History

| Version | Detection Method | npx Worked? | Why |
|---|---|---|---|
| v1.0–v1.4.4 | `import.meta.url` only | Varies | Depended on npm version |
| v1.4.5 | `import.meta.url` + `npm_execpath` + `dollhousemcp` check | Yes (usually) | `npm_execpath` contained 'npx' on most npm versions at the time |
| v2.0.0-rc.1–v2.0.10 | `scriptPath.endsWith()` + `npm_execpath` + `dollhousemcp` check | **No** | Symlink not resolved, modern npm doesn't set npx in execpath, `mcp-server` bin not checked |
| **v2.0.11+** | `realpathSync` + `npm_command` + both bin names | **Yes** | All three layers cover all known execution paths |

## Releases

- **v2.0.11** — stable hotfix, published to npm `@latest`
- **v2.0.12-rc.1** — RC with hotfix cherry-picked, published to npm `@rc`
- Both have GitHub releases with `.mcpb` bundles attached

## Lessons Learned

1. **The one-liner install path must be tested on a truly clean environment** — not a dev machine with cached packages or prior installs.
2. **Node.js does not resolve symlinks in `process.argv[1]`** — any detection logic based on argv path suffixes must account for `.bin/` symlinks.
3. **npm environment variables change between major versions** — relying on `npm_execpath` containing 'npx' broke silently when npm v7 changed npx to use `npm exec` internally.
4. **Silent success is worse than a loud failure** — the server should have logged *why* it wasn't starting, rather than exiting cleanly with code 0.

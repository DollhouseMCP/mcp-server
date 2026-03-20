# jsdom Version Strategy

## Current Status

| Package | Version | Status |
|---------|---------|--------|
| jsdom | ^24.1.3 | **Active** - Downgraded from 27.2.0 |
| @types/jsdom | ^21.1.7 | Aligned with jsdom 24.x |

## Why We Downgraded

### The Problem (December 2024)

jsdom v27.x introduced a dependency on parse5 v7+, which became an ESM-only module. However, jsdom's internal code still uses CommonJS `require()`:

```javascript
// jsdom/lib/jsdom/browser/parser/html.js:3
const parse5 = require("parse5");  // ❌ Fails with ESM-only parse5
```

This caused the MCP server to crash in Docker:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module
  /app/dollhousemcp/node_modules/jsdom/node_modules/parse5/dist/index.js
  from /app/dollhousemcp/node_modules/jsdom/lib/jsdom/browser/parser/html.js
  not supported.
```

### Impact

- MCP server wouldn't start in Docker container
- All MCP tools unavailable to Claude Code
- 100% of behavior tests failed (tools not registered)

### The Fix

Downgraded to jsdom 24.1.3, which:
- Uses parse5 v6.x (CommonJS compatible)
- Has identical DOM/HTML parsing capabilities for our use case
- Is stable and well-tested

## What jsdom Is Used For

jsdom is used in two places for DOMPurify sanitization:

### 1. `src/security/yamlValidator.ts`
```typescript
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';

const window = new JSDOM('').window;
const purify = DOMPurify(window);
// Sanitizes YAML content to prevent XSS
```

### 2. `src/elements/memories/Memory.ts`
```typescript
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';

// Sanitizes memory entry content
```

We use jsdom to provide a DOM environment for DOMPurify, which sanitizes user-provided content to prevent XSS attacks.

## Upgrade Path

### When to Upgrade

Monitor for these conditions:

1. **jsdom releases a fix** for ESM/CommonJS compatibility with parse5
   - Watch: https://github.com/jsdom/jsdom/issues
   - Likely resolution: jsdom switches to dynamic `import()` for parse5

2. **parse5 releases a dual-format package** (ESM + CJS)
   - Watch: https://github.com/inikulin/parse5/issues

3. **Node.js improves ESM/CJS interop** for this pattern
   - Less likely to be the solution

### How to Test Upgrade

```bash
# 1. Update package.json
npm install jsdom@latest @types/jsdom@latest

# 2. Run local tests
npm test
npm run test:integration

# 3. Test in Docker (critical - this is where it failed)
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-dollhouse-test .

# 4. Verify MCP server starts
docker run --rm --entrypoint "" claude-dollhouse-test \
  bash -c 'echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}" | \
  timeout 5 node /app/dollhousemcp/dist/index.js 2>&1 | head -20'

# 5. Run behavior tests
MCP_AQL_VERBOSE=false ./tests/scripts/docker/mcp-aql-behavior-tests.sh
```

### Upgrade Checklist

- [ ] Check jsdom changelog for ESM compatibility fix
- [ ] Update `package.json`: `jsdom` and `@types/jsdom`
- [ ] Run `npm install` to regenerate lock file
- [ ] Run local unit tests
- [ ] Build Docker image
- [ ] Verify MCP server starts in Docker (no ERR_REQUIRE_ESM)
- [ ] Run all behavior tests
- [ ] Update this document with new version

## Security Monitoring

While on jsdom 24.x:

1. **Monitor for CVEs**
   - https://www.npmjs.com/advisories?search=jsdom
   - https://github.com/jsdom/jsdom/security/advisories

2. **Check npm audit regularly**
   ```bash
   npm audit --audit-level=high
   ```

3. **Consider alternatives if critical vulnerability**
   - happy-dom (lighter, faster, but less complete)
   - linkedom (similar to happy-dom)
   - Switch DOMPurify to server-side sanitization without DOM

## Version History

| Date | Version | Reason |
|------|---------|--------|
| 2024-12-31 | 24.1.3 | Downgrade to fix ESM/parse5 crash in Docker |
| Previous | 27.2.0 | Latest version (broken in Docker) |

## Related Issues

- PR #240: fix(mcp-aql): Add instructions parameter support for persona creation
- Root cause: jsdom 27.x + parse5 ESM incompatibility

---

*Last updated: 2024-12-31*

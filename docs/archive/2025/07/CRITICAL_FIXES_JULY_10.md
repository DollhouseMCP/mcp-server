# Critical Fixes Applied - July 10, 2025

## 1. MCP Protocol Compatibility (v1.2.4)

### Problem
Console output was breaking MCP JSON-RPC protocol with errors like:
```
Unexpected token 'S', "[SECURITY]"... is not valid JSON
```

### Solution
Created MCP-safe logger (`src/utils/logger.ts`):
- Only outputs during initialization (before MCP connection)
- Stores logs in memory during protocol communication
- Suppresses all console output in test environment

### Key Code
```typescript
// In src/index.ts after transport connection:
logger.setMCPConnected();

// Logger checks before outputting:
if (!this.isMCPConnected) {
  const isTest = process.env.NODE_ENV === 'test';
  if (!isTest) {
    console.error(fullMessage);
  }
}
```

## 2. Path Resolution (v1.2.3)

### Problem
Server trying to create `/personas` at filesystem root

### Solution
Changed from `process.cwd()` to `__dirname` based resolution:
```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
this.personasDir = path.join(__dirname, "..", "personas");
```

## 3. NPM Package Missing Personas

### Problem
`.npmignore` excluded `personas/` directory

### Temporary Fix
Manually copied personas to user's npm installation:
```bash
cp personas/*.md /opt/homebrew/lib/node_modules/@mickdarling/dollhousemcp/personas/
```

### Permanent Fix (v1.2.5)
Updated `.npmignore` to include personas in package

## 4. JSON Config Merge Issues

### Problem
Users struggling to merge MCP server configs

### Solution
- Created visual JSON merge guide
- Added Quick Start to README
- Fixed user's config directly

### Correct Structure
```json
{
  "mcpServers": {
    "server1": {...},
    "server2": {...}  // Siblings, not nested or duplicate
  }
}
```
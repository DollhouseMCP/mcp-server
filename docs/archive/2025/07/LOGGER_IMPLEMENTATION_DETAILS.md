# Logger Implementation Details - July 10, 2025

## Why We Needed a Custom Logger

### The MCP Protocol Constraint
- MCP uses stdout/stderr for JSON-RPC communication
- ANY non-JSON output breaks the protocol
- Even a single console.log crashes the connection
- Error: `Unexpected token 'S', "[SECURITY]"... is not valid JSON`

## Implementation Strategy

### 1. Dual-Mode Operation
```typescript
class MCPLogger {
  private isMCPConnected = false;
  
  // Called after MCP handshake
  public setMCPConnected(): void {
    this.isMCPConnected = true;
  }
}
```

### 2. Memory Storage with Circular Buffer
```typescript
private logs: LogEntry[] = [];
private maxLogs = 1000;

// Prevent unbounded memory growth
if (this.logs.length > this.maxLogs) {
  this.logs.shift();
}
```

### 3. Test Environment Detection
```typescript
// CRITICAL: Check must be INSIDE the method, not at module level
if (!this.isMCPConnected) {
  const isTest = process.env.NODE_ENV === 'test';
  if (!isTest) {
    console.error(fullMessage);
  }
}
```

## Key Lessons Learned

### 1. NODE_ENV Timing Issue
**Problem**: Initially checked `process.env.NODE_ENV` at module load
**Issue**: Jest sets NODE_ENV after modules are loaded
**Solution**: Check NODE_ENV inside the log method every time

### 2. Test Updates Required
**Problem**: Tests expected console output
**Solution**: Update tests to check in-memory logs instead

### 3. Docker Test Failures
**Problem**: Docker tests checked for "Loaded persona:" in output
**Solution**: Check for initialization messages instead

## Integration Points

### 1. Server Initialization
```typescript
// src/index.ts
const transport = new StdioServerTransport();
await transport.connect(server);
logger.setMCPConnected(); // Critical timing!
```

### 2. Security Monitor
```typescript
// Used to use console.error for alerts
// Now uses logger.error with structured data
logger.error('🚨 CRITICAL SECURITY ALERT 🚨', {
  type: event.type,
  details: event.details
});
```

### 3. Future Debug Tool
```typescript
// Planned MCP tool to retrieve logs
export async function getLogs(args: GetLogsArgs) {
  const logs = logger.getLogs(args.count, args.level);
  return formatLogsForMCP(logs);
}
```

## Performance Considerations

1. **Memory Usage**: ~1MB for 1000 full log entries
2. **CPU Impact**: Minimal - no async operations
3. **Circular Buffer**: O(1) for adds, O(n) for shifts

## Future Enhancements (Issue #190)

1. **Log Levels**: Filter by DEBUG/INFO/WARN/ERROR
2. **Configuration**: Environment variables for buffer size
3. **Structured Metadata**: Add file/line information
4. **Lazy Serialization**: Defer JSON.stringify until needed

## Critical Code Paths

### All Console Replacements
- `src/index.ts` - Server lifecycle logging
- `src/security/securityMonitor.ts` - Security alerts
- `src/marketplace/GitHubClient.ts` - API errors
- `src/persona/PersonaLoader.ts` - Loading messages
- `src/update/BackupManager.ts` - Backup operations
- `src/update/SignatureVerifier.ts` - GPG operations

### Test Files Updated
- `__tests__/security/securityMonitor.test.ts`
- `__tests__/basic.test.ts`
- `.github/workflows/docker-testing.yml`

## Remember
- NEVER use console.* in MCP server code
- Always use logger.* instead
- Test environment must suppress ALL output
- Logger is a singleton - import and use directly
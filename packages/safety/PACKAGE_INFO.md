# @dollhousemcp/safety - Package Information

## Package Details

- **Name**: `@dollhousemcp/safety`
- **Version**: 1.0.0
- **License**: AGPL-3.0
- **Size**: ~22KB JavaScript (uncompressed)
- **Dependencies**: Zero runtime dependencies
- **Node.js**: >= 20.0.0
- **Type**: ESM (ES Modules only)

## What's Included

### Core Services

1. **TieredSafetyService** - Safety tier determination and risk assessment
2. **VerificationStore** - Server-side challenge storage with expiration
3. **DisplayService** - Cross-platform OS dialogs (macOS, Linux, Windows)
4. **AuditLogger** - Pluggable audit logging interface

### Type Definitions

All TypeScript types are exported:
- SafetyTier, SafetyConfig, SafetyTierResult
- VerificationChallenge, ConfirmationRequest, DangerZoneOperation
- ExecutionContext, StoredChallenge
- AuditLogger, SafetyAuditEvent

### Configuration

- `DEFAULT_SAFETY_CONFIG` - Production-ready defaults
  - Advisory: 0-30
  - Confirm: 31-60
  - Verify: 61-85
  - Danger Zone: 86+

## Test Coverage

- **Test Suites**: 3 passed
- **Tests**: 51 passed
- **Coverage**:
  - TieredSafetyService: 89.65% statements, 84.61% branches
  - VerificationStore: 100% statements, 87.5% branches
  - DisplayService: Platform-specific (tested manually)

## Build Artifacts

### Source Files (src/)
- AuditLogger.ts
- DisplayService.ts
- TieredSafetyService.ts
- VerificationStore.ts
- types.ts
- config.ts
- index.ts

### Test Files (tests/)
- TieredSafetyService.test.ts
- VerificationStore.test.ts
- DisplayService.test.ts

### Distribution (dist/)
- All .js, .d.ts, .js.map, .d.ts.map files
- Full TypeScript type definitions
- Source maps for debugging

## Zero Dependencies

This package uses ONLY Node.js built-in modules:
- `crypto` - For randomBytes (verification codes)
- `child_process` - For execSync (OS dialogs)
- `os` - For platform detection

No external NPM packages required at runtime.

## Platform Support

### macOS
- Native dialogs via `osascript`
- Always available

### Linux
- Tries `zenity`, `kdialog`, `xmessage` in order
- Graceful fallback if GUI not available

### Windows
- PowerShell MessageBox
- Always available

## Usage Scenarios

1. **MCP-AQL Gatekeeper** - Tiered safety for agent execution
2. **MCP-AQL Adapters** - Safety infrastructure for external servers
3. **Any MCP Server** - Reusable safety system
4. **Standalone Tools** - Safety assessment utilities

## Integration Notes

- Works with any MCP server (not DollhouseMCP-specific)
- Injectable logger for custom audit trails
- Configurable thresholds and patterns
- Agent chain tracking for multi-agent systems

## Next Steps

To use this package in DollhouseMCP:
1. Update `src/elements/agents/safetyTierService.ts` to import from package
2. Replace inline implementations with package exports
3. Add package as dependency in main package.json
4. Update imports throughout codebase

## Build Commands

```bash
npm install       # Install dev dependencies
npm run build     # TypeScript compilation
npm test          # Run test suite
npm run test:coverage  # Run with coverage report
npm run lint      # ESLint validation
```

## Package Quality

✓ TypeScript compilation successful
✓ All 51 tests passing
✓ Coverage targets met
✓ Zero runtime dependencies
✓ ESM module format
✓ Full type definitions
✓ Cross-platform support
✓ Well-documented API

# Session Notes - August 9, 2025 - OAuth Config Fix for Claude Desktop

## Problem Discovery

### The Issue
After successfully implementing PR #518 (OAuth helper process), we discovered OAuth still fails in Claude Desktop with the error:
```
GitHub OAuth client ID is not configured. Please set the DOLLHOUSE_GITHUB_CLIENT_ID environment variable.
```

### Root Cause Analysis
1. **Claude Desktop starts MCP servers with a clean environment** - doesn't inherit shell variables
2. **Our implementation requires `DOLLHOUSE_GITHUB_CLIENT_ID` from environment**
3. **PR #518 fixed token storage but not client ID configuration**

### What We Built vs What's Missing

#### Successfully Implemented ✅
- Detached OAuth helper process (survives MCP shutdown)
- Secure token storage in `~/.dollhouse/.auth/github_token.enc`
- Token retrieval falls back to secure storage if no env var
- All security hardening (no hardcoded client IDs)

#### Missing Piece ❌
- **Client ID configuration** - Still requires env var that Claude Desktop doesn't provide
- No persistent storage for client ID
- No way to configure without environment variables

## Solution: ConfigManager Implementation

### Architecture Decision
Implement a configuration management system that stores the OAuth client ID (and future settings) in a persistent config file that both the MCP server and OAuth helper can read.

### Why This Approach
1. **Works with Claude Desktop's clean environment**
2. **No hardcoding in configs** (security principle from PR #518)
3. **One-time setup** for users
4. **Backward compatible** with env vars
5. **Extensible** for future configuration needs

## Test-Driven Development Approach

### Process
1. Write comprehensive tests FIRST
2. Run tests (they should fail)
3. Implement code to make tests pass
4. Verify all tests pass
5. Test in real environment

### Agent Orchestration
- Using specialized agents for each component
- Orchestrator (me) verifies all work
- Double-checking ensures correctness

## Implementation Plan

### Phase 1: ConfigManager (Branch: `feature/config-manager`)

#### Config File Structure
```json
{
  "version": "1.0.0",
  "oauth": {
    "githubClientId": "Ov23liXXXXXXXXXXXXXX"
  }
}
```

#### Location
- `~/.dollhouse/config.json`
- File permissions: `0o600` (owner read/write only)
- Directory permissions: `0o700` (owner full access only)

#### Key Features
- Singleton pattern with race condition protection
- Cross-platform support (Windows, macOS, Linux)
- Graceful handling of missing/corrupted config
- Environment variable precedence (backward compatibility)

### Phase 2: OAuth Integration (Branch: `feature/oauth-config-integration`)

#### Components to Update
1. **GitHubAuthManager.ts**
   - Check env var first (backward compatibility)
   - Fall back to ConfigManager
   - Better error messages

2. **oauth-helper.mjs**
   - Read client ID from config if not passed
   - Handle missing config gracefully

3. **src/index.ts**
   - Use ConfigManager in `setupGitHubAuth()`
   - Guide users to setup if unconfigured

### Phase 3: Setup Tool (Branch: `feature/oauth-setup-tool`)

#### MCP Tool: `configure_oauth`
- No args: Show current configuration
- With client ID: Validate and save
- Clear success/error messages

#### Standalone Script: `scripts/setup-oauth.js`
- Interactive setup wizard
- Works without MCP server running
- Validates client ID format
- Platform-agnostic

### Phase 4: Documentation (Branch: `feature/oauth-config-docs`)

#### Updates Required
- README.md - Configuration section
- OAuth setup guide - New process
- Migration guide - From env vars to config
- Troubleshooting - Common issues

## Issues Created

### Issue #520: OAuth fails in Claude Desktop - client ID not found
- Type: bug
- Priority: critical
- Root cause: Clean environment in Claude Desktop

### Issue #521: Implement ConfigManager for persistent configuration
- Type: enhancement
- Priority: high
- Solution component

### Issue #522: Update OAuth system to use ConfigManager
- Type: bug
- Priority: critical
- Integration work

### Issue #523: Create OAuth setup tool for easy configuration
- Type: enhancement
- Priority: high
- User experience improvement

## Progress Tracking

### Session 1 (August 9, 2025 - Morning)
- [x] Analyzed OAuth failure in Claude Desktop
- [x] Identified root cause (clean environment)
- [x] Designed ConfigManager solution
- [x] Created comprehensive implementation plan
- [x] Created this session documentation
- [ ] Create GitHub issues
- [ ] Write ConfigManager tests
- [ ] Implement ConfigManager
- [ ] Verify implementation

### Next Session
- [ ] OAuth integration tests & implementation
- [ ] Test in Claude Desktop
- [ ] Setup tool implementation
- [ ] Documentation updates

## Testing Checklist

### ConfigManager Tests
- [ ] Singleton pattern works
- [ ] Config file creation
- [ ] Config file loading
- [ ] Corrupted config handling
- [ ] Permission settings
- [ ] Cross-platform paths
- [ ] Environment variable precedence
- [ ] Client ID validation

### Integration Tests
- [ ] GitHubAuthManager reads from config
- [ ] OAuth helper reads from config
- [ ] Backward compatibility with env vars
- [ ] Error messages are helpful

### E2E Tests
- [ ] Setup tool validates input
- [ ] Config saves correctly
- [ ] OAuth works in Claude Desktop
- [ ] Complete flow works

## Success Criteria

1. **OAuth works in Claude Desktop** without environment variables
2. **Backward compatible** - Existing env var setups still work
3. **Easy setup** - Users can configure in under 1 minute
4. **Clear errors** - Users know exactly what to do
5. **100% test coverage** for new code
6. **Cross-platform** - Works on Windows, macOS, Linux
7. **Secure** - Proper file permissions
8. **Well documented** - Clear instructions

## Important Context for Future Sessions

### Key Design Decisions
1. **Config file over env vars** - Works with Claude Desktop
2. **No hardcoding** - Security principle from PR #518
3. **Test-driven** - Write tests first
4. **Agent orchestration** - Use specialized agents, verify work

### File Locations
- Config: `~/.dollhouse/config.json`
- Token: `~/.dollhouse/.auth/github_token.enc`
- OAuth helper: `oauth-helper.mjs` (project root)

### Testing Commands
```bash
# Run ConfigManager tests
npm test -- test/__tests__/unit/config/ConfigManager.test.ts

# Run integration tests
npm test -- test/__tests__/integration/oauth-config-flow.test.ts

# Test OAuth flow
node test-oauth-helper.mjs

# Check config
cat ~/.dollhouse/config.json
```

## Notes

- Client ID is PUBLIC (not a secret) - safe to store in config
- Token is SECRET - already encrypted in secure storage
- Environment variables take precedence for backward compatibility
- Config file approach enables future configuration needs

---
*Session continues with implementation...*
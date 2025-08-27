# Investigation Plan: Content Truncation and Collection Submission Issues

**Date**: August 27, 2025  
**Issues**: #784 (Content Truncation), #785 (Collection Error Codes)  
**Branch**: `feature/content-truncation-investigation`

## Problem Summary

### 1. Content Truncation (CRITICAL - Data Loss)
- Markdown files are being truncated mid-sentence
- Example: ARIA-7 persona cuts off at "you often wonder a"
- Location in pipeline is unknown
- Affects all element types

### 2. Collection Submission Failures
- Generic "auth error" despite valid token
- OAuth helper not detected
- Works for portfolio but not collection
- No clear diagnostic information

## Investigation Approach

### Phase 1: Add Diagnostic Logging

We need to trace content length at every stage:

```typescript
// Key logging points:
1. Element creation (create_persona, etc.)
2. File save operations (PersonaLoader.save())
3. Serialization (Element.serialize())
4. GitHub API calls (base64 encoding)
5. Response handling (decoded content)
```

### Phase 2: Identify Truncation Point

Potential causes to investigate:
- **String operations**: substring(), slice(), substr()
- **Buffer limits**: Node.js buffer sizes
- **GitHub API**: 1MB file limit (750KB after base64)
- **Security validators**: MAX_CONTENT_LENGTH
- **YAML parser**: Document size limits
- **Character encoding**: UTF-8 boundary issues

### Phase 3: Create Reproduction Test

```typescript
// Test with progressively larger content:
- 1KB - Should work
- 10KB - Should work
- 100KB - Should work
- 500KB - Should work
- 750KB - Should work (GitHub limit)
- 1MB - May fail (exceeds GitHub API)
```

## Implementation Plan

### Content Truncation Fix

1. **Add logging** to trace content size through pipeline
2. **Run test** with known large content
3. **Identify** exact truncation point
4. **Fix** the root cause
5. **Test** with various content sizes
6. **Document** any legitimate limits

### Collection Error Codes

```typescript
enum CollectionErrorCode {
  // Step 1: Authentication
  COLL_AUTH_001: "Token validation failed",
  COLL_AUTH_002: "Missing public_repo scope",
  COLL_AUTH_003: "OAuth helper not running",
  
  // Step 2: Portfolio Upload
  COLL_PORT_001: "Portfolio upload failed",
  
  // Step 3: Collection Submission
  COLL_API_001: "Rate limit exceeded",
  COLL_API_002: "Issue creation failed",
  
  // Step 4: Configuration
  COLL_CFG_001: "Auto-submit disabled"
}
```

## Files to Modify

### For Truncation Investigation:
- `src/index.ts` - Add size logging
- `src/persona/PersonaLoader.ts` - File operations
- `src/portfolio/PortfolioRepoManager.ts` - GitHub API
- `src/tools/portfolio/submitToPortfolioTool.ts` - Submission

### For Error Codes:
- `src/config/error-codes.ts` (NEW) - Define codes
- `src/tools/portfolio/submitToPortfolioTool.ts` - Implement
- `src/auth/GitHubAuthManager.ts` - Enhanced errors

## Testing Strategy

### Content Integrity Tests:
```typescript
describe('Content Integrity', () => {
  test('saves 100KB content without truncation');
  test('saves 500KB content without truncation');
  test('preserves Unicode characters');
  test('handles multi-line content');
});
```

### Collection Error Tests:
```typescript
describe('Collection Error Codes', () => {
  test('returns COLL_AUTH_001 for invalid token');
  test('returns COLL_AUTH_003 for missing OAuth helper');
  test('returns COLL_API_001 for rate limit');
});
```

## Success Criteria

- [ ] Truncation point identified
- [ ] Content preserved up to 750KB
- [ ] Error codes at each step
- [ ] Clear remediation messages
- [ ] QA tests passing
- [ ] Documentation updated

## Notes

- Focus on truncation first (data loss)
- Error codes second (diagnostics)
- Consider compression for large content
- Document any hard limits clearly

---

## Setup Instructions for Testing Production MCP Server

To set up the production MCP server in a separate Claude Code session:

### 1. Create Clean Environment
```bash
# In the new Claude Code session
mkdir ~/test-mcp-production
cd ~/test-mcp-production
```

### 2. Install Production Version
```bash
# Install from NPM (once published)
npm install -g @dollhousemcp/mcp-server

# Or install specific version
npm install -g @dollhousemcp/mcp-server@1.6.8
```

### 3. Configure for Testing
```bash
# Create test config directory
mkdir -p ~/.dollhouse-test
export DOLLHOUSE_PORTFOLIO_DIR=~/.dollhouse-test/portfolio

# Set up Claude Desktop config (provide path to test config)
cat > ~/test-claude-config.json << 'EOF'
{
  "mcpServers": {
    "dollhousemcp-test": {
      "command": "npx",
      "args": ["@dollhousemcp/mcp-server"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "~/.dollhouse-test/portfolio"
      }
    }
  }
}
EOF
```

### 4. Test Scenarios
```typescript
// Test these specific scenarios:
1. Create large persona (>100KB)
2. Save to portfolio
3. Check if truncated
4. Try collection submission
5. Note error messages
```

### 5. Compare with Development
- Note differences in behavior
- Check if truncation exists in production
- Compare error messages
- Test OAuth flow differences

### 6. Report Findings
Document in this session:
- Does production have same truncation?
- What error messages appear?
- OAuth helper behavior differences
- Any other observations

This will help determine if issues are:
- Recent regressions (dev only)
- Long-standing bugs (prod + dev)
- Configuration issues
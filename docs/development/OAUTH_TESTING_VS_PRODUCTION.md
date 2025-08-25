# OAuth Testing vs Production: Critical Differences

## ⚠️ CRITICAL DISTINCTION

This document explains the fundamental differences between OAuth testing (using PAT) and production OAuth (using device flow). **These are completely different authentication methods with different behaviors and limitations.**

## Quick Reference

| Aspect | Testing (PAT) | Production (OAuth Device Flow) |
|--------|--------------|--------------------------------|
| **Token Type** | Personal Access Token | OAuth Access Token |
| **User Interaction** | None | Manual device code entry |
| **Browser Required** | No | Yes |
| **Helper Process** | Not used | Required (oauth-helper.mjs) |
| **MCP Stateless Issue** | N/A | Critical (requires helper) |
| **Token Persistence** | Via environment variable | Via file system |
| **Automation** | ✅ Fully automated | ❌ Requires human interaction |
| **CI/CD Compatible** | ✅ Yes | ❌ No |
| **Tests User Experience** | ❌ No | ✅ Yes |

## Testing Setup (PAT)

### What It Is
- Uses GitHub Personal Access Token for direct API authentication
- Bypasses entire OAuth device flow
- Enabled via `TEST_GITHUB_TOKEN` environment variable

### How to Set Up
1. Create PAT at https://github.com/settings/tokens/new
2. Required scopes: `repo`, `read:user`, `user:email`, `read:org`
3. Add to environment:
   ```bash
   export TEST_GITHUB_TOKEN="ghp_your_token_here"
   ```

### What It Tests ✅
- GitHub API authentication works
- Token validation logic
- API rate limiting
- Repository access permissions
- MCP tool integration with authenticated requests

### What It DOESN'T Test ❌
- Device code generation
- Browser opening/redirect
- User code entry experience
- Helper process (`oauth-helper.mjs`) lifecycle
- Token polling mechanism
- OAuth error states
- Session persistence issues
- MCP stateless architecture handling

## Production Setup (OAuth Device Flow)

### What It Is
- Full GitHub OAuth Device Authorization Flow
- Requires manual user interaction
- Uses helper process to handle MCP's stateless nature

### How It Works
1. User calls `setup_github_auth` MCP tool
2. Server spawns detached `oauth-helper.mjs` process
3. Returns device code to user
4. **MCP server terminates** (stateless)
5. Helper process continues polling GitHub
6. User enters code at github.com/login/device
7. Helper receives and stores token
8. Next MCP call can use stored token

### Critical Architecture Points
- MCP server **cannot** wait for OAuth completion
- Helper process **must** be detached
- Token storage **must** persist across MCP calls
- Each MCP call is **completely independent**

## Why We Need Both

### PAT for CI/CD
```yaml
# GitHub Actions example
env:
  TEST_GITHUB_TOKEN: ${{ secrets.TEST_GITHUB_TOKEN }}
```
- Enables automated testing
- No human interaction required
- Consistent, repeatable tests
- Fast execution

### OAuth for End Users
- Real user experience
- Secure authorization flow
- No token exposure
- GitHub-managed permissions

## Testing Guidelines

### When to Use PAT
- CI/CD pipelines
- Automated test suites
- Development testing
- Quick API validation

### When to Test OAuth Manually
- Before releases
- After OAuth-related changes
- User experience validation
- Error handling verification

## Common Pitfalls

### ❌ DON'T Assume PAT Tests Validate OAuth
PAT testing confirms API access works but says nothing about:
- Whether device codes generate correctly
- If the browser opens properly
- How users experience the auth flow
- Whether token polling works
- If the helper process survives MCP termination

### ❌ DON'T Use PAT in Production
- PAT is for testing only
- Has different rate limits
- Doesn't use OAuth scopes
- Bypasses security flows

### ❌ DON'T Skip Manual OAuth Testing
Even with 100% PAT test coverage, you must manually test OAuth because:
- User interaction can't be automated
- Browser behavior varies
- Network issues affect polling
- Helper process issues only appear in real use

## How to Test Both

### Automated Testing (CI/CD)
```bash
# With PAT (automated)
export TEST_GITHUB_TOKEN="ghp_..."
npm test
```

### Manual Testing (Required Before Release)
```bash
# Without PAT (real OAuth flow)
unset TEST_GITHUB_TOKEN

# Start MCP Inspector
npx @modelcontextprotocol/inspector dist/index.js

# In browser:
# 1. Call setup_github_auth
# 2. Copy device code
# 3. Open github.com/login/device
# 4. Enter code
# 5. Authorize
# 6. Call check_github_auth to verify
```

## Debugging

### Check Current Mode
```bash
node scripts/utils/github-auth.js
```

### PAT Issues
- Verify token hasn't expired
- Check required scopes
- Confirm environment variable is set
- Test with curl: `curl -H "Authorization: token $TEST_GITHUB_TOKEN" https://api.github.com/user`

### OAuth Issues
- Check helper process: `ps aux | grep oauth-helper`
- View helper logs: `tail -f ~/.dollhouse/.auth/oauth-helper.log`
- Verify token storage: `ls -la ~/.dollhouse/.github_token`
- Check device code expiration (15 minutes)

## Summary

**PAT (Testing)**: Fast, automated, CI-friendly, but doesn't test user experience
**OAuth (Production)**: Real user flow, secure, but requires manual interaction

Both are necessary for complete testing coverage. PAT enables CI/CD, OAuth ensures users can actually authenticate.
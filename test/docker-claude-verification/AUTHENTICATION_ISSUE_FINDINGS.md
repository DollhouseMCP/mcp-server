# Authentication Issue Findings

## Summary
The Docker integration is NOT working as documented. Claude Code v1.0.110 does not accept API keys via environment variables.

## What Was Found

### The Binary
- **Package**: `@anthropic-ai/claude-code` v1.0.110
- **Binary name**: `claude` (symlink to `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`)
- **Product**: This IS "Claude Code" - the CLI tool from Anthropic

### Authentication Methods Available
1. **setup-token**: Requires Claude subscription (not API key)
   - Command: `claude setup-token`
   - This is for web-based Claude subscribers, not API users

2. **Environment Variable**: ANTHROPIC_API_KEY
   - **Expected**: Should work according to September 10 documentation
   - **Actual**: Does NOT work - returns "Invalid API key · Please run /login"

### The "/login" Mystery
- Error message refers to "/login" but this is NOT a claude command
- `claude --help` does not list any login command
- Only authentication command is `setup-token` which requires a subscription

## Evidence

### Test Results
```bash
# API key IS passed to container correctly
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env -c 'echo ${ANTHROPIC_API_KEY:0:15}'
# Output: sk-ant-api03-9N...

# But Claude Code rejects it
echo "Say TEST" | docker run -i --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint claude claude-mcp-test-env --model sonnet
# Output: Invalid API key · Please run /login
```

### Available Commands (from --help)
- config - Manage configuration
- mcp - Configure and manage MCP servers
- migrate-installer - Migrate from global npm installation
- **setup-token** - Set up a long-lived authentication token (requires Claude subscription)
- doctor - Check health of auto-updater
- update - Check for updates
- install - Install Claude Code native build

No "login" command exists.

## Conclusion

**Critical Finding**: The September 10, 2025 documentation states that Claude Code worked with API keys, but the current version (1.0.110) does NOT accept API keys via environment variables.

### Possible Explanations:
1. **Breaking Change**: Authentication method changed between versions
2. **Different Product**: The `@anthropic-ai/claude-code` npm package may be for Claude.ai subscribers, not API users
3. **Missing Configuration**: There may be an undocumented configuration step required

### What Works:
- ✅ Docker container builds
- ✅ Claude Code CLI installs
- ✅ DollhouseMCP builds and configures
- ✅ MCP configuration is valid
- ✅ API key is passed to container

### What Fails:
- ❌ Claude Code does not accept API keys
- ❌ No documented way to authenticate with API key
- ❌ `/login` command mentioned in error does not exist

## Recommendation

The documented process from September 10 appears to no longer work with Claude Code v1.0.110. The authentication mechanism has likely changed, and API key authentication may no longer be supported in the npm-distributed version of Claude Code.
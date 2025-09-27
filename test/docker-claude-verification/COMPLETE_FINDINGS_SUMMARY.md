# Complete Summary of Docker Claude Code Testing - September 22, 2025

## What We're Trying to Do
Run Claude Code CLI with DollhouseMCP in a Docker container, authenticated with an Anthropic API key, based on documentation from September 10, 2025 that showed this working.

## What We Know Works

### 1. Infrastructure ✅
- Docker image builds successfully
- Claude Code CLI v1.0.110 installs via `npm install -g @anthropic-ai/claude-code@1.0.110`
- Binary is located at `/usr/local/bin/claude` (symlink to `cli.js`)
- DollhouseMCP v1.9.8 builds successfully (785KB dist/index.js)
- MCP configuration file exists and is valid JSON
- Container runs and entrypoint executes

### 2. API Key ✅
- API key format is correct: `sk-ant-api03-...` (108 characters)
- API key is successfully passed to container via `-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"`
- API key is valid - confirmed with curl test returning HTTP 200 from Anthropic API
- API key works with direct Anthropic API calls

### 3. Configuration ✅
- MCP config at `/home/claude/.config/claude-code/config.json` is valid
- Contains correct DollhouseMCP server configuration
- Points to `/app/dollhousemcp/dist/index.js`

## What Fails ❌

### Authentication Problem
- Claude Code CLI returns: `Invalid API key · Please run /login`
- This occurs with ALL attempts:
  - Basic run: `claude --model sonnet`
  - With MCP config: `claude --model sonnet --mcp-config /path/to/config.json`
  - With print flag: `claude --model sonnet --print`
  - With allowed tools: `claude --model sonnet --print --allowedTools ...`

## Key Discoveries

### 1. `/login` is NOT a CLI command
- `claude --help` does not list any `login` command
- Only auth command is `setup-token` which requires Claude subscription
- `/login` is a command in the Claude Code IDE environment (where user is now), not in CLI

### 2. Claude Code vs Claude Code CLI
- User is currently IN Claude Code (the IDE-like environment)
- User can type `/login` there and it works
- The npm package `@anthropic-ai/claude-code` provides a CLI tool
- This CLI tool is what we're trying to run in Docker
- The CLI appears to need different authentication than just API key

### 3. Flags We Found
- `--print` - Non-interactive mode for pipes (non-TTY)
- `--allowedTools` - Pre-approve specific MCP tools
- `--dangerously-skip-permissions` - Bypass all permissions (not recommended)
- `--permission-mode` - Different permission modes
- `--mcp-config` - Load MCP servers from config files

### 4. Environment Variables Tried
- `ANTHROPIC_API_KEY` - Does not work
- `CLAUDE_API_KEY` - Does not work
- No `--api-key` flag exists

### 5. Config Options Available
Cannot set API key via config. Only these keys allowed:
- Local config: allowedTools, hasTrustDialogAccepted, hasCompletedProjectOnboarding, ignorePatterns
- Global config: apiKeyHelper, installMethod, autoUpdates, theme, verbose, etc.
- Note: `apiKeyHelper` exists but is undefined by default

## September 10 Documentation Claims

According to SESSION_NOTES_2025_09_10_DOCKER_CLAUDE_CODE.md:
- Same Claude Code version (v1.0.110)
- Same Docker setup
- Claims it worked with API key via environment variable
- Shows 29 MCP tools were detected
- Claims successful integration

## Critical Questions

1. **Did authentication change between Sept 10 and Sept 22?**
   - Same version number but different behavior
   - Possible server-side authentication change?

2. **Is there a different Claude CLI tool?**
   - Is `@anthropic-ai/claude-code` the right package?
   - Is there an API-key-compatible CLI we should use instead?

3. **Was there a missing step in Sept 10 documentation?**
   - Did they authenticate first and copy tokens?
   - Was there a different method not documented?

## What We Haven't Tried
- Finding and copying authentication tokens from host to container
- Using `claude setup-token` (requires subscription)
- Different npm package or version
- Building Claude Code from source instead of npm

## Next Steps Needed
1. Search web for recent changes to Claude Code CLI authentication
2. Look for documentation on using Claude Code with API keys
3. Find if there's a different Claude CLI tool for API users
4. Check if authentication method changed after September 10, 2025

## Test Commands for Reference

```bash
# Build container
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .

# Test with all flags (still fails with auth error)
echo "Say TEST" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --entrypoint claude \
  claude-mcp-test-env \
  --model sonnet \
  --print \
  --mcp-config /home/claude/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__get_build_info

# Result: "Invalid API key · Please run /login"
```

---

*Summary prepared before web search to preserve context*
*Date: September 22, 2025*
*Time: ~08:45 PST*
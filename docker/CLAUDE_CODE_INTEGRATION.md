# Claude Code + DollhouseMCP Docker Integration

## Overview
This document provides the complete configuration and setup for running Claude Code and DollhouseMCP together in a Docker container. This creates an isolated testing environment where both tools run together with Claude Code using DollhouseMCP as its MCP server.

## Quick Start Commands

```bash
# 1. Build the container
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .

# 2. Set your API key
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# 3. Run Claude Code with DollhouseMCP
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Critical Configuration Details

### MCP Configuration Path
**IMPORTANT**: The MCP configuration MUST be explicitly loaded using:
```
--mcp-config /root/.config/claude-code/config.json
```

Without this flag, Claude Code will NOT connect to DollhouseMCP.

### Model Selection
Use `--model sonnet` for Claude 3.5 Sonnet (recommended for testing)

### API Key Requirement
The container requires `ANTHROPIC_API_KEY` environment variable to function.

## MCP Configuration File

Location in container: `/root/.config/claude-code/config.json`

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/app/dollhousemcp/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "/app/portfolio",
        "DOLLHOUSE_CACHE_DIR": "/app/cache",
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug"
      }
    }
  },
  "defaultMcpServer": "dollhousemcp"
}
```

## Verified Working Configuration

### Software Versions
- **Claude Code**: v1.0.110
- **DollhouseMCP**: v1.7.3
- **Node.js**: 20-slim
- **npm package**: `@anthropic-ai/claude-code`

### Available MCP Tools (29 total)
Successfully detected and accessible:
- Element management tools (list, activate, create, edit, delete)
- Portfolio operations (sync, status, config)
- Collection browsing and searching
- GitHub authentication and integration
- User identity management
- Configuration tools

## Docker Commands Reference

### Build
```bash
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
```

### Run Interactive Session
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Run Single Command
```bash
echo "Your prompt here" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Debug Commands
```bash
# Get shell access
docker run -it --rm --entrypoint /bin/bash claude-dollhouse-test

# Check Claude Code installation
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c "claude --version"

# View MCP configuration
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c \
  "cat /root/.config/claude-code/config.json"

# Test MCP server directly
docker run --rm claude-dollhouse-test test-mcp
```

## Testing MCP Integration

### Test 1: List MCP Tools
```bash
echo "List all available MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

Expected: Should list 29 DollhouseMCP tools with `mcp__dollhousemcp__` prefix

### Test 2: Use MCP Tool
```bash
echo "Use mcp__dollhousemcp__list_elements to list personas" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

Expected: Claude will request permission to use the tool (security feature)

### Test 3: Check Build Info
```bash
echo "Use mcp__dollhousemcp__get_build_info to show version" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Volume Mounts for Development

### Mount Local DollhouseMCP Source
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/app/dollhousemcp \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Mount Local Portfolio
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v ~/.dollhouse/portfolio:/app/portfolio \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Environment Variables

### Required
- `ANTHROPIC_API_KEY`: Your Anthropic API key

### Optional (set in container)
- `DOLLHOUSE_PORTFOLIO_DIR`: `/app/portfolio`
- `DOLLHOUSE_CACHE_DIR`: `/app/cache`
- `NODE_ENV`: `development`
- `LOG_LEVEL`: `debug`

## File Structure in Container

```
/app/
├── dollhousemcp/
│   ├── dist/              # Built DollhouseMCP
│   ├── src/               # Source code
│   ├── package.json
│   └── node_modules/
├── portfolio/
│   ├── personas/
│   ├── skills/
│   ├── templates/
│   ├── agents/
│   ├── memories/
│   └── ensembles/
└── cache/

/root/.config/claude-code/
└── config.json            # MCP configuration

/usr/local/bin/
└── claude                 # Claude Code executable
```

## Known Issues and Solutions

### Issue: MCP tools not detected
**Solution**: Always use `--mcp-config /root/.config/claude-code/config.json`

### Issue: Permission required for MCP tools
**Expected behavior**: Claude Code asks for permission before using MCP tools

### Issue: TTY required for interactive mode
**Solution**: Use `-it` flags or pipe input with `-i` for non-interactive

### Issue: Build fails with "tsc not found"
**Solution**: Ensure Dockerfile uses `npm ci` (not `npm ci --only=production`)

## Performance Metrics

- **Build time**: ~2-3 minutes (first build)
- **Image size**: ~1.2GB
- **Startup time**: ~2 seconds
- **Memory usage**: ~200MB idle, ~400MB active
- **MCP tools detected**: 29

## Security Notes

1. **API Key**: Never hardcode in Dockerfile, always pass via environment
2. **Container runs as root**: Consider adding non-root user for production
3. **MCP Permission**: Claude Code requires approval for MCP tool usage
4. **Network isolation**: Container has full network access by default

## CI/CD Integration Example

```yaml
# .github/workflows/test-integration.yml
name: Test Claude Code Integration

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build Docker image
        run: docker build -f Dockerfile.claude-testing -t test:${{ github.sha }} .
      
      - name: Test MCP tools detection
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          echo "List all MCP tools" | docker run -i --rm \
            -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
            test:${{ github.sha }} \
            claude --model sonnet --mcp-config /root/.config/claude-code/config.json \
            | grep -q "mcp__dollhousemcp"
```

## Success Criteria

✅ **All Confirmed Working:**
- Claude Code v1.0.110 installed
- DollhouseMCP v1.7.3 built
- MCP configuration loaded
- 29 tools detected
- API key passes through
- Model selection works
- Container runs successfully

## Last Tested
- **Date**: September 10, 2025
- **Time**: 6:45 PM PST
- **Branch**: `feature/docker-claude-code-testing`
- **Result**: Full success

---

*This configuration enables complete integration testing of DollhouseMCP with Claude Code in an isolated Docker environment.*
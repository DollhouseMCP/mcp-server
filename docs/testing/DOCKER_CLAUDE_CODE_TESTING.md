# Docker Testing Environment: Claude Code + DollhouseMCP

## Overview

This document describes how to create a Docker container that runs both Claude Code and DollhouseMCP together in an isolated environment. This setup is ideal for:
- Integration testing
- Reproducible development environments
- Testing DollhouseMCP changes with Claude Code
- CI/CD pipeline testing
- Demonstrating DollhouseMCP capabilities

## Architecture

```
┌─────────────────────────────────────┐
│         Docker Container            │
│                                     │
│  ┌─────────────────────────────┐   │
│  │     Claude Code CLI         │   │
│  │   (installed via npm)       │   │
│  └──────────┬──────────────────┘   │
│             │                       │
│          stdio                      │
│             │                       │
│  ┌──────────▼──────────────────┐   │
│  │    DollhouseMCP Server      │   │
│  │  (running as MCP server)    │   │
│  └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

## Prerequisites

- Docker installed on host machine
- DollhouseMCP repository cloned
- Anthropic API key (get one from https://console.anthropic.com/)
- At least 2GB of disk space for Docker image

## Quick Start

### Step 1: Build the Container
```bash
# From the mcp-server directory
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
```

### Step 2: Set Your API Key
```bash
# Export your API key (get one from https://console.anthropic.com/)
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

### Step 3: Run Claude Code with DollhouseMCP
```bash
# IMPORTANT: Must use --mcp-config flag to load MCP servers
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Step 4: Verify MCP Integration
Test that DollhouseMCP is working:
```bash
# List all available MCP tools (should show 29 tools)
echo "List all MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

Expected output should include tools like:
- `mcp__dollhousemcp__list_elements`
- `mcp__dollhousemcp__activate_element`
- `mcp__dollhousemcp__create_element`
- And 26 more...

## Complete Dockerfile

The `Dockerfile.claude-testing` has been created in the project root with the following key features:

### Key Components:

1. **Base Image**: Node.js 20-slim for minimal size
2. **Claude Code Installation**: Uses official npm package `@anthropic-ai/claude-code`
3. **DollhouseMCP Build**: Builds from source in the container
4. **Auto-Configuration**: Sets up Claude Code to use DollhouseMCP automatically
5. **Environment Setup**: Configures all necessary paths and directories

### Installation Method:

The Dockerfile uses the official Claude Code npm package:
```bash
npm install -g @anthropic-ai/claude-code@latest
```

This is the recommended method from Anthropic for installing Claude Code in containerized environments.

## Building the Container

```bash
# From the mcp-server directory
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
```

## Running the Container

### Interactive Mode (for testing)
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="your-api-key-here" \
  claude-dollhouse-test
```

### With Volume Mounts (for development)
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="your-api-key-here" \
  -v $(pwd):/app/dollhousemcp \
  -v ~/.dollhouse/portfolio:/app/portfolio \
  claude-dollhouse-test
```

### Running Specific Commands
```bash
# Start Claude Code interactively
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test claude

# Or run with a specific prompt
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test claude "What MCP tools are available?"
```

## Testing Procedures

### 1. Basic Connectivity Test
```bash
# Start container and check if DollhouseMCP is recognized
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  "Can you see the DollhouseMCP server? List all available MCP tools."
```

Expected: Claude Code should list all DollhouseMCP tools (list_elements, activate_element, etc.)

### 2. Persona Operations Test
```bash
# Test persona listing and activation
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  "List all personas, then activate the Creative Writer persona"
```

Expected: Should list personas and successfully activate one

### 3. Portfolio Sync Test
```bash
# Test portfolio synchronization
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  claude-dollhouse-test \
  "Check my portfolio status and sync any local changes"
```

Expected: Should show portfolio status and perform sync operations

### 4. Template Rendering Test
```bash
# Test template functionality
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  "Create a simple template with variables and render it with test data"
```

Expected: Should create and render a template with variable substitution

### 5. Collection Browsing Test
```bash
# Test collection access
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  "Browse the DollhouseMCP collection and show me some interesting personas"
```

Expected: Should access and display collection content

## Debugging

### View Logs
```bash
# Run with verbose logging
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e DEBUG="*" \
  claude-dollhouse-test
```

### Shell Access
```bash
# Get a shell in the container for debugging
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --entrypoint /bin/bash \
  claude-dollhouse-test
```

### Check MCP Configuration
```bash
# Inside the container
cat /root/.config/claude-code/config.json
```

### Test DollhouseMCP Directly
```bash
# Inside the container
node /app/dollhousemcp/dist/index.js
```

## CI/CD Integration

### GitHub Actions Example
```yaml
name: Test DollhouseMCP with Claude Code

on:
  pull_request:
    branches: [main, develop]

jobs:
  integration-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build test container
        run: docker build -f Dockerfile.claude-testing -t claude-test .
      
      - name: Run integration tests
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Test basic connectivity
          docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
            claude-test "List all MCP tools" | grep -q "list_elements"
          
          # Test persona operations
          docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
            claude-test "List personas" | grep -q "personas"
```

## Troubleshooting

### Issue: ANTHROPIC_API_KEY not set
**Solution**: Ensure you pass the API key via `-e ANTHROPIC_API_KEY="your-key"`

### Issue: MCP server not responding
**Solution**: Check that DollhouseMCP built successfully in the Docker image

### Issue: Permission denied errors
**Solution**: Ensure proper permissions on mounted volumes

### Issue: Claude Code not finding MCP server
**Solution**: Verify the config.json is correctly formatted and in the right location

## Advanced Configuration

### Custom MCP Server Arguments
Modify the config.json in the Dockerfile to add custom arguments:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": [
        "/app/dollhousemcp/dist/index.js",
        "--verbose",
        "--security-mode=strict"
      ]
    }
  }
}
```

### Multiple MCP Servers
Add additional MCP servers to the config:

```json
{
  "mcpServers": {
    "dollhousemcp": { ... },
    "another-mcp": { ... }
  }
}
```

## Performance Considerations

- Container size: ~1.5GB (Node + Claude Code + DollhouseMCP)
- Startup time: ~5-10 seconds
- Memory usage: ~512MB typical, 1GB recommended
- CPU: 1 core minimum, 2 cores recommended

## Security Notes

1. **Never commit API keys** - Always use environment variables
2. **Use secrets in CI/CD** - Store API keys in GitHub Secrets or similar
3. **Limit container permissions** - Run with minimal required privileges
4. **Network isolation** - Use Docker networks to isolate test environments

## Future Enhancements

1. **Multi-stage builds** - Reduce final image size
2. **Health checks** - Add Docker health check for MCP server
3. **Compose setup** - Docker Compose for complex test scenarios
4. **Test automation** - Automated test suite using the container
5. **Version matrix** - Test multiple Claude Code versions

---

*Last Updated: September 10, 2025*
*Session Reference: Testing DollhouseMCP v1.7.3 with Claude Code in Docker*
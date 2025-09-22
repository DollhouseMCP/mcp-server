# Complete Guide: Running Claude Code with DollhouseMCP in Docker Using API Key

## Overview
This document provides the **VERIFIED WORKING PROCESS** for running Claude Code and DollhouseMCP together in a Docker container, authenticated using an Anthropic API key.

**Last Verified Working**: September 10, 2025
**Versions Used**:
- Claude Code: v1.0.110
- DollhouseMCP: v1.7.3
- Docker Base: node:20-slim

## Prerequisites

1. **Docker installed** on your system
2. **Anthropic API key** (starts with `sk-ant-api03-`)
3. **Git repository** cloned locally

## Complete Step-by-Step Process

### Step 1: Set Your API Key
```bash
export ANTHROPIC_API_KEY="sk-ant-api03-YOUR-KEY-HERE"
```

### Step 2: Navigate to Project Directory
```bash
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
```

### Step 3: Build the Docker Container
```bash
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .
```

Build takes 2-3 minutes on first run.

### Step 4: Run Claude Code with DollhouseMCP

#### Option A: Interactive Mode (Recommended for Testing)
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

#### Option B: Single Command Mode
```bash
echo "List all personas using mcp__dollhousemcp__list_elements" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Critical Configuration Points

### 1. MCP Configuration Flag (MANDATORY)
**YOU MUST INCLUDE THIS FLAG**:
```
--mcp-config /root/.config/claude-code/config.json
```

Without this flag, Claude Code will NOT connect to DollhouseMCP!

### 2. API Key Environment Variable
The container requires the `ANTHROPIC_API_KEY` environment variable:
```
-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

### 3. Model Selection
Use `--model sonnet` for Claude 3.5 Sonnet (recommended)

## What Happens Inside the Container

### Architecture
```
┌─────────────────────────────────────┐
│         Docker Container            │
│                                     │
│  ┌─────────────────────────────┐   │
│  │     Claude Code CLI         │   │
│  │   Installed via npm:        │   │
│  │   @anthropic-ai/claude-code │   │
│  └──────────┬──────────────────┘   │
│             │                       │
│        MCP Protocol                 │
│             │                       │
│  ┌──────────▼──────────────────┐   │
│  │    DollhouseMCP Server      │   │
│  │    29 tools available       │   │
│  └─────────────────────────────┘   │
│                                     │
│  Config: /root/.config/claude-code │
└─────────────────────────────────────┘
```

### MCP Configuration (Auto-Created)
Location: `/root/.config/claude-code/config.json`
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

## Available MCP Tools (29 Total)

When successfully connected, Claude Code can access these DollhouseMCP tools:

### Element Management
- `mcp__dollhousemcp__list_elements`
- `mcp__dollhousemcp__activate_element`
- `mcp__dollhousemcp__get_active_elements`
- `mcp__dollhousemcp__deactivate_element`
- `mcp__dollhousemcp__create_element`
- `mcp__dollhousemcp__edit_element`
- `mcp__dollhousemcp__delete_element`
- `mcp__dollhousemcp__validate_element`

### Portfolio Operations
- `mcp__dollhousemcp__portfolio_status`
- `mcp__dollhousemcp__sync_portfolio`
- `mcp__dollhousemcp__search_portfolio`

### Collection Browsing
- `mcp__dollhousemcp__browse_collection`
- `mcp__dollhousemcp__search_collection`
- `mcp__dollhousemcp__get_collection_content`

### System Information
- `mcp__dollhousemcp__get_build_info`
- `mcp__dollhousemcp__get_user_identity`

## Testing the Integration

### Test 1: Verify MCP Tools Are Available
```bash
echo "List all available MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

Expected: Claude will list tools starting with `mcp__dollhousemcp__`

### Test 2: Use an MCP Tool
```bash
echo "Use mcp__dollhousemcp__list_elements to show all personas" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

Expected: Claude will request permission, then list personas

### Test 3: Check Version
```bash
echo "Use mcp__dollhousemcp__get_build_info to show version" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Handling Permissions

Claude Code asks for permission before using MCP tools (security feature).

### Pre-Approve Tools (For Automation)
```bash
echo "List personas" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__list_elements,mcp__dollhousemcp__get_build_info
```

## Common Issues and Solutions

### Issue: MCP tools not detected
**Solution**: Always include `--mcp-config /root/.config/claude-code/config.json`

### Issue: API key error
**Solution**: Ensure `ANTHROPIC_API_KEY` is exported and valid

### Issue: Build fails with "tsc not found"
**Solution**: Dockerfile uses `npm ci` (not `npm ci --only=production`)

### Issue: Permission prompts in non-interactive mode
**Solution**: Use `--allowedTools` to pre-approve specific tools

## Advanced Usage

### Mount Local Source for Development
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/app/dollhousemcp \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Mount Local Portfolio
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v ~/.dollhouse/portfolio:/app/portfolio \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Helper Script

Use the provided helper script for easier operation:
```bash
./scripts/claude-docker.sh --allow-all "List all personas"
```

## Key Dockerfile Components

The Dockerfile (`docker/test-configs/Dockerfile.claude-testing`) performs these steps:

1. **Base Image**: Uses `node:20-slim` for efficiency
2. **System Dependencies**: Installs git, curl, build tools
3. **DollhouseMCP Build**:
   ```dockerfile
   COPY package*.json /app/dollhousemcp/
   WORKDIR /app/dollhousemcp
   RUN npm ci
   COPY . /app/dollhousemcp/
   RUN npm run build
   ```
4. **Claude Code Installation**:
   ```dockerfile
   RUN npm install -g @anthropic-ai/claude-code@1.0.110
   ```
5. **MCP Configuration**: Auto-creates config at `/root/.config/claude-code/config.json`
6. **Entrypoint**: Checks for API key and provides usage instructions

## Success Verification Checklist

✅ Docker image builds successfully
✅ API key is set in environment
✅ Container starts without errors
✅ Claude Code connects to Anthropic API
✅ MCP tools are detected (29 tools)
✅ Tools can be executed with permission
✅ DollhouseMCP responds to tool calls

## Quick Reference Card

```bash
# Build
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .

# Set API Key
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# Run Interactive
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json

# Run Command
echo "YOUR PROMPT" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json

# Debug Shell
docker run -it --rm --entrypoint /bin/bash claude-mcp-test-env
```

## Summary

This process creates an isolated Docker environment where:
1. **Claude Code CLI** is installed and configured
2. **DollhouseMCP** is built and running as an MCP server
3. **Authentication** uses your Anthropic API key
4. **Integration** works through the MCP protocol
5. **29 tools** are available for AI customization

The key to success is:
- Always use the `--mcp-config` flag
- Export your API key before running
- Build the container with the correct Dockerfile
- Use the exact commands as shown above

---

*Document created: September 22, 2025*
*Based on verified working session: September 10, 2025*
*Author: Alex Sterling*
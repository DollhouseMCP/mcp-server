# Session Notes - September 10, 2025 - Docker Claude Code Integration

## Session Overview
**Time**: Afternoon (~2:10 PM - 6:45 PM PST)  
**Branch**: `feature/docker-claude-code-testing`  
**Context**: Creating Docker environment for testing Claude Code with DollhouseMCP  
**Result**: ✅ Successfully created working Docker container with both tools integrated

## Objective
Create a Docker container that runs BOTH Claude Code and DollhouseMCP together in an isolated environment for integration testing. This allows testing DollhouseMCP changes with Claude Code without affecting the host system.

## Key Achievement
Successfully built and tested a Docker container where:
- Claude Code CLI is installed inside the container
- DollhouseMCP is built and running inside the same container
- Claude Code is configured to use DollhouseMCP as its MCP server
- All 29 DollhouseMCP tools are accessible from Claude Code

## Process Summary

### 1. Initial Research
- Searched web for Claude Code Docker installation methods
- Found official npm package: `@anthropic-ai/claude-code`
- Discovered installation command: `npm install -g @anthropic-ai/claude-code@latest`

### 2. Created Docker Infrastructure

#### Files Created:
1. **`Dockerfile.claude-testing`** - Main Dockerfile with:
   - Node.js 20-slim base image
   - Claude Code installation via npm
   - DollhouseMCP build from source
   - Auto-configuration of MCP connection
   - Entrypoint script with environment checks

2. **`.dockerignore.claude-testing`** - Optimized build context:
   - Excludes node_modules, test files, docs
   - Reduces build time and image size

3. **`docs/testing/DOCKER_CLAUDE_CODE_TESTING.md`** - Complete documentation:
   - Architecture overview
   - Quick start guide
   - Testing procedures
   - Troubleshooting section

4. **`scripts/test-claude-docker.sh`** - Interactive test script:
   - Build, test, and run commands
   - Menu-driven interface
   - Color-coded output

### 3. Build Process Challenges & Solutions

#### Challenge 1: TypeScript Not Found
**Error**: `sh: 1: tsc: not found`
**Solution**: Changed from `npm ci --only=production` to `npm ci` to include dev dependencies

#### Challenge 2: API Key Configuration
**Issue**: ANTHROPIC_API_KEY needed for Claude Code
**Solution**: Pass via environment variable: `-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"`

#### Challenge 3: MCP Tools Not Detected
**Issue**: Claude Code didn't automatically load MCP config
**Solution**: Use explicit flag: `--mcp-config /root/.config/claude-code/config.json`

### 4. Final Working Configuration

#### Build Command:
```bash
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
```

#### Run Command (Full):
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### 5. Verification Results

#### ✅ Confirmed Working:
- Claude Code v1.0.110 installed
- DollhouseMCP v1.7.3 built and configured
- 29 MCP tools detected and available
- Configuration properly linked
- Sonnet model can be specified

#### MCP Tools Available:
- Element management (create, edit, delete, validate)
- Portfolio operations (sync, status, config)
- Collection browsing and searching
- GitHub authentication and integration
- User identity management
- Configuration tools

## Key Discoveries

### 1. MCP Configuration Loading
Claude Code doesn't automatically load MCP configs from `~/.config/claude-code/`. Must use:
- `--mcp-config <path>` flag to explicitly load MCP servers
- Or use `claude mcp` commands to manage servers

### 2. Model Selection
Can specify model with `--model` flag:
- `--model sonnet` for Claude 3.5 Sonnet
- `--model opus` for Claude 3 Opus
- Full model names also work

### 3. Permission System
Claude Code asks for permission before using MCP tools (security feature)
- In interactive mode, user approves tool usage
- Tools are recognized but gated behind approval

## Architecture Achieved

```
┌─────────────────────────────────────┐
│         Docker Container            │
│                                     │
│  ┌─────────────────────────────┐   │
│  │     Claude Code CLI         │   │
│  │   npm: @anthropic-ai/       │   │
│  │        claude-code          │   │
│  └──────────┬──────────────────┘   │
│             │                       │
│        stdio + MCP                  │
│             │                       │
│  ┌──────────▼──────────────────┐   │
│  │    DollhouseMCP Server      │   │
│  │    29 tools available       │   │
│  └─────────────────────────────┘   │
│                                     │
│  Config: /root/.config/claude-code │
└─────────────────────────────────────┘
```

## Testing Commands Reference

### Basic Tests:
```bash
# Check versions
docker run --rm claude-dollhouse-test claude --version

# List MCP tools
echo "List all MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json

# Test specific MCP operation
echo "Use mcp__dollhousemcp__list_elements to list personas" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Debug Commands:
```bash
# Get shell access
docker run --rm --entrypoint /bin/bash claude-dollhouse-test

# Check Claude installation
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c "which claude"

# View MCP config
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c \
  "cat /root/.config/claude-code/config.json"

# Test MCP server directly
docker run --rm claude-dollhouse-test test-mcp
```

## File Structure in Container

```
/app/
├── dollhousemcp/          # DollhouseMCP source and build
│   ├── dist/              # Built JavaScript
│   ├── src/               # TypeScript source
│   └── package.json
├── portfolio/             # Portfolio directory
│   ├── personas/
│   ├── skills/
│   ├── templates/
│   └── ...
└── cache/                 # Cache directory

/root/.config/claude-code/
└── config.json            # MCP server configuration

/usr/local/bin/
└── claude                 # Claude Code CLI executable
```

## Lessons Learned

1. **Always verify package names** - Web search essential for finding correct npm packages
2. **Build dependencies matter** - Production builds need dev dependencies for TypeScript
3. **Explicit configuration** - MCP configs must be explicitly passed to Claude Code
4. **Environment isolation** - Docker provides perfect testing environment
5. **Documentation is crucial** - Complex setups need comprehensive docs

## Next Steps

### Immediate:
1. Test full integration scenarios
2. Add to CI/CD pipeline
3. Create automated test suite

### Future Enhancements:
1. Multi-stage build to reduce image size
2. Docker Compose for complex scenarios
3. Pre-built images on Docker Hub
4. GitHub Actions integration

## Success Metrics

- ✅ Docker image builds successfully
- ✅ Claude Code installs and runs
- ✅ DollhouseMCP builds and configures
- ✅ MCP tools are detected (29 tools)
- ✅ Configuration links properly
- ✅ API key passes through correctly
- ✅ Model selection works (Sonnet)

## Commands for Next Session

```bash
# Switch to feature branch
git checkout feature/docker-claude-code-testing

# Run the test script
./scripts/test-claude-docker.sh

# Or manually build and run
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Final State

- **Branch**: `feature/docker-claude-code-testing`
- **Docker Image**: `claude-dollhouse-test:latest` built and working
- **Integration**: Claude Code + DollhouseMCP successfully connected
- **Documentation**: Complete guide in `docs/testing/DOCKER_CLAUDE_CODE_TESTING.md`
- **Ready for**: Integration testing and CI/CD implementation

---

*Session Duration: ~4.5 hours*  
*Context: Testing infrastructure for DollhouseMCP v1.7.3*  
*Result: Complete success - working Docker testing environment*
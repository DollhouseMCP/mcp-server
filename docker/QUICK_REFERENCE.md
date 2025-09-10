# Docker Claude Code + DollhouseMCP Quick Reference

## 🚀 One-Line Setup

```bash
# Build and run (assumes ANTHROPIC_API_KEY is set)
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test . && \
docker run -it --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude-dollhouse-test \
claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## 📋 Essential Commands

### Build
```bash
docker build -f Dockerfile.claude-testing -t claude-dollhouse-test .
```

### Run Interactive
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Test MCP Tools
```bash
echo "List all MCP tools" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-dollhouse-test \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

### Get Shell
```bash
docker run -it --rm --entrypoint /bin/bash claude-dollhouse-test
```

## ⚙️ Key Configuration

| Component | Value |
|-----------|-------|
| Claude Code Version | v1.0.110 |
| DollhouseMCP Version | v1.7.3 |
| npm Package | `@anthropic-ai/claude-code` |
| MCP Config Path | `/root/.config/claude-code/config.json` |
| MCP Tools Available | 29 |
| Recommended Model | `sonnet` |

## 🔑 Critical Flags

**MUST USE**: `--mcp-config /root/.config/claude-code/config.json`
- Without this, MCP tools won't load!

**Model Selection**: `--model sonnet`
- Uses Claude 3.5 Sonnet

## 🧪 Test Script

```bash
# Use the provided test script for interactive testing
./scripts/test-claude-docker.sh
```

Options:
1. Build image
2. Run tests
3. Interactive shell
4. Run with Claude Code
5. Build and test
6. Clean up

## 📁 Files Created

```
.
├── Dockerfile.claude-testing          # Main Dockerfile
├── .dockerignore.claude-testing       # Build optimization
├── scripts/test-claude-docker.sh      # Test script
└── docs/
    ├── testing/DOCKER_CLAUDE_CODE_TESTING.md    # Full guide
    └── development/SESSION_NOTES_2025_09_10_*.md # Session notes
```

## ✅ Success Indicators

- ✅ Shows "1.0.110 (Claude Code)" on `--version`
- ✅ Lists 29 MCP tools starting with `mcp__dollhousemcp__`
- ✅ Can execute MCP operations (with permission prompt)
- ✅ Shows DollhouseMCP v1.7.3 in startup banner

## ⚠️ Common Issues

| Issue | Solution |
|-------|----------|
| MCP tools not found | Add `--mcp-config /root/.config/claude-code/config.json` |
| API key error | Export `ANTHROPIC_API_KEY` before running |
| TTY error | Use `-it` for interactive or `-i` for piped input |
| Build fails (tsc not found) | Dockerfile should use `npm ci` not `npm ci --only=production` |

## 🔍 Debug Commands

```bash
# Check Claude installation
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c "which claude"

# View MCP config
docker run --rm --entrypoint /bin/bash claude-dollhouse-test -c \
  "cat /root/.config/claude-code/config.json"

# Test MCP server directly
docker run --rm claude-dollhouse-test test-mcp
```

## 📊 Performance

- Build time: ~2-3 minutes
- Image size: ~1.2GB  
- Startup: ~2 seconds
- Memory: ~400MB active

## 🎯 Next Steps

1. Run integration tests
2. Add to CI/CD pipeline
3. Create automated test suite
4. Push image to Docker Hub

---

*Last tested: September 10, 2025 | Branch: `feature/docker-claude-code-testing`*
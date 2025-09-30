# Docker Integration Testing Guide for DollhouseMCP

**Last Updated**: September 30, 2025 (v1.9.14 release)
**Status**: ✅ VERIFIED WORKING

## Purpose

This guide provides a complete, repeatable process for integration testing DollhouseMCP with Claude Code in a Docker container. Use this to verify bug fixes and new features before releases.

---

## Quick Start (Copy-Paste)

### 1. Build Docker Image

```bash
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env:test .
```

**Build time**: ~2-3 minutes (first time)

### 2. Run Basic Test

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
  mkdir -p /home/claude/.claude && \
  cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
  chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
  claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1 && \
  claude --model sonnet --print "Say TEST_SUCCESSFUL"'
```

**Expected output**: `TEST_SUCCESSFUL`

### 3. Test MCP Integration

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
  mkdir -p /home/claude/.claude && \
  cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
  chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
  claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1 && \
  echo "Use mcp__dollhousemcp__get_build_info and show the version" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__get_build_info'
```

**Expected output**: Should show DollhouseMCP version and build info

---

## Critical Configuration

### Claude Code Version

**✅ VERIFIED WORKING**: `@anthropic-ai/claude-code@1.0.128`
**❓ UNTESTED/UNKNOWN**: `@anthropic-ai/claude-code@2.0.x` (we couldn't get authentication working with our current approach)

**Why v1.0.128**: This is the version we have successfully tested and verified working with the apiKeyHelper pattern. Claude Code v2.0+ may work with a different authentication approach, but we have not yet found a working configuration.

### Authentication Pattern (apiKeyHelper)

The **ONLY** pattern that works:

```bash
mkdir -p /home/claude/.claude
cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
chmod +x /home/claude/.claude/anthropic_key_helper.sh
claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh
```

**Critical details**:
- Use heredoc (`<< "EOFHELPER"`) to preserve variable interpolation
- Script must output API key to stdout
- Must configure AFTER script creation
- API key passed via `-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"`

### MCP Configuration Path

**✅ CORRECT**: `/home/claude/.config/claude-code/config.json`
**❌ WRONG**: `/root/.config/claude-code/config.json` (permission denied, container runs as `claude` user)

---

## Testing Release-Specific Bug Fixes

### Template for Testing a Bug Fix

When releasing a fix, create a test that:
1. Creates test data that triggered the original bug
2. Performs the operation that previously failed
3. Verifies the fix by checking the output

### Example: v1.9.14 Bug Fix Tests

#### Fix #1: Security Scanner False Positives (PR #1212)

**Bug**: Memories containing security terms (S7018, vulnerability, exploit) threw SecurityError

**Test**:
```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
# Setup auth (see authentication pattern above)
mkdir -p /home/claude/.claude && \
cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1

# Create test memory with security terms that triggered the bug
mkdir -p /app/portfolio/memories
cat > /app/portfolio/memories/test-security-terms.yaml << "EOFMEM"
metadata:
  name: test-security-terms
  description: Memory with security terms
  version: 1.0.0
  created: 2025-09-30T00:00:00Z
entries:
  - content: |
      Rule S7018: Prevent SQL Injection vulnerability
      Contains: exploit, attack, CRITICAL security hotspot
    timestamp: 2025-09-30T00:00:00Z
EOFMEM

# Test: List memories (should succeed without SecurityError)
echo "Use mcp__dollhousemcp__list_elements with type=memories" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__list_elements
'
```

**Success criteria**:
- ✅ Memory appears in list
- ✅ No SecurityError thrown
- ✅ Output contains `test-security-terms`

#### Fix #2: Portfolio Search File Extensions (PR #1215)

**Bug**: Portfolio search showed incorrect file extensions for memories

**Test**:
```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
# Setup auth
mkdir -p /home/claude/.claude && \
cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1

# Create test memory
mkdir -p /app/portfolio/memories
cat > /app/portfolio/memories/test-extension.yaml << "EOFMEM"
metadata:
  name: test-extension
  description: Test memory
  version: 1.0.0
entries:
  - content: "Test"
EOFMEM

# Test: Search should show .yaml extension
echo "Use mcp__dollhousemcp__search_portfolio with query=test and type=memories" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__search_portfolio
' | grep -o "test-extension\.yaml"
```

**Success criteria**:
- ✅ Output contains `test-extension.yaml` (not `.md`)
- ✅ Personas show `.md` extension
- ✅ Correct extension for each element type

---

## Common Test Patterns

### Pattern 1: Test MCP Tool Call

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
  # Auth setup (heredoc pattern)
  mkdir -p /home/claude/.claude && \
  cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
  chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
  claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1

  # Execute test
  echo "YOUR_PROMPT" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__TOOL_NAME
'
```

### Pattern 2: Create Test Fixture + Test

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
  # Auth setup
  mkdir -p /home/claude/.claude && \
  cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
  chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
  claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1

  # Create test data
  mkdir -p /app/portfolio/TYPE
  cat > /app/portfolio/TYPE/test-element.ext << "EOFDATA"
# Your test data here
EOFDATA

  # Run test
  echo "Test the created fixture" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__TOOL_NAME
'
```

### Pattern 3: Multi-Tool Test

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --entrypoint bash claude-mcp-test-env:test -c '
  # Auth setup (heredoc)
  mkdir -p /home/claude/.claude && \
  cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
  chmod +x /home/claude/.claude/anthropic_key_helper.sh && \
  claude config set --global apiKeyHelper /home/claude/.claude/anthropic_key_helper.sh >/dev/null 2>&1

  # Test multiple tools in sequence
  echo "Use tool1 then tool2" | \
  claude --model sonnet --print \
    --mcp-config /home/claude/.config/claude-code/config.json \
    --allowedTools mcp__dollhousemcp__tool1,mcp__dollhousemcp__tool2
'
```

---

## Troubleshooting

### Issue: "Invalid API key · Please run /login"

**Cause**: Authentication not configured properly

**Solution**: Ensure you're using the **exact heredoc pattern** for apiKeyHelper:
```bash
cat > /home/claude/.claude/anthropic_key_helper.sh << "EOFHELPER"
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
EOFHELPER
```

**DO NOT** use:
- ❌ `echo 'echo $ANTHROPIC_API_KEY'` (wrong quoting)
- ❌ `echo ${ANTHROPIC_API_KEY}` (expands at wrong time)

**NOTE**: If using Claude Code v2.0+, authentication may require a different approach (not yet documented)

### Issue: "MCP config file not found"

**Cause**: Using wrong config path

**Solution**: Use `/home/claude/.config/claude-code/config.json` (not `/root/.config/`)

### Issue: "Input must be provided either through stdin..."

**Cause**: Prompt consumed by earlier commands in script

**Solution**:
- Use `echo "prompt" | claude ...` (stdin)
- OR pass prompt as last argument: `claude --model sonnet --print "prompt here"`
- Don't mix stdin and argument approaches

### Issue: Docker build fails

**Cause**: Building from wrong directory

**Solution**: Always build from `mcp-server` root:
```bash
cd /path/to/mcp-server
docker build -f docker/test-configs/Dockerfile.claude-testing -t IMAGE_NAME .
#                                                                            ^ DOT IS CRITICAL
```

---

## Verification Checklist

Before releasing, verify:

- [ ] Docker image builds successfully
- [ ] Basic Claude Code test passes (no MCP)
- [ ] MCP integration test passes (`get_build_info`)
- [ ] Version number matches expected release
- [ ] Bug-specific tests pass (create fixtures for each fix)
- [ ] File extensions correct in search results
- [ ] No SecurityError on valid content

---

## Environment

**Host**: macOS (works on Linux/Windows with Docker)
**Docker**: v20+
**Node.js in container**: 20.18.1-slim
**Claude Code**: v1.0.128
**DollhouseMCP**: Version being tested

---

## Why This Configuration

### Why Claude Code v1.0.128?
- Verified working with apiKeyHelper pattern
- We couldn't get v2.0.1 authentication working (may be possible with different approach)
- v1.0.128 is reliable and tested as of September 30, 2025

### Why apiKeyHelper instead of ANTHROPIC_API_KEY?
- Claude Code v1.x doesn't read env var directly
- Requires helper script for API key
- This is the only pattern that works

### Why heredoc for helper script?
- Ensures correct variable interpolation
- Prevents quoting issues
- Proven pattern from September 22-30, 2025 debugging

---

## Related Documentation

- `docker/test-configs/Dockerfile.claude-testing` - Dockerfile used for testing
- `test/docker-claude-verification/README.md` - Original test suite
- Memory: `docker-claude-code-dollhousemcp-integration-testing.yaml` - Full reference
- Memory: `docker-claude-code-authentication-solution.yaml` - Auth solution details

---

## Last Verified

**Date**: September 30, 2025
**Version**: v1.9.14
**Test Results**:
- ✅ Security scanner false positives fixed (PR #1212)
- ✅ File extension display fixed (PR #1215)
- ✅ MCP tools responding correctly
- ✅ Docker integration fully working

**Next verification**: Before v1.9.15 release

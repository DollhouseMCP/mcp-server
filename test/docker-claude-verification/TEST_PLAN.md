# Docker Claude Code + DollhouseMCP Verification Test Plan

## Test Metadata
- **Test Date**: September 22, 2025
- **Test Version**: 1.0.0
- **Expected Duration**: 30-45 minutes
- **Test Type**: Integration Verification
- **Risk Level**: Low (read-only operations)

## Prerequisites Verification Checklist

### Environment Requirements
- [ ] Docker version >= 20.10 installed (`docker --version`)
- [ ] At least 5GB free disk space (`df -h`)
- [ ] Internet connectivity for Docker Hub and npm
- [ ] Git repository cloned and up-to-date
- [ ] Terminal with color support for output verification

### API Key Verification
- [ ] ANTHROPIC_API_KEY environment variable set
- [ ] API key format verified (starts with `sk-ant-api03-`)
- [ ] API key has active credits (will test with actual API call)

## Test Phases

### Phase 1: Build Verification (10 minutes)

#### Test 1.1: Clean Build
```bash
# Remove any existing images
docker rmi claude-mcp-test-env 2>/dev/null || true

# Record build start time
BUILD_START=$(date +%s)

# Build with verbose output
docker build --no-cache \
  -f docker/test-configs/Dockerfile.claude-testing \
  -t claude-mcp-test-env . \
  2>&1 | tee build.log

# Record build end time
BUILD_END=$(date +%s)
BUILD_TIME=$((BUILD_END - BUILD_START))
```

**Success Criteria:**
- [ ] Build completes without errors
- [ ] Build time < 300 seconds (5 minutes)
- [ ] Final image size < 2GB
- [ ] Build log contains "Successfully built"
- [ ] Build log contains "Successfully tagged claude-mcp-test-env"

#### Test 1.2: Image Inspection
```bash
# Check image exists and get details
docker images claude-mcp-test-env --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

# Inspect image layers
docker history claude-mcp-test-env --no-trunc

# Check for expected files in image
docker run --rm claude-mcp-test-env ls -la /app/dollhousemcp/dist/
docker run --rm claude-mcp-test-env ls -la /root/.config/claude-code/
docker run --rm claude-mcp-test-env which claude
```

**Success Criteria:**
- [ ] Image size reasonable (1-2GB expected)
- [ ] `/app/dollhousemcp/dist/index.js` exists
- [ ] `/root/.config/claude-code/config.json` exists
- [ ] `claude` binary found in PATH

### Phase 2: Configuration Verification (5 minutes)

#### Test 2.1: MCP Configuration Validity
```bash
# Extract and validate MCP config
docker run --rm claude-mcp-test-env \
  cat /root/.config/claude-code/config.json | \
  python3 -m json.tool > extracted-config.json

# Verify required fields
grep -q '"mcpServers"' extracted-config.json
grep -q '"dollhousemcp"' extracted-config.json
grep -q '"/app/dollhousemcp/dist/index.js"' extracted-config.json
```

**Success Criteria:**
- [ ] Config is valid JSON
- [ ] Contains mcpServers.dollhousemcp section
- [ ] Points to correct DollhouseMCP path
- [ ] Has required environment variables

#### Test 2.2: DollhouseMCP Server Health
```bash
# Test MCP server can start (will timeout, that's expected)
timeout 3 docker run --rm claude-mcp-test-env \
  node /app/dollhousemcp/dist/index.js 2>&1 | \
  tee mcp-health.log

# Check for error messages
grep -i error mcp-health.log && echo "FAIL: Errors found" || echo "PASS: No errors"
```

**Success Criteria:**
- [ ] Server attempts to start
- [ ] No JavaScript errors
- [ ] No missing module errors
- [ ] Timeout exit (124) is expected

### Phase 3: API Connection Verification (5 minutes)

#### Test 3.1: Claude Code Version Check
```bash
# This will fail without API key, but should show version attempt
docker run --rm claude-mcp-test-env claude --version 2>&1 | tee version.log
```

**Success Criteria:**
- [ ] Command executes
- [ ] Shows version or API key requirement

#### Test 3.2: API Key Validation
```bash
# Test with API key - basic connectivity
echo "Say 'Hello, test successful' and nothing else" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet 2>&1 | tee api-test.log

# Check for success
grep -q "test successful" api-test.log && echo "PASS: API Connected" || echo "FAIL: API Error"
```

**Success Criteria:**
- [ ] Response received from Claude
- [ ] No authentication errors
- [ ] Response contains expected text

### Phase 4: MCP Integration Verification (10 minutes)

#### Test 4.1: MCP Tools Detection
```bash
# List available MCP tools
echo "List all available MCP tools that start with mcp__dollhousemcp" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json 2>&1 | \
  tee mcp-tools.log

# Count detected tools
TOOL_COUNT=$(grep -o "mcp__dollhousemcp__" mcp-tools.log | wc -l)
echo "Tools detected: $TOOL_COUNT"
```

**Success Criteria:**
- [ ] At least 20 tools detected
- [ ] Tools have mcp__dollhousemcp__ prefix
- [ ] No MCP connection errors

#### Test 4.2: MCP Tool Execution - Read Only
```bash
# Test get_build_info (safe, read-only)
echo "Use the MCP tool mcp__dollhousemcp__get_build_info to show the DollhouseMCP version" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__get_build_info 2>&1 | \
  tee build-info.log

# Verify version info returned
grep -q "version" build-info.log && echo "PASS: Version found" || echo "FAIL: No version"
```

**Success Criteria:**
- [ ] Tool executes without permission prompt
- [ ] Returns version information
- [ ] Contains "DollhouseMCP" or version number

#### Test 4.3: MCP Tool Execution - List Elements
```bash
# Test list_elements (safe, read-only)
echo "Use mcp__dollhousemcp__list_elements with type 'personas' to list all personas" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__list_elements 2>&1 | \
  tee list-personas.log

# Check for persona listings
grep -i "persona" list-personas.log && echo "PASS: Personas listed" || echo "FAIL: No personas"
```

**Success Criteria:**
- [ ] Tool executes successfully
- [ ] Returns list of personas or "no personas found"
- [ ] No JavaScript errors

### Phase 5: Permission System Verification (5 minutes)

#### Test 5.1: Permission Prompt Test
```bash
# Run WITHOUT --allowedTools to test permission system
echo "Use mcp__dollhousemcp__get_build_info to show version" | \
timeout 5 docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json 2>&1 | \
  tee permission-test.log

# Check for permission request
grep -i "permission" permission-test.log && echo "PASS: Permission system active" || echo "WARN: Check manually"
```

**Success Criteria:**
- [ ] Permission request appears OR timeout occurs
- [ ] No unauthorized execution

#### Test 5.2: Pre-approved Tools Test
```bash
# Test with multiple pre-approved tools
echo "First use mcp__dollhousemcp__get_build_info then use mcp__dollhousemcp__list_elements with type personas" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__get_build_info,mcp__dollhousemcp__list_elements 2>&1 | \
  tee multi-tool.log

# Both tools should execute
grep -q "version" multi-tool.log && grep -q "persona" multi-tool.log && \
  echo "PASS: Multiple tools work" || echo "FAIL: Tool execution issue"
```

**Success Criteria:**
- [ ] Both tools execute
- [ ] No permission prompts
- [ ] Expected output from both tools

### Phase 6: Stress & Edge Cases (5 minutes)

#### Test 6.1: Invalid API Key Handling
```bash
# Test with invalid API key
echo "Say hello" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="invalid-key-123" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json 2>&1 | \
  tee invalid-key.log

# Should show auth error
grep -i "auth\|api\|key" invalid-key.log && echo "PASS: Auth error shown" || echo "FAIL: No error"
```

**Success Criteria:**
- [ ] Clear authentication error
- [ ] No crash or hang
- [ ] Graceful failure

#### Test 6.2: Missing MCP Config Flag
```bash
# Run WITHOUT --mcp-config flag
echo "List all MCP tools" | \
docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet 2>&1 | \
  tee no-mcp-config.log

# Should NOT find DollhouseMCP tools
grep -q "mcp__dollhousemcp" no-mcp-config.log && \
  echo "FAIL: Tools found without config!" || echo "PASS: Config required"
```

**Success Criteria:**
- [ ] No DollhouseMCP tools available
- [ ] Confirms config flag is required

#### Test 6.3: Container Resource Check
```bash
# Run container and check resource usage
docker run -d --name test-resources \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  sleep 30

# Check memory and CPU
docker stats test-resources --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}"

# Cleanup
docker rm -f test-resources
```

**Success Criteria:**
- [ ] Memory usage < 500MB idle
- [ ] CPU usage minimal when idle

## Automated Test Script

Create `run-verification.sh`:
```bash
#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_TESTS=20

log_test() {
    echo -e "\n${YELLOW}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASS_COUNT++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAIL_COUNT++))
}

# Run all tests sequentially
log_test "Starting Docker Claude Code Verification Suite"
echo "Test Date: $(date)"
echo "API Key Set: $([ -n "$ANTHROPIC_API_KEY" ] && echo "Yes" || echo "No")"

# Continue with each test...
# (Full script implementation would include all tests above)

echo -e "\n========== TEST RESULTS =========="
echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
echo -e "Total:  $TOTAL_TESTS"
echo -e "=================================="

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "\n${GREEN}✅ ALL TESTS PASSED${NC}"
    exit 0
else
    echo -e "\n${RED}❌ SOME TESTS FAILED${NC}"
    exit 1
fi
```

## Success Criteria Summary

### Critical (Must Pass)
1. Docker image builds successfully
2. API key authentication works
3. MCP tools are detected (>20 tools)
4. At least one MCP tool executes successfully

### Important (Should Pass)
1. Build time < 5 minutes
2. Image size < 2GB
3. No JavaScript errors in logs
4. Permission system functions correctly

### Nice to Have
1. All 29 documented tools detected
2. Memory usage < 500MB
3. Multi-tool execution works

## Test Report Template

```markdown
# Docker Claude Code Verification Report

**Date**: [DATE]
**Tester**: [NAME]
**Environment**: [OS, Docker version]

## Results Summary
- Build Tests: [X/Y] Passed
- Config Tests: [X/Y] Passed
- API Tests: [X/Y] Passed
- MCP Tests: [X/Y] Passed
- Permission Tests: [X/Y] Passed
- Edge Cases: [X/Y] Passed

## Issues Found
1. [Issue description, severity, workaround]

## Recommendation
[ ] VERIFIED - Ready for use
[ ] PARTIAL - Works with limitations
[ ] FAILED - Requires fixes

## Evidence
- Build log: [attached]
- Test outputs: [attached]
- Screenshots: [if applicable]
```

---

This test plan provides rigorous, reproducible verification of the Docker Claude Code + DollhouseMCP integration process.
# Docker Claude Code Verification Test Suite

## Quick Start

### Prerequisites
1. Set your API key:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-api03-..."
   ```

2. Navigate to the MCP server directory:
   ```bash
   cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
   ```

### Run the Verification

#### Option 1: Automated Test Suite (Recommended)
```bash
./test/docker-claude-verification/run-verification.sh
```

This runs all 20+ tests automatically and generates a report.

#### Option 2: Quick Manual Test
```bash
# 1. Build the container
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .

# 2. Test basic connectivity
echo "Say TEST_SUCCESSFUL" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet

# 3. Test MCP integration
echo "Use mcp__dollhousemcp__get_build_info to show version" | docker run -i --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude-mcp-test-env \
  claude --model sonnet \
  --mcp-config /root/.config/claude-code/config.json \
  --allowedTools mcp__dollhousemcp__get_build_info
```

## Test Suite Contents

- **TEST_PLAN.md** - Comprehensive test plan with 6 phases
- **run-verification.sh** - Automated test script
- **EXPECTED_OUTPUTS.md** - Expected outputs and failure modes
- **README.md** - This file

## Model Note

All tests use `--model sonnet` (Claude 3.5 Sonnet) for cost efficiency. The integration works identically with Opus or other models if needed.

## Success Criteria

✅ **Minimum Viable Test** (3 tests must pass):
1. Docker image builds successfully
2. API authentication works
3. At least one MCP tool executes

✅ **Full Verification** (20+ tests):
- Run `./run-verification.sh` for complete testing

## Test Results

After running, check:
- `test-results-*/VERIFICATION_REPORT.md` - Full report
- `test-results-*/test-results.log` - Detailed logs
- Exit code: 0 = success, 1 = failures detected

## Troubleshooting

If tests fail, check:
1. API key is valid and has credits
2. Docker daemon is running
3. Internet connectivity is available
4. No firewall blocking Docker or API calls

See `EXPECTED_OUTPUTS.md` for detailed failure diagnostics.

---

*Test suite created: September 22, 2025*
*Uses Sonnet model for cost-effective testing*
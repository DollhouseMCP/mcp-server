# Next Session: Docker CI Debug with Agents

**Priority**: CRITICAL - Blocking PR #611  
**Approach**: Multi-agent systematic debugging  
**Context**: Previous session fixed race condition but Docker CI still fails

## Starting Commands
```bash
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout fix/server-initialization-race-condition
git pull origin fix/server-initialization-race-condition

# Check current status
gh pr checks 611
gh pr view 611 --comments | tail -50
```

## Agent Architecture Required

### 🎯 Orchestrator: Opus
Coordinates the investigation and synthesizes findings.

### 🔍 Agent 1: CI Environment Analyzer
**Task**: Understand GitHub Actions Docker environment
```yaml
Focus Areas:
- How stdin/stdout is handled in GitHub Actions
- Docker run behavior in CI vs local
- Environment variables that differ
- Network/security constraints

Starting Points:
- Check GitHub Actions documentation for Docker
- Review docker-testing.yml workflow
- Compare with working workflows in other projects
```

### 🐛 Agent 2: Docker Output Debugger
**Task**: Add comprehensive debugging to capture what's really happening
```yaml
Modifications Needed:
- Add hexdump of output
- Check exit codes explicitly
- Time how long container runs
- Capture stderr separately from stdout
- Test if stdin is connected

Key File:
- .github/workflows/docker-testing.yml
```

### 🧪 Agent 3: Local vs CI Comparison
**Task**: Find the EXACT difference between local and CI
```yaml
Test Matrix:
- Local: echo | docker run -i
- Local: docker run < /dev/null
- Local: docker run with timeout
- CI: Current implementation
- CI: With explicit EOF
- CI: With timeout wrapper

Document:
- What works where
- Exact error messages
- Timing differences
```

### 🔧 Agent 4: Solution Implementer
**Task**: Test hypotheses and implement fixes
```yaml
Hypotheses to Test:
1. stdin not connected in CI
2. Container exits too quickly
3. Output not captured properly
4. Security constraints differ
5. Platform differences (linux/amd64 vs others)

For Each Hypothesis:
- Design test
- Implement change
- Document result
```

## Critical Information

### What Works (Verified)
- ✅ Race condition fixed
- ✅ Unit tests all pass
- ✅ Local Docker works perfectly
- ✅ MCP server responds correctly

### What Fails (Honest)
- ❌ Docker CI tests timeout/fail
- ❌ Don't know WHY (this is the problem)
- ❌ Security audit (API error, not our code)

### The Mystery
**Local**: 
```bash
echo '{"jsonrpc":"2.0","method":"initialize"...}' | docker run -i test-mcp
# Returns: {"result":{"serverInfo":{"name":"dollhousemcp"...}}}
```

**CI**: Same command fails to find output or times out

## Specific Debug Additions Needed

Add to docker-testing.yml:
```bash
# Before running Docker
echo "=== Environment ==="
env | grep -i docker || true
docker version
echo "=== Starting test ==="

# Capture output with debugging
docker_output=$(echo "$MCP_INIT" | \
  timeout 30 docker run -i ... 2>&1 || echo "EXIT_CODE=$?")

# Debug output
echo "=== Raw output (first 1000 chars) ==="
echo "${docker_output:0:1000}"
echo "=== Hex dump (first 200 bytes) ==="
echo "$docker_output" | head -c 200 | hexdump -C
echo "=== Output length: ${#docker_output} ==="
echo "=== Contains serverInfo: ==="
echo "$docker_output" | grep -c serverInfo || echo "0"
```

## Working Hypothesis

The Docker container in CI might be:
1. Not receiving stdin properly
2. Exiting before output is captured
3. Having output buffered differently
4. Running with different security context

## Success Criteria

1. **Identify**: The EXACT reason Docker tests fail in CI
2. **Fix**: Make Docker tests pass
3. **Document**: Why it failed and how we fixed it
4. **Verify**: All CI checks green

## Don't Do This

- ❌ Trial and error without hypothesis
- ❌ Assume things work like local
- ❌ Skip debugging output
- ❌ Give up and disable tests

## Do This Instead

- ✅ Add massive amounts of debug output
- ✅ Test each hypothesis systematically
- ✅ Use agents to parallelize
- ✅ Document every finding

## If All Else Fails

Consider:
1. Different test approach (not Docker)
2. Skip with documented reason
3. Test only on one platform
4. Use different CI service

But TRY TO FIX IT FIRST!

---
*The answer is there - we just need systematic debugging to find it*
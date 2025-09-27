# Expected Outputs and Failure Modes

## Expected Successful Outputs

### 1. Docker Build Success
**Command**: `docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .`

**Expected Output Pattern**:
```
[+] Building XXX.Xs (XX/XX) FINISHED
 => [internal] load build definition from Dockerfile.claude-testing
 => [internal] load .dockerignore
 => [base 1/X] FROM docker.io/library/node:20-slim
 => [X/X] RUN npm run build
 => exporting to image
 => => naming to docker.io/library/claude-mcp-test-env
```

**Success Indicators**:
- "Successfully built" message
- "Successfully tagged claude-mcp-test-env"
- No error messages
- Build time < 300 seconds

### 2. API Connection Success
**Command**: `echo "Say CONNECTION_TEST_SUCCESSFUL" | docker run -i --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude-mcp-test-env claude --model sonnet`

**Expected Output Pattern**:
```
CONNECTION_TEST_SUCCESSFUL
```

**Success Indicators**:
- Response contains requested text
- No authentication errors
- Response time < 30 seconds

### 3. MCP Tools Detection
**Command**: With `--mcp-config` flag

**Expected Output Pattern**:
```
Available MCP tools:
- mcp__dollhousemcp__list_elements
- mcp__dollhousemcp__activate_element
- mcp__dollhousemcp__get_active_elements
- mcp__dollhousemcp__deactivate_element
- mcp__dollhousemcp__get_element_details
[... 20+ more tools ...]
```

**Success Indicators**:
- At least 20 tools listed
- All tools prefixed with "mcp__dollhousemcp__"
- No connection errors

### 4. MCP Tool Execution
**Command**: `mcp__dollhousemcp__get_build_info`

**Expected Output Pattern**:
```
{
  "version": "1.X.X",
  "buildTime": "2025-XX-XX",
  "environment": "development",
  "nodeVersion": "20.X.X",
  "platform": "linux"
}
```

**Success Indicators**:
- Valid JSON response
- Version number present
- No JavaScript errors

### 5. List Elements Success
**Command**: `mcp__dollhousemcp__list_elements` with type "personas"

**Expected Output Pattern**:
```
Available Personas:
- alex-sterling
- creative-writer
- debug-detective
[... or ...]
No personas found in portfolio
```

**Success Indicators**:
- Either lists personas or states none found
- No errors about missing functions
- Structured output

## Expected Failure Modes and Diagnostics

### Build Failures

#### 1. TypeScript Compilation Error
**Symptom**: `sh: 1: tsc: not found`
**Cause**: Using `npm ci --only=production` instead of `npm ci`
**Fix**: Ensure Dockerfile includes dev dependencies

#### 2. Missing Dependencies
**Symptom**: `Cannot find module 'X'`
**Cause**: Package not installed or wrong version
**Fix**: Check package.json and npm install logs

#### 3. Build Context Too Large
**Symptom**: Build takes > 10 minutes or hangs
**Cause**: .dockerignore not excluding node_modules
**Fix**: Verify .dockerignore.claude-testing exists

### API Connection Failures

#### 1. Invalid API Key
**Symptom**:
```
Error: Authentication failed
Status: 401 Unauthorized
```
**Cause**: Invalid or expired API key
**Fix**: Verify ANTHROPIC_API_KEY is valid

#### 2. Rate Limit
**Symptom**:
```
Error: Rate limit exceeded
Please wait X seconds
```
**Cause**: Too many API requests
**Fix**: Wait and retry, or use different key

#### 3. Network Issues
**Symptom**:
```
Error: ECONNREFUSED
Could not connect to API
```
**Cause**: Network connectivity or firewall
**Fix**: Check internet connection and proxy settings

### MCP Integration Failures

#### 1. No Tools Detected
**Symptom**: No tools starting with "mcp__dollhousemcp"
**Cause**: Missing `--mcp-config` flag
**Fix**: Always include `--mcp-config /root/.config/claude-code/config.json`

#### 2. MCP Server Crash
**Symptom**:
```
Error: MCP server exited unexpectedly
TypeError: Cannot read property 'X' of undefined
```
**Cause**: Bug in DollhouseMCP code
**Fix**: Check MCP server logs, rebuild if needed

#### 3. Permission Denied
**Symptom**:
```
I need permission to use this tool
```
**Cause**: Tool not in --allowedTools list
**Fix**: Add tool to --allowedTools or use interactive mode

### Configuration Failures

#### 1. Missing Config File
**Symptom**: `/root/.config/claude-code/config.json: No such file`
**Cause**: Config not created during build
**Fix**: Check Dockerfile RUN commands for config creation

#### 2. Invalid JSON
**Symptom**: `SyntaxError: Unexpected token in JSON`
**Cause**: Malformed config file
**Fix**: Validate JSON syntax in Dockerfile

#### 3. Wrong Paths
**Symptom**: `Cannot find /app/dollhousemcp/dist/index.js`
**Cause**: Build didn't complete or wrong paths
**Fix**: Verify build step and file paths

## Diagnostic Commands

### Quick Health Check
```bash
# Check if everything is installed
docker run --rm claude-mcp-test-env bash -c "
  echo '=== Claude Code ===' && which claude &&
  echo '=== DollhouseMCP ===' && ls -la /app/dollhousemcp/dist/index.js &&
  echo '=== MCP Config ===' && cat /root/.config/claude-code/config.json
"
```

### MCP Server Direct Test
```bash
# Test MCP server directly (will timeout, that's OK)
timeout 3 docker run --rm claude-mcp-test-env \
  node /app/dollhousemcp/dist/index.js
```

### Check Container Logs
```bash
# Run with debug logging
docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e LOG_LEVEL="debug" \
  claude-mcp-test-env \
  claude --model sonnet --mcp-config /root/.config/claude-code/config.json
```

## Success Criteria Matrix

| Test Category | Critical | Important | Nice to Have |
|--------------|----------|-----------|--------------|
| **Build** | ✅ Completes without error | Build < 5 min | Build < 3 min |
| **Image** | ✅ All binaries present | Size < 2GB | Size < 1.5GB |
| **API** | ✅ Authenticates successfully | Response < 10s | Response < 5s |
| **MCP Detection** | ✅ Finds any tools | ≥20 tools | All 29 tools |
| **Tool Execution** | ✅ One tool works | Multiple tools | All tools work |
| **Permissions** | ✅ No unauthorized access | Clear prompts | Batch approval |
| **Error Handling** | ✅ No crashes | Clear messages | Helpful hints |

## Minimum Viable Test

For absolute minimum verification, these THREE tests must pass:

1. **Build Success**
   ```bash
   docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-mcp-test-env .
   ```
   Must complete without errors.

2. **API Works**
   ```bash
   echo "Say WORKING" | docker run -i --rm \
     -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
     claude-mcp-test-env claude --model sonnet
   ```
   Must return "WORKING".

3. **MCP Tool Executes**
   ```bash
   echo "Use mcp__dollhousemcp__get_build_info" | docker run -i --rm \
     -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
     claude-mcp-test-env \
     claude --model sonnet \
     --mcp-config /root/.config/claude-code/config.json \
     --allowedTools mcp__dollhousemcp__get_build_info
   ```
   Must return version information.

If these three pass, the system is functional.

---

*This document defines expected outputs for verification testing.*
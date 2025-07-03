# Docker Testing Troubleshooting Guide - July 3, 2025

## Current Issue Summary

**Status**: Docker Testing workflow failing consistently after PR #22 merge  
**Symptom**: Multi-architecture Docker builds and container tests failing  
**Impact**: 1 of 6 workflows not functional, blocking complete CI/CD coverage  

## Failure Evidence

### GitHub Actions Failures
```
❌ Docker Build & Test (linux/amd64)    fail  16s
❌ Docker Build & Test (linux/arm64)    fail  13s  
❌ Docker Compose Test                  fail   6s
```

### Working Workflows (For Reference)
```
✅ Test (macos-latest, Node 20.x)      pass  18s
✅ Test (ubuntu-latest, Node 20.x)     pass  21s  
✅ Test (windows-latest, Node 20.x)    pass  1m8s
✅ Validate Build Artifacts           pass  19s
✅ claude-review                      pass  2m4s (scored 9.25/10)
```

## Investigation Commands

### Check Recent Workflow Logs
```bash
# Get latest Docker Testing workflow run
gh run list --workflow="Docker Testing" --limit 3

# View specific failed run logs
gh run view <run-id> --log-failed

# Check all recent runs for patterns
gh run list --limit 10 | grep -i docker
```

### Local Docker Testing
```bash
# Test basic Docker build
docker build -t dollhousemcp:test .

# Test with specific platform
docker buildx build --platform linux/amd64 -t dollhousemcp:amd64 .
docker buildx build --platform linux/arm64 -t dollhousemcp:arm64 .

# Test container startup
docker run -d --name test-container dollhousemcp:test
docker logs test-container
docker exec test-container node -e "console.log('Container responsive')"

# Test health check
docker inspect test-container --format='{{.State.Health.Status}}'

# Cleanup
docker stop test-container && docker rm test-container
```

### Debug MCP Server in Container
```bash
# Interactive container testing
docker run -it dollhousemcp:test /bin/sh

# Inside container:
ls -la /app/
ls -la /app/dist/
ls -la /app/personas/
node --version
npm --version
node /app/dist/index.js
```

## Potential Root Causes

### 1. Container Build Issues
- **Missing dependencies** in Alpine Linux base image
- **File permissions** preventing proper operation
- **Build context** missing required files
- **Multi-stage build** issues between builder and production stages

### 2. MCP Server Runtime Issues
- **Path resolution** problems in containerized environment
- **Personas directory** not accessible or missing
- **Node.js module** loading issues in container
- **Environment variables** not properly set

### 3. Health Check Problems
- **Health check command** failing in container context
- **Timeout values** too short for container startup
- **Python dependency** not available for health parsing
- **Container networking** preventing health validation

### 4. Multi-Architecture Issues
- **ARM64 builds** failing due to platform-specific problems
- **Cross-compilation** issues with Node.js or dependencies
- **Platform-specific paths** or configurations
- **Docker Buildx** configuration problems

## Troubleshooting Steps

### Step 1: Basic Build Validation
```bash
# Verify Dockerfile syntax and build process
docker build --no-cache -t dollhousemcp:debug .

# Check build stages individually
docker build --target builder -t dollhousemcp:builder .
docker build --target production -t dollhousemcp:production .
```

### Step 2: Container Environment Validation
```bash
# Test container file structure
docker run --rm dollhousemcp:debug ls -la /app/
docker run --rm dollhousemcp:debug ls -la /app/dist/
docker run --rm dollhousemcp:debug cat /app/package.json

# Test Node.js environment
docker run --rm dollhousemcp:debug node --version
docker run --rm dollhousemcp:debug npm list
```

### Step 3: MCP Server Testing
```bash
# Test MCP server module loading
docker run --rm dollhousemcp:debug node -e "require('/app/dist/index.js')"

# Test with personas directory
docker run --rm dollhousemcp:debug node -e "
const fs = require('fs');
console.log('Personas dir:', fs.readdirSync('/app/personas/'));
"
```

### Step 4: Health Check Validation
```bash
# Test health check command directly
docker run --rm dollhousemcp:debug node -e "console.log('healthy')"

# Test with actual health check from Dockerfile
docker run --rm dollhousemcp:debug sh -c "node -e \"console.log('Health check passed')\" || exit 1"
```

## Common Fixes

### Missing Dependencies
```dockerfile
# Add to Dockerfile if needed
RUN apk add --no-cache \
    python3 \
    py3-pip \
    build-base
```

### File Permissions
```dockerfile
# Ensure proper ownership
COPY --chown=dollhouse:nodejs . .
RUN chown -R dollhouse:nodejs /app
```

### Path Resolution
```typescript
// In src/index.ts, use absolute paths
const personasDir = process.env.PERSONAS_DIR || path.join(__dirname, '..', 'personas');
```

### Health Check Robustness
```dockerfile
# Simpler health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
```

## Workflow Configuration Issues

### Timeout Adjustments
```yaml
# In docker-testing.yml, increase timeouts if needed
timeout-minutes: 20  # Instead of 15

# Container startup wait time
sleep 15  # Instead of 10
```

### Platform-Specific Handling
```yaml
# Add platform-specific conditionals
- name: Platform-specific setup
  if: matrix.platform == 'linux/arm64'
  run: |
    echo "ARM64-specific configuration"
```

## Expected File Structure in Container

```
/app/
├── dist/
│   ├── index.js         # Compiled MCP server
│   └── index.d.ts       # TypeScript declarations
├── personas/
│   ├── creative-writer.md
│   ├── technical-analyst.md
│   └── ...
├── package.json
├── package-lock.json
└── node_modules/        # Production dependencies only
```

## Success Criteria

### Container Build Success
- ✅ Docker build completes without errors
- ✅ Multi-stage build produces correct artifacts
- ✅ File permissions and ownership correct
- ✅ All required dependencies installed

### Container Runtime Success
- ✅ Container starts without immediate exit
- ✅ MCP server loads and initializes
- ✅ Personas directory accessible
- ✅ Health check passes consistently

### Multi-Architecture Success
- ✅ Both AMD64 and ARM64 builds successful
- ✅ Cross-platform compatibility validated
- ✅ No platform-specific runtime issues

## Next Steps After Fix

1. **Test locally** to ensure fix works
2. **Create small PR** with targeted fix
3. **Monitor workflow** for consistent success
4. **Proceed with minor improvements** from Claude Code review
5. **Enable branch protection** once all workflows stable

---

**Created**: July 3, 2025  
**Purpose**: Guide for resolving Docker Testing workflow failures  
**Status**: Investigation required - multiple potential root causes identified
# Lessons Learned: Docker CI Debugging Session

**Date**: August 16, 2025  
**Time Investment**: ~8 hours across multiple sessions  
**Result**: Identified 4 separate issues, fixed 3, narrowed down the 4th

## Key Lessons

### 1. Tests Should Actually Test Functionality
**Problem**: Docker tests were just checking if container started, not if MCP worked  
**Lesson**: Always verify tests are testing what you think they're testing  
**Action**: Added actual MCP command testing to Docker tests

### 2. One Fix Can Reveal Hidden Issues
**Pattern**: Race condition fix → Portfolio issue → Path mismatch → Cache issue  
**Lesson**: Fixing fundamental issues often exposes other problems  
**Approach**: Be prepared for cascading discoveries

### 3. Local ≠ CI Environment
**Discovery**: Environment variables behave differently in GitHub Actions  
**Lesson**: Never assume CI mirrors local Docker exactly  
**Solution**: Add fallback detection for CI-specific behavior

### 4. Read-Only Filesystems Are Tricky
**Issues Found**:
- Portfolio directory creation
- Cache directory creation
- Temp file creation
- Log file writes

**Lesson**: Audit ALL filesystem writes when using read-only mode  
**Best Practice**: Explicitly configure all writable paths

### 5. Multi-Agent Approach Works Well
**What Worked**:
- Parallel investigation by specialized agents
- Coordination document kept everyone aligned
- UltraThink agent for deep analysis
- Implementation agents for coding

**Improvement**: Start with coordination document immediately

### 6. Document As You Go
**Benefits**:
- Easy to resume after interruptions
- Other team members can pick up work
- Prevents re-discovering same issues
- Creates knowledge base for future

**Key Documents Created**:
- Coordination document (central tracking)
- Session documents (detailed history)
- Quick start guide (rapid resumption)

## Technical Insights

### Docker Environment Variables
```bash
# What we expected to work
ENV DOLLHOUSE_CACHE_DIR=/app/tmp/cache

# What actually happens in CI
# Environment variable doesn't propagate to Node.js process
# Need fallback detection
```

### Filesystem Hierarchy in Docker
```
/app/             # Read-only
├── dist/         # Application code (read-only)
├── node_modules/ # Dependencies (read-only)
└── tmp/          # Writable (tmpfs mount)
    ├── portfolio/  # Portfolio directory
    └── cache/      # Cache directory
```

### Security Constraints Impact
- `--user 1001:1001`: Non-root user
- `--read-only`: Filesystem read-only except tmpfs
- `--no-new-privileges`: Security hardening
- `--memory 512m`: Memory limits
- `--cpus 0.5`: CPU limits

Each constraint can cause different failures!

## What We Should Have Done Differently

### 1. Started with Comprehensive Logging
Add debug output FIRST, not after multiple failures:
```typescript
logger.info(`Environment: ${JSON.stringify(process.env)}`);
logger.info(`Writable paths: ${this.findWritablePaths()}`);
```

### 2. Tested CI-Like Environment Locally
```bash
# Simulate CI constraints locally
docker run --read-only --user 1001:1001 --tmpfs /tmp --tmpfs /app/tmp ...
```

### 3. Questioned Assumptions Earlier
- Assumed env vars work the same everywhere
- Assumed local Docker = CI Docker
- Assumed one fix would solve everything

### 4. Used Binary Search for Issues
Instead of fixing sequentially, could have:
1. Disabled all constraints
2. Added them back one by one
3. Found exact constraint causing failure

## Reusable Patterns

### Pattern 1: Environment Detection
```typescript
const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/app');
const isCI = process.env.CI === 'true';
const isReadOnly = !this.canWrite(process.cwd());
```

### Pattern 2: Fallback Directories
```typescript
const dirs = [
  process.env.CUSTOM_DIR,
  '/app/tmp/component',
  '/tmp/component',
  path.join(os.tmpdir(), 'component'),
  path.join(process.cwd(), '.component')
].filter(Boolean);

for (const dir of dirs) {
  if (await this.tryCreateDir(dir)) {
    return dir;
  }
}
```

### Pattern 3: Graceful Degradation
```typescript
try {
  await this.initializeCache();
} catch (error) {
  logger.warn('Cache unavailable, continuing without cache');
  this.cacheEnabled = false;
}
```

## For Future Docker Debugging

### Checklist
- [ ] Add comprehensive logging first
- [ ] Test with exact CI constraints locally
- [ ] Check ALL components for filesystem writes
- [ ] Verify environment variables are propagating
- [ ] Test with minimal example first
- [ ] Document each finding immediately
- [ ] Use coordination document for complex issues
- [ ] Consider CI-specific behavior

### Quick Debug Commands
```bash
# Check what's writable
docker run --rm IMAGE find / -type d -writable 2>/dev/null

# Check environment variables
docker run --rm IMAGE env | grep DOLLHOUSE

# Test with CI constraints
docker run --read-only --user 1001:1001 --tmpfs /tmp IMAGE

# Monitor in real-time
docker run IMAGE 2>&1 | tee docker.log
```

## Success Metrics

- **Issues Identified**: 4
- **Issues Fully Fixed**: 2
- **Issues Partially Fixed**: 2
- **Time to First Fix**: 1 hour
- **Time to Root Cause**: 4 hours
- **Documentation Created**: 7 files
- **Commits Made**: 5
- **Learning Value**: High

## Final Thoughts

This was a challenging debugging session that revealed multiple layered issues. The key success factors were:
1. Systematic investigation
2. Multi-agent approach
3. Comprehensive documentation
4. Incremental progress
5. Not giving up!

The session demonstrates that complex CI issues often have multiple causes and require patience and methodical debugging to resolve.

---

*These lessons will help future debugging sessions be more efficient and effective.*
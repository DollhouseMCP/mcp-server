# v1.9.13 Memory Fixes - Docker Integration Tests

Automated Docker-based testing for v1.9.13 memory system fixes.

## What This Tests

### Fix #1: Security Scanner False Positives
- Creates `test-security-docs.yaml` with security terminology
- Terms: "vulnerability", "exploit", "attack vector", "security hotspot"
- **Expected**: Memory activates successfully (old code would fail)

### Fix #2: Silent Error Reporting
- Monitors logs for failed load warnings
- **Expected**: Clear error messages if any loads fail

### Fix #3: Legacy Memory Migration
- Creates `legacy-test.md` in root (old format)
- Runs migration tool in dry-run mode
- **Expected**: Tool detects file and shows migration plan

## Usage

### Quick Test
```bash
# Set your API key
export ANTHROPIC_API_KEY="your-key-here"

# Run tests
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml up --build

# View results
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml logs
```

### Cleanup
```bash
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml down -v
```

### Interactive Testing
```bash
# Run container interactively
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml run v1913-test /bin/bash

# Then inside container:
/home/claude/test-v1913-fixes.sh
```

## Expected Output

### Test 1 (Security False Positive)
```
✅ SUCCESS: Memory 'test-security-docs' activated
```

### Test 2 (Error Reporting)
```
[WARN] Failed to load 0 memories (or specific error details)
```

### Test 3 (Migration Tool)
```
Found 1 legacy files:
✅ legacy-test.md
   Migrated frontmatter+markdown
   → /home/claude/.dollhouse/portfolio/memories/2025-08-01/legacy-test.yaml
```

## Troubleshooting

### Container fails to start
- Check: `docker logs dollhouse-v1913-memory-test`
- Verify: ANTHROPIC_API_KEY is set

### Tests fail
- Check build logs: `docker-compose logs v1913-test`
- Inspect portfolio: `docker run -it dollhouse-v1913-memory-test ls -la /home/claude/.dollhouse/portfolio/memories/`

### Need to iterate
```bash
# Rebuild with latest code
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml build --no-cache

# Run again
docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml up
```

## Integration with CI

Can be added to GitHub Actions:
```yaml
- name: Test v1.9.13 Memory Fixes
  run: |
    docker-compose -f test/docker-v1913-memory-fixes/docker-compose.yml up --exit-code-from v1913-test
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Notes

- Uses feature branch code (not NPM package)
- Isolated environment (own volumes, network)
- Can run parallel with other tests
- Logs preserved in named volume for analysis
# Performance Calibration - Quick Start Guide

> Predict CI performance from local benchmarks using Docker resource constraints.

## TL;DR

```bash
# One-time setup: Establish calibration baseline
npm run calibration:compare

# Daily use: Run local benchmarks
npm run calibration:local

# View predictions: Check report
cat calibration-results/comparison-report.md
```

## The Problem

Your MacBook Pro has 8 cores and 32GB RAM. GitHub Actions ubuntu-latest has 2 cores and 7GB RAM.

**Local benchmark**: 1000ms ⚡
**CI benchmark**: ???ms ❓

You can't predict CI performance from local results.

## The Solution

Run benchmarks in **two environments**:

1. **Local** (unconstrained): Full machine resources
2. **Docker CI simulation** (constrained): 2 CPUs, 7GB RAM

Compare results, get a **ratio** (e.g., 2.5x), then use it to predict:

```
Local: 500ms → CI prediction: 500ms × 2.5 = 1250ms
```

## Quick Start

### Step 1: Run Comparison (One-Time)

```bash
npm run calibration:compare
```

This will:
1. Run benchmarks locally (fast, full resources)
2. Build Docker image with CI constraints
3. Run benchmarks in Docker (slow, 2 CPU, 7GB RAM)
4. Calculate ratios and generate report

**Time**: 5-10 minutes (first run builds Docker image)

**Output**:
```
calibration-results/
  calibration-local-latest.json
  calibration-ci-simulation-latest.json
  comparison-latest.json
  comparison-report.md  ← Read this!
```

### Step 2: Read the Report

```bash
cat calibration-results/comparison-report.md
```

Look for:
```markdown
## Summary
- **Duration Ratio**: 2.35x (CI vs Local)
- **Prediction Confidence**: high

## Performance Predictions
When you run a benchmark locally and it takes **1000ms**, you can expect:
- **CI Duration**: 2350ms
```

**Remember this ratio**: 2.35x

### Step 3: Use for Predictions

Run local benchmarks:
```bash
npm run calibration:local
```

View results:
```bash
cat calibration-results/calibration-local-latest.json
```

Calculate prediction:
```
Local duration: 1500ms
Ratio: 2.35x
CI prediction: 1500ms × 2.35 = 3525ms
```

If prediction is acceptable, push your code!

## Daily Workflow

### During Development

```bash
# Make changes to code
vim src/performance-critical-module.ts

# Run local benchmark (fast)
npm run calibration:local

# Check duration
# Local: 800ms → CI prediction: 800ms × 2.35 = 1880ms

# Acceptable! Keep coding.
```

### Before Opening PR

```bash
# Validate in Docker CI simulation (optional)
npm run calibration:docker

# Confirms your prediction was accurate
# If results differ significantly, re-run calibration:compare
```

### When to Re-Calibrate

Run `npm run calibration:compare` again when:
- ✅ Upgrading Node.js version
- ✅ Major dependency updates (TypeScript, Jest, etc.)
- ✅ Hardware changes (new laptop)
- ✅ Monthly/quarterly maintenance
- ❌ Every PR (overkill)

## Understanding Results

### Confidence Levels

**High confidence** (variance < 0.2):
- Ratios consistent across metrics
- Predictions reliable
- Trust the numbers

**Medium confidence** (variance 0.2-0.5):
- Some variance between metrics
- Use as rough estimate
- Consider 20% margin of error

**Low confidence** (variance > 0.5):
- High variance
- Use cautiously
- May need to re-calibrate

### Platform Accuracy

| Platform | Accuracy | Use Case |
|----------|----------|----------|
| ubuntu-latest | 85-95% | Production predictions |
| macos-latest | 60-75% | Rough estimates only |
| windows-latest | 60-75% | Rough estimates only |

**Why**: Docker can only simulate Linux. macOS/Windows simulations approximate resources but not OS behavior.

## Common Scenarios

### Scenario 1: Performance Regression

```bash
# Before changes
npm run calibration:local
# Duration: 1200ms → CI: ~2820ms ✅

# After changes
npm run calibration:local
# Duration: 2500ms → CI: ~5875ms ⚠️

# Action: Optimize before pushing
```

### Scenario 2: Validating Optimization

```bash
# Baseline
npm run calibration:local
# Duration: 3000ms → CI: ~7050ms

# After optimization
npm run calibration:local
# Duration: 1500ms → CI: ~3525ms ✅

# 50% improvement! Ready to ship.
```

### Scenario 3: Setting Performance Budgets

```bash
# Team decision: CI benchmarks must stay under 10 seconds
# Ratio: 2.5x
# Local budget: 10000ms / 2.5 = 4000ms

# Test
npm run calibration:local
# Duration: 3200ms → CI: ~8000ms ✅ Under budget
```

## Troubleshooting

### "Docker not found"

Install Docker Desktop:
- macOS: https://docs.docker.com/desktop/install/mac-install/
- Windows: https://docs.docker.com/desktop/install/windows-install/
- Linux: https://docs.docker.com/engine/install/

### "Results don't match CI"

1. **Check calibration age**: Re-run if > 1 month old
2. **Check Node version**: Must match CI (Node 20.x)
3. **Check dependencies**: `rm -rf node_modules && npm ci`
4. **Accept variance**: 10-20% difference is normal

### "Low confidence warning"

Causes:
- Background processes consuming resources
- System under load during calibration
- Docker not allocated enough resources

Fix:
1. Close other applications
2. Increase Docker memory (Docker Desktop > Settings > Resources)
3. Re-run: `npm run calibration:compare`

### "Docker build fails"

```bash
# Clean and rebuild
npm run calibration:clean
npm run calibration:build
```

## Advanced Usage

### Run Specific Platform

```bash
# Ubuntu (default)
npm run calibration:docker

# macOS approximation
./scripts/run-calibration.sh docker --platform=macos

# Windows approximation
./scripts/run-calibration.sh docker --platform=windows
```

### Compare All Platforms

```bash
docker compose -f docker/docker-compose.calibration.yml \
  --profile comparison-all \
  up --remove-orphans
```

### View Raw Data

```bash
# JSON format for scripting
cat calibration-results/comparison-latest.json | jq '.ratios'

# Output:
# {
#   "durationRatio": 2.35,
#   "memoryRatio": 1.42,
#   "throughputRatio": 0.43
# }
```

### Clean Up

```bash
# Remove all calibration results
npm run calibration:clean

# Remove Docker images
docker compose -f docker/docker-compose.calibration.yml down --rmi all
```

## Integration with CI

### Add to PR Template

```markdown
## Performance Impact

- [ ] Ran local calibration: `npm run calibration:local`
- Local duration: XXXXms
- Predicted CI: XXXXms (ratio: 2.35x)
- Under 10s budget: ✅/❌
```

### Pre-commit Hook (Optional)

```bash
# .git/hooks/pre-commit
npm run calibration:local

DURATION=$(jq '.suite.summary.totalDuration' calibration-results/calibration-local-latest.json)
PREDICTED=$((DURATION * 235 / 100))  # 2.35x ratio

if [ $PREDICTED -gt 10000 ]; then
  echo "⚠️ Performance budget exceeded: ${PREDICTED}ms > 10000ms"
  exit 1
fi
```

## Files and Commands Reference

### Files Created

```
docker/
  Dockerfile.ci-simulation           # Multi-stage Docker build
  docker-compose.calibration.yml    # Resource-constrained services

tests/calibration/
  types.ts                          # Interfaces and types
  CalibrationBenchmark.ts           # Three benchmark classes
  run-local.ts                      # Run locally
  run-docker.ts                     # Run in Docker
  compare-results.ts                # Compare and generate report

scripts/
  run-calibration.sh                # CLI wrapper

calibration-results/              # Generated (gitignored)
  calibration-local-latest.json
  calibration-ci-simulation-latest.json
  comparison-latest.json
  comparison-report.md
```

### NPM Commands

| Command | Description | Time |
|---------|-------------|------|
| `npm run calibration:local` | Run local benchmarks | 30s-2min |
| `npm run calibration:docker` | Run Docker CI simulation | 2-5min |
| `npm run calibration:compare` | Run both + compare | 5-10min |
| `npm run calibration:build` | Build Docker images | 2-5min |
| `npm run calibration:clean` | Remove results | <1s |

### Script Commands

```bash
./scripts/run-calibration.sh local       # Same as npm run calibration:local
./scripts/run-calibration.sh docker      # Same as npm run calibration:docker
./scripts/run-calibration.sh compare     # Same as npm run calibration:compare
./scripts/run-calibration.sh build       # Build images
./scripts/run-calibration.sh clean       # Clean results
./scripts/run-calibration.sh help        # Show usage
```

## When NOT to Use This

❌ **OS-specific bugs**: Use actual CI (Docker simulates Linux only)
❌ **Network operations**: Benchmarks should be CPU/memory bound
❌ **External integrations**: Use actual CI for API calls
❌ **Security testing**: Use actual CI for clean environment

✅ **CPU-intensive operations**: Excellent accuracy
✅ **Memory pressure testing**: Very good accuracy
✅ **Algorithm performance**: Great for comparisons
✅ **Quick iteration**: Much faster than waiting for CI

## Example: Real Workflow

```bash
# Monday: Start new feature
git checkout -b feature/new-search-algorithm

# Tuesday: Implement feature
vim src/portfolio/UnifiedIndexManager.ts

# Run local benchmark
npm run calibration:local
# Result: 2800ms → CI: ~6580ms (ratio 2.35x)
# Too slow! Optimize.

# Wednesday: Optimize
vim src/portfolio/UnifiedIndexManager.ts

npm run calibration:local
# Result: 1200ms → CI: ~2820ms ✅
# Much better!

# Validate in Docker (optional)
npm run calibration:docker
# Result: 2750ms (close to prediction!)

# Thursday: Open PR
git push
gh pr create

# PR runs CI: actual result 2890ms
# Within 5% of prediction ✅
```

## Summary

**Core concept**: Local benchmarks × Calibration ratio = CI prediction

**One-time setup**: `npm run calibration:compare`

**Daily use**: `npm run calibration:local` + mental math

**Re-calibrate**: Monthly or after major changes

**Accuracy**: 85-95% for ubuntu-latest

**Time saved**: 10-20 minutes per iteration by avoiding CI round-trips

**Result**: Faster development, fewer CI failures, more confidence

---

**Start now**: `npm run calibration:compare`

Full documentation: [`docs/developer-guide/performance-calibration.md`](./performance-calibration.md)

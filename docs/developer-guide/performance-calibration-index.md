# Performance Calibration System - Documentation Index

> Navigate the complete documentation for the Docker-based CI simulation and performance calibration system.

## Quick Navigation

**Just getting started?** → [Quick Start Guide](./performance-calibration-quickstart.md)

**Need full details?** → [Comprehensive Guide](./performance-calibration.md)

**Want technical depth?** → [Design Document](../architecture/performance-calibration-design.md)

**Visual learner?** → [Workflow Diagrams](../diagrams/calibration-workflow.md)

**Executive summary?** → [System Summary](../../CALIBRATION_SYSTEM_SUMMARY.md)

## Documentation Structure

```
performance-calibration/
├── 📖 Quick Start (11KB)
│   └── performance-calibration-quickstart.md
│       • TL;DR for busy developers
│       • 3-step setup
│       • Common scenarios
│       • Troubleshooting
│
├── 📚 Comprehensive Guide (19KB)
│   └── performance-calibration.md
│       • Full architecture explanation
│       • Docker configuration details
│       • Accuracy expectations
│       • Workflow integration
│       • Best practices
│
├── 🔬 Design Document (26KB)
│   └── ../architecture/performance-calibration-design.md
│       • Technical deep dive
│       • Design decisions and rationale
│       • Alternatives considered
│       • Implementation checklist
│       • Future enhancements
│
├── 📊 Workflow Diagrams
│   └── ../diagrams/calibration-workflow.md
│       • Visual architecture
│       • Data flow diagrams
│       • Decision trees
│       • Timeline comparisons
│
└── 📋 System Summary
    └── ../../CALIBRATION_SYSTEM_SUMMARY.md
        • Executive summary
        • What was built
        • Deliverables checklist
        • Next steps
```

## Documentation by Persona

### For Developers (Daily Users)

**Read first**:
1. [Quick Start Guide](./performance-calibration-quickstart.md) (5 min read)
   - Minimum viable usage
   - One-time setup
   - Daily workflow
   - Command reference

**Bookmark for reference**:
2. [Comprehensive Guide](./performance-calibration.md) - Section: "Usage Examples"
3. [Quick Start](./performance-calibration-quickstart.md) - Section: "Troubleshooting"

**Commands you'll use**:
```bash
npm run calibration:local     # Daily iteration
npm run calibration:compare   # Monthly recalibration
```

---

### For Tech Leads (Decision Makers)

**Read first**:
1. [System Summary](../../CALIBRATION_SYSTEM_SUMMARY.md) (10 min read)
   - Executive summary
   - Success metrics
   - ROI analysis
   - Next steps

**Deep dive**:
2. [Design Document](../architecture/performance-calibration-design.md) - Sections:
   - "Design Decisions"
   - "Accuracy vs. Complexity"
   - "Alternatives Considered"

**Key metrics**:
- Accuracy: 85-95% for ubuntu-latest
- Time saved: 10-20 minutes per iteration
- CI minutes saved: ~200 minutes/month

---

### For Architects (System Designers)

**Read first**:
1. [Design Document](../architecture/performance-calibration-design.md) (30 min read)
   - Complete technical specification
   - Design rationale
   - Trade-off analysis
   - Future roadmap

**Visual understanding**:
2. [Workflow Diagrams](../diagrams/calibration-workflow.md)
   - Architecture diagrams
   - Data flow visualization
   - Docker constraint mechanism

**Key decisions**:
- Why Docker? (vs. VMs, cloud testing, manual limits)
- Why skip disk I/O? (diminishing returns, 60-70% accuracy)
- Why "close enough"? (85% accuracy is practical)

---

### For DevOps Engineers (CI/CD Integration)

**Read first**:
1. [Comprehensive Guide](./performance-calibration.md) - Sections:
   - "Docker Configuration"
   - "Resource Constraint Strategy"
   - "Workflow Integration"

**Implementation**:
2. [Design Document](../architecture/performance-calibration-design.md) - Section:
   - "Future Enhancements" → "GitHub Actions Integration"

**Files to configure**:
- `docker/docker-compose.calibration.yml` - Resource constraints
- `.github/workflows/performance-regression.yml` - CI integration (future)

---

## Documentation by Task

### Task: Set Up Calibration (First Time)

**Read**:
- [Quick Start Guide](./performance-calibration-quickstart.md) - Section: "Quick Start"

**Run**:
```bash
npm run calibration:compare
```

**Verify**:
```bash
cat calibration-results/comparison-report.md
```

---

### Task: Use Calibration Daily

**Read**:
- [Quick Start Guide](./performance-calibration-quickstart.md) - Section: "Daily Workflow"

**Run**:
```bash
npm run calibration:local
```

**Predict**:
```
Local: XXXms × Ratio = CI prediction
```

---

### Task: Troubleshoot Issues

**Read**:
- [Quick Start Guide](./performance-calibration-quickstart.md) - Section: "Troubleshooting"
- [Comprehensive Guide](./performance-calibration.md) - Section: "Troubleshooting"

**Common issues**:
- Docker not found → Install Docker Desktop
- Results don't match → Re-run calibration
- Low confidence → Close other apps, re-run

---

### Task: Integrate with CI/CD

**Read**:
- [Comprehensive Guide](./performance-calibration.md) - Section: "Workflow Integration"
- [Design Document](../architecture/performance-calibration-design.md) - Section: "Future Enhancements"

**Example workflows**:
- Pre-commit hooks
- PR templates
- GitHub Actions (future)

---

### Task: Understand Accuracy Limitations

**Read**:
- [Design Document](../architecture/performance-calibration-design.md) - Sections:
  - "Limitations and Accuracy Expectations"
  - "What Docker CAN/CANNOT Simulate"

**Key takeaways**:
- ✅ CPU: 95%+ accuracy
- ✅ Memory: 90%+ accuracy
- ⚠️ Disk I/O: 60-70% accuracy
- ❌ OS-specific: Variable

---

## Key Concepts Explained

### Calibration Ratio

**What it is**: Multiplier that converts local performance to CI prediction.

**Example**:
```
Duration Ratio: 2.35x
Local: 1000ms → CI: 1000ms × 2.35 = 2350ms
```

**Where to find**: `calibration-results/comparison-report.md`

**Learn more**: [Quick Start](./performance-calibration-quickstart.md) - Section: "Understanding Results"

---

### Confidence Level

**What it is**: Reliability indicator for predictions (high/medium/low).

**Based on**: Consistency of ratios across different metrics.

**Interpretation**:
- **High**: Trust predictions (variance < 0.2)
- **Medium**: Use with caution (variance 0.2-0.5)
- **Low**: Re-calibrate (variance > 0.5)

**Learn more**: [Comprehensive Guide](./performance-calibration.md) - Section: "Understanding Results"

---

### Resource Constraints

**What they are**: Docker limits that simulate GitHub Actions runner specs.

**Configuration**:
```yaml
cpus: '2.0'           # 2-core CPU
mem_limit: 7g         # 7GB RAM
memswap_limit: 7g     # No swap
```

**Learn more**: [Design Document](../architecture/performance-calibration-design.md) - Section: "Resource Constraint Strategy"

---

### CI Simulation vs. Actual CI

**Simulation (Docker)**:
- Fast (2-5 minutes)
- Good accuracy (85-95%)
- Iterative development
- Cannot simulate OS differences

**Actual CI**:
- Slow (10-20 minutes)
- Perfect accuracy (source of truth)
- Final validation
- Platform-specific testing

**Learn more**: [Design Document](../architecture/performance-calibration-design.md) - Section: "When to Use Docker vs. When to Use CI"

---

## Command Reference

### NPM Scripts

| Command | Description | Time | When to Use |
|---------|-------------|------|-------------|
| `npm run calibration:local` | Run local benchmarks | 30s-2min | Daily iteration |
| `npm run calibration:docker` | Run Docker CI simulation | 2-5min | Validate predictions |
| `npm run calibration:compare` | Run both + compare | 5-10min | Establish baseline |
| `npm run calibration:build` | Build Docker images | 2-5min | First time / updates |
| `npm run calibration:clean` | Remove results | <1s | Clean slate |

**Learn more**: [Quick Start](./performance-calibration-quickstart.md) - Section: "Files and Commands Reference"

---

### Shell Script Commands

```bash
./scripts/run-calibration.sh local       # Same as npm run calibration:local
./scripts/run-calibration.sh docker      # Same as npm run calibration:docker
./scripts/run-calibration.sh compare     # Same as npm run calibration:compare
./scripts/run-calibration.sh build       # Build images
./scripts/run-calibration.sh clean       # Clean results
./scripts/run-calibration.sh help        # Show usage

# Advanced: Specific platform
./scripts/run-calibration.sh docker --platform=macos
./scripts/run-calibration.sh docker --platform=windows
```

**Learn more**: [Comprehensive Guide](./performance-calibration.md) - Section: "Usage Examples"

---

## File Locations

### Source Code

```
docker/
  Dockerfile.ci-simulation           # Docker build configuration
  docker-compose.calibration.yml     # Resource constraints

tests/calibration/
  types.ts                          # Type definitions
  CalibrationBenchmark.ts           # Three benchmark classes
  run-local.ts                      # Run locally
  run-docker.ts                     # Run in Docker
  compare-results.ts                # Compare and generate report

scripts/
  run-calibration.sh                 # CLI wrapper
```

### Generated Results

```
calibration-results/                 # Created on first run (gitignored)
  calibration-local-latest.json      # Local benchmark results
  calibration-ci-simulation-latest.json  # CI simulation results
  comparison-latest.json             # Ratios and predictions
  comparison-report.md               # Human-readable report
```

### Documentation

```
docs/
  developer-guide/
    performance-calibration-quickstart.md  # Quick start (11KB)
    performance-calibration.md             # Comprehensive guide (19KB)
    performance-calibration-index.md       # This file

  architecture/
    performance-calibration-design.md      # Design document (26KB)

  diagrams/
    calibration-workflow.md                # Visual diagrams

CALIBRATION_SYSTEM_SUMMARY.md              # Executive summary
```

---

## Learning Path

### Beginner Path (30 minutes)

1. Read: [Quick Start Guide](./performance-calibration-quickstart.md) (10 min)
2. Run: `npm run calibration:compare` (10 min)
3. Explore: `calibration-results/comparison-report.md` (5 min)
4. Practice: `npm run calibration:local` (5 min)

**Outcome**: Can use calibration for daily development.

---

### Intermediate Path (1 hour)

1. Complete: Beginner Path (30 min)
2. Read: [Comprehensive Guide](./performance-calibration.md) - Sections:
   - "Architecture" (10 min)
   - "Usage Examples" (10 min)
   - "Troubleshooting" (10 min)

**Outcome**: Understand system deeply, can troubleshoot issues.

---

### Advanced Path (2 hours)

1. Complete: Intermediate Path (1 hour)
2. Read: [Design Document](../architecture/performance-calibration-design.md) (45 min)
3. Review: [Workflow Diagrams](../diagrams/calibration-workflow.md) (15 min)

**Outcome**: Can extend system, integrate with CI/CD, make architectural decisions.

---

## FAQ Quick Links

**Q: How accurate are predictions?**
→ [Design Document](../architecture/performance-calibration-design.md) - Section: "Accuracy Matrix"
- ubuntu-latest: 85-95%
- macOS/Windows: 60-75% (approximations)

**Q: When should I re-calibrate?**
→ [Comprehensive Guide](./performance-calibration.md) - Section: "Best Practices"
- After Node.js upgrades
- After major dependency changes
- Monthly/quarterly

**Q: Can I simulate macOS/Windows?**
→ [Design Document](../architecture/performance-calibration-design.md) - Section: "Platform Simulations"
- No true simulation (licensing)
- Resource approximation only
- 60-75% accuracy

**Q: What about disk I/O?**
→ [Design Document](../architecture/performance-calibration-design.md) - Section: "Why Disk I/O is Hard"
- Skipped due to low accuracy (60-70%)
- Docker throttling insufficient
- Focus on CPU/memory (80% of impact)

**Q: How much time does this save?**
→ [System Summary](../../CALIBRATION_SYSTEM_SUMMARY.md) - Section: "Success Metrics"
- Per iteration: 10-20 minutes
- Per month: ~200 CI minutes saved

---

## Feedback and Contributions

**Found an issue?** Open a GitHub issue with:
- Which document
- What's unclear/incorrect
- Suggested improvement

**Want to improve?** Submit a PR with:
- Documentation updates
- Additional examples
- Workflow improvements

**Have questions?** Ask in:
- Team Slack: #performance-engineering
- GitHub Discussions: DollhouseMCP/mcp-server

---

## Version History

- **v1.0.0** (2025-11-13): Initial implementation
  - Docker-based CI simulation
  - Calibration ratio system
  - Complete documentation suite

---

## Related Documentation

- [Architecture Overview](../architecture/overview.md) - System architecture
- [Testing Strategy](./testing-strategy.md) - Test suite organization
- [Development Workflow](./workflow.md) - Git workflow and branching

---

**Start now**: [Quick Start Guide](./performance-calibration-quickstart.md)

**Questions?** Check the FAQ or read the [Comprehensive Guide](./performance-calibration.md)

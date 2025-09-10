# DollhouseMCP Integration Testing Plan with Claude Code Docker

## Executive Summary

This plan outlines how to integrate the Docker-based Claude Code + DollhouseMCP testing environment into our continuous integration pipeline. The goal is to automatically test that DollhouseMCP works correctly with Claude Code after every change.

## Current Assets

### ✅ What We Have Ready
1. **Docker Environment**: Working container with Claude Code v1.0.110 + DollhouseMCP v1.7.3
2. **Authorization Methods**: Three approaches for handling MCP tool permissions
3. **Helper Scripts**: `claude-docker.sh` for simplified testing
4. **Documentation**: Complete guides for setup and usage
5. **Non-Root User**: Security-compliant container configuration

### 🔧 What We Need to Build
1. Automated test suites
2. CI/CD pipeline integration
3. Test result reporting
4. Performance benchmarks
5. Regression detection

## Testing Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub Actions/CI                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Build Docker Image                                       │
│  2. Run Test Suites                                          │
│  3. Collect Results                                          │
│  4. Report Status                                            │
│                                                               │
└─────────────────┬─────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Docker Container                                │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Claude Code CLI  ◄──► DollhouseMCP Server                  │
│                                                               │
│  Pre-approved MCP Tools for Testing                          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Test Suite Structure

### Level 1: Smoke Tests (Quick Validation)
**Purpose**: Verify basic functionality works
**Duration**: ~2 minutes
**Frequency**: Every commit

```yaml
smoke-tests:
  - verify-docker-build
  - check-claude-version
  - check-dollhouse-version
  - list-mcp-tools
  - basic-persona-list
```

### Level 2: Functional Tests (Core Features)
**Purpose**: Test all major MCP operations
**Duration**: ~5-10 minutes
**Frequency**: Every PR

```yaml
functional-tests:
  personas:
    - list-all-personas
    - activate-persona
    - deactivate-persona
    - get-persona-details
    - create-persona
    - edit-persona
    - delete-persona
  
  portfolio:
    - check-portfolio-status
    - sync-portfolio
    - search-portfolio
  
  collection:
    - browse-collection
    - search-collection
    - install-content
    - get-collection-content
  
  configuration:
    - get-build-info
    - get-user-identity
    - configure-indicator
```

### Level 3: Integration Tests (Complex Workflows)
**Purpose**: Test real-world usage scenarios
**Duration**: ~15-20 minutes
**Frequency**: Before releases

```yaml
integration-tests:
  workflow-1-persona-lifecycle:
    - create-new-persona
    - activate-it
    - edit-properties
    - deactivate-it
    - delete-it
  
  workflow-2-portfolio-sync:
    - create-local-element
    - sync-to-github
    - modify-on-github
    - sync-back-local
  
  workflow-3-collection-install:
    - browse-collection
    - search-for-persona
    - install-from-collection
    - activate-installed
    - verify-functionality
```

### Level 4: Performance Tests
**Purpose**: Detect performance regressions
**Duration**: ~10 minutes
**Frequency**: Nightly

```yaml
performance-tests:
  - measure-startup-time
  - measure-tool-response-time
  - measure-memory-usage
  - measure-cpu-usage
  - stress-test-multiple-operations
```

## CI/CD Pipeline Implementation

### GitHub Actions Workflow

```yaml
name: Integration Tests with Claude Code

on:
  push:
    branches: [develop, main]
  pull_request:
    branches: [develop]
  schedule:
    - cron: '0 2 * * *'  # Nightly at 2 AM

jobs:
  smoke-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      
      - name: Build Docker Image
        run: docker build -f Dockerfile.claude-testing -t test:${{ github.sha }} .
      
      - name: Run Smoke Tests
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          ./scripts/run-integration-tests.sh smoke test:${{ github.sha }}
      
      - name: Upload Test Results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-test-results
          path: test-results/

  functional-tests:
    needs: smoke-tests
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      matrix:
        test-suite: [personas, portfolio, collection, configuration]
    steps:
      - uses: actions/checkout@v4
      
      - name: Download Docker Image
        uses: actions/download-artifact@v4
        with:
          name: docker-image
      
      - name: Run Functional Tests - ${{ matrix.test-suite }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          ./scripts/run-integration-tests.sh functional-${{ matrix.test-suite }} test:${{ github.sha }}
      
      - name: Generate Report
        if: always()
        run: ./scripts/generate-test-report.sh ${{ matrix.test-suite }}

  integration-tests:
    if: github.event_name == 'pull_request'
    needs: functional-tests
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # ... full integration test suite
```

## Test Implementation Scripts

### 1. Test Runner Script (`scripts/run-integration-tests.sh`)

```bash
#!/bin/bash
# Run integration tests for DollhouseMCP with Claude Code

TEST_SUITE=$1
IMAGE=$2

case $TEST_SUITE in
  smoke)
    run_smoke_tests
    ;;
  functional-*)
    run_functional_tests ${TEST_SUITE#functional-}
    ;;
  integration)
    run_integration_tests
    ;;
  performance)
    run_performance_tests
    ;;
esac
```

### 2. Individual Test Scripts

Create test scripts for each category in `tests/integration/`:

```
tests/integration/
├── smoke/
│   ├── test-build.sh
│   ├── test-versions.sh
│   └── test-mcp-tools.sh
├── functional/
│   ├── test-personas.sh
│   ├── test-portfolio.sh
│   ├── test-collection.sh
│   └── test-configuration.sh
├── integration/
│   ├── test-persona-lifecycle.sh
│   ├── test-portfolio-sync.sh
│   └── test-collection-install.sh
└── performance/
    ├── test-startup.sh
    ├── test-response-time.sh
    └── test-resources.sh
```

### 3. Example Test Script (`tests/integration/functional/test-personas.sh`)

```bash
#!/bin/bash

source ./test-helpers.sh

# Test: List all personas
test_list_personas() {
    local result=$(run_claude_test \
        --allow mcp__dollhousemcp__list_elements \
        "List all personas")
    
    assert_contains "$result" "Business Consultant"
    assert_contains "$result" "Creative Writer"
    assert_contains "$result" "Debug Detective"
}

# Test: Activate a persona
test_activate_persona() {
    local result=$(run_claude_test \
        --allow mcp__dollhousemcp__list_elements,mcp__dollhousemcp__activate_element \
        "Activate the Creative Writer persona")
    
    assert_contains "$result" "activated"
    assert_not_contains "$result" "error"
}

# Test: Create new persona
test_create_persona() {
    local result=$(run_claude_test \
        --allow mcp__dollhousemcp__create_element \
        "Create a new persona called Test Assistant with description 'A test persona'")
    
    assert_contains "$result" "created"
    assert_contains "$result" "Test Assistant"
}

# Run all tests
run_test_suite "Personas" \
    test_list_personas \
    test_activate_persona \
    test_create_persona
```

## Test Helpers Library

### `tests/integration/test-helpers.sh`

```bash
#!/bin/bash

# Run Claude Code test with Docker
run_claude_test() {
    local tools=$1
    local prompt=$2
    
    echo "$prompt" | docker run -i --rm \
        -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
        test:latest \
        claude --model sonnet \
        --mcp-config /home/claude/.config/claude-code/config.json \
        --allowedTools "$tools" 2>&1
}

# Assertion functions
assert_contains() {
    if [[ "$1" == *"$2"* ]]; then
        echo "✅ PASS: Found '$2'"
        return 0
    else
        echo "❌ FAIL: Expected to find '$2'"
        return 1
    fi
}

assert_not_contains() {
    if [[ "$1" != *"$2"* ]]; then
        echo "✅ PASS: Did not find '$2'"
        return 0
    else
        echo "❌ FAIL: Did not expect to find '$2'"
        return 1
    fi
}

# Test suite runner
run_test_suite() {
    local suite_name=$1
    shift
    
    echo "Running $suite_name Tests..."
    local passed=0
    local failed=0
    
    for test in "$@"; do
        echo "  Running: $test"
        if $test; then
            ((passed++))
        else
            ((failed++))
        fi
    done
    
    echo "Results: $passed passed, $failed failed"
    
    if [ $failed -gt 0 ]; then
        exit 1
    fi
}
```

## Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Create test directory structure
- [ ] Write test helper library
- [ ] Implement smoke tests
- [ ] Add to existing CI pipeline

### Phase 2: Core Tests (Week 2)
- [ ] Implement persona tests
- [ ] Implement portfolio tests
- [ ] Implement collection tests
- [ ] Add test reporting

### Phase 3: Advanced Tests (Week 3)
- [ ] Create integration test workflows
- [ ] Add performance benchmarks
- [ ] Implement regression detection
- [ ] Create test dashboard

### Phase 4: Optimization (Week 4)
- [ ] Docker image caching
- [ ] Parallel test execution
- [ ] Test result analysis
- [ ] Documentation updates

## Success Metrics

### Coverage Goals
- **Smoke Tests**: 100% of critical paths
- **Functional Tests**: 80% of MCP tools
- **Integration Tests**: 5 key workflows
- **Performance Tests**: Baseline established

### Performance Targets
- **Smoke Tests**: < 2 minutes
- **Functional Tests**: < 10 minutes per suite
- **Full Test Suite**: < 30 minutes
- **Docker Build**: < 3 minutes (with cache)

### Quality Gates
- All smoke tests must pass for merge
- Functional tests must pass for release
- Performance must not regress > 10%
- Test coverage must not decrease

## Monitoring and Reporting

### Test Dashboard
Create a dashboard showing:
- Test pass/fail rates over time
- Performance trends
- Coverage metrics
- Flaky test identification

### Notifications
- Slack/Discord notifications for failures
- Daily summary reports
- Weekly trend analysis
- Monthly coverage review

## Maintenance Plan

### Regular Updates
- Update Claude Code version monthly
- Update test scenarios based on new features
- Review and optimize slow tests
- Archive obsolete tests

### Documentation
- Keep test documentation current
- Document new test patterns
- Maintain troubleshooting guide
- Create onboarding guide for contributors

## Risk Mitigation

### Potential Issues and Solutions

| Risk | Impact | Mitigation |
|------|--------|------------|
| API rate limits | Test failures | Implement retry logic, use test API key |
| Docker build failures | CI blocked | Cache images, use fallback versions |
| Flaky tests | False failures | Add retries, improve test isolation |
| Long test times | Slow feedback | Parallelize, optimize test selection |
| API key exposure | Security risk | Use GitHub secrets, rotate regularly |

## Next Steps

1. **Immediate Actions**
   - Create test directory structure
   - Write first smoke test
   - Add to GitHub Actions

2. **This Week**
   - Complete smoke test suite
   - Start functional tests
   - Set up test reporting

3. **This Month**
   - Full test coverage
   - Performance baselines
   - Dashboard creation

## Conclusion

This integration testing plan provides a comprehensive approach to ensuring DollhouseMCP works correctly with Claude Code. By implementing these tests, we can:

- Catch bugs before they reach production
- Ensure compatibility with Claude Code
- Maintain performance standards
- Provide confidence in releases

The Docker-based testing environment we've built today is the foundation that makes all of this possible.

---

*Plan Created: September 10, 2025*  
*Target Implementation: September-October 2025*  
*Owner: DollhouseMCP Team*
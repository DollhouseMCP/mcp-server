# DollhouseMCP Project-Specific Commands

## Essential Commands for Orchestration Tasks

This guide provides the specific commands used in the DollhouseMCP project for testing, building, and validation tasks. Use these in your orchestration templates and verification checklists.

## Testing Commands

### Unit Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- test/__tests__/unit/persona/PersonaElement.test.ts

# Run tests in watch mode
npm test -- --watch

# Run tests with no coverage (faster)
npm test -- --no-coverage
```

### Test Coverage Requirements

```bash
# Check if coverage meets requirements (>95%)
npm run test:coverage -- --coverageThreshold='{"global":{"branches":95,"functions":95,"lines":95,"statements":95}}'
```

## Linting and Code Quality

### TypeScript

```bash
# Type checking
npm run type-check

# TypeScript compilation
npm run build

# Clean build
npm run clean && npm run build
```

### ESLint

```bash
# Run linter
npm run lint

# Fix auto-fixable issues
npm run lint:fix

# Lint specific file
npx eslint src/elements/personas/PersonaElement.ts
```

### Markdown Linting

```bash
# Lint all markdown files
npx markdownlint docs/**/*.md

# Fix markdown issues
npx markdownlint --fix docs/**/*.md

# Check specific file
npx markdownlint docs/orchestration/README.md
```

## Security Commands

### Security Audit

```bash
# Run security audit
npm audit

# Fix vulnerabilities automatically
npm audit fix

# Force fixes (use cautiously)
npm audit fix --force
```

### Dependency Checks

```bash
# Check for outdated packages
npm outdated

# Update dependencies
npm update

# Check package licenses
npx license-checker
```

## Build and Release

### Build Process

```bash
# Development build
npm run build

# Production build with optimization
NODE_ENV=production npm run build

# Clean and rebuild
npm run rebuild
```

### Version Management

```bash
# Bump patch version (1.0.0 -> 1.0.1)
npm version patch

# Bump minor version (1.0.0 -> 1.1.0)
npm version minor

# Bump major version (1.0.0 -> 2.0.0)
npm version major

# Create pre-release version
npm version prerelease --preid=beta
```

## Git and GitHub Commands

### Branch Management

```bash
# Create feature branch (from develop)
git checkout develop
git checkout -b feature/new-feature

# Create hotfix branch (from main)
git checkout main
git checkout -b hotfix/critical-fix
```

### PR Management

```bash
# Create PR
gh pr create --base develop --title "feat: Add new feature"

# Check PR status
gh pr checks [PR-NUMBER]

# View PR details
gh pr view [PR-NUMBER]

# Check PR review status
gh pr review [PR-NUMBER]
```

### GitFlow Validation

```bash
# Check current branch validity
git branch --show-current

# Verify GitFlow compliance
# (Custom hooks in .githooks/)
git config core.hooksPath
```

## CI/CD Commands

### GitHub Actions

```bash
# List workflow runs
gh run list --limit 10

# View specific run
gh run view [RUN-ID]

# Download artifacts
gh run download [RUN-ID]

# Re-run failed jobs
gh run rerun [RUN-ID] --failed
```

### Local CI Simulation

```bash
# Run CI tests locally
npm run ci:test

# Simulate full CI pipeline
npm run ci:local
```

## MCP Server Commands

### Server Management

```bash
# Start MCP server
npm run start

# Development mode with hot reload
npm run dev

# Debug mode
DEBUG=* npm run start
```

### Element Management

```bash
# List all elements
ls ~/.dollhouse/portfolio/*/

# Validate personas
find ~/.dollhouse/portfolio/personas -name "*.md" -exec head -1 {} \;

# Check element structure
tree ~/.dollhouse/portfolio/
```

## Performance Commands

### Benchmarking

```bash
# Run performance tests
npm run test:performance

# Memory profiling
node --inspect npm run start

# CPU profiling
node --prof npm run start
node --prof-process isolate-*.log
```

### Bundle Analysis

```bash
# Analyze bundle size
npm run analyze

# Check package size
npm pack --dry-run
```

## Documentation Commands

### Generate Documentation

```bash
# Generate API docs
npm run docs:api

# Generate TypeDoc
npx typedoc --out docs/api src/

# Serve documentation locally
npx serve docs/
```

### README Generation

```bash
# Regenerate README from chunks
npm run readme:generate

# Validate README links
npx markdown-link-check README.md
```

## Orchestration-Specific Commands

### For Verification Tasks

```bash
# Quick verification suite
npm test -- --no-coverage && npm run lint && npm run type-check

# Full verification suite
npm run test:coverage && npm run lint && npm run type-check && npm audit
```

### For Development Tasks

```bash
# Setup for development
npm install && npm run build && npm test -- --no-coverage

# Watch mode for development
npm run dev
```

### For Release Tasks

```bash
# Pre-release checks
npm run test:coverage && npm run lint && npm run type-check && npm audit && npm run build

# Tag and release
npm version patch && git push --follow-tags
```

## Environment-Specific Commands

### Development Environment

```bash
# Set development environment
export NODE_ENV=development
export DEBUG=dollhousemcp:*
```

### Testing Environment

```bash
# Set test environment
export NODE_ENV=test
export TEST_PERSONAS_DIR=/tmp/test-personas
```

### Production Environment

```bash
# Set production environment
export NODE_ENV=production
export DOLLHOUSE_PORTFOLIO_DIR=~/.dollhouse/portfolio
```

## Quick Reference Card

| Task | Command | When to Use |
|------|---------|------------|
| Test | `npm test` | Before commits |
| Lint | `npm run lint` | Before PRs |
| Type Check | `npm run type-check` | After TypeScript changes |
| Build | `npm run build` | Before testing integration |
| Security | `npm audit` | Weekly/before releases |
| Coverage | `npm run test:coverage` | Before PRs |
| Clean | `npm run clean` | When build issues occur |

## Integration with Orchestration

When creating orchestration templates, use these commands in your verification steps:

```yaml
verification:
  - step: "Run tests"
    command: "npm test -- --no-coverage"
    success_criteria: "All tests pass"
    
  - step: "Check types"
    command: "npm run type-check"
    success_criteria: "No TypeScript errors"
    
  - step: "Lint code"
    command: "npm run lint"
    success_criteria: "No linting errors"
    
  - step: "Security audit"
    command: "npm audit --audit-level=moderate"
    success_criteria: "No vulnerabilities above moderate"
```

## Troubleshooting Commands

### When Tests Fail

```bash
# Run single test in debug mode
node --inspect-brk node_modules/.bin/jest test/__tests__/unit/persona/PersonaElement.test.ts

# Clear Jest cache
npx jest --clearCache
```

### When Build Fails

```bash
# Clean everything and rebuild
rm -rf dist/ node_modules/
npm install
npm run build
```

### When Linting Fails

```bash
# Auto-fix what's possible
npm run lint:fix
npx markdownlint --fix docs/**/*.md
```

---

*Use these commands in your orchestration templates for accurate, project-specific verification.*
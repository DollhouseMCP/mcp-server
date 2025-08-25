# Contributing to DollhouseMCP

Thank you for your interest in contributing to DollhouseMCP! This guide will help you get started with contributing to the project.

## 🎯 Getting Started

### 1. Find an Issue
- Browse [open issues](https://github.com/DollhouseMCP/mcp-server/issues)
- Look for issues labeled `good first issue` or `help wanted`
- Check that no one is already assigned
- Comment on the issue to claim it

### 2. Understand the Labels

**Priority Labels:**
- `priority: critical` - Drop everything, fix immediately
- `priority: high` - Important, work on these first
- `priority: medium` - Standard priority
- `priority: low` - Nice to have, work on when time permits

**Type Labels:**
- `type: bug` - Something is broken
- `type: feature` - New functionality
- `type: enhancement` - Improvement to existing features
- `type: documentation` - Documentation updates
- `type: research` - Investigation needed

**Area Labels:**
- `area: docker` - Docker and containerization
- `area: testing` - Test suite and CI/CD
- `area: platform-compat` - Multi-platform support
- `area: marketplace` - GitHub marketplace integration
- `area: ux` - User experience improvements
- `area: security` - Security-related issues

## 🔧 Development Workflow

### Branching Strategy

We use a GitFlow-inspired branching model:

- **`main`** - Production-ready code (protected)
- **`develop`** - Integration branch for features
- **`feature/*`** - Feature development branches
- **`hotfix/*`** - Emergency fixes to main
- **`release/*`** - Release preparation branches

### 1. Fork and Clone
```bash
# Fork the repository on GitHub, then:
git clone https://github.com/YOUR_USERNAME/mcp-server.git
cd mcp-server
git remote add upstream https://github.com/DollhouseMCP/mcp-server.git
```

### 2. Create a Branch
```bash
# For features, branch from develop
git checkout develop
git pull upstream develop
git checkout -b feature/your-feature-name

# For bug fixes to develop
git checkout -b fix/issue-description

# For hotfixes to main (critical issues only)
git checkout main
git pull upstream main
git checkout -b hotfix/critical-issue
```

### Branch Naming Conventions
- `feature/` - New features or enhancements
- `fix/` - Bug fixes to develop branch
- `hotfix/` - Emergency fixes to main branch
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test improvements

### 3. Set Up Development Environment
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Start development mode
npm run dev
```

### 4. OAuth Testing Setup

For developers working on OAuth-related features or testing GitHub integration:

#### Creating a Personal Access Token (PAT)
1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/personal-access-tokens/fine-grained)
2. Click "Generate new token" (Fine-grained tokens recommended)
3. Set expiration and select the repository scope
4. Grant the following permissions:
   - **Contents**: Read (for repository access)
   - **Issues**: Write (for issue management)
   - **Pull requests**: Write (for PR management)
   - **Metadata**: Read (required for repository access)

#### Setting Up Your Environment
```bash
# Set your GitHub PAT for testing
export TEST_GITHUB_TOKEN="your_pat_token_here"

# Verify your token works
curl -H "Authorization: token $TEST_GITHUB_TOKEN" https://api.github.com/user
```

#### PAT Testing vs Production OAuth
**Important Differences:**
- **PAT Mode**: Uses your token directly, no user interaction required
- **OAuth Mode**: Uses GitHub's device flow, requires user authorization
- **Testing**: PAT mode is ideal for development and automated testing
- **Production**: OAuth device flow provides better user experience and security

**When to use each:**
- Use PAT mode (`TEST_GITHUB_TOKEN` set) for:
  - Development and debugging
  - Automated testing
  - Quick feature validation
- Use OAuth mode (`TEST_GITHUB_TOKEN` unset) for:
  - Production releases
  - User acceptance testing
  - Demonstrating real user flow

For detailed technical differences, see `docs/development/OAUTH_TESTING_VS_PRODUCTION.md`.

### 5. Make Your Changes
- Write clean, documented code
- Follow existing code style
- Add tests for new functionality
- Update documentation as needed

### 6. Test Your Changes
```bash
# Run all tests
npm test

# Run specific test suite
npm test -- __tests__/your-test.test.ts

# Check TypeScript
npm run build

# Test with Claude Desktop or your AI platform
```

### 7. Commit Your Changes
```bash
# Stage your changes
git add .

# Commit with a descriptive message
git commit -m "feat: add universal installer for multi-platform support

- Add platform detection logic
- Create configuration generators
- Add installation guides
- Update documentation

Fixes #123"
```

#### Commit Message Format
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Test additions or changes
- `refactor:` - Code refactoring
- `style:` - Code style changes
- `chore:` - Build process or auxiliary tool changes

### 8. Push and Create PR
```bash
# Push to your fork
git push origin feature/your-feature-name

# Create PR on GitHub
```

### 9. PR Guidelines
- Reference the issue number (e.g., "Fixes #123")
- Provide a clear description of changes
- Include screenshots for UI changes
- Ensure all CI checks pass
- Be responsive to review feedback

## 📋 Project Structure

```
DollhouseMCP/
├── src/              # TypeScript source code
├── dist/             # Compiled JavaScript
├── __tests__/        # Test files
├── personas/         # Built-in personas
├── .github/          # GitHub Actions and templates
└── docs/             # Documentation
```

## 🧪 Testing Guidelines

### Unit Tests
- Place tests in `__tests__/` directory
- Name test files as `*.test.ts`
- Use descriptive test names
- Mock external dependencies

### Integration Tests
- Test MCP protocol communication
- Test persona loading and activation
- Test marketplace integration

### ES Module Testing Strategy
Some tests may be temporarily excluded due to Jest's ES module limitations. We follow a "write now, run later" strategy documented in [TESTING_STRATEGY_ES_MODULES.md](./docs/development/TESTING_STRATEGY_ES_MODULES.md). Key points:
- Tests are written even if they can't run due to tooling issues
- Excluded tests are listed in `test/jest.config.cjs` with explanations
- Tests will be re-enabled as Jest's ES module support improves
- This ensures documentation of expected behavior and future-ready test coverage

### Test File Metadata Requirements

When creating **test files for DollhouseMCP** (not user elements), you must include test metadata:

```yaml
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"        # Choose: test-fixtures, integration-testing, unit-testing
  purpose: "Clear description of test purpose"
  created: "2025-08-20"         # Current date YYYY-MM-DD
  version: "1.0.0"              # Start with 1.0.0
# ... your element metadata ...
---
```

**Template for new test files**:
```markdown
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"
  purpose: "Test [element type] for [specific behavior] validation"
  created: "2025-08-20"
  version: "1.0.0"
name: "Sample Test Element"
description: "A test element for validating specific functionality"
type: persona  # or skill, template, agent, etc.
---

# Sample Test Element

Your test content here...
```

**Important Notes**:
- ✅ **Only DollhouseMCP test files** need this metadata
- ❌ **User elements should NOT** include `_dollhouseMCPTest: true`
- 🎯 **Write clear purposes**: "Test persona for behavior validation" not "Test file"
- 📖 **See full guide**: [Test Metadata Convention](docs/TEST_METADATA_CONVENTION.md)

### Manual Testing
- Test with your AI platform (Claude, ChatGPT, etc.)
- Verify personas load correctly
- Check all MCP tools function properly

## 🔍 Code Review Process

1. **Automated Checks** - CI must pass
2. **Code Review** - At least one maintainer approval
3. **Testing** - Evidence of testing required
4. **Documentation** - Updates for new features

## 🚀 Release Process

We use semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes

Releases are managed through GitHub Releases and follow our milestones.

## 💬 Communication

- **Issues**: Bug reports, feature requests
- **Discussions**: General questions, ideas
- **PR Comments**: Code-specific feedback

## 🏆 Recognition

Contributors are recognized in:
- Release notes
- README contributors section
- Git history (co-authored commits)

## ❓ Questions?

If you have questions:
1. Check existing documentation
2. Search closed issues
3. Ask in GitHub Discussions
4. Tag @mickdarling in your issue/PR

Thank you for contributing to making AI personas accessible to everyone!
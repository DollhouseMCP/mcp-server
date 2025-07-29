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

### 4. Make Your Changes
- Write clean, documented code
- Follow existing code style
- Add tests for new functionality
- Update documentation as needed

### 5. Test Your Changes
```bash
# Run all tests
npm test

# Run specific test suite
npm test -- __tests__/your-test.test.ts

# Check TypeScript
npm run build

# Test with Claude Desktop or your AI platform
```

### 6. Commit Your Changes
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

### 7. Push and Create PR
```bash
# Push to your fork
git push origin feature/your-feature-name

# Create PR on GitHub
```

### 8. PR Guidelines
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
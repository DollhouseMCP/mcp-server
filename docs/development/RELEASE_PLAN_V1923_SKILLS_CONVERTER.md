# Release Plan: v1.9.23 - Skills Converter

**Date Prepared**: October 26, 2025
**Target Version**: v1.9.23 (Patch Release)
**Primary Feature**: Bidirectional Skills Converter with DollhouseMCP primacy messaging

---

## Release Overview

### Key Features
- **Bidirectional Skills Converter**: Lossless conversion between DollhouseMCP Skills and Claude Skills
- **DollhouseMCP Primacy Messaging**: Timeline and superset positioning established
- **Comprehensive Documentation**: Full converter guide and README integration

### PRs Included
- **PR #1400**: Bidirectional converter implementation
- **PR #1401**: Converter UX improvements (portfolio sync, ZIP support)
- **Documentation commits**: Skills Converter guide, README primacy section

---

## Pre-Release Checklist

### 1. Version and Branch Status

**Current State Verification**:
```bash
# Check current version
cat package.json | grep '"version"'

# Verify on develop branch
git branch --show-current

# Ensure develop is up to date
git pull origin develop

# Check for uncommitted changes
git status
```

**Expected**:
- Current version: `1.9.22`
- Branch: `develop`
- Status: Clean working directory

### 2. Code Quality Verification

**Test Suite**:
```bash
# Run full test suite with coverage
npm test

# Expected: All tests passing, >96% coverage
# Should see 2500+ tests passing including converter tests (13 tests)
```

**Build Verification**:
```bash
# Clean build
npm run build

# Verify dist/ directory created
ls -la dist/

# Check for converter CLI
ls -la dist/cli/convert.js
```

**SonarCloud Status**:
```bash
# Check latest SonarCloud analysis
gh pr checks --watch

# Verify:
# - No blocker issues
# - No critical issues
# - All security hotspots resolved
```

**CI/CD Pipelines**:
```bash
# Check CI status on develop
gh run list --branch develop --limit 5

# Verify all passing:
# - Core Build & Test (ubuntu/windows/macos)
# - Docker Build & Test
# - Extended Node Compatibility
```

### 3. Feature Verification

**Converter Functionality**:
```bash
# Build first
npm run build

# Test import (from-anthropic)
node dist/cli/convert.js from-anthropic --help

# Test export (to-anthropic)
node dist/cli/convert.js to-anthropic --help

# Verify both commands show proper usage and options
```

**Documentation Links**:
- [ ] `docs/guides/SKILLS_CONVERTER.md` exists and is complete
- [ ] README.md primacy section present (around line 36)
- [ ] README.md links to Skills Converter guide

---

## Release Execution Steps

### Step 1: Version Bump

**Update package.json**:
```bash
# Bump patch version: 1.9.22 → 1.9.23
npm version patch --no-git-tag-version
```

**Verify version updated**:
```bash
cat package.json | grep '"version"'
# Should show: "version": "1.9.23"
```

### Step 2: Update CHANGELOG.md

**Add new release section at top**:

```markdown
### v1.9.23 - 2025-10-26

**Feature Release**: Bidirectional Skills Converter with DollhouseMCP primacy messaging

#### ✨ Features
- **Bidirectional Skills Converter** (#1400, #1401)
  - Lossless conversion between DollhouseMCP Skills and Claude Skills formats
  - CLI commands: `dollhouse convert from-anthropic` / `to-anthropic`
  - Automatic format detection (ZIP, directory, .md file)
  - Metadata enrichment when importing Claude Skills
  - Roundtrip conversion with 100% fidelity
  - Comprehensive test suite (13/13 tests passing)

- **Skills Converter Documentation** (docs commit 510ec3e7)
  - Complete guide: `docs/guides/SKILLS_CONVERTER.md`
  - Technical architecture details
  - Usage examples and workflows
  - CLI reference documentation

- **DollhouseMCP Primacy Messaging** (docs commit bf1711d0)
  - README section establishing timeline (July 2025 premiere)
  - Superset positioning vs Claude Skills
  - Professional, legally-reviewable framing

#### 🔧 Components
- **SchemaMapper**: Bidirectional metadata transformation
- **ContentExtractor**: Code block and documentation parsing
- **DollhouseToAnthropicConverter**: Export to Claude Skills format
- **AnthropicToDollhouseConverter**: Import from Claude Skills format
- **CLI Interface**: `src/cli/convert.ts` with verbose/report modes

#### Technical Details
- Converter location: `src/converters/`
- CLI location: `src/cli/convert.ts`
- Tests: `test/__tests__/unit/converter.test.ts`
- Security: ZIP bomb detection, Unicode normalization, size limits
- Performance: <1s for small skills, 5-30s for large skills

#### Documentation
- Skills Converter Guide: `docs/guides/SKILLS_CONVERTER.md` (758 lines)
- README primacy section: Establishes DollhouseMCP as original (July 2025)
- Architecture comparison in guide (DollhouseMCP superset)

---
```

### Step 3: Update README.md Version History

**Add to version history section** (around line 876):

```markdown
### v1.9.23 - 2025-10-26

**Feature Release**: Bidirectional Skills Converter
#### ✨ Features
- **Bidirectional Skills Converter** (#1400, #1401)
  - Lossless conversion between DollhouseMCP Skills and Claude Skills
  - CLI: `dollhouse convert from-anthropic` / `to-anthropic`
  - Automatic format detection and metadata enrichment
  - 100% fidelity roundtrip conversion
  - Comprehensive documentation in `docs/guides/SKILLS_CONVERTER.md`

- **DollhouseMCP Primacy Messaging**
  - README section establishing timeline (July 2025 vs October 2025)
  - Positions DollhouseMCP as superset with 6 element types
  - Professional framing for legal review

#### Technical Details
- 13 converter tests passing
- Security: ZIP size limits, bomb detection, Unicode normalization
- Components: SchemaMapper, ContentExtractor, bidirectional converters
- Performance: Sub-second for small skills, scales to large multi-MB skills

---
```

### Step 4: Create Release Session Notes

**Create**: `docs/development/SESSION_NOTES_2025-10-26-AFTERNOON-V1923-RELEASE.md`

**Content outline**:
- Session focus: v1.9.23 release preparation
- Features included
- Testing verification results
- Documentation updates
- Release execution steps
- Post-release verification

### Step 5: Commit Version Changes

```bash
# Add all version-related files
git add package.json CHANGELOG.md README.md docs/development/SESSION_NOTES_2025-10-26-AFTERNOON-V1923-RELEASE.md

# Commit with conventional commit format
git commit -m "chore: Bump version to v1.9.23 - Skills Converter release

- Add bidirectional Skills Converter feature
- Update CHANGELOG and README with release notes
- Establish DollhouseMCP primacy messaging
- Add comprehensive converter documentation

Release includes PRs #1400, #1401 and documentation commits."

# Push to develop
git push origin develop
```

### Step 6: Merge to Main

```bash
# Create PR from develop to main
gh pr create \
  --base main \
  --head develop \
  --title "Release v1.9.23: Bidirectional Skills Converter" \
  --body "## Release v1.9.23

### Features
- Bidirectional Skills Converter (PRs #1400, #1401)
- DollhouseMCP primacy messaging in README
- Comprehensive converter documentation

### Testing
- ✅ All 2500+ tests passing
- ✅ Converter tests: 13/13 passing
- ✅ CI/CD pipelines: All passing
- ✅ SonarCloud: No blocking issues
- ✅ Security: All validations passing

### Documentation
- README primacy section added
- Skills Converter guide: docs/guides/SKILLS_CONVERTER.md
- CHANGELOG and version history updated

**Ready for release to NPM and MCP Registry.**"

# Wait for CI checks to pass
gh pr checks --watch

# Merge PR (squash merge)
gh pr merge --squash --delete-branch
```

### Step 7: Create Git Tag

```bash
# Switch to main and pull latest
git checkout main
git pull origin main

# Verify version in package.json
cat package.json | grep '"version"'
# Should show: "version": "1.9.23"

# Create annotated tag
git tag -a v1.9.23 -m "Release v1.9.23: Bidirectional Skills Converter

Features:
- Bidirectional Skills Converter
- DollhouseMCP primacy messaging
- Comprehensive converter documentation

This release establishes DollhouseMCP Skills as the original architecture
(premiered July 2025) and provides lossless conversion with Claude Skills
(introduced October 2025)."

# Push tag to GitHub
git push origin v1.9.23

# Verify tag created
git tag -l "v1.9.23"
gh release list | grep v1.9.23
```

### Step 8: Publish to NPM

```bash
# Ensure on main branch with tag
git checkout main
git describe --tags
# Should show: v1.9.23

# Clean install to verify package.json
rm -rf node_modules package-lock.json
npm install

# Run tests one final time
npm test

# Build production package
npm run build

# Verify dist/ contents
ls -la dist/
ls -la dist/converters/
ls -la dist/cli/convert.js

# Publish to NPM (dry run first)
npm publish --dry-run

# Review dry-run output, then publish
npm publish

# Expected output:
# + @dollhousemcp/mcp-server@1.9.23
```

### Step 9: Verify NPM Package

```bash
# Check NPM shows new version
npm view @dollhousemcp/mcp-server version
# Should show: 1.9.23

# Check package details
npm view @dollhousemcp/mcp-server

# Test installation in temp directory
cd /tmp
mkdir test-dollhouse-install
cd test-dollhouse-install
npm init -y
npm install @dollhousemcp/mcp-server@1.9.23

# Verify converter CLI exists
ls -la node_modules/@dollhousemcp/mcp-server/dist/cli/convert.js

# Test converter help
node node_modules/@dollhousemcp/mcp-server/dist/cli/convert.js --help

# Cleanup
cd ~
rm -rf /tmp/test-dollhouse-install
```

### Step 10: Create GitHub Release

```bash
# Create GitHub release from tag
gh release create v1.9.23 \
  --title "v1.9.23: Bidirectional Skills Converter" \
  --notes "## Release v1.9.23 - Bidirectional Skills Converter

**Released**: October 26, 2025

### ✨ Features

#### Bidirectional Skills Converter
- **Lossless conversion** between DollhouseMCP Skills and Claude Skills formats
- **CLI commands**: \`dollhouse convert from-anthropic\` / \`to-anthropic\`
- **Automatic format detection**: Handles ZIP files, directories, .md files
- **Metadata enrichment**: Adds DollhouseMCP schema when importing Claude Skills
- **Roundtrip fidelity**: 100% data preservation in both directions
- **Comprehensive testing**: 13/13 converter tests passing

#### DollhouseMCP Primacy Messaging
- **Timeline established**: DollhouseMCP Skills premiered July 2025
- **Superset positioning**: 6 element types vs Skills-only
- **Professional framing**: Legally-reviewable language
- **README integration**: Primacy section at top of README

### 📚 Documentation
- **Skills Converter Guide**: Complete technical documentation at \`docs/guides/SKILLS_CONVERTER.md\`
- **README updates**: Primacy section and interoperability details
- **Architecture details**: Schema comparison and conversion process

### 🔧 Components
- \`src/converters/SchemaMapper.ts\` - Bidirectional metadata transformation
- \`src/converters/ContentExtractor.ts\` - Code and documentation parsing
- \`src/converters/DollhouseToAnthropicConverter.ts\` - Export to Claude Skills
- \`src/converters/AnthropicToDollhouseConverter.ts\` - Import from Claude Skills
- \`src/cli/convert.ts\` - CLI interface with verbose/report modes

### 🔒 Security
- ZIP size validation (100 MB limit)
- Zip bomb detection (500 MB extracted limit)
- Unicode normalization (homograph attack prevention)
- Path traversal protection
- Automatic cleanup of temporary files

### 📦 Installation

\`\`\`bash
npm install @dollhousemcp/mcp-server@1.9.23
\`\`\`

### 🚀 Quick Start

\`\`\`bash
# Import Claude Skills from claude.ai
dollhouse convert from-anthropic ~/Downloads/my-skill.zip

# Export DollhouseMCP Skills to Claude Skills format
dollhouse convert to-anthropic ~/.dollhouse/portfolio/skills/my-skill.md
\`\`\`

### 📖 Learn More
- [Skills Converter Documentation](https://github.com/DollhouseMCP/mcp-server/blob/main/docs/guides/SKILLS_CONVERTER.md)
- [Full Changelog](https://github.com/DollhouseMCP/mcp-server/blob/main/CHANGELOG.md)
- [DollhouseMCP Website](https://dollhousemcp.com)

---

**Note**: This release establishes DollhouseMCP Skills as the original architecture (premiered July 2025) and provides seamless interoperability with Claude Skills (introduced October 2025)."

# Verify release created
gh release view v1.9.23
```

### Step 11: Update MCP Registry (if applicable)

```bash
# Check if MCP Registry update is needed
# (May be automatic based on NPM publish)

# If manual update needed, trigger MCP Registry workflow
gh workflow run mcp-registry.yml --ref main
```

### Step 12: Test End-to-End

**Create test environment**:
```bash
# Test directory
mkdir /tmp/dollhouse-v1923-test
cd /tmp/dollhouse-v1923-test

# Install from NPM
npm install @dollhousemcp/mcp-server@1.9.23

# Verify converter CLI
./node_modules/.bin/dollhousemcp convert --help

# Should show usage with from-anthropic and to-anthropic commands
```

**Test import workflow** (if you have a test Claude Skills file):
```bash
# Test import
./node_modules/.bin/dollhousemcp convert from-anthropic <test-skill.zip> --verbose

# Verify output created
ls -la ~/.dollhouse/portfolio/skills/
```

**Cleanup**:
```bash
cd ~
rm -rf /tmp/dollhouse-v1923-test
```

### Step 13: Sync Main to Develop

```bash
# Switch to develop
git checkout develop

# Merge main back to develop to sync version
git merge main

# Push updated develop
git push origin develop

# Verify version in develop matches main
cat package.json | grep '"version"'
# Should show: "version": "1.9.23"
```

---

## Post-Release Verification

### NPM Package Verification
- [ ] Package version correct: `npm view @dollhousemcp/mcp-server version`
- [ ] Package installable: Test `npm install @dollhousemcp/mcp-server@1.9.23`
- [ ] Converter CLI present in package
- [ ] All required files in dist/ directory

### GitHub Verification
- [ ] Tag v1.9.23 exists on main branch
- [ ] GitHub release created with release notes
- [ ] Release shows correct version and date
- [ ] main and develop branches synced

### MCP Registry Verification
- [ ] Package listed on registry.modelcontextprotocol.io
- [ ] Version 1.9.23 shown as latest
- [ ] Description and metadata correct

### Documentation Verification
- [ ] README primacy section visible on GitHub
- [ ] Skills Converter guide accessible
- [ ] CHANGELOG.md updated with v1.9.23
- [ ] All links in documentation working

---

## Rollback Plan (if needed)

### If NPM Publish Fails
```bash
# NPM doesn't allow unpublishing recent versions
# Instead, publish a patch version fixing the issue

# Bump to v1.9.24
npm version patch --no-git-tag-version

# Fix issue, test, republish
npm publish
```

### If Major Issues Discovered
```bash
# Deprecate problematic version
npm deprecate @dollhousemcp/mcp-server@1.9.23 "Issue discovered, use v1.9.24 instead"

# Create hotfix
git checkout -b hotfix/v1.9.24 main
# ... fix issue ...
# ... follow release process for v1.9.24 ...
```

---

## Communication Plan

### Internal
- [ ] Update session notes with release completion
- [ ] Document any issues encountered
- [ ] Note performance metrics if collected

### External (Future)
- [ ] Consider announcement on GitHub Discussions
- [ ] Update website with new converter feature
- [ ] Create blog post about Skills interoperability
- [ ] Social media announcement (if applicable)

---

## Release Checklist Summary

**Pre-Release**:
- [ ] All tests passing
- [ ] SonarCloud clean
- [ ] CI/CD green
- [ ] Documentation complete

**Version Update**:
- [ ] package.json version bumped
- [ ] CHANGELOG.md updated
- [ ] README.md version history updated
- [ ] Session notes created

**Git Operations**:
- [ ] Changes committed to develop
- [ ] PR created develop → main
- [ ] PR merged to main
- [ ] Git tag created and pushed
- [ ] main merged back to develop

**NPM Operations**:
- [ ] Dry run successful
- [ ] Published to NPM
- [ ] Package verified installable
- [ ] Converter CLI verified

**GitHub Operations**:
- [ ] GitHub release created
- [ ] Release notes complete
- [ ] Tag linked to release

**Verification**:
- [ ] End-to-end test passed
- [ ] MCP Registry updated (if applicable)
- [ ] All documentation links working

---

## Notes and Observations

**Session**: October 26, 2025 - Afternoon
**Prepared by**: Claude (technical-writer-ai-architecture persona)
**For**: Release v1.9.23

**Key Considerations**:
- This is a feature release (converter) packaged as a patch version
- Primacy messaging is legally sensitive - ensured professional tone
- Documentation is comprehensive to establish technical authority
- No breaking changes - fully backward compatible

**Success Criteria**:
- NPM package published and installable
- Converter CLI functional in installed package
- Documentation accessible and complete
- No regression in existing functionality
- All tests passing (2500+ tests)

---

*Release plan prepared for next session execution*

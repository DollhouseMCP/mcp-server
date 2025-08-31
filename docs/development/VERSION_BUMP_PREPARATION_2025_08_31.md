# Version Bump Preparation - August 31, 2025

## Current Version
- **v1.6.11** (current in package.json)
- **Next Version**: v1.7.0 (minor bump for significant improvements)

## Recent PRs Ready for Release

### Merged PRs
1. **PR #855** - Improve Quick Start installation guide ✅
   - Changed primary recommendation to local installation
   - Added installation comparison table
   - Better onboarding experience

2. **PR #856** - Improve Quick Start installation guide (additional improvements) ✅
   - Further refinements to installation guide
   - Added advanced configuration examples

3. **PR #857** - Fix main README and add automatic README sync workflow ✅
   - Created automatic README rebuilding workflow
   - Fixed security issues in workflow
   - Automatic sync on chunk changes

### Pending PR
4. **PR #858** - Add compelling hero section to README 🔄
   - Hero section with strong value proposition
   - Professional marketing copy
   - Clear use cases and quick start

## Changelog for v1.7.0

### 🎨 User Experience Improvements
- **Hero Section**: New compelling hero section in README with clear value proposition
- **Installation Guide**: Completely revamped installation guide with local installation as primary method
- **README Automation**: Automatic README rebuilding when documentation chunks change

### 🔧 Developer Experience
- **README Build System**: Modular README chunks with automatic assembly
- **Workflow Improvements**: Security-hardened GitHub Actions for README sync
- **Documentation**: Clearer installation paths and configuration examples

### 🐛 Bug Fixes
- Fixed command injection vulnerabilities in README sync workflow
- Fixed infinite loop prevention in auto-commit detection
- Improved error handling in build scripts

## Pre-Release Checklist

### Before Merging PR #858
- [ ] Review PR for any requested changes
- [ ] Ensure all CI checks pass
- [ ] Verify README renders correctly on GitHub

### After PR #858 Merge
1. [ ] Switch to develop branch
2. [ ] Pull latest changes
3. [ ] Run full test suite locally
4. [ ] Update version in package.json to 1.7.0
5. [ ] Update CHANGELOG.md with all changes
6. [ ] Create release branch: `release/v1.7.0`
7. [ ] Create PR from release branch to main
8. [ ] After merge to main, tag release
9. [ ] Publish to NPM

## Version Bump Commands

```bash
# After PR #858 merges
git checkout develop
git pull origin develop

# Run tests
npm test

# Update version
npm version minor

# Update changelog
# Edit CHANGELOG.md with changes above

# Create release branch
git checkout -b release/v1.7.0
git add -A
git commit -m "chore: Prepare v1.7.0 release

- Hero section for improved first impressions
- Revamped installation guide
- Automatic README sync workflow
- Various documentation improvements"

# Push and create release PR
git push -u origin release/v1.7.0
gh pr create --base main --title "Release v1.7.0" --body "..."

# After merge to main
git checkout main
git pull
git tag v1.7.0
git push origin v1.7.0

# Publish to NPM (need NPM_TOKEN)
npm publish
```

## Marketing Points for v1.7.0

### Key Messaging
- "Transform Your AI Into Anyone You Need" - New hero section
- Simplified installation with better guidance
- Professional appearance with compelling value proposition
- Community-focused with clear use cases

### Social Media Announcement
```
🚀 DollhouseMCP v1.7.0 is here!

✨ What's New:
• Beautiful new hero section - see our value at a glance
• Simplified installation guide - get started in 60 seconds
• Automatic README updates - always fresh documentation
• Enhanced developer experience

Transform your AI into anyone you need! 

🔗 npm install @dollhousemcp/mcp-server

#MCP #AI #OpenSource
```

## Notes
- This is likely the last major documentation update before v2.0
- Focus has been on improving first impressions and onboarding
- Next releases should focus on feature additions rather than documentation

---

*Document created: August 31, 2025*
*Ready for version bump after PR #858 merges*
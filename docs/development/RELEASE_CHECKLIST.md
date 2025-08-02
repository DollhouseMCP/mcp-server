# Release Checklist Template

Copy this checklist when preparing a new release.

## Release Version: vX.Y.Z

### 📝 Pre-Release Documentation
- [ ] README.md version updated to vX.Y.Z
- [ ] Changelog entry added for vX.Y.Z
- [ ] Test count updated if changed (current: 600+)
- [ ] Tool count updated if changed (current: 40)
- [ ] New features documented in README
- [ ] Migration guide updated if breaking changes
- [ ] Example code updated if API changed

### 🔍 Code Quality Checks
- [ ] All tests passing: `npm test`
- [ ] Security audit clean: `npm run security:audit`
- [ ] Build successful: `npm run build`
- [ ] No debug console.log statements
- [ ] TypeScript strict mode passing
- [ ] Linting passing: `npm run lint` (if available)

### 🌳 Branch Preparation
- [ ] Feature branches merged to develop
- [ ] Develop branch up to date with main
- [ ] Release/hotfix branch created (if needed)
- [ ] All CI checks passing on develop

### 📦 Version & Release
- [ ] Documentation PR merged FIRST
- [ ] Version bumped: `npm version [patch|minor|major]`
- [ ] Version tag pushed: `git push origin --tags`
- [ ] PR created from develop/release to main
- [ ] PR reviewed and approved
- [ ] PR merged to main
- [ ] GitHub release created with notes
- [ ] NPM package published (automatic)

### ✅ Post-Release Verification
- [ ] GitHub release visible
- [ ] NPM package updated: `npm view @dollhousemcp/mcp-server`
- [ ] README correct on main branch
- [ ] Tag visible in repository
- [ ] No failed CI runs
- [ ] Develop synced with main

### 📢 Communication
- [ ] Release notes clear and complete
- [ ] Breaking changes highlighted (if any)
- [ ] Migration path documented (if needed)
- [ ] Community notified (if major release)

---

**Remember**: Always update documentation BEFORE bumping version!
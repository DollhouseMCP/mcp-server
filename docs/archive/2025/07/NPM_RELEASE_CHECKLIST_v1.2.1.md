# NPM Release Checklist - v1.2.1

## Pre-Flight Checks ✅ (All Complete)
- [x] Version updated to 1.2.1 in package.json
- [x] Critical bugs fixed (Issues #144, #145)
- [x] All tests passing (372 tests)
- [x] CI/CD all green
- [x] README updated with current information
- [x] Node.js requirement set to >=20.0.0
- [x] Main branch up to date

## NPM Publishing Steps (TODO)

### 1. Create .npmignore
```bash
cat > .npmignore << 'EOF'
# Source files (we publish compiled JS)
src/
__tests__/
__mocks__/

# Development files
.github/
docs/
scripts/
personas/
custom-personas/
test-personas/

# Config files
jest.*.js
jest.*.cjs
jest.*.mjs
tsconfig.*.json
.dockerignore
Dockerfile
docker-compose.yml

# Backup directories
dollhousemcp-backups/
backup-*/

# CI/Build artifacts
coverage/
.nyc_output/
*.log
*.tgz

# Development dependencies config
.editorconfig
.eslintrc*
.prettierrc*

# OS files
.DS_Store
Thumbs.db

# Git files
.gitignore
.gitattributes

# Keep only:
# - dist/
# - package.json
# - package-lock.json
# - README.md
# - LICENSE
# - CHANGELOG.md
EOF
```

### 2. Update README with NPM Installation
Add after the Quick Start section:
```markdown
### NPM Installation (Coming Soon)

```bash
npm install -g dollhousemcp
```

Then add to Claude Desktop config as shown above.
```

### 3. Test the Package
```bash
# Clean build
npm run clean
npm run build

# Test packing
npm pack --dry-run

# Check package contents
npm pack
tar -tzf dollhousemcp-1.2.1.tgz | head -20

# Test local install
npm install -g ./dollhousemcp-1.2.1.tgz
dollhousemcp --version  # Should work

# Uninstall test
npm uninstall -g dollhousemcp
rm dollhousemcp-1.2.1.tgz
```

### 4. NPM Login & Publish
```bash
# Login to npm
npm login
# Username: (your npm username)
# Password: (your npm password)
# Email: (your email)
# OTP: (if 2FA enabled)

# Publish with public access
npm publish --access public

# Verify
npm view dollhousemcp
```

### 5. Create GitHub Release
```bash
# Create release
gh release create v1.2.1 \
  --title "v1.2.1 - Critical Data Protection Release" \
  --notes "$(cat <<'EOF'
## Critical Bug Fixes

This release includes two critical fixes to protect user data:

### 🛡️ Copy-on-Write for Default Personas (Issue #145)
- Default personas are no longer modified in place
- Editing a default persona creates a copy with unique ID
- Prevents git conflicts and preserves originals

### 💾 User Personas Included in Backups (Issue #144)
- Backups now include all user-created personas
- Prevents data loss during rollback operations
- Comprehensive backup system for all persona files

### 📦 NPM Publishing Preparation
- Updated to Node.js 20+ requirement
- Package optimized for npm distribution
- Enhanced documentation and README

### 📊 Statistics
- 372 tests all passing
- Package size: ~280 KB
- Node.js requirement: >=20.0.0
- npm requirement: >=10.0.0

### 🙏 Thanks
Thanks to all contributors and testers who helped identify these critical issues!

**Full Changelog**: https://github.com/mickdarling/DollhouseMCP/compare/v1.2.0...v1.2.1
EOF
)"
```

### 6. Post-Publish Verification
```bash
# Install from npm
npm install -g dollhousemcp

# Test it works
dollhousemcp --version

# Check npm page
open https://www.npmjs.com/package/dollhousemcp
```

### 7. Update Documentation
- [ ] Update README to show npm installation as primary method
- [ ] Tweet/announce the release
- [ ] Update any external documentation

## Potential Issues & Solutions

### If npm publish fails:
1. **Name taken**: Package name might be taken
   - Check: `npm view dollhousemcp`
   - Solution: May need scoped package `@mickdarling/dollhousemcp`

2. **Auth issues**: 
   - Ensure npm login worked
   - Check: `npm whoami`

3. **Package too large**:
   - Review .npmignore
   - Ensure dist/ is built
   - Check with `npm pack --dry-run`

### If GitHub release fails:
1. Check you're on main branch
2. Ensure tag doesn't exist: `git tag -l v1.2.1`
3. Use `--target main` if needed

## Success Criteria
- [ ] Package published to npm
- [ ] `npm install -g dollhousemcp` works
- [ ] GitHub release created
- [ ] Documentation updated
- [ ] Version tag in git
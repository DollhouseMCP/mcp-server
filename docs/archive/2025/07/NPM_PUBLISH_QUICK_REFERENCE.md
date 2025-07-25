# NPM Publishing Quick Reference

## Pre-Publishing Checklist

### 1. Merge PR #150 First
```bash
gh pr view 150
gh pr merge 150 --merge  # After CI passes
```

### 2. Final Version Check
```bash
# Ensure package.json has correct version
grep version package.json  # Should be 1.2.0

# Verify engines are correct
grep -A2 engines package.json  # Should show node >=20.0.0, npm >=10.0.0
```

### 3. Create .npmignore
```bash
cat > .npmignore << 'EOF'
# Source files
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

# Keep only:
# - dist/
# - package.json
# - README.md
# - LICENSE
# - CHANGELOG.md
EOF
```

### 4. Build Final Package
```bash
npm run clean
npm run build
npm pack --dry-run  # Check what will be included
```

### 5. Update README for NPM
Add installation instructions at the top:
```markdown
## Installation

```bash
npm install -g dollhousemcp
```

## Quick Start

1. Install globally:
   ```bash
   npm install -g dollhousemcp
   ```

2. Configure Claude Desktop...
```

### 6. Final Tests
```bash
# Test the packed version
npm pack
npm install -g dollhousemcp-1.2.0.tgz
dollhousemcp --version  # Should work

# Cleanup
npm uninstall -g dollhousemcp
rm dollhousemcp-1.2.0.tgz
```

### 7. Publish to NPM
```bash
# Login to npm (if not already)
npm login

# Publish with public access
npm publish --access public

# Verify it worked
npm view dollhousemcp
```

### 8. Create GitHub Release
```bash
gh release create v1.2.0 \
  --title "v1.2.0 - Security & Reliability Release" \
  --notes "See CHANGELOG.md for details" \
  --target main
```

### 9. Post-Publish Verification
```bash
# Install from npm registry
npm install -g dollhousemcp

# Verify it runs
dollhousemcp --version
```

## Important Notes

1. **Node.js Compatibility**: We support Node.js 20+ even though we develop on 24
2. **Package Size**: Should be around 280 KB
3. **Binary Name**: `dollhousemcp` (defined in package.json bin field)
4. **Scope**: Publishing unscoped (not @mickdarling/dollhousemcp)
5. **Access**: Must use `--access public` for first publish

## Rollback Plan

If issues arise:
```bash
# Unpublish (within 72 hours)
npm unpublish dollhousemcp@1.2.0

# Or deprecate
npm deprecate dollhousemcp@1.2.0 "Critical issue found, use 1.2.1"
```

## Next Version Planning

After successful publish:
1. Create issue for v1.3.0 features
2. Update package.json version to 1.3.0-dev
3. Continue development on main branch
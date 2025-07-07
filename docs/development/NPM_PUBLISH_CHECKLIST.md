# NPM Publish Checklist for v1.2.0

## Pre-Publish Verification

### 1. **Ensure Clean Working Directory**
```bash
git status
# Should show: nothing to commit, working tree clean
```

### 2. **Verify You're on Main Branch**
```bash
git branch --show-current
# Should show: main
```

### 3. **Pull Latest Changes**
```bash
git pull origin main
# Should show: Already up to date.
```

### 4. **Verify Git Tags**
```bash
git tag | grep v1.2.0
# Should show: v1.2.0
```

### 5. **Check Package Version**
```bash
cat package.json | grep '"version"'
# Should show: "version": "1.2.0",
```

### 6. **Verify CI Status**
- Check GitHub Actions: https://github.com/mickdarling/DollhouseMCP/actions
- All workflows should be passing (green checkmarks)

## Build and Test

### 7. **Clean Build**
```bash
npm run clean
npm run build
```

### 8. **Run All Tests Locally**
```bash
npm test
# Should show: 309 tests passing
```

### 9. **Check Package Contents**
```bash
npm pack --dry-run
# Review the file list to ensure no sensitive files are included
```

### 10. **Test Package Size**
```bash
npm pack
# Should create: dollhousemcp-1.2.0.tgz
# Size should be approximately 279.3 kB
```

## NPM Authentication

### 11. **Verify NPM Login**
```bash
npm whoami
# Should show your npm username
```

If not logged in:
```bash
npm login
# Enter your npm credentials
```

### 12. **Check Registry**
```bash
npm config get registry
# Should show: https://registry.npmjs.org/
```

## Publish to NPM

### 13. **Final Version Check**
```bash
npm view dollhousemcp version
# Should show the current published version (likely 1.1.0 or lower)
```

### 14. **Publish the Package**
```bash
npm publish
```

Expected output:
```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ dollhousemcp@1.2.0
```

### 15. **Verify Publication**
```bash
npm view dollhousemcp@1.2.0
```

Should show the new version details.

### 16. **Test Installation**
In a temporary directory:
```bash
mkdir /tmp/test-dollhouse
cd /tmp/test-dollhouse
npm install dollhousemcp@1.2.0
ls node_modules/dollhousemcp
```

## Post-Publish Tasks

### 17. **Update GitHub Release**
1. Go to: https://github.com/mickdarling/DollhouseMCP/releases/tag/v1.2.0
2. Edit the release if needed
3. Add npm installation instructions:
   ```
   npm install -g dollhousemcp@1.2.0
   ```

### 18. **Close Related Issues**
Close these issues with a comment about v1.2.0 being published:
- #72 (Rate limiting)
- #73 (Signature verification)
- #125 (Git tags in CI)
- #126 (Windows paths)

### 19. **Update Project Board**
1. Go to: https://github.com/users/mickdarling/projects/1
2. Move v1.2.0 items to "Done" column
3. Update milestone status

### 20. **Announce Release**
Consider announcing in:
- GitHub Discussions
- Discord/Slack channels
- Twitter/Social Media
- Blog post

## Troubleshooting

### If npm publish fails:

1. **403 Forbidden**: Check npm login and permissions
   ```bash
   npm login
   npm whoami
   ```

2. **Version already exists**: The version might already be published
   ```bash
   npm view dollhousemcp versions
   ```

3. **Network issues**: Try again with verbose logging
   ```bash
   npm publish --verbose
   ```

4. **Package too large**: Check npm pack output
   ```bash
   npm pack
   ls -lh *.tgz
   ```

### If you need to unpublish (within 24 hours):
```bash
npm unpublish dollhousemcp@1.2.0
```
Note: npm has strict unpublish policies. Only use in emergencies.

## Success Criteria

- ✅ Package published to npm registry
- ✅ Installation works: `npm install dollhousemcp@1.2.0`
- ✅ Version shows correctly: `npm view dollhousemcp version`
- ✅ No security warnings during install
- ✅ Package size is reasonable (~279 kB)

## Important Notes

1. **Do NOT** bump version after publishing - v1.2.0 is already set
2. **Do NOT** create new git tags - v1.2.0 tag already exists
3. **Do NOT** make code changes - everything is tested and ready
4. This checklist assumes you have npm publish permissions for 'dollhousemcp'

## Quick Command Summary

For experienced users, here's the essential flow:
```bash
# Verify
git status
git pull
npm test

# Build
npm run clean && npm run build

# Publish
npm publish

# Verify
npm view dollhousemcp@1.2.0
```

## Contact for Issues

If you encounter any problems:
- **Author**: Mick Darling (mick@mickdarling.com)
- **Repository**: https://github.com/mickdarling/DollhouseMCP/issues
# NPM Token Configuration Issue

## Issue Found
The NPM release workflow (v1.3.2) failed at the publish step with authentication error:
```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

The NODE_AUTH_TOKEN environment variable was empty in the workflow logs, indicating the NPM_TOKEN secret is not configured in the repository settings.

## Root Cause
The `release-npm.yml` workflow expects an NPM_TOKEN secret to authenticate with npm registry:
```yaml
- name: Publish to NPM
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: npm publish
```

But the secret `NPM_TOKEN` is not set in the repository's GitHub secrets.

## Impact
- ✅ All tests pass
- ✅ Build succeeds
- ✅ Changelog generates
- ❌ NPM publish fails
- ❌ GitHub release not created (depends on NPM publish)
- ❌ Manual intervention required

## Solution Required

### 1. Generate NPM Token
1. Log in to npmjs.com with the account that owns `@dollhousemcp/mcp-server`
2. Go to Account Settings → Access Tokens
3. Click "Generate New Token"
4. Choose "Automation" token type (for CI/CD)
5. Name it: "GitHub Actions - DollhouseMCP"
6. Copy the token (starts with `npm_`)

### 2. Add to GitHub Repository
1. Go to https://github.com/DollhouseMCP/mcp-server/settings/secrets/actions
2. Click "New repository secret"
3. Name: `NPM_TOKEN`
4. Value: Paste the npm token
5. Click "Add secret"

### 3. Verify Setup
After adding the token, the next release should:
1. Authenticate successfully with npm
2. Publish the package
3. Create the GitHub release
4. Complete the entire workflow

## Testing the Fix
Once the token is added:
```bash
# Re-run the failed workflow
gh run rerun [WORKFLOW_RUN_ID]

# Or create a new patch release to test
git checkout main
git pull origin main
git checkout -b release/v1.3.3
npm version patch
# Update CHANGELOG
git add -A
git commit -m "Release v1.3.3"
git push -u origin release/v1.3.3
gh pr create --base main --title "Release v1.3.3"
```

## Security Notes
- NPM tokens should be "Automation" type (read-only for packages, write for publishing)
- Tokens should be rotated periodically
- Never commit tokens to the repository
- Use GitHub secrets for all sensitive values

## Workflow Gaps Summary
After complete testing of v1.3.2 release, we found:
1. ✅ TEST_PERSONAS_DIR environment variable (fixed in PR #400)
2. ✅ Package name consistency (fixed in PR #401)
3. ❌ Automatic tag creation (documented, needs implementation)
4. ❌ NPM_TOKEN secret (this issue, needs configuration)

Once the NPM_TOKEN is configured, the automated release workflow will be fully functional.

---
*Discovered: July 29, 2025 during v1.3.2 release workflow testing*
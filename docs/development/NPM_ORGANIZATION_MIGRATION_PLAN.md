# NPM Organization Migration Plan - July 10, 2025

## Current Status (5:00 PM Thursday, July 10, 2025)
- ✅ v1.2.2 successfully published to NPM as `@mickdarling/dollhousemcp`
- ✅ GitHub release created
- ✅ NPM organization "DollhouseMCP" created
- ⏳ Ready to migrate to `@dollhousemcp/mcp-server` (Option B chosen)

## Migration Plan: Option B - New Package Under Organization

### Why Option B?
- Clean package name matching GitHub structure
- Only ~40 downloads on current package (low impact)
- Better long-term branding alignment
- Clearer organization structure

### Step-by-Step Migration Process

#### 1. Update package.json
```json
{
  "name": "@dollhousemcp/mcp-server",  // Changed from @mickdarling/dollhousemcp
  "version": "1.2.3",  // Bump version for new package
  // ... rest stays the same
}
```

#### 2. Update All References
Files that need updating:
- `package.json` - name field
- `package-lock.json` - will regenerate
- `README.md` - installation instructions
- `__tests__/basic.test.ts` - package name test
- Various documentation files

#### 3. Deprecate Old Package
```bash
npm deprecate @mickdarling/dollhousemcp "Package moved to @dollhousemcp/mcp-server"
```

#### 4. Publish to New Organization
```bash
# Ensure you're logged in
npm login

# Publish to the organization
npm publish --access public
```

#### 5. Update Installation Instructions
Change all documentation from:
```bash
npm install -g @mickdarling/dollhousemcp
```

To:
```bash
npm install -g @dollhousemcp/mcp-server
```

#### 6. Update Claude Desktop Config Examples
For NPM installation:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["@dollhousemcp/mcp-server"]
    }
  }
}
```

### Files Requiring Updates

#### High Priority Files
1. `package.json` - Change name
2. `README.md` - Update all NPM references
3. `__tests__/basic.test.ts:12` - Update expected package name

#### Documentation Files
All files currently referencing `@mickdarling/dollhousemcp`:
- `docs/session-history/2025/07/NPM_AND_GITHUB_URLS_REFERENCE.md`
- `docs/session-history/2025/07/QUICK_REFERENCE_JULY_10_2025.md`
- `docs/session-history/2025/07/ORGANIZATION_MIGRATION_REFERENCE.md`
- Various session summaries

### Testing Checklist
- [ ] Run all tests with new package name
- [ ] Test global installation
- [ ] Test npx execution
- [ ] Verify Claude Desktop integration
- [ ] Check executable name (bin field)

### Post-Migration Tasks
1. Update GitHub repo description with new NPM package name
2. Add redirect/deprecation notice to old package
3. Update any external documentation or announcements
4. Monitor for any user issues

### Benefits After Migration
- **Consistent Branding**: GitHub and NPM both under DollhouseMCP
- **Professional Appearance**: Organization-scoped packages look more official
- **Future Expansion**: Easy to add more packages under same org
- **Clear Structure**: `@dollhousemcp/mcp-server`, `@dollhousemcp/cli`, etc.

## Next Session Quick Start
```bash
# 1. Update package.json name
# 2. Run tests to ensure they pass
npm test

# 3. Build the project
npm run build

# 4. Publish to organization
npm publish --access public

# 5. Deprecate old package
npm deprecate @mickdarling/dollhousemcp "Package moved to @dollhousemcp/mcp-server"
```

## Important Notes
- The NPM organization "DollhouseMCP" is already created
- Only ~40 downloads on current package (minimal disruption)
- Version should be bumped (suggest 1.2.3 or 1.3.0)
- Remember to use `--access public` when publishing to org
# NPM Organization Migration Plan

## Current State (July 11, 2025)
- **Current package**: `@mickdarling/dollhousemcp` (v1.2.4)
- **Target package**: `@dollhousemcp/mcp-server` (or similar)
- **Reason**: Move from personal namespace to organization namespace

## Migration Steps

### 1. Create NPM Organization
```bash
# If not already created
npm org create dollhousemcp
```

### 2. Update package.json
```json
{
  "name": "@dollhousemcp/mcp-server",
  "version": "1.2.5",
  // ... rest of config
}
```

### 3. Deprecate Old Package
```bash
npm deprecate @mickdarling/dollhousemcp@"*" "Package moved to @dollhousemcp/mcp-server"
```

### 4. Publish to New Location
```bash
npm publish --access public
```

### 5. Update Documentation
- README.md installation instructions
- GitHub repository description
- Any blog posts or announcements

## Considerations

### Why This Is Safe Now
- Very new project (just published July 10, 2025)
- Minimal real user adoption yet
- Mostly automated/bot downloads
- Good time to make the change before real adoption

### Benefits
- Professional organization namespace
- Consistent with GitHub org (DollhouseMCP)
- Room for multiple packages under org
- Better for long-term branding

### Package Naming Options
1. `@dollhousemcp/mcp-server` (descriptive)
2. `@dollhousemcp/server` (shorter)
3. `@dollhousemcp/core` (if planning multiple packages)

### Update Locations
- [ ] package.json name field
- [ ] README.md install command
- [ ] GitHub repo description
- [ ] Any CI/CD references
- [ ] Documentation examples

## Example Update Commit
```bash
git commit -m "chore: Migrate npm package to @dollhousemcp organization

- Change package name from @mickdarling/dollhousemcp to @dollhousemcp/mcp-server
- Update all documentation references
- Deprecate old package with migration message
- Version bump to 1.2.5 for fresh start"
```

## Post-Migration
1. Monitor for any user issues
2. Update any external references
3. Consider adding package migration note to README
4. Set up npm org permissions/teams if needed
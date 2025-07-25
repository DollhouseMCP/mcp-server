# Migration Lessons Learned - July 8, 2025

## 🎓 Key Insights from Today's Migration

### NPM Publishing Insights

#### What Worked
- **Classic automation tokens** are essential for first-time publishing
- **Scoped packages** (`@username/package`) solve permission issues
- **`.npmignore`** dramatically reduces package size (1.1MB → 209KB)
- **Dry run testing** (`npm pack --dry-run`) catches issues early

#### What Didn't Work
- Granular access tokens fail with "403 Forbidden" for new packages
- Unscoped package names require organization-level permissions
- OTP (One-Time Password) is cumbersome - tokens are better

### GitHub Organization Migration

#### Smooth Processes
- Repository transfers preserve all issues, stars, and history
- GitHub automatically creates redirects from old URLs
- GraphQL API is powerful for project management
- Organization creation is free and instant

#### Challenges Overcome
- Can't transfer GitHub Projects directly (must recreate)
- Can't add options to existing single-select fields (must recreate)
- Area labels needed manual mapping to field values
- Some GitHub APIs have changed (description now required for options)

### Project Management Automation

#### GraphQL Capabilities Discovered
- ✅ CAN create project fields programmatically
- ✅ CAN update field values in bulk
- ✅ CAN migrate complex metadata between projects
- ❌ CANNOT modify existing field options (must delete/recreate)
- ❌ CANNOT transfer projects between accounts

#### Useful Mutations
```graphql
# These are the key mutations we used
createProjectV2Field        # Create new fields
updateProjectV2ItemFieldValue # Update field values
deleteProjectV2Field        # Remove fields
```

### Technical Discoveries

#### Path Updates Required
When migrating organizations, update:
1. Source code constants (`src/config/constants.ts`)
2. API URLs in all service files
3. Documentation links
4. GitHub Actions configurations
5. Issue templates
6. Clone commands in docs

#### Git Remote Management
```bash
# Simple command that saved time
git remote set-url origin https://github.com/DollhouseMCP/mcp-server.git
```

### Process Improvements for Next Time

#### If Doing Another Migration
1. **Create field structure first** - Before migrating issues
2. **Script everything** - Manual updates are error-prone
3. **Check API docs** - GitHub's APIs evolve quickly
4. **Test tokens early** - NPM auth is tricky
5. **Document field IDs** - You'll need them for updates

#### Automation Opportunities
- Create reusable migration scripts
- Build field mapping utilities
- Automate URL updates with sed/awk
- Use GitHub CLI more extensively

### Community Insights

#### Organization Benefits
- Professional appearance attracts contributors
- Scalable structure for multiple repos
- Clear separation from personal projects
- Better discovery through GitHub explore

#### NPM Publishing Benefits
- One-command installation for users
- Automatic updates through npm
- Version management built-in
- Download statistics for tracking adoption

## 🔮 Future Considerations

### For v1.3.0 Release
- Consider waiting for Node.js 24 LTS (October 2025)
- Plan coordinated npm + GitHub release
- Automate the release process
- Create release checklist

### For Organization Growth
- Add more collaborators with proper permissions
- Create contribution guidelines
- Set up GitHub Discussions
- Consider GitHub Sponsors

### For Project Management
- Explore GitHub Projects automation
- Create project templates
- Build custom workflows
- Track velocity metrics

## 📝 Quick Command Reference

### Commands That Saved Time
```bash
# Bulk update files
find . -name "*.ts" -exec sed -i '' 's|old|new|g' {} \;

# Check what needs updating
grep -r "mickdarling/DollhouseMCP" . --include="*.ts" | wc -l

# Project management via CLI
gh project item-list 1 --owner DollhouseMCP --limit 100

# Batch GraphQL operations
gh api graphql --paginate -f query='...'
```

### Useful GitHub CLI Patterns
```bash
# Organization management
gh api orgs/DollhouseMCP --method PATCH -f key=value

# Project field creation
gh api graphql -f query='mutation {...}'

# Bulk issue updates
gh issue list --json number,labels | jq '...'
```

## 🎯 Time Estimates for Future

Based on today's experience:
- Repository transfer: 5 minutes
- Project recreation: 30 minutes
- Field migration: 45 minutes
- Code updates: 60 minutes
- Documentation: 30 minutes
- **Total migration**: ~3 hours

## 💡 Pro Tips

1. **Always backup** before major changes
2. **Test in small batches** when using GraphQL mutations
3. **Document field IDs** immediately after creation
4. **Use GitHub CLI** instead of web UI for repetitive tasks
5. **Create scripts** for any multi-step process

This migration was a complete success thanks to careful planning and the powerful GitHub APIs!
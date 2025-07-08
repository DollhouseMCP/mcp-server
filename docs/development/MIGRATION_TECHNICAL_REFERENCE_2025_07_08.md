# Migration Technical Reference - July 8, 2025

## Critical Information for Next Session

### NPM Package Status
- **Package Name**: `@mickdarling/dollhousemcp`
- **Version**: 1.2.1 (published successfully)
- **Registry**: https://www.npmjs.com/package/@mickdarling/dollhousemcp
- **Note**: Package name is scoped to @mickdarling due to npm token limitations
- **Installation**: `npm install -g @mickdarling/dollhousemcp`

### GitHub Organization Structure
```
Organization: DollhouseMCP
├── Repositories:
│   ├── mcp-server (main codebase)
│   ├── personas (marketplace)
│   └── .github (org profile)
├── Project: 
│   └── DollhouseMCP Roadmap (57 issues)
└── Settings:
    ├── Description: "Professional AI persona management platform with marketplace ecosystem"
    ├── Email: mick@mickdarling.com
    ├── Website: https://dollhousemcp.com
    └── Location: United States
```

### Authentication & Tokens
- **NPM Token**: Classic automation token (stored in npm config)
- **GitHub Token**: Already configured with `gh` CLI
- **Important**: Never use granular tokens for first-time npm publishing

### Key API Endpoints Updated
```javascript
// Core repository
https://api.github.com/repos/DollhouseMCP/mcp-server

// Marketplace
https://api.github.com/repos/DollhouseMCP/personas/contents/personas

// Releases
https://api.github.com/repos/DollhouseMCP/mcp-server/releases/latest
```

### Project Management Details
- **Project URL**: https://github.com/orgs/DollhouseMCP/projects/1
- **Project ID**: PVT_kwDODRuHjc4A9b0K
- **Total Issues**: 57
- **Custom Fields**: 9 (Priority, Size, Area, Effort, Sprint, Iteration, Estimate, Start date, End date)

### GraphQL Mutations for Projects
```graphql
# Create field
mutation createProjectV2Field($projectId: ID!, $dataType: ProjectV2CustomFieldType!, ...) 

# Update item field
mutation updateProjectV2ItemFieldValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!)

# Delete field (if needed)
mutation deleteProjectV2Field($fieldId: ID!)
```

### Files Still Needing Updates (Low Priority)
- Historical documentation in docs/development/
- Some test files with hardcoded URLs
- Old session summaries (OK to keep for history)

### Known Issues
1. **package.json bin warning**: npm warns about bin field format (non-critical)
2. **Git config**: Local commits show "mick@TheMachine.local" (cosmetic)
3. **Area field**: Had to delete and recreate to add all options

### Quick Commands for Next Session
```bash
# Check npm package
npm view @mickdarling/dollhousemcp

# Update organization
gh api orgs/DollhouseMCP --method PATCH -f description="..."

# View project
gh project view 1 --owner DollhouseMCP

# Check repos
gh repo list DollhouseMCP
```

### What's Working Perfectly
- ✅ All source code using new URLs
- ✅ Marketplace integration with new repos
- ✅ Auto-update system checking correct repo
- ✅ NPM package installation and usage
- ✅ GitHub redirects from old URLs
- ✅ Project with all issues and metadata

### Next Development Priorities
1. Fix remaining test file references (low priority)
2. Update package.json in next release
3. Continue feature development
4. Build community around new organization
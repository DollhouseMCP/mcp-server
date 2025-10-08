# GitHub Organization Migration Reference

## 🏢 Organization Details
- **Organization**: https://github.com/DollhouseMCP
- **Plan**: Free (perfect for open source)
- **Owner**: @mickdarling
- **Created**: July 8, 2025

## 📁 Repository Structure

### Current Repositories
```
github.com/DollhouseMCP/
└── mcp-server (main MCP server - transferred from mickdarling/DollhouseMCP)
```

### Planned Future Structure
```
github.com/DollhouseMCP/
├── mcp-server       # Main MCP server (current)
├── personas         # Persona marketplace (to transfer)
├── website          # dollhousemcp.com source (future)
├── docs             # Documentation site (future)
├── skills           # Skills marketplace (future)
├── agents           # Agents marketplace (future)
└── tools            # Tools marketplace (future)
```

## 🔄 Migration Process Completed

### 1. Repository Transfer
- **From**: `mickdarling/DollhouseMCP`
- **To**: `DollhouseMCP/mcp-server`
- **Method**: GitHub Settings → Transfer Ownership
- **Automatic redirects**: GitHub maintains old URL redirects

### 2. Local Repository Updates
```bash
# Update remote URL
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP
git remote set-url origin https://github.com/DollhouseMCP/mcp-server.git

# Verify
git remote -v
```

### 3. URL Updates Required (ALL COMPLETED)

#### package.json
```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/DollhouseMCP/mcp-server.git"
  },
  "bugs": {
    "url": "https://github.com/DollhouseMCP/mcp-server/issues"
  }
}
```

#### README.md Badge Updates (10+ badges)
- Core Build & Test workflow badges
- Build Artifacts workflow badges  
- Extended Node Compatibility badges
- Docker Testing badges
- Platform support badges (Windows/macOS/Linux)
- Test Coverage badges
- Auto-Update badges

#### README.md Content Updates
```markdown
# Repository links in header
**🌐 Repository**: https://github.com/DollhouseMCP/mcp-server

# Clone commands throughout README
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server  # Changed from "cd DollhouseMCP"
```

## 🧪 Test Fixes Required

### Basic Test Package Name
**File**: `__tests__/basic.test.ts:12`
```typescript
// BEFORE (failed)
expect(packageJson.name).toBe('dollhousemcp');

// AFTER (fixed)
expect(packageJson.name).toBe('@mickdarling/dollhousemcp');
```

**Why**: Package name changed to scoped for npm publishing

## 🚨 Post-Migration Checklist

### ✅ Completed
- [x] Repository transferred to organization
- [x] Local git remote updated
- [x] package.json repository URLs updated
- [x] All README badge URLs updated (10+ badges)
- [x] All clone commands updated
- [x] Basic test fixed for scoped package name
- [x] GitHub release created with new URLs
- [x] Dependabot PR #151 passing

### 🔄 Still Needed (Future Sessions)
- [ ] Transfer personas repository: `mickdarling/DollhouseMCP-Personas` → `DollhouseMCP/personas`
- [ ] Set up organization profile with description/logo
- [ ] Add organization README
- [ ] Configure organization-level settings
- [ ] Plan future repository structure

## 💡 Best Practices Learned

### Organization Naming
- ✅ **DollhouseMCP**: Clean, matches project name
- ✅ **No confusion**: Clear it's the official org
- ✅ **Scalable**: Room for multiple related repos

### Repository Naming
- ✅ **mcp-server**: Descriptive, not redundant
- ✅ **Future-proof**: Allows personas, website, docs repos
- ✅ **Clear purpose**: Immediately obvious what it contains

### Migration Strategy
1. **Create organization first**
2. **Transfer repositories via GitHub UI** (easier than CLI)
3. **Update ALL URLs systematically** (package.json, README, badges)
4. **Fix tests that depend on package/repo names**
5. **Verify CI passes** before considering complete

## 🔗 Important URLs Updated

### GitHub URLs
- Repository: `DollhouseMCP/mcp-server`
- Issues: `DollhouseMCP/mcp-server/issues`
- Actions: `DollhouseMCP/mcp-server/actions`
- Releases: `DollhouseMCP/mcp-server/releases`

### NPM
- Package: `@mickdarling/dollhousemcp` (unchanged)
- Still published under personal scope (not org scope)

### Badges (All Updated)
- Workflow status badges point to new repository
- Issue/stars counts point to new repository
- All test/coverage badges updated

This migration positions DollhouseMCP as a professional platform ready for community contributions and multi-repository expansion!
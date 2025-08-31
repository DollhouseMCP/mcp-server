# Repository Metadata Guide

## Overview
This guide explains how to maintain and update the repository metadata to ensure proper display on GitHub and NPM.

## Key Metadata Locations

### 1. Package.json
The `package.json` file contains the primary metadata:
- **name**: `@dollhousemcp/mcp-server` - The NPM package name
- **homepage**: `https://dollhousemcp.com` - The project website
- **repository.url**: `git+https://github.com/DollhouseMCP/mcp-server.git` - Links NPM to GitHub
- **description**: Brief description of the project

### 2. GitHub Repository Settings
These settings control what appears in the GitHub UI:
- **Homepage URL**: Should match package.json homepage
- **Topics**: Help with discoverability
- **Description**: Shows in the About section

## Updating Repository Metadata

### Automatic Update Script
Run the provided script to sync settings:
```bash
./scripts/update-repo-settings.sh
```

This script:
1. Reads the homepage URL from package.json
2. Updates the GitHub repository homepage setting
3. Adds relevant topics for discoverability
4. Verifies the changes

### Manual Update via GitHub CLI
```bash
# Set homepage URL
gh repo edit DollhouseMCP/mcp-server --homepage "https://dollhousemcp.com"

# Add topics
gh repo edit DollhouseMCP/mcp-server --add-topic "npm-package"

# Update description
gh repo edit DollhouseMCP/mcp-server --description "Your description here"
```

## NPM Package Link Display

GitHub automatically displays the NPM package link in the About section when:

1. **package.json exists** in the repository root
2. **Package is published** to NPM registry
3. **Repository field matches** - The `repository.url` in package.json points to the GitHub repository

### Troubleshooting NPM Link Not Showing

If the NPM package link doesn't appear:

1. **Verify package.json repository field**:
   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/DollhouseMCP/mcp-server.git"
   }
   ```

2. **Check NPM publication**:
   ```bash
   npm view @dollhousemcp/mcp-server
   ```

3. **Wait for GitHub to update** - It can take a few hours for GitHub to detect and display the NPM package link

4. **Check package visibility** - Ensure the package is public on NPM

## Expected Display Locations

### GitHub Repository Page (Right Sidebar - About Section)
- 🔗 Website link (from homepage URL)
- 📦 NPM package link (auto-detected)
- 📝 Description
- 🏷️ Topics

### NPM Package Page (Right Sidebar)
- Homepage link (from package.json homepage)
- Repository link (from package.json repository)
- Issues link (from package.json bugs)

## Best Practices

1. **Keep metadata synchronized** across package.json and GitHub settings
2. **Run update script** after changing package.json metadata
3. **Use descriptive topics** to improve discoverability
4. **Update version** in package.json before releases
5. **Maintain accurate description** in both locations

## Related Files
- `/package.json` - Primary metadata source
- `/scripts/update-repo-settings.sh` - Automation script
- `/README.md` - Project documentation with links
# NPM Package Fixes Needed for v1.2.5

## Critical Issue: Missing Personas in NPM Package

### Current Problem
- `.npmignore` excludes `personas/` directory (line 27)
- Users installing via npm get empty personas directory
- Had to manually copy personas to user's installation

### Fix Already Applied (needs release)
```diff
# .npmignore line 26-28
# Dollhouse specific
- personas/
+ # personas/  # Include personas in npm package
claude.md
```

### Verification Steps
```bash
# Before publishing v1.2.5
npm pack --dry-run | grep personas
# Should show: personas/business-consultant.md, etc.

# After publishing
npm install -g @mickdarling/dollhousemcp@1.2.5
ls $(npm root -g)/@mickdarling/dollhousemcp/personas/
# Should show all 5 default personas
```

## Additional NPM Considerations

### 1. Package Size
Current: 372.2 kB packed, 1.9 MB unpacked
- Consider if we need all the duplicate dist/src files
- TypeScript declaration maps might not be needed

### 2. Binary Path
```json
"bin": {
  "dollhousemcp": "dist/index.js"
}
```
- Currently not used since we use npx
- Consider adding shebang to dist/index.js for direct execution

### 3. Default Personas to Include
1. business-consultant.md
2. creative-writer.md
3. debug-detective.md
4. eli5-explainer.md
5. technical-analyst.md

### 4. User Experience Improvements
- Consider adding post-install script to show config instructions
- Maybe create `dollhousemcp --show-config` command
- Add version check on startup
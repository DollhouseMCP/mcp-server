# User Pain Points Discovered - July 10, 2025

## 1. JSON Configuration Merging 🔴 CRITICAL

### The Problem
Users don't understand how to merge MCP server configurations. Common mistakes:
- Creating duplicate `mcpServers` keys
- Nesting servers incorrectly
- Not knowing where to add new servers

### What Users See
```json
// They have this:
{
  "mcpServers": {
    "whois": {...}
  }
}

// Documentation shows this:
{
  "mcpServers": {
    "dollhousemcp": {...}
  }
}

// They don't know how to combine them!
```

### Solutions Implemented
1. Created visual JSON merge guide with ❌ wrong ways and ✅ right way
2. Added Quick Start section to README
3. Provided complete config examples

### Future Improvements
- Consider a CLI tool: `dollhousemcp --add-to-config`
- Video tutorial showing the merge process
- Interactive config builder on website

## 2. NPM Installation Path Confusion

### The Problem
Users don't know where npm installs global packages, especially on macOS with Homebrew.

### Locations by System
- **Homebrew macOS**: `/opt/homebrew/lib/node_modules/`
- **Intel macOS**: `/usr/local/lib/node_modules/`
- **Windows**: `%AppData%\npm\node_modules\`
- **Linux**: `/usr/lib/node_modules/`

### Future Improvements
- Add `dollhousemcp --show-install-path` command
- Document common paths in README
- Auto-detect in setup script

## 3. Missing Default Personas

### The Problem
NPM package doesn't include personas due to .npmignore

### User Experience
- Install seems successful
- Claude Desktop loads server
- `list_personas` returns empty
- User thinks installation failed

### Fix
- Include personas in npm package (v1.2.5)
- Consider embedding default personas in code as fallback

## 4. Console Output Breaking MCP

### The Problem
Any console.log/error/warn breaks MCP protocol

### Symptoms Users See
- "Unexpected token" errors
- Server appears to crash
- Connection lost messages
- No clear indication of what went wrong

### Solution
- MCP-safe logger that suppresses output during protocol
- Better error messages in Claude Desktop would help

## 5. Setup Complexity

### Current Process
1. Install package
2. Find config file location
3. Edit JSON (merge correctly)
4. Restart Claude Desktop
5. Hope it works

### Desired Process
1. `npm install -g @mickdarling/dollhousemcp`
2. `dollhousemcp --setup-claude`
3. Done!

## Recommendations for Better UX

1. **Automated Setup**
   - CLI command to add to Claude config
   - Detect existing config and merge properly
   - Show success confirmation

2. **Better Error Messages**
   - Clear indication when personas directory is empty
   - Helpful messages when config is wrong
   - Log file location for debugging

3. **Visual Aids**
   - Screenshots in README
   - Config file examples for common scenarios
   - Video walkthrough

4. **Testing Tools**
   - `dollhousemcp --test-connection`
   - `dollhousemcp --validate-config`
   - `dollhousemcp --list-personas` (CLI mode)

## Key Insight
The gap between "npm install" and "working in Claude" is too large. Users need more hand-holding through the configuration process.
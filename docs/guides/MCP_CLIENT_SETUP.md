# MCP Client Setup Guide for DollhouseMCP

Complete configuration guide for setting up DollhouseMCP with various MCP-compatible clients.

## Overview

DollhouseMCP is a platform-agnostic MCP server that works with any client supporting stdio transport and JSON-RPC communication. This guide provides detailed setup instructions for confirmed working clients.

## Confirmed Working Clients

- ✅ **Claude Desktop** - Anthropic's desktop AI assistant
- ✅ **Claude Code** - VS Code integration with Claude
- ✅ **Bolt AI** - AI-powered development platform
- ✅ **Gemini** - Google's AI platform (with stdio MCP support)

---

## Claude Desktop

### Installation

1. Install DollhouseMCP:
```bash
mkdir ~/mcp-servers
cd ~/mcp-servers
npm install @dollhousemcp/mcp-server
```

2. Locate your config file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

3. Add DollhouseMCP configuration:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js"]
    }
  }
}
```

4. Replace `/Users/YOUR_USERNAME` with your actual home directory path

5. Restart Claude Desktop

### Verification

In Claude Desktop, try:
```
list_elements type="personas"
```

You should see available personas from your portfolio.

### Troubleshooting

**Issue**: Claude Desktop doesn't show DollhouseMCP
**Solution**:
- Verify config file location is correct
- Check JSON syntax is valid (use JSONLint)
- Ensure Node.js is installed and in PATH
- Restart Claude Desktop completely

**Issue**: "command not found: node"
**Solution**:
- Install Node.js from https://nodejs.org
- Add Node.js to your PATH
- Use absolute path to node: `"command": "/usr/local/bin/node"`

---

## Claude Code

### Installation

Claude Code supports MCP servers through two main configuration methods:

#### Method 1: CLI Wizard (Recommended)

1. Install DollhouseMCP:
```bash
npm install -g @dollhousemcp/mcp-server
```

2. Use Claude Code's CLI to add the server:
```bash
claude mcp add dollhousemcp dollhousemcp --scope user
```

This adds DollhouseMCP to your user-level configuration for use across all projects.

#### Method 2: Direct Configuration File

1. Install DollhouseMCP:
```bash
mkdir ~/mcp-servers
cd ~/mcp-servers
npm install @dollhousemcp/mcp-server
```

2. Edit your Claude Code configuration file:

**Config Locations**:
- **User scope** (recommended): `~/.claude.json`
- **Project scope**: `.mcp.json` in project root
- **Local scope**: Project-specific user settings

3. Add DollhouseMCP configuration:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {},
      "cwd": "/Users/YOUR_USERNAME/mcp-servers"
    }
  }
}
```

4. Reload VS Code window

### Configuration Scopes

- **User scope**: Personal tooling across all projects (`~/.claude.json`)
- **Project scope**: Team collaboration (`.mcp.json` in repo)
- **Local scope**: Project-specific personal settings

### CLI Commands

- Add server: `claude mcp add [name] --scope user`
- List servers: `claude mcp list`
- Remove server: `claude mcp remove [name]`

### Verification

In Claude Code, try:
```
list_elements type="personas"
```

### Troubleshooting

**Issue**: MCP server not connecting
**Solution**:
- Check VS Code output panel for errors
- Verify Node.js is accessible: `which node`
- Check config file syntax: `cat ~/.claude.json`
- Reload VS Code window after changes

**Issue**: Permission denied
**Solution**:
- Ensure npm modules are readable: `ls -la ~/mcp-servers`
- Don't use sudo for npm install
- Check file permissions on mcp-server directory

**Issue**: Server appears but tools don't work
**Solution**:
- Verify server is in correct scope (user vs project vs local)
- Check Claude Code logs for initialization errors
- Test server manually: `node path/to/dist/index.js`

---

## Gemini (Gemini CLI)

### Prerequisites

- Gemini CLI installed
- Node.js installed and in PATH
- Gemini CLI uses stdio transport for local MCP servers (JSON-RPC based protocol)

### Installation

#### Method 1: CLI Command (Recommended)

1. Install DollhouseMCP globally:
```bash
npm install -g @dollhousemcp/mcp-server
```

2. Use Gemini CLI to add the server:
```bash
gemini mcp add dollhousemcp dollhousemcp
```

This uses stdio transport (the default) and adds the server to your settings.json.

#### Method 2: Manual Configuration

1. Install DollhouseMCP:
```bash
mkdir ~/mcp-servers
cd ~/mcp-servers
npm install @dollhousemcp/mcp-server
```

2. Edit Gemini CLI settings.json file

3. Add DollhouseMCP to `mcpServers` configuration:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {},
      "cwd": "/Users/YOUR_USERNAME/mcp-servers",
      "timeout": 600000
    }
  }
}
```

### Configuration Options

- `command`: Path to executable (for stdio transport)
- `args`: Arguments passed to the command
- `env`: Environment variables for the server process
- `cwd`: Working directory for stdio transport
- `timeout`: Request timeout in milliseconds (default: 600,000ms = 10 minutes)

### JSON-RPC Handshake

Gemini CLI uses standard JSON-RPC protocol:
1. Client sends `initialize` request
2. Server responds with protocol version and capabilities
3. Client sends `initialized` notification to complete setup

### Verification

In Gemini CLI:
```
List available personas using DollhouseMCP
```

Or use direct tool access if supported.

### Troubleshooting

**Issue**: Gemini rejects DollhouseMCP as "Claude Desktop only"
**Solution**: This was a documentation issue (fixed in v1.9.15+). DollhouseMCP is fully compatible with any stdio MCP client including Gemini CLI. Ensure you're using latest version.

**Issue**: Server not starting
**Solution**:
- Verify Gemini CLI is installed: `gemini --version`
- Check settings.json syntax is valid
- Test server manually: `node path/to/dist/index.js`
- Check Gemini CLI logs for errors

**Issue**: Connection timeout
**Solution**:
- Increase timeout in server configuration
- Check system resources (memory, CPU)
- Verify Node.js process can start
- Check for port conflicts (if using HTTP transport)

**Issue**: Tools not discovered
**Solution**:
- Ensure server completed initialization handshake
- Check server capabilities in logs
- Verify JSON-RPC communication succeeded

---

## Bolt AI

**Note**: BoltAI is a macOS/iOS app. Configuration differs between desktop and mobile.

### Desktop (macOS) Installation

#### Method 1: Import from Another App

If you already use Claude Desktop or Cursor with DollhouseMCP:

1. Open BoltAI
2. Go to **Settings > Plugins**
3. Click the **ellipsis button (...)**
4. Select **"Import from Claude"** or **"Import from Cursor"**
5. BoltAI will automatically import your MCP server configurations

#### Method 2: Direct Configuration

1. Install DollhouseMCP:
```bash
mkdir ~/mcp-servers
cd ~/mcp-servers
npm install @dollhousemcp/mcp-server
```

2. Edit BoltAI's `mcp.json` file:
   - BoltAI stores MCP configuration in `mcp.json`
   - Location accessible via Settings > Plugins

3. Add DollhouseMCP:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js"]
    }
  }
}
```

4. Restart BoltAI

### Using MCP Servers in BoltAI

MCP servers function like AI plugins in BoltAI:
1. Enable the server in the **Plugin Dropdown**
2. Start interacting with the server's tools
3. BoltAI handles stdio communication automatically

### Mobile (iOS) Limitations

**Important**: BoltAI for iOS only supports **remote MCP servers**, not local stdio servers.

- iOS doesn't allow running local servers
- You must use a remote MCP server URL
- Alternative: Use `mcp-remote` to convert local servers to remote endpoints

**Mobile Setup**:
1. Settings > MCP Servers
2. Tap **Add**
3. Enter server name and remote URL
4. Tap **"Add Server"**

### Verification

In BoltAI:
1. Open Plugin Dropdown
2. Enable "dollhousemcp"
3. Test with: `list_elements type="personas"`

### Troubleshooting

**Issue**: Server not appearing in plugin list
**Solution**:
- Verify mcp.json syntax is valid
- Check Node.js is installed and in PATH: `which node`
- Restart BoltAI completely
- Check BoltAI logs for initialization errors

**Issue**: Import from Claude Desktop failed
**Solution**:
- Ensure Claude Desktop has valid configuration
- Check Claude Desktop config location is standard
- Try manual configuration instead

**Issue**: Tools not working after enabling
**Solution**:
- Verify server started successfully
- Check stdio connection is established
- Review BoltAI console for error messages
- Test server manually: `node path/to/dist/index.js`

**Issue**: Mobile app can't connect
**Solution**:
- Remember: iOS requires **remote** MCP servers only
- Use `mcp-remote` to expose local server
- Verify remote URL is accessible from device
- Check network connectivity

---

## Advanced Configuration

### Using npx (Latest Version)

For any MCP client, use npx for automatic updates:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["@dollhousemcp/mcp-server@latest"]
    }
  }
}
```

**Pros**: Always uses latest version
**Cons**: Slower startup, requires internet

### Global Installation

Install once, use everywhere:

```bash
npm install -g @dollhousemcp/mcp-server
```

Configuration:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "dollhousemcp"
    }
  }
}
```

**Note**: Only one global version - local installation recommended for flexibility.

### Environment Variables

Customize portfolio location:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "/path/to/custom/portfolio"
      }
    }
  }
}
```

### Multiple Configurations

Run multiple DollhouseMCP instances with different portfolios:

```json
{
  "mcpServers": {
    "dollhouse-personal": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "~/portfolios/personal"
      }
    },
    "dollhouse-work": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "~/portfolios/work"
      }
    }
  }
}
```

---

## Common Issues Across All Clients

### Server Won't Start

**Symptoms**: MCP client doesn't show DollhouseMCP

**Solutions**:
1. Verify Node.js is installed: `node --version`
2. Check installation path is correct
3. Ensure no typos in configuration
4. Restart MCP client completely
5. Check client logs for error messages

### Permission Errors

**Symptoms**: "EACCES" or "Permission denied" errors

**Solutions**:
1. Check file permissions: `ls -la ~/mcp-servers`
2. Ensure user owns the directory: `chown -R $USER ~/mcp-servers`
3. Don't use sudo for npm install
4. On Windows, run as administrator if needed

### Path Issues

**Symptoms**: "command not found" or "cannot find module"

**Solutions**:
1. Use absolute paths in configuration
2. Verify Node.js is in PATH: `which node` (Unix) or `where node` (Windows)
3. Use full path to node executable in config
4. Check environment variables are correctly set

### JSON Syntax Errors

**Symptoms**: Configuration file rejected

**Solutions**:
1. Validate JSON syntax at jsonlint.com
2. Check for:
   - Missing or extra commas
   - Unmatched quotes
   - Incorrect escaping in paths (Windows)
3. Use a JSON-aware editor

---

## Platform-Specific Notes

### macOS

- Config files typically in `~/Library/Application Support/`
- Use forward slashes in paths
- Node.js usually in `/usr/local/bin/node` or `/opt/homebrew/bin/node`

### Windows

- Config files typically in `%APPDATA%`
- Use forward slashes or escaped backslashes in JSON: `"C:/Users/..."` or `"C:\\Users\\..."`
- Node.js usually in `C:/Program Files/nodejs/node.exe`

### Linux

- Config files typically in `~/.config/`
- Use forward slashes in paths
- Node.js usually in `/usr/bin/node` or `/usr/local/bin/node`

---

## Getting Help

If you continue to experience issues:

1. **Check the logs**: Most MCP clients provide debug logs
2. **Verify versions**: Ensure you're using compatible versions
3. **Test manually**: Run the server directly: `node ~/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js`
4. **GitHub Issues**: https://github.com/DollhouseMCP/mcp-server/issues
5. **Discussions**: https://github.com/DollhouseMCP/mcp-server/discussions

---

## Contributing

Found a working configuration for another MCP client? Please contribute:

1. Test thoroughly with the client
2. Document the setup process
3. Submit a PR adding to this guide

---

*Last updated: October 2025*
*DollhouseMCP version: 1.9.15+*

## 🚀 Quick Start

### Step 1: Install the MCP Server

```bash
# Install globally (recommended)
npm install -g @dollhousemcp/mcp-server
```

### Step 2: Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**Configuration file location by OS:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

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

### Step 3: Restart Claude Desktop

After restarting Claude Desktop, you're ready to use DollhouseMCP! 

Try `list_elements type="personas"` in Claude to get started.
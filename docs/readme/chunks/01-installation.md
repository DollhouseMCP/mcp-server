## 📦 Installation

### Choose Your Installation Method

<table>
<tr>
<th>Method</th>
<th>Best For</th>
<th>Pros</th>
<th>Cons</th>
</tr>
<tr>
<td><strong>Local Install</strong><br>(Recommended)</td>
<td>Most users, multiple configs, customization</td>
<td>✅ Multiple setups<br>✅ Easy backup<br>✅ No permissions</td>
<td>❌ Longer path in config</td>
</tr>
<tr>
<td><strong>npx</strong></td>
<td>Quick testing, always latest</td>
<td>✅ No install<br>✅ Always updated</td>
<td>❌ Slower startup<br>❌ Needs internet</td>
</tr>
<tr>
<td><strong>Global Install</strong></td>
<td>Single shared instance</td>
<td>✅ Short command</td>
<td>❌ Only one version<br>❌ Needs sudo/admin</td>
</tr>
</table>

---

### Method 1: Local Installation (Recommended)

Create a dedicated folder for your MCP servers and install there:

```bash
# Create MCP servers directory
mkdir ~/mcp-servers
cd ~/mcp-servers

# Install DollhouseMCP
npm install @dollhousemcp/mcp-server
```

**Configure Claude Desktop:**

Add to your config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

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

💡 **Pro tip**: Replace `/Users/YOUR_USERNAME` with your actual home directory path.

---

### Method 2: Always Latest with npx

No installation needed! Configure Claude Desktop to always use the latest version:

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

📝 **Note**: The `@latest` tag ensures you always get the newest version. Remove it to use npm's cached version.

---

### Method 3: Global Installation

```bash
# Install globally (may require sudo/admin)
npm install -g @dollhousemcp/mcp-server
```

**Configure Claude Desktop:**

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "dollhousemcp"
    }
  }
}
```

⚠️ **Warning**: Only one version system-wide. Consider local installation for more flexibility.

---

### 🎯 Advanced: Multiple Configurations

Want separate portfolios for different contexts? Create multiple local installations:

```bash
# Personal assistant
mkdir ~/mcp-servers/personal
cd ~/mcp-servers/personal
npm install @dollhousemcp/mcp-server

# Work assistant
mkdir ~/mcp-servers/work
cd ~/mcp-servers/work
npm install @dollhousemcp/mcp-server

# Creative writing
mkdir ~/mcp-servers/creative
cd ~/mcp-servers/creative
npm install @dollhousemcp/mcp-server
```

**Configure each with its own portfolio:**

```json
{
  "mcpServers": {
    "dollhouse-personal": {
      "command": "node",
      "args": ["/Users/YOU/mcp-servers/personal/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "/Users/YOU/portfolios/personal"
      }
    },
    "dollhouse-work": {
      "command": "node",
      "args": ["/Users/YOU/mcp-servers/work/node_modules/@dollhousemcp/mcp-server/dist/index.js"],
      "env": {
        "DOLLHOUSE_PORTFOLIO_DIR": "/Users/YOU/portfolios/work"
      }
    }
  }
}
```

Now you can enable/disable different configurations in Claude Desktop as needed!

---

### ✅ Verify Installation

After configuring and restarting Claude Desktop, test with:

```
list_elements type="personas"
```

You should see your available personas. If not, check the [Troubleshooting](#troubleshooting) section.

---

### 📁 Default Portfolio Location

By default, your elements are stored in:
- **macOS/Linux**: `~/.dollhouse/portfolio/`
- **Windows**: `%USERPROFILE%\.dollhouse\portfolio\`

Use the `DOLLHOUSE_PORTFOLIO_DIR` environment variable to customize this location.
# DollhouseMCP

[![npm version](https://img.shields.io/npm/v/@dollhousemcp/mcp-server.svg)](https://www.npmjs.com/package/@dollhousemcp/mcp-server)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Core Build & Test](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml)

A comprehensive Model Context Protocol (MCP) server that enables dynamic AI persona management with an integrated GitHub-powered collection. DollhouseMCP allows Claude and other compatible AI assistants to activate different behavioral personas while supporting community sharing and monetization.

**🌐 Repository**: https://github.com/DollhouseMCP/mcp-server  
**🏪 Collection**: https://github.com/DollhouseMCP/collection  
**📦 NPM Package**: https://www.npmjs.com/package/@dollhousemcp/mcp-server  
**🌍 Website**: https://dollhousemcp.com

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

### Claude Code

```bash
# All projects (recommended)
claude mcp add -s user dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc

# Current project only
claude mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc
```

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

You should see your available personas. If not, check the [Troubleshooting](#-troubleshooting) section.

---

### 📁 Default Portfolio Location

By default, your elements are stored in:
- **macOS/Linux**: `~/.dollhouse/portfolio/`
- **Windows**: `%USERPROFILE%\.dollhouse\portfolio\`

Use the `DOLLHOUSE_PORTFOLIO_DIR` environment variable to customize this location.

## 🚀 Quick Start

Once installed, try these commands in Claude:

```bash
# Browse available personas
list_elements type="personas"

# Activate a persona
activate_element name="creative-writer" type="personas"

# Browse the community collection
browse_collection type="personas"

# Search for specific content
search_collection query="python" type="skills"
```

> **📘 New User?** Follow our [Roundtrip Workflow Guide](docs/guides/roundtrip-workflow-user-guide.md) for a complete walkthrough of discovering, customizing, and sharing AI elements with the community.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎭 **41 MCP Tools** | Complete portfolio element management through chat interface |
| 🏪 **GitHub Collection** | Browse, search, install, and submit personas to community collection |
| 🔄 **Roundtrip Workflow** | Complete cycle: discover → customize → share → collaborate |
| 📁 **GitHub Portfolio** | Personal repository for storing and versioning your AI elements |
| 👤 **User Identity System** | Environment-based attribution for persona creators |
| 🆔 **Unique ID System** | Advanced ID generation: `{type}_{name}_{author}_{YYYYMMDD}-{HHMMSS}` |
| 💬 **Chat-Based Management** | Create, edit, and validate personas through conversational interface |
| 🔄 **Real-time Operations** | Live editing with automatic version bumping and validation |
| 📦 **NPM Installation** | Install MCP servers from npm with cross-platform support and atomic operations |
| 🛡️ **Data Protection** | Copy-on-write for default personas, comprehensive backup system |
| 🏠 **Local-First Architecture** | Full functionality without cloud dependency |

## 🎨 Portfolio Elements

DollhouseMCP supports multiple element types for customizing AI behavior:

| Element | Purpose | Status |
|---------|---------|--------|
| 🎭 **Personas** | Define AI personality, tone, and behavioral characteristics | ✅ Available |
| 🛠️ **Skills** | Add specific capabilities like code review, data analysis, or creative writing | ✅ Available |
| 📝 **Templates** | Create reusable response formats for emails, reports, documentation | ✅ Available |
| 🤖 **Agents** | Build autonomous assistants that can pursue goals and make decisions | ✅ Available |
| 💬 **Prompts** | Pre-configured conversation starters and structured interactions | 🔄 Coming Soon |
| 🧠 **Memory** | Persistent context storage with retention policies and search capabilities | 🔄 Coming Soon |
| 🎯 **Ensemble** | Orchestrate multiple elements together as one unified entity | 🔄 Coming Soon |

Your portfolio lives in `~/.dollhouse/portfolio/` with elements organized by type.

## 🔧 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| **Personas not loading** | Check `~/.dollhouse/portfolio/personas/` directory exists |
| **Server won't start** | Ensure Node.js v20+ is installed: `node --version` |
| **Collection not working** | Check internet connection and GitHub API access |
| **Tools not appearing in Claude** | Restart Claude Desktop completely after config changes |
| **"Cannot find module" errors** | Reinstall: `npm install -g @dollhousemcp/mcp-server@latest` |
| **Rate limit errors** | Wait 60 seconds; GitHub API has hourly limits |

### Need Help?

- 📖 [Full Troubleshooting Guide](docs/guides/troubleshooting.md)
- 💬 [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- 💭 [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)

## 📚 Resources

### Documentation
- [Roundtrip Workflow Guide](docs/guides/roundtrip-workflow-user-guide.md)
- [Portfolio Setup Guide](docs/guides/portfolio-setup-guide.md)
- [Element Detection Guide](docs/guides/element-detection-guide.md)
- [PersonaTools Migration Guide](docs/archive/migrations/personatools-migration-guide.md)
- [API Documentation](docs/reference/api-reference.md)

### Community
- [GitHub Repository](https://github.com/DollhouseMCP/mcp-server)
- [NPM Package](https://www.npmjs.com/package/@dollhousemcp/mcp-server)
- [Community Collection](https://github.com/DollhouseMCP/collection)
- [Discord Community](https://discord.gg/dollhousemcp) (coming soon)

### Development
- [Contributing Quick Start](CONTRIBUTING.md)
- [Contributor Reference](docs/contributing.md)
- [Security Policy](docs/security/documentation-guide.md)
- [Full Changelog](CHANGELOG.md)

## 📄 License

DollhouseMCP is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

### What this means:
- ✅ **Free to use** for personal and commercial purposes
- ✅ **Modify and distribute** with the same license
- ✅ **Network use** requires source code disclosure
- ✅ **Platform stability** commitments protect users

See [LICENSE](LICENSE) for full terms.

---

*Built with ❤️ by the DollhouseMCP team*
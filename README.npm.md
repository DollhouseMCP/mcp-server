# DollhouseMCP

[![npm version](https://img.shields.io/npm/v/@dollhousemcp/mcp-server.svg)](https://www.npmjs.com/package/@dollhousemcp/mcp-server)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Core Build & Test](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml)

A comprehensive Model Context Protocol (MCP) server that enables dynamic AI persona management with an integrated GitHub-powered collection. DollhouseMCP allows Claude and other compatible AI assistants to activate different behavioral personas while supporting community sharing and monetization.

**🌐 Repository**: https://github.com/DollhouseMCP/mcp-server  
**🏪 Collection**: https://github.com/DollhouseMCP/collection  
**📦 NPM Package**: https://www.npmjs.com/package/@dollhousemcp/mcp-server  
**🌍 Website**: https://dollhousemcp.com (planned)

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

## 🎯 Getting Started

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

> **📘 New User?** Follow our [Roundtrip Workflow Guide](docs/guides/ROUNDTRIP_WORKFLOW_USER_GUIDE.md) for a complete walkthrough of discovering, customizing, and sharing AI elements with the community.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎭 **42 MCP Tools** | Complete portfolio element management through chat interface |
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

- 📖 [Full Troubleshooting Guide](docs/TROUBLESHOOTING.md)
- 💬 [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- 📧 Support: support@dollhousemcp.com

## 📚 Resources

### Documentation
- [Roundtrip Workflow Guide](docs/guides/ROUNDTRIP_WORKFLOW_USER_GUIDE.md)
- [Portfolio Setup Guide](docs/guides/PORTFOLIO_SETUP_GUIDE.md)
- [Element Detection Guide](docs/guides/ELEMENT_DETECTION_GUIDE.md)
- [PersonaTools Migration Guide](docs/PERSONATOOLS_MIGRATION_GUIDE.md)
- [API Documentation](docs/API.md)

### Community
- [GitHub Repository](https://github.com/DollhouseMCP/mcp-server)
- [NPM Package](https://www.npmjs.com/package/@dollhousemcp/mcp-server)
- [Community Collection](https://github.com/DollhouseMCP/collection)
- [Discord Community](https://discord.gg/dollhousemcp) (coming soon)

### Development
- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
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
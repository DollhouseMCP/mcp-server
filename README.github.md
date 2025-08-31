# DollhouseMCP

## Project Status
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)
[![npm version](https://img.shields.io/npm/v/@dollhousemcp/mcp-server.svg)](https://www.npmjs.com/package/@dollhousemcp/mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![GitHub Views](https://komarev.com/ghpvc/?username=DollhouseMCP&repo=mcp-server&label=Repository+Views&style=flat)](https://github.com/DollhouseMCP/mcp-server)

## Build & Quality
[![Core Build & Test](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml)
[![Build Artifacts](https://github.com/DollhouseMCP/mcp-server/actions/workflows/build-artifacts.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/build-artifacts.yml)
[![Test Coverage](https://img.shields.io/badge/Coverage-1858%2B%20Tests-green)](https://github.com/DollhouseMCP/mcp-server/tree/main/__tests__)
[![Enterprise-Grade Security](https://img.shields.io/badge/Security-Enterprise%20Grade-purple)](docs/SECURITY.md)

## Platform Support
[![Windows Build Status](https://img.shields.io/badge/Windows-✓_Tested-0078D4?logo=windows&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "Windows CI Build Status")
[![macOS Build Status](https://img.shields.io/badge/macOS-✓_Tested-000000?logo=apple&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "macOS CI Build Status")
[![Linux Build Status](https://img.shields.io/badge/Linux-✓_Tested-FCC624?logo=linux&logoColor=black)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "Linux CI Build Status")
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/blob/main/Dockerfile)

## Technology
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Extended Node Compatibility](https://github.com/DollhouseMCP/mcp-server/actions/workflows/extended-node-compatibility.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/extended-node-compatibility.yml)
[![Docker Testing](https://github.com/DollhouseMCP/mcp-server/actions/workflows/docker-testing.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/docker-testing.yml)

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
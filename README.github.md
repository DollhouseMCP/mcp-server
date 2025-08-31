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
| 🎭 **40 MCP Tools** | Complete portfolio element management through chat interface |
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

## 🎨 Portfolio System

The DollhouseMCP Portfolio system provides a comprehensive framework for managing AI elements locally and in the cloud.

### Portfolio Structure

Your portfolio is organized by element type:

```
~/.dollhouse/portfolio/
├── personas/       # Behavioral profiles
├── skills/         # Discrete capabilities  
├── templates/      # Reusable content structures
├── agents/         # Goal-oriented actors
├── memories/       # Persistent context
└── ensembles/      # Element combinations
```

### Key Features

- **Local-First Architecture**: All elements stored locally with optional cloud sync
- **GitHub Integration**: Sync your portfolio with GitHub for backup and sharing
- **Version Control**: Full git integration for tracking changes
- **Smart Detection**: Automatically identifies element types from content
- **Flexible Naming**: Use any naming convention you prefer

### Portfolio Management Tools

Use the comprehensive set of MCP tools to manage your portfolio:

- `list_portfolio_elements` - View all elements across types
- `sync_portfolio` - Synchronize with GitHub
- `upload_to_portfolio` - Share elements with the community
- `download_from_portfolio` - Get elements from GitHub

For detailed portfolio documentation, see the [Portfolio Guide](docs/guides/PORTFOLIO_SETUP_GUIDE.md).

## 🔒 Security

DollhouseMCP implements enterprise-grade security measures to protect your data and ensure safe operation.

### Security Features

- **Input Sanitization**: All user inputs validated and sanitized
- **Path Traversal Prevention**: Filesystem access strictly controlled
- **YAML Injection Protection**: Safe parsing with validation
- **Command Injection Prevention**: No direct shell command execution
- **Token Encryption**: OAuth tokens encrypted at rest
- **Rate Limiting**: API calls throttled to prevent abuse
- **Audit Logging**: Security events tracked for analysis

### Security Testing

- **Automated Security Scanning**: GitHub Advanced Security enabled
- **Dependency Scanning**: Automated vulnerability detection
- **Code Analysis**: Static analysis with CodeQL
- **Secret Scanning**: Prevents credential leaks

### Reporting Security Issues

If you discover a security vulnerability, please:

1. **DO NOT** create a public GitHub issue
2. Open a private security advisory on GitHub
3. Include steps to reproduce if possible
4. Allow up to 48 hours for initial response

For more details, see our [Security Policy](SECURITY.md).

## 🛠️ Development

### Getting Started

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

### Development Workflow

1. **Create Feature Branch**: `git checkout -b feature/your-feature`
2. **Make Changes**: Implement your feature or fix
3. **Run Tests**: `npm test`
4. **Build**: `npm run build`
5. **Submit PR**: Create pull request to develop branch

### Available Scripts

- `npm run build` - Compile TypeScript
- `npm run dev` - Development mode with watch
- `npm test` - Run test suite
- `npm run lint` - Check code style
- `npm run typecheck` - TypeScript type checking

### Project Structure

```
src/
├── index.ts           # Main server entry
├── tools/            # MCP tool implementations
├── utils/            # Utility functions
├── types/            # TypeScript definitions
└── elements/         # Element system
```

For detailed development guides, see [Development Documentation](docs/development/).

## 🏭 Architecture

### System Overview

DollhouseMCP follows a modular, extensible architecture built on the Model Context Protocol (MCP) standard.

### Core Components

#### MCP Server
- **Transport**: StdioServerTransport for Claude Desktop integration
- **Protocol**: JSON-RPC 2.0 communication
- **Tools**: 42+ MCP tools for comprehensive functionality

#### Element System
- **BaseElement**: Abstract base class for all elements
- **IElement Interface**: Common contract for elements
- **Element Types**: Personas, Skills, Templates, Agents, Memories, Ensembles

#### Portfolio Manager
- **Local Storage**: File-based element storage
- **GitHub Sync**: Git-based synchronization
- **Version Control**: Full git integration

#### Security Layer
- **Input Validation**: All inputs sanitized
- **Path Security**: Traversal prevention
- **Token Management**: Encrypted storage

### Data Flow

1. **Client Request** → MCP Server
2. **Tool Routing** → Appropriate handler
3. **Element Processing** → Element system
4. **Storage** → Portfolio manager
5. **Response** → Client

For detailed architecture documentation, see [Architecture Guide](docs/ARCHITECTURE.md).

## 🎯 Troubleshooting

### Common Issues

#### MCP Server Not Connecting

**Symptoms**: Claude Desktop doesn't show DollhouseMCP in available servers

**Solutions**:
1. Verify configuration file location:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Check JSON syntax is valid
3. Restart Claude Desktop after configuration changes

#### OAuth Authentication Fails

**Symptoms**: Cannot authenticate with GitHub

**Solutions**:
1. Check internet connection
2. Verify GitHub account has proper permissions
3. Try using Personal Access Token instead:
   ```bash
   export GITHUB_TOKEN=your_pat_token
   ```
4. Clear cached credentials and retry

#### Elements Not Loading

**Symptoms**: Portfolio appears empty

**Solutions**:
1. Check portfolio directory exists: `~/.dollhouse/portfolio/`
2. Verify file permissions
3. Run `list_portfolio_elements` tool to diagnose
4. Check element file format (YAML frontmatter required)

#### Performance Issues

**Symptoms**: Slow response times

**Solutions**:
1. Check portfolio size (large portfolios may be slow)
2. Verify adequate system resources
3. Consider using pagination for large lists
4. Check network latency for GitHub operations

### Getting Help

- **Documentation**: [Full docs](https://github.com/DollhouseMCP/mcp-server/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)

For detailed troubleshooting, see [Troubleshooting Guide](docs/troubleshooting/).

## 🤝 Contributing

We welcome contributions to DollhouseMCP! Here's how you can help:

### Ways to Contribute

- **🐛 Report Bugs**: Open an issue with reproduction steps
- **✨ Request Features**: Suggest new functionality
- **📝 Improve Documentation**: Fix typos, add examples
- **💻 Submit Code**: Fix bugs or implement features
- **🎨 Share Elements**: Contribute personas, skills, templates

### Development Process

1. **Fork the Repository**
   ```bash
   gh repo fork DollhouseMCP/mcp-server
   ```

2. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature
   ```

3. **Make Changes**
   - Follow existing code style
   - Add tests for new functionality
   - Update documentation

4. **Test Thoroughly**
   ```bash
   npm test
   npm run lint
   npm run typecheck
   ```

5. **Submit Pull Request**
   - Target the `develop` branch
   - Provide clear description
   - Reference any related issues

### Code Style

- TypeScript with strict mode
- ESLint configuration provided
- Prettier for formatting
- Comprehensive JSDoc comments

### Commit Messages

Follow conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Testing
- `chore:` Maintenance

### Review Process

1. Automated CI checks must pass
2. Code review by maintainers
3. Address feedback
4. Merge when approved

For detailed guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## 📚 Resources

### Documentation

- **[Quick Start Guide](docs/QUICK_START.md)** - Get up and running quickly
- **[Portfolio Setup](docs/guides/PORTFOLIO_SETUP_GUIDE.md)** - Configure your portfolio
- **[Element Development](docs/ELEMENT_DEVELOPER_GUIDE.md)** - Create custom elements
- **[API Reference](docs/API_REFERENCE.md)** - Complete tool documentation
- **[Architecture Guide](docs/ARCHITECTURE.md)** - System design details
- **[Security Documentation](docs/SECURITY.md)** - Security measures and best practices

### Repositories

- **[Main Repository](https://github.com/DollhouseMCP/mcp-server)** - Core MCP server
- **[Collection](https://github.com/DollhouseMCP/collection)** - Community elements
- **[Developer Kit](https://github.com/DollhouseMCP/developer-kit)** - Development tools

### Community

- **[GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)** - Q&A and ideas
- **[GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)** - Bug reports and features
- **[Discord Server](#)** - Real-time chat (coming soon)

### External Resources

- **[Model Context Protocol](https://modelcontextprotocol.io)** - MCP specification
- **[Claude Desktop](https://claude.ai/download)** - AI assistant with MCP support
- **[Anthropic Documentation](https://docs.anthropic.com)** - Claude documentation

### Learning Materials

- **Tutorials** (coming soon)
  - Building Your First Persona
  - Creating Custom Skills
  - Portfolio Management Best Practices
  - GitHub Integration Setup

- **Videos** (coming soon)
  - Installation Walkthrough
  - Feature Demonstrations
  - Developer Tutorials

### Support

- **GitHub Issues**: [Report issues or request features](https://github.com/DollhouseMCP/mcp-server/issues)
- **Security Issues**: [Private security advisories](https://github.com/DollhouseMCP/mcp-server/security/advisories)
- **Discussions**: [Community Q&A](https://github.com/DollhouseMCP/mcp-server/discussions)

## 🏷️ Version History

### v1.6.11 - August 28, 2025

**Test Reliability & Collection Fixes**: Improved test suite stability and fixed collection system

#### 🔧 Bug Fixes
- **Collection Index URL**: Fixed to use GitHub Pages for better reliability
- **E2E Test Tokens**: Improved token prioritization for CI environments
- **Response Format**: Enhanced compatibility with various response formats
- **Type Safety**: Improved TypeScript types throughout test suite

#### ✨ Improvements
- Added helper functions for better code organization
- Enhanced test reliability in CI/CD pipelines
- General code quality improvements

---

### v1.6.10 - August 28, 2025

**Collection Submission Fix**: Critical fix for collection submission pipeline

#### 🔧 Bug Fixes
- **Collection Submission**: Fixed workflow failing due to missing element types
- **Local Path Parameter**: Added missing localPath parameter to submission tool
- **Duplicate Detection**: Added detection for duplicate portfolio uploads and collection issues

#### ✨ Improvements
- Added comprehensive QA tests for collection submission validation
- Cleaned up QA documentation files
- Updated all documentation to v1.6.10

---

### v1.6.9 - August 26, 2025

**Critical Fixes**: Fixed OAuth helper NPM packaging and performance testing workflow

#### 🔧 Bug Fixes
- **OAuth NPM Packaging**: Fixed missing `oauth-helper.mjs` file in NPM distribution
  - File was present in repository but not included in published package
  - OAuth authentication now works correctly for NPM users
- **Performance Tests**: Fixed CI workflow running all tests instead of performance tests
  - Performance monitoring now works correctly in GitHub Actions

---

### v1.6.3 - August 25, 2025

**OAuth Authentication Fix**: Fixed invalid OAuth client ID and improved error handling

#### 🔧 Bug Fixes
- **OAuth Client ID**: Updated from incorrect ID to correct `Ov23li9gyNZP6m9aJ2EP`
- **Error Messages**: Improved clarity of OAuth error messages for better debugging
- **Setup Tool**: Fixed `setup_github_auth` tool to properly handle authentication flow

---

### v1.6.2 - August 25, 2025

**Critical Hotfix**: Fixed OAuth default client ID not being used in `setup_github_auth` tool

#### 🔧 Bug Fixes
- **OAuth Default Client**: Fixed `setup_github_auth` tool not using default client ID when none provided
- **Authentication Flow**: Restored ability to authenticate without manual client ID entry

#### 📝 Documentation
- Added troubleshooting guide for OAuth issues
- Updated setup instructions with clearer OAuth configuration steps

---

### v1.6.1 - August 25, 2025

**⚠️ Breaking Changes**:
- 🔄 **Serialization Format Change** - `BaseElement.serialize()` now returns markdown with YAML frontmatter instead of JSON

#### 🔧 Bug Fixes
- **Serialization Format**: Fixed `BaseElement.serialize()` to return markdown format
  - Changed from JSON string to markdown with YAML frontmatter
  - Maintains consistency with existing persona format
  - Fixes portfolio round-trip workflow

#### ✨ Improvements
- **Code Quality**: Extracted validation methods into ValidationService
- **Error Handling**: Improved validation error messages with specific field information
- **Test Coverage**: Added comprehensive tests for markdown serialization

---

### v1.6.0 - August 25, 2025

**🚀 Major Release: Portfolio System & OAuth Integration**

This release introduces the complete portfolio management system with GitHub OAuth authentication, enabling secure cloud-based element synchronization and management.

#### ✨ New Features

##### 🔐 GitHub OAuth Authentication
- **OAuth App Integration**: Full OAuth flow with GitHub for secure authentication
- **Personal Access Token Support**: Alternative authentication method for CI/CD
- **Token Management**: Secure storage and rotation of authentication tokens
- **Multi-Account Support**: Handle multiple GitHub accounts seamlessly

##### 📦 Portfolio Management System
- **Cloud Sync**: Automatic synchronization between local and GitHub portfolios
- **Version Control**: Full git integration for portfolio elements
- **Conflict Resolution**: Smart merging of local and remote changes
- **Batch Operations**: Upload/download multiple elements efficiently

##### 🛠️ New MCP Tools (42 total)
- `setup_github_auth`: Interactive GitHub OAuth setup
- `check_github_auth`: Verify authentication status
- `refresh_github_token`: Rotate OAuth tokens
- `sync_portfolio`: Bidirectional portfolio synchronization
- `upload_to_portfolio`: Upload local elements to GitHub
- `download_from_portfolio`: Download elements from GitHub
- `submit_to_portfolio`: Submit elements for review
- And 30 more tools for complete portfolio management

#### 🔧 Bug Fixes
- **Element Detection**: Fixed smart detection of element types
- **YAML Parsing**: Improved handling of complex YAML structures
- **Path Resolution**: Fixed Windows path compatibility issues
- **Token Security**: Enhanced token storage encryption

#### 📝 Documentation
- Comprehensive OAuth setup guide
- Portfolio management tutorials
- Troubleshooting guides for common issues
- API documentation for all new tools

#### 🔒 Security
- OAuth token encryption at rest
- Secure token transmission
- Rate limiting for API calls
- Audit logging for all operations

---

For complete release history prior to v1.6.0, see the [GitHub Releases](https://github.com/DollhouseMCP/mcp-server/releases) page.

## 📜 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** with Platform Stability Commitments.

### What This Means

#### ✅ You CAN:
- Use the software for personal projects
- Use the software for commercial projects
- Modify the source code
- Distribute the software
- Use personas and elements you create

#### ⚠️ You MUST:
- Include the license and copyright notice
- State changes made to the code
- Disclose your source code when distributing
- Use the same AGPL-3.0 license for derivatives
- **Make network use source available** (AGPL requirement)

#### ❌ You CANNOT:
- Hold us liable for damages
- Use our trademarks without permission
- Claim warranty or guarantee of fitness

### Platform Stability Commitments

We provide additional guarantees beyond the AGPL-3.0:

- **90-day advance notice** for monetization policy changes
- **12-month revenue sharing locks** for content creators
- **Full data portability** - export all your content anytime
- **180-day transition period** for platform ownership changes
- **Community advisory input** on major policy decisions

### Contributor License Agreement

By contributing to DollhouseMCP, you agree that:

1. You have the right to grant us license to your contribution
2. Your contribution is licensed under AGPL-3.0
3. You grant us additional rights to use your contribution in our commercial offerings
4. You retain copyright to your contribution

For the complete license text, see [LICENSE](LICENSE).

### Questions?

If you have questions about the license or what you can do with DollhouseMCP:

- **Documentation**: [License FAQ](docs/LICENSE_FAQ.md)
- **GitHub Issue**: Open an issue with the `license` label
- **Discussions**: Ask in [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)

---

*Copyright © 2025 DollhouseMCP. All rights reserved.*
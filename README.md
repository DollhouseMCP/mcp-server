# DollhouseMCP

[![Core Build & Test](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml)
[![Build Artifacts](https://github.com/DollhouseMCP/mcp-server/actions/workflows/build-artifacts.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/build-artifacts.yml)
[![Extended Node Compatibility](https://github.com/DollhouseMCP/mcp-server/actions/workflows/extended-node-compatibility.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/extended-node-compatibility.yml)
[![Docker Testing](https://github.com/DollhouseMCP/mcp-server/actions/workflows/docker-testing.yml/badge.svg)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/docker-testing.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

## Platform Support

[![Windows Build Status](https://img.shields.io/badge/Windows-✓_Tested-0078D4?logo=windows&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "Windows CI Build Status")
[![macOS Build Status](https://img.shields.io/badge/macOS-✓_Tested-000000?logo=apple&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "macOS CI Build Status")
[![Linux Build Status](https://img.shields.io/badge/Linux-✓_Tested-FCC624?logo=linux&logoColor=black)](https://github.com/DollhouseMCP/mcp-server/actions/workflows/core-build-test.yml?query=branch:main "Linux CI Build Status")
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://github.com/DollhouseMCP/mcp-server/blob/main/Dockerfile)
[![Test Coverage](https://img.shields.io/badge/Coverage-600%2B%20Tests-green)](https://github.com/DollhouseMCP/mcp-server/tree/main/__tests__)
[![Auto-Update](https://img.shields.io/badge/Auto--Update-Enterprise%20Grade-purple)](https://github.com/DollhouseMCP/mcp-server)

A comprehensive Model Context Protocol (MCP) server that enables dynamic AI persona management with an integrated GitHub-powered collection. DollhouseMCP allows Claude and other compatible AI assistants to activate different behavioral personas while supporting community sharing and monetization.

**🌐 Repository**: https://github.com/DollhouseMCP/mcp-server  
**🏪 Collection**: https://github.com/DollhouseMCP/collection  
**📦 NPM Package**: https://www.npmjs.com/package/@dollhousemcp/mcp-server  
**🌍 Website**: https://dollhousemcp.com (planned)  
**📦 Version**: v1.5.0

> **⚠️ Breaking Change Notice**: Tool names have changed from "marketplace" to "collection" terminology. Old names still work but are deprecated. See [Migration Guide](docs/MIGRATION_GUIDE_COLLECTION_RENAME.md) for details.

## 🚀 Quick Start

```bash
# Install globally
npm install -g @dollhousemcp/mcp-server

# ✅ v1.5.0 introduces GitHub OAuth authentication!
# New secure authentication without manual token management:
# npm install -g @dollhousemcp/mcp-server@latest

# Add to Claude Desktop config (see path below for your OS)
# macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
# Windows: %APPDATA%\Claude\claude_desktop_config.json  
# Linux: ~/.config/Claude/claude_desktop_config.json
```

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

Restart Claude Desktop and you're ready to use DollhouseMCP! Try `list_personas` to get started.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎭 **49 MCP Tools** | Complete portfolio element management through chat interface |
| 🏪 **GitHub Collection** | Browse, search, install, and submit personas to community collection |
| 👤 **User Identity System** | Environment-based attribution for persona creators |
| 🆔 **Unique ID System** | Advanced ID generation: `{type}_{name}_{author}_{YYYYMMDD}-{HHMMSS}` |
| 💬 **Chat-Based Management** | Create, edit, and validate personas through conversational interface |
| 🔄 **Real-time Operations** | Live editing with automatic version bumping and validation |
| 🚀 **Auto-Update System** | Enterprise-grade auto-update with backup/rollback and dependency validation |
| 📦 **NPM Installation** | Install MCP servers from npm with cross-platform support and atomic operations |
| 🛡️ **Data Protection** | Copy-on-write for default personas, comprehensive backup system |
| 🏠 **Local-First Architecture** | Full functionality without cloud dependency |

## 🎨 Portfolio Customization Elements

DollhouseMCP introduces a comprehensive portfolio system for customizing AI behavior. Your portfolio is your personal collection of AI customization elements that enhance and tailor your AI experience.

### Portfolio Element Types

| Element | Purpose | Status |
|---------|---------|--------|
| 🎭 **Personas** | Define AI personality, tone, and behavioral characteristics | ✅ Available |
| 🛠️ **Skills** | Add specific capabilities like code review, data analysis, or creative writing | ✅ Available |
| 📝 **Templates** | Create reusable response formats for emails, reports, documentation | ✅ Available |
| 🤖 **Agents** | Build autonomous assistants that can pursue goals and make decisions | ✅ Available |
| 🧠 **Memory** | Persistent context storage with retention policies and search capabilities | ✅ Available |
| 🎯 **Ensemble** | Orchestrate multiple elements together as one unified entity | ✅ Available |

### Managing Your Portfolio

Use these new generic tools to manage any element type in your portfolio:

- **`list_elements`** - Browse your portfolio elements by type
- **`activate_element`** - Activate elements to customize AI behavior
- **`get_active_elements`** - View currently active customizations
- **`deactivate_element`** - Deactivate specific customizations
- **`get_element_details`** - Examine element configuration and metadata
- **`reload_elements`** - Refresh portfolio from filesystem

### Specialized Element Tools

Some portfolio elements have specialized operations:

- **`render_template`** - Generate content using template elements with variables
- **`execute_agent`** - Deploy agent elements to accomplish specific goals

### Portfolio Examples

```
# Browse your skill portfolio
list_elements type="skills"

# Activate a code review skill
activate_element name="code-review" type="skills"

# Activate a professional email template
activate_element name="email-professional" type="templates"

# Use a template to generate content
render_template name="project-update" variables='{"project": "DollhouseMCP", "status": "Released"}'

# Deploy an agent for a specific task
execute_agent name="project-manager" goal="Create a sprint plan for next week"
```

### Portfolio Structure

Your portfolio lives in `~/.dollhouse/portfolio/` with elements organized by type:

```
~/.dollhouse/portfolio/
├── personas/       # Personality and behavior profiles
├── skills/         # Specialized capabilities
├── templates/      # Reusable content structures
└── agents/         # Autonomous assistants
```

### Legacy Persona Tools

For backward compatibility, the original persona-specific tools still work:
- `list_personas` → calls `list_elements type="personas"`
- `activate_persona` → calls `activate_element type="personas"`
- `get_active_persona` → calls `get_active_elements type="personas"`
- etc.

## 🔒 Enterprise-Grade Security

DollhouseMCP implements comprehensive security measures to protect your personas and system:

### Security Features
- **🛡️ Content Sanitization**: DOMPurify integration prevents XSS attacks in persona content
- **📝 YAML Injection Prevention**: Secure parsing with schema validation and size limits
- **🔐 Token Security**: GitHub OAuth device flow authentication with AES-256-GCM encrypted storage
- **🐳 Container Hardening**: Non-root execution, read-only filesystem, resource limits
- **🚦 Rate Limiting**: Token bucket algorithm prevents API abuse (10 checks/hour default)
- **✅ Signature Verification**: GPG verification ensures release authenticity
- **🔍 Input Validation**: Comprehensive validation for all user inputs
- **📊 Security Monitoring**: Audit logging for security-relevant operations

### Security Testing
- **487 comprehensive tests** including security-specific test suites
- **Continuous security scanning** with GitHub Advanced Security
- **Vulnerability-free**: All security alerts resolved (0 active)

## 📋 Prerequisites

- **Node.js**: v20.0.0 or higher (LTS recommended)
- **npm**: v10.0.0 or higher
- **git**: For cloning the repository
- **Operating System**: Windows, macOS, or Linux

> **Note**: DollhouseMCP is developed on Node.js 24 but supports Node.js 20+ for broad compatibility.

## 🚀 Quick Start

### Installation

#### NPM Installation (NEW! - Recommended)

```bash
npm install -g @mickdarling/dollhousemcp
```

After installation, add DollhouseMCP to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
**Linux**: `~/.config/Claude/claude_desktop_config.json`

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

> **Note**: If you have other MCP servers configured, add dollhousemcp to your existing mcpServers object.

#### Automated Setup (Alternative) - Claude Desktop Only

> [!WARNING]
> **Claude Desktop Only**: The automated setup script is specifically designed for **Claude Desktop** integration. If you're using **Claude Code**, other AI platforms (ChatGPT, BoltAI, Gemini, etc.), or custom MCP implementations, please use the [Manual Installation](#manual-installation) process below.

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Run automated setup script (Claude Desktop only)
./setup.sh
```

The setup script will:
- 📦 Install all dependencies
- 🔨 Build the TypeScript code
- 📍 Detect your installation path
- 🔧 Generate the exact Claude Desktop configuration
- 📋 Provide step-by-step setup instructions

#### Manual Installation

> **Note**: Manual installation works with all MCP-compatible platforms including Claude Desktop, Claude Code, ChatGPT, BoltAI, Gemini, and custom implementations.

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Install dependencies and build
npm install
npm run build

# Optional: Set user identity for persona attribution
export DOLLHOUSE_USER="your-username"
export DOLLHOUSE_EMAIL="your-email@example.com"
```

### Claude Desktop Configuration

Add DollhouseMCP to your Claude Desktop configuration:

**Location**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

#### For NPM Installation:
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

#### For Source Installation:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/absolute/path/to/DollhouseMCP/dist/index.js"]
    }
  }
}
```

**🔄 After configuration:**
1. Save the file
2. Restart Claude Desktop completely
3. All 49 DollhouseMCP tools will be available

## 🛠️ Available Tools (49 Total)

### Portfolio Element Management (NEW!)
- **`list_elements`** - List all elements of a specific type
- **`activate_element`** - Activate an element by name and type
- **`get_active_elements`** - Get currently active elements of a type
- **`deactivate_element`** - Deactivate a specific element
- **`get_element_details`** - View detailed information about an element
- **`reload_elements`** - Refresh elements from filesystem

### Element-Specific Operations (NEW!)
- **`render_template`** - Render a template element with provided variables
- **`execute_agent`** - Execute an agent element with a specific goal

### Core Persona Management (Legacy - Still Supported)
- **`list_personas`** - Display all local personas with enhanced metadata
- **`activate_persona`** - Activate by name, filename, or unique ID
- **`get_active_persona`** - Get current persona information
- **`deactivate_persona`** - Return to default mode
- **`get_persona_details`** - View complete persona details
- **`reload_personas`** - Refresh from filesystem

### GitHub Collection Integration
- **`browse_collection`** - Browse content by section and type (flat structure, no categories)
- **`search_collection`** - Search across all collection content
- **`get_collection_content`** - View detailed content info
- **`install_element`** - One-click download and installation of any element type
- **`submit_persona`** - Submit to collection via GitHub issue

### User Identity Management
- **`set_user_identity`** - Set username for persona attribution
- **`get_user_identity`** - View current identity status
- **`clear_user_identity`** - Return to anonymous mode

### Chat-Based Persona Management
- **`create_persona`** - Guided persona creation through chat
- **`edit_persona`** - Modify existing persona fields
- **`validate_persona`** - Comprehensive quality validation

### Auto-Update System
- **`check_for_updates`** - Check GitHub releases for available DollhouseMCP updates
- **`update_server`** - Automated git pull + npm install + build with backup creation
- **`rollback_update`** - Restore previous version from automatic backups
- **`get_server_status`** - Comprehensive server status with version, git info, and system details

### Persona Indicators
- **`configure_indicator`** - Configure how persona indicators appear in AI responses
- **`get_indicator_config`** - View current indicator configuration settings

### GitHub Authentication (NEW!)
- **`setup_github_auth`** - Start GitHub OAuth device flow authentication
- **`check_github_auth`** - Check current authentication status
- **`clear_github_auth`** - Remove stored authentication credentials

## 📖 Usage Examples

### Collection Operations
```
browse_collection(section="library", type="personas")  # Browse all personas
browse_collection(section="library", type="skills")    # Browse skills
search_collection "writing"                # Search for writing personas
install_element "library/personas/storyteller.md"  # Install from collection
```

### Persona Creation & Management
```
create_persona "Study Buddy" "A helpful tutor" "educational" "You are a patient tutor..."
edit_persona "Study Buddy" "description" "An encouraging academic mentor"
validate_persona "Study Buddy"             # Check quality and format
submit_persona "Study Buddy"               # Share with community
```

### User Identity
```
set_user_identity "your-username"          # Set attribution
get_user_identity                          # Check current status
clear_user_identity                        # Return to anonymous
```

### Auto-Update Operations

The auto-update system provides enterprise-grade update management with safety features:

```
check_for_updates                          # Check for new DollhouseMCP versions
get_server_status                          # View current version and system info
update_server true                         # Perform automated update with backup
rollback_update true                       # Revert to previous version if needed
```

**How Auto-Update Works:**

1. **Version Check**: Queries GitHub releases API for latest version
2. **Backup Creation**: Automatically backs up current installation (including user personas)
3. **Update Process**: 
   - Performs `git pull` to fetch latest code
   - Runs `npm install` for dependency updates
   - Rebuilds TypeScript with `npm run build`
4. **Verification**: Validates the update succeeded
5. **Rollback Option**: Keep last 5 backups for easy recovery

**Safety Features:**
- Rate limiting prevents API abuse
- GPG signature verification (when available)
- Dependency version validation
- Automatic backup retention (5 most recent)
- User personas preserved during updates

### Persona Indicators
DollhouseMCP adds visual indicators to AI responses when a persona is active:
```
[🎭 Creative Writer v2.1 by @mickdarling] Your creative response here...
```

Configure indicators:
```
get_indicator_config                       # View current settings
configure_indicator enabled:false          # Disable indicators
configure_indicator style:"minimal"        # Use minimal format: 🎭 Creative Writer
configure_indicator style:"compact"        # Use compact: [Creative Writer v2.1]
configure_indicator style:"full"           # Full format (default)
configure_indicator emoji:"🤖"             # Change emoji
configure_indicator showAuthor:false       # Hide author attribution
configure_indicator bracketStyle:"round"   # Use (parentheses) instead of [brackets]
```

Environment variables for persistent configuration:
```bash
export DOLLHOUSE_INDICATOR_ENABLED=true
export DOLLHOUSE_INDICATOR_STYLE=minimal
export DOLLHOUSE_INDICATOR_EMOJI=🎨
```

### GitHub Authentication (NEW! v1.5.0)

DollhouseMCP now supports GitHub OAuth device flow authentication for secure access to GitHub features without exposing tokens:

```
setup_github_auth                         # Start OAuth device flow
check_github_auth                         # Check authentication status
clear_github_auth                         # Remove stored credentials
```

**Features:**
- 🔐 **Secure Token Storage**: Tokens encrypted with AES-256-GCM
- 📱 **Device Flow**: No need to manually create or paste tokens
- 🔄 **Automatic Token Management**: Secure storage and retrieval
- 🛡️ **Rate Limiting**: Built-in protection against API abuse
- ✅ **Unicode Security**: Prevents homograph attacks

**How It Works:**
1. Run `setup_github_auth` to start the OAuth flow
2. Visit the provided URL and enter the user code
3. Authorize DollhouseMCP in your browser
4. Authentication completes automatically
5. Token is securely stored for future use

**Example Usage:**
```
# First-time setup
setup_github_auth
# Copy the user code: XXXX-XXXX
# Visit: https://github.com/login/device
# Enter the code and authorize

# Check status
check_github_auth
# ✅ Authenticated as: your-username

# Later sessions automatically use stored token
browse_collection  # Works with authenticated access
```

## 🖥️ Cross-Platform Installation

### 🐧 Linux Installation

#### Prerequisites
- **Node.js**: v20.0.0 or higher
- **npm**: v10.0.0 or higher
- **git**: For version control

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nodejs npm git
# Verify Node.js version
node --version  # Should be v20.0.0 or higher

# CentOS/RHEL/Fedora  
sudo dnf install -y nodejs npm git
# Verify Node.js version
node --version  # Should be v20.0.0 or higher

# Arch Linux
sudo pacman -S nodejs npm git
# Verify Node.js version
node --version  # Should be v20.0.0 or higher
```

> **Note**: If your system's Node.js is older than v20, install from [NodeSource](https://github.com/nodesource/distributions) or use [nvm](https://github.com/nvm-sh/nvm).

#### Installation Steps
```bash
# Clone and build
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server
npm install
npm run build

# Optional: Set user identity
export DOLLHOUSE_USER="your-username"
export DOLLHOUSE_EMAIL="your-email@example.com"
```

#### Claude Desktop Configuration (Linux)
```bash
# Configuration location
~/.config/Claude/claude_desktop_config.json

# Or use XDG_CONFIG_HOME if set
$XDG_CONFIG_HOME/Claude/claude_desktop_config.json
```

Configuration content:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/absolute/path/to/DollhouseMCP/dist/index.js"]
    }
  }
}
```

### 🪟 Windows Installation

#### Prerequisites
- **Node.js**: v20.0.0 or higher
- **npm**: v10.0.0 or higher (included with Node.js)
- **git**: For version control

```powershell
# Install Node.js from https://nodejs.org/ (download LTS version)
# Or using Chocolatey
choco install nodejs --version=20.18.0
choco install git

# Or using winget
winget install OpenJS.NodeJS Git.Git

# Verify Node.js version
node --version  # Should be v20.0.0 or higher
```

#### Installation Steps (PowerShell)
```powershell
# Clone and build
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server
npm install
npm run build

# Optional: Set user identity
$env:DOLLHOUSE_USER = "your-username"
$env:DOLLHOUSE_EMAIL = "your-email@example.com"
```

#### Claude Desktop Configuration (Windows)
```powershell
# Configuration location
$env:APPDATA\Claude\claude_desktop_config.json
```

Configuration content (use forward slashes or double backslashes):
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["C:/path/to/DollhouseMCP/dist/index.js"]
    }
  }
}
```

### 🍎 macOS Installation

#### Prerequisites
- **Node.js**: v20.0.0 or higher
- **npm**: v10.0.0 or higher (included with Node.js)
- **git**: For version control

```bash
# Using Homebrew (recommended)
brew install node git

# Or download from https://nodejs.org/ (LTS version)

# Verify Node.js version
node --version  # Should be v20.0.0 or higher
```

#### Installation Steps
```bash
# Clone and build
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server
npm install
npm run build

# Optional: Set user identity
export DOLLHOUSE_USER="your-username"
export DOLLHOUSE_EMAIL="your-email@example.com"
```

#### Claude Desktop Configuration (macOS)
```bash
# Configuration location
~/Library/Application Support/Claude/claude_desktop_config.json
```

Configuration content:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/absolute/path/to/DollhouseMCP/dist/index.js"]
    }
  }
}
```

## 🐳 Docker Installation

### Quick Start with Docker
```bash
# Clone repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server

# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t dollhousemcp .
docker run -d --name dollhousemcp dollhousemcp
```

### Docker Compose (Recommended)

#### Production deployment:
```bash
docker-compose up -d
```

#### Development with hot reload:
```bash
docker-compose --profile dev up dollhousemcp-dev
```

### Custom Personas with Docker
```bash
# Mount your custom personas directory
docker run -d \
  --name dollhousemcp \
  -v /path/to/your/personas:/app/personas \
  -e DOLLHOUSE_USER="your-username" \
  dollhousemcp
```

### Docker Environment Variables
```bash
# Set user identity
DOLLHOUSE_USER=your-username
DOLLHOUSE_EMAIL=your-email@example.com

# Custom personas directory (inside container)
PERSONAS_DIR=/app/personas

# Node.js environment
NODE_ENV=production
```

## 🧪 Testing

### Running Tests

The project includes comprehensive tests for cross-platform compatibility:

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode (for development)
npm run test:watch

# Run specific test suites
npm run test:auto-update
npm run test:personas
npm run test:collection
```

### Test Coverage

Current test coverage includes:
- ✅ **102 comprehensive tests** covering all functionality
- ✅ **Auto-update system** - GitHub API, backup/rollback, dependency validation
- ✅ **Security testing** - Command injection prevention, input validation
- ✅ **Cross-platform compatibility** - Windows, macOS, Linux path handling
- ✅ **Version validation** - Parsing tests for git/npm output formats
- ✅ **Edge case coverage** - Network failures, missing dependencies, malformed input

### Manual Verification

Verify your setup works correctly:

```bash
# Build the project
npm run build

# Test the server (should output server info)
node dist/index.js --help 2>/dev/null || echo "Server compiled successfully"

# Verify personas directory
ls -la personas/

# Test auto-update system
check_for_updates    # Use in Claude Desktop
get_server_status    # Check current system status
```

## ☁️ Cloud Deployment

### Container Registries

The project supports deployment to:
- **GitHub Container Registry** (ghcr.io)
- **Docker Hub**
- **AWS ECR**
- **Google Container Registry**

### Example Cloud Deployments

#### AWS ECS
```json
{
  "family": "dollhousemcp",
  "containerDefinitions": [{
    "name": "dollhousemcp",
    "image": "ghcr.io/mickdarling/dollhousemcp:latest",
    "memory": 512,
    "cpu": 256,
    "environment": [
      {"name": "NODE_ENV", "value": "production"},
      {"name": "PERSONAS_DIR", "value": "/app/personas"},
      {"name": "DOLLHOUSE_USER", "value": "production"}
    ]
  }]
}
```

#### Google Cloud Run
```bash
gcloud run deploy dollhousemcp \
  --image ghcr.io/mickdarling/dollhousemcp:latest \
  --platform managed \
  --region us-central1 \
  --set-env-vars NODE_ENV=production,DOLLHOUSE_USER=production
```

#### Azure Container Instances
```bash
az container create \
  --name dollhousemcp \
  --resource-group myResourceGroup \
  --image ghcr.io/mickdarling/dollhousemcp:latest \
  --environment-variables NODE_ENV=production DOLLHOUSE_USER=production
```

## 🏗️ Project Structure

```
DollhouseMCP/
├── .github/
│   ├── actions/
│   │   └── validate-yaml/         # Reusable YAML validation action
│   ├── workflows/                 # CI/CD workflows
│   └── ISSUE_TEMPLATE/           # Issue templates for bug/feature/task
├── __tests__/
│   ├── unit/                     # Unit tests for components
│   ├── integration/              # Integration tests
│   └── *.test.ts                 # Test files (600+ tests total)
├── src/
│   ├── index.ts                  # Main MCP server (DollhouseMCPServer)
│   ├── cache/                    # API caching layer
│   ├── config/                   # Configuration management
│   ├── marketplace/              # GitHub collection integration
│   ├── persona/                  # Persona management core
│   ├── security/                 # Input validation and security
│   ├── server/                   # MCP server setup and tools
│   ├── types/                    # TypeScript type definitions
│   ├── update/                   # Auto-update system components
│   └── utils/                    # Utility functions
├── dist/                         # Compiled JavaScript (auto-generated)
├── personas/                     # Default persona collection
│   ├── creative-writer.md
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── custom-personas/              # User-created personas (git-ignored)
├── docs/                         # Documentation
│   ├── auto-update/             # Auto-update system docs
│   └── development/             # Development notes and guides
├── scripts/                      # Management and utility scripts
├── Dockerfile                    # Multi-stage Docker build
├── docker-compose.yml           # Production and development configs
├── package.json                 # Project config (dollhousemcp v1.4.2)
├── tsconfig.json                # TypeScript configuration
├── jest.config.cjs              # Jest test configuration
├── setup.sh                     # Automated installation script
├── LICENSE                      # AGPL-3.0 with platform stability
├── CHANGELOG.md                 # Version history
├── claude.md                    # Project context for Claude
└── README.md                    # This file
```

## 📝 Creating Custom Personas

### Enhanced Persona Format

Create `.md` files in the `personas/` directory with this structure:

```markdown
---
name: "Your Persona Name"
description: "Brief description of what this persona does"
unique_id: "auto-generated-if-missing"
author: "your-username"
triggers: ["keyword1", "keyword2"]
version: "1.0"
category: "creative"
age_rating: "all"
ai_generated: false
generation_method: "human"
price: "free"
license: "CC-BY-SA-4.0"
---

# Your Persona Name

Your persona instructions go here. This content defines how the AI should behave when this persona is activated.

## Response Style
- Communication guidelines
- Tone and approach
- Specific behaviors

## Key Techniques
- Problem-solving methods
- Interaction patterns
```

### Metadata Fields

#### Required Fields
| Field | Description |
|-------|-------------|
| `name` | Display name for the persona |
| `description` | Brief description of purpose and capabilities |

#### Optional Fields
| Field | Description |
|-------|-------------|
| `unique_id` | Auto-generated in format: `what-it-is_YYYYMMDD-HHMMSS_who-made-it` |
| `author` | Creator username (uses DOLLHOUSE_USER environment variable or generates anonymous ID) |
| `category` | One of: creative, professional, educational, gaming, personal |
| `triggers` | Array of keywords that suggest when to use this persona |
| `version` | Semantic version number (auto-incremented on edits) |
| `age_rating` | Content rating: all, 13+, or 18+ |
| `ai_generated` | Boolean flag indicating if content was AI-created |
| `price` | Monetization field - **TODO: Future Release** (will support "free" or pricing tiers) |

## 📚 Built-in Personas

| Persona | Purpose | Best For |
|---------|---------|----------|
| **Creative Writer** | Imaginative storytelling and creative content | Brainstorming, creative writing, engaging narratives |
| **Technical Analyst** | Deep technical analysis and systematic problem-solving | Architecture decisions, debugging, technical docs |
| **ELI5 Explainer** | Simplifying complex topics for beginners | Teaching, onboarding, concept explanation |
| **Business Consultant** | Strategic business analysis and recommendations | Strategy planning, business decisions, market analysis |
| **Debug Detective** | Systematic debugging and troubleshooting | Bug hunting, system troubleshooting, root cause analysis |

## 🏪 Collection Integration (Beta)

> **🧪 Beta Feature**: The GitHub-powered collection is currently in beta. Features may change based on community feedback.

DollhouseMCP includes an experimental GitHub-powered collection:

- **Browse by Category**: creative, professional, educational, gaming, personal
- **Search Content**: Find personas by keywords and descriptions
- **One-Click Install**: Download and integrate collection personas
- **Community Submissions**: Submit your personas via `submit_persona` tool
- **Version Control**: Full Git history for all collection content

> **Note**: Collection features require internet connection and GitHub API access. Rate limits may apply.

### ⚠️ Migration Guide - Breaking Changes

**Important**: Tool names have changed in recent versions:
- `browse_marketplace` → `browse_collection`
- `search_marketplace` → `search_collection`
- `get_marketplace_persona` → `get_collection_content`

If you have scripts or workflows using the old tool names, please update them to use the new names.

## 💼 Business Model & Legal

### Licensing
- **Core Server**: AGPL-3.0 (prevents proprietary competing platforms)
- **Persona Content**: CC-BY-SA-4.0 for free personas, custom licenses for premium
- **Platform Terms**: Creator-friendly 80/20 revenue split (applies only to paid personas when monetization is implemented)

### Platform Stability Commitments
- 90-day advance notice for monetization changes
- 12-month revenue sharing locks for existing paid personas
- Transparent governance for platform policy updates
- Full data portability rights
- Community advisory input on policy changes

## 🛠️ Development

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run the compiled server |
| `npm run dev` | Run in development mode with auto-reload |
| `npm run clean` | Remove compiled files |
| `npm run rebuild` | Clean and rebuild the project |
| `npm run setup` | Install dependencies and build |
| `npm test` | Run the comprehensive test suite |
| `npm run test:coverage` | Run tests with coverage reporting |

### Environment Variables

Customize server behavior with these environment variables:

```bash
# User Attribution
export DOLLHOUSE_USER="your-username"          # User attribution for persona creation
export DOLLHOUSE_EMAIL="your-email"            # Contact email (optional)

# Directory Configuration
export PERSONAS_DIR="/custom/path/to/personas"  # Custom personas directory

# Auto-Update Configuration
export GITHUB_TOKEN="your-token"               # For private repository access (optional)

# Development Configuration
export NODE_ENV="development"                  # Development mode
export DEBUG="dollhousemcp:*"                  # Debug logging (optional)
```

## 🔧 Troubleshooting

### ⚠️ NPM Installation Issues (v1.4.2)

If the MCP server crashes on startup after NPM installation:
1. Check your version: `npm list -g @dollhousemcp/mcp-server`
2. If you have v1.4.2, upgrade immediately: `npm install -g @dollhousemcp/mcp-server@latest`
3. Clear your portfolio and let it regenerate: `rm -rf ~/.dollhouse/portfolio`

**Note**: v1.4.2 had a critical bug that prevented proper initialization. v1.4.3 attempted to fix this but introduced new crashes. Both issues are fixed in v1.4.4.

### Directory Structure (v1.4.3+)

As of v1.4.3, all element directories use plural names:
- `~/.dollhouse/portfolio/personas/` (was `persona/` in v1.4.2)
- `~/.dollhouse/portfolio/skills/` (was `skill/` in v1.4.2)
- `~/.dollhouse/portfolio/templates/` (was `template/` in v1.4.2)
- `~/.dollhouse/portfolio/agents/` (was `agent/` in v1.4.2)
- `~/.dollhouse/portfolio/memories/` (was `memory/` in v1.4.2)
- `~/.dollhouse/portfolio/ensembles/` (was `ensemble/` in v1.4.2)

If you upgraded from v1.4.2, the server will automatically migrate your directories.

### Common Issues

| Issue | Solution |
|-------|----------|
| **v1.4.2 or v1.4.3 installation broken** | Upgrade to v1.4.4+ immediately |
| **Personas not loading** | Check `~/.dollhouse/portfolio/personas/` directory exists |
| **Server won't start** | Run `npm run rebuild` to clean and rebuild |
| **Collection not working** | Check internet connection and GitHub API access |
| **User identity not saving** | Set `DOLLHOUSE_USER` environment variable before starting Claude |
| **"Cannot find module" errors** | Ensure `npm install` completed successfully |
| **TypeScript compilation errors** | Verify Node.js version is 20+ with `node --version` |
| **Tools not appearing in Claude** | Restart Claude Desktop completely after config changes |
| **Default personas modified** | v1.2.1+ uses copy-on-write; git restore if needed |
| **Update/rollback issues** | Check write permissions; disable with `DOLLHOUSE_DISABLE_UPDATES=true` |
| **Rate limit errors** | Wait 60 seconds; GitHub API has hourly limits |

### Debug Steps

1. **Check build status:**
   ```bash
   npm run build
   ```

2. **Verify persona files:**
   ```bash
   ls -la personas/*.md
   ```

3. **Test server startup:**
   ```bash
   node dist/index.js
   ```

4. **Validate configuration:**
   ```bash
   # Check Claude Desktop config
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json
   
   # Verify Node.js version (requires 20+)
   node --version
   
   # Check npm version
   npm --version
   ```

5. **Test auto-update system:**
   ```bash
   # Use within Claude Desktop
   check_for_updates    # Check for available updates
   get_server_status    # View system information
   ```

6. **Validate personas:**
   Use the `reload_personas` tool to check for loading errors

## 📚 Documentation

### Element System Documentation
- **[Element Architecture](docs/ELEMENT_ARCHITECTURE.md)** - System design and core concepts
- **[Element Types Reference](docs/ELEMENT_TYPES.md)** - Detailed guide for all element types
- **[Developer Guide](docs/ELEMENT_DEVELOPER_GUIDE.md)** - How to create new element types
- **[API Reference](docs/API_REFERENCE.md)** - Complete MCP tool documentation
- **[Migration Guide](docs/MIGRATION_TO_PORTFOLIO.md)** - Upgrading from personas-only

### Additional Resources
- **[Security Guidelines](docs/SECURITY.md)** - Security best practices
- **[Contributing Guide](CONTRIBUTING.md)** - How to contribute

## 🤝 Contributing

We welcome contributions! DollhouseMCP includes integrated tools for submitting personas directly from Claude.

### Integrated Contribution Process (Recommended)

1. **Create or modify a persona** using the chat-based tools:
   ```
   create_persona "My Awesome Persona" "A helpful assistant for..." "professional"
   ```

2. **Validate your persona** to ensure quality:
   ```
   validate_persona "My Awesome Persona"
   ```

3. **Submit to the collection** directly from Claude:
   ```
   submit_persona "My Awesome Persona"
   ```
   This automatically creates a GitHub issue for community review.

### Manual Contribution Process

1. Fork the repository
2. Create persona files in `personas/` or `custom-personas/`
3. Follow the metadata format and naming conventions
4. Test thoroughly with `validate_persona` tool
5. Submit a pull request with clear description

### Reporting Issues

Please include:
- Node.js version (`node --version`)
- Operating system and version
- Complete error messages
- Steps to reproduce the issue
- Relevant persona files (if applicable)
- Claude Desktop configuration (without sensitive paths)

### Development Guidelines

1. **Follow TypeScript best practices**
2. **Maintain existing code style and patterns**
3. **Add comprehensive error handling**
4. **Update documentation for new features**
5. **Test thoroughly across platforms before submitting PRs**
6. **Include tests for new functionality**
7. **Follow semantic versioning for releases**

### Development Workflow

```bash
# Fork and clone
git clone https://github.com/your-username/DollhouseMCP.git
cd mcp-server

# Install dependencies
npm install

# Create feature branch
git checkout -b feature/your-feature-name

# Make changes and test
npm run build
npm test

# Commit and push
git commit -m "feat: your feature description"
git push origin feature/your-feature-name

# Submit pull request
```

## 📄 API Reference

### MCP Tool Specifications

Each tool follows the MCP specification:

```typescript
interface DollhouseTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}
```

### Tool Categories

#### Core Persona Management
```typescript
// list_personas - No parameters
// activate_persona - { persona: string }
// get_active_persona - No parameters  
// deactivate_persona - No parameters
// get_persona_details - { persona: string }
// reload_personas - No parameters
```

#### Collection Integration
```typescript
// browse_collection - { section?: string, type?: string }
// search_collection - { query: string }
// get_collection_content - { path: string }
// install_element - { path: string, type?: string }
// submit_persona - { persona: string }
```

#### User Identity Management
```typescript
// set_user_identity - { username: string }
// get_user_identity - No parameters
// clear_user_identity - No parameters
```

#### Chat-Based Management
```typescript
// create_persona - { name: string, description: string, category?: string, instructions: string }
// edit_persona - { persona: string, field: string, value: string }
// validate_persona - { persona: string }
```

#### Auto-Update System
```typescript
// check_for_updates - No parameters
// update_server - { confirm: boolean }
// rollback_update - { confirm: boolean }
// get_server_status - No parameters
```

### Error Handling

The server provides detailed error messages for:
- **Invalid persona identifiers** - Clear suggestions for valid names
- **File system issues** - Permission and path resolution errors
- **Malformed persona files** - YAML parsing and validation errors
- **Network errors** - GitHub API and collection connectivity issues
- **Runtime errors** - Server startup and operation failures

### Response Formats

All responses follow consistent patterns:
- **Success responses**: Include requested data and operation status
- **Error responses**: Include error type, message, and suggested resolution
- **Progress indicators**: Step-by-step feedback for long operations
- **Validation results**: Detailed reports with recommendations

## 📄 License

This project is licensed under the **AGPL-3.0** License with Platform Stability Commitments - see the [LICENSE](LICENSE) file for details.

**Platform Stability Guarantees:**
- 90-day advance notice for policy changes
- 12-month revenue sharing locks
- Full data portability rights
- Community advisory input

## 🏷️ Version History

### v1.5.0 - August 5, 2025 (Current)
**GitHub OAuth Authentication**:
- 🔐 **OAuth Device Flow** - Secure authentication without manual token management
- 🔒 **AES-256-GCM Encryption** - Tokens encrypted at rest with machine-specific keys
- 🛡️ **Rate Limiting** - Built-in protection against brute force attacks
- ✅ **Natural Language Flow** - User-friendly authentication instructions
- 🧪 **Comprehensive Tests** - 420+ lines of OAuth implementation tests

### v1.4.5 - August 5, 2025
**Claude Desktop Integration Fix**:
- ✅ **Fixed "Server disconnected" errors** when using `npx` or `dollhousemcp` CLI
- 🔄 **Progressive retry mechanism** for better compatibility across different machine speeds
- 🔒 **Security improvements** - removed detailed error logging to prevent information disclosure
- 🧪 **Added comprehensive tests** for execution detection logic

### v1.4.4 - August 4, 2025
**Emergency Hotfix**:
- 🚨 **Fixed v1.4.3 total failure** - initialization crashes fixed
- 🔧 **Fixed jsdom crash** - heavy dependencies now load lazily
- 🐳 **Fixed Docker compatibility** - handles read-only environments

### v1.4.3 - August 4, 2025
**Directory Structure Fix**:
- 🚨 **Fixed NPM installation failure** but introduced new crashes

### v1.4.2 - August 4, 2025
**Critical NPM Installation Fix**:
- 🚨 **Fixed NPM installation failure** where empty portfolios caused server crashes
- 📦 **DefaultElementProvider** automatically populates default content on first run
- 🔍 **Smart path detection** searches multiple NPM/Git installation locations
- 💬 **Helpful error messages** guide new users when portfolios are empty
- 🔒 **Security hardened** with audit logging and file integrity verification

### v1.4.1 - August 2, 2025
**NPM Installation Support**:
- 📦 **Install MCP servers from npm packages** with full cross-platform support
- 🔄 **Atomic operations** with transaction-based rollback on failure
- 📊 **Progress indicators** for better user experience during long operations
- 🏗️ **Centralized configuration** respecting platform conventions (XDG on Linux)
- 🛠️ **FileOperations utility** for consistent cross-platform behavior

### v1.4.0 - August 2, 2025
**Complete Element System**:
- 🎭 **Ensemble elements** for orchestrating multiple elements together
- 🧠 **Memory elements** with retention policies and search capabilities
- 🤖 **Agent elements** with goal-oriented decision making
- 📝 **Template elements** with secure variable substitution
- 🛠️ **Skill elements** with parameter system and proficiency tracking
- 🔒 **Comprehensive security** throughout all element types

### v1.3.3 - August 2, 2025
**Portfolio System & Element Types**:
- 🎨 **Portfolio-based architecture** for managing all AI customization elements
- 🛠️ **Generic element tools** that work with any element type
- 📁 **Structured directory layout** under `~/.dollhouse/portfolio/`
- 🔄 **Backward compatibility** maintained for existing personas

### v1.3.2 - August 1, 2025
**GitFlow Implementation**:
- 🔀 **GitFlow branching model** for better release management
- 🏷️ **Automated version tagging** on releases
- 📦 **NPM release automation** (pending token configuration)

### v1.3.1 - July 31, 2025
**Collection System Updates**:
- 🏪 **Improved collection browsing** with better error handling
- 🔍 **Enhanced search functionality** for finding content
- 📥 **Better installation process** with validation

### v1.3.0 - July 30, 2025
**Major Architecture Refactor**:
- 🏗️ **Element interface system** providing foundation for all element types
- 🔐 **Security-first implementation** with comprehensive protections
- 📊 **Improved test coverage** reaching 96%+

### v1.2.5 - July 2025

**Collection Rename & Breaking Changes**:
- 🔄 **Renamed all "marketplace" tools to "collection"**:
  - `browse_marketplace` → `browse_collection`
  - `search_marketplace` → `search_collection`
  - `get_marketplace_persona` → `get_collection_content`
  - `install_persona` → `install_persona` (unchanged)
  - `submit_persona` → `submit_persona` (unchanged)
- ✅ **Added backward compatibility aliases** (deprecated, will be removed in v2.0.0)
- ✅ **Updated repository** from `/personas` to `/collection`
- ✅ **Created migration guide** for users to update their scripts
- ✅ **Fixed all date references** from January to July 2025

### v1.2.4 - July 10, 2025

**Critical Fix**:
- ✅ **Fixed MCP protocol compatibility** - console output no longer breaks JSON-RPC communication
- ✅ **Added MCP-safe logger utility** for proper logging during protocol sessions
- ✅ **Resolves connection failures** in Claude Desktop
- ✅ **Updated Docker tests** to work with new logging approach
- ✅ **Added comprehensive logger unit tests**

### v1.2.3 - July 10, 2025

**Bug Fix**:
- ✅ **Fixed personas directory path resolution** for production environments
- ✅ **Changed from process.cwd() to __dirname-based paths**
- ✅ **Fixed setup script** with correct tool count and repository URLs

### v1.2.2 - July 10, 2025
- ✅ **Comprehensive security enhancements**:
  - Content sanitization with DOMPurify (SEC-001)
  - YAML injection prevention (SEC-003)
  - GitHub token security (SEC-004)
  - Docker container hardening (SEC-005)
- ✅ **487 comprehensive tests** including extensive security coverage
- ✅ **CI timing test fixes** for reliable cross-platform testing
- ✅ **TypeScript compilation fixes** for all test files
- ✅ **All security vulnerabilities resolved** (0 active alerts)

### v1.2.1 - July 8, 2025
- ✅ **Critical bug fixes** for data protection:
  - Copy-on-write for default personas (Issue #145)
  - User personas included in backups (Issue #144)
- ✅ **Node.js 20+ requirement** for npm publishing compatibility
- ✅ **372 comprehensive tests** covering all functionality
- ✅ **Enhanced security** with all vulnerabilities resolved
- ✅ **Improved documentation** with clear prerequisites

### v1.2.0 - July 7, 2025
- ✅ **Rate limiting implementation** to prevent API abuse
- ✅ **GPG signature verification** for release authenticity
- ✅ **GitHub Advanced Security** integration
- ✅ **309 tests** with improved CI environment coverage
- ✅ **Package optimization** at 279.3 kB

### v1.1.0 - July 4, 2025
- ✅ **Platform-specific badges** for Windows, macOS, Linux visibility
- ✅ **GitHub Project management** with issue templates and milestones
- ✅ **ARM64 Docker fix** switching from Alpine to Debian base images
- ✅ **100% workflow reliability** (except Docker ARM64)
- ✅ **First GitHub release** with CHANGELOG.md
- ✅ **21 total MCP tools** at time of release

### Phase 2B+ - July 3, 2025
- ✅ **Enterprise-grade auto-update system** with 4 new MCP tools
- ✅ **50 comprehensive tests** covering all functionality  
- ✅ **Security hardening** - eliminated all command injection vulnerabilities
- ✅ **Cross-platform support** - Windows, macOS, Linux with CI/CD testing
- ✅ **Docker containerization** with production and development configurations
- ✅ **21 total MCP tools** with backup/rollback and dependency validation

### Phase 2B - July 1-2, 2025
- ✅ Complete chat-based persona management
- ✅ GitHub marketplace integration
- ✅ User identity and attribution system
- ✅ Real-time validation and editing
- ✅ Enterprise-grade GitHub Actions security

### Phase 1 - July 1, 2025
- ✅ Fresh AGPL-3.0 licensed repository
- ✅ Enhanced unique ID system
- ✅ Anonymous user support
- ✅ Marketplace-ready metadata schema

---

**🎭 Transform your AI interactions with the power of personas**

For support, please [open an issue](https://github.com/DollhouseMCP/mcp-server/issues) or visit our [collection](https://github.com/DollhouseMCP/collection).
# DollhouseMCP

[![CI/CD Pipeline](https://github.com/mickdarling/DollhouseMCP/actions/workflows/cross-platform.yml/badge.svg)](https://github.com/mickdarling/DollhouseMCP/actions/workflows/cross-platform.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[![Platform Support](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/mickdarling/DollhouseMCP/actions/workflows/cross-platform.yml)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://github.com/mickdarling/DollhouseMCP/blob/main/Dockerfile)
[![Test Coverage](https://img.shields.io/badge/Coverage-50%20Tests-green)](https://github.com/mickdarling/DollhouseMCP/tree/main/__tests__)
[![Auto-Update](https://img.shields.io/badge/Auto--Update-Enterprise%20Grade-purple)](https://github.com/mickdarling/DollhouseMCP)

A comprehensive Model Context Protocol (MCP) server that enables dynamic AI persona management with an integrated GitHub-powered marketplace. DollhouseMCP allows Claude and other compatible AI assistants to activate different behavioral personas while supporting community sharing and monetization.

**🌐 Repository**: https://github.com/mickdarling/DollhouseMCP  
**🏪 Marketplace**: https://github.com/mickdarling/DollhouseMCP-Personas  
**🌍 Website**: https://dollhousemcp.com (planned)

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎭 **21 MCP Tools** | Complete persona lifecycle management through chat interface |
| 🏪 **GitHub Marketplace** | Browse, search, install, and submit personas to community marketplace |
| 👤 **User Identity System** | Environment-based attribution for persona creators |
| 🆔 **Unique ID System** | Advanced ID generation: `what-it-is_YYYYMMDD-HHMMSS_who-made-it` |
| 💬 **Chat-Based Management** | Create, edit, and validate personas through conversational interface |
| 🔄 **Real-time Operations** | Live editing with automatic version bumping and validation |
| 🚀 **Auto-Update System** | Enterprise-grade auto-update with backup/rollback and dependency validation |
| 🏠 **Local-First Architecture** | Full functionality without cloud dependency |

## 🚀 Quick Start

### Installation

#### Automated Setup (Recommended)
```bash
# Clone the repository
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP

# Run automated setup script
./setup.sh
```

The setup script will:
- 📦 Install all dependencies
- 🔨 Build the TypeScript code
- 📍 Detect your installation path
- 🔧 Generate the exact Claude Desktop configuration
- 📋 Provide step-by-step setup instructions

#### Manual Installation
```bash
# Clone the repository
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP

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
3. All 21 DollhouseMCP tools will be available

## 🛠️ Available Tools (21 Total)

### Core Persona Management
- **`list_personas`** - Display all local personas with enhanced metadata
- **`activate_persona`** - Activate by name, filename, or unique ID
- **`get_active_persona`** - Get current persona information
- **`deactivate_persona`** - Return to default mode
- **`get_persona_details`** - View complete persona details
- **`reload_personas`** - Refresh from filesystem

### GitHub Marketplace Integration
- **`browse_marketplace`** - Browse personas by category
- **`search_marketplace`** - Search across all marketplace personas
- **`get_marketplace_persona`** - View detailed marketplace persona info
- **`install_persona`** - One-click download and installation
- **`submit_persona`** - Submit to marketplace via GitHub issue

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

## 📖 Usage Examples

### Marketplace Operations
```
browse_marketplace                          # See all categories
browse_marketplace "creative"               # Browse creative personas
search_marketplace "writing"                # Search for writing personas
install_persona "creative/storyteller.md"  # Install from marketplace
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
```
check_for_updates                          # Check for new DollhouseMCP versions
get_server_status                          # View current version and system info
update_server true                         # Perform automated update with backup
rollback_update true                       # Revert to previous version if needed
```

## 🖥️ Cross-Platform Installation

### 🐧 Linux Installation

#### Prerequisites
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nodejs npm git

# CentOS/RHEL/Fedora  
sudo dnf install -y nodejs npm git

# Arch Linux
sudo pacman -S nodejs npm git
```

#### Installation Steps
```bash
# Clone and build
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP
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
```powershell
# Install Node.js from https://nodejs.org/
# Or using Chocolatey
choco install nodejs git

# Or using winget
winget install OpenJS.NodeJS Git.Git
```

#### Installation Steps (PowerShell)
```powershell
# Clone and build
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP
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
```bash
# Using Homebrew (recommended)
brew install node git

# Or download from https://nodejs.org/
```

#### Installation Steps
```bash
# Clone and build
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP
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
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP

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
npm run test:marketplace
```

### Test Coverage

Current test coverage includes:
- ✅ **50 comprehensive tests** covering all functionality
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
│   │   └── validate-yaml/    # Reusable YAML validation action
│   └── workflows/
│       ├── cross-platform.yml    # Cross-platform testing (Mac/Windows/Linux)
│       ├── claude.yml             # Interactive Claude Code workflow
│       └── claude-code-review.yml # Automated PR review workflow
├── __tests__/
│   └── auto-update.test.ts   # Comprehensive test suite (50 tests)
├── src/
│   └── index.ts              # Main MCP server (DollhouseMCPServer class)
├── dist/                     # Compiled JavaScript (auto-generated)
├── personas/                 # Local persona collection
│   ├── creative-writer.md    # Enhanced with unique ID system
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # Production and development configurations
├── .dockerignore            # Docker build optimizations
├── package.json              # Project config (dollhousemcp, AGPL-3.0)
├── tsconfig.json             # TypeScript configuration
├── setup.sh                  # Automated installation script
├── LICENSE                   # AGPL-3.0 with platform stability terms
├── CONVERSATION_SUMMARY.md   # Development session documentation
├── claude.md                 # Project context file
└── README.md                 # This file
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

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Display name for the persona |
| `description` | ✅ | Brief description of purpose |
| `unique_id` | ❌ | Auto-generated if missing |
| `author` | ❌ | Creator username (uses environment or anonymous) |
| `category` | ❌ | creative, professional, educational, gaming, personal |
| `triggers` | ❌ | Keywords that suggest this persona |
| `version` | ❌ | Version tracking |
| `age_rating` | ❌ | all, 13+, 18+ |
| `ai_generated` | ❌ | Boolean flag for AI-created content |
| `price` | ❌ | "free" or monetary amount |

## 📚 Built-in Personas

| Persona | Purpose | Best For |
|---------|---------|----------|
| **Creative Writer** | Imaginative storytelling and creative content | Brainstorming, creative writing, engaging narratives |
| **Technical Analyst** | Deep technical analysis and systematic problem-solving | Architecture decisions, debugging, technical docs |
| **ELI5 Explainer** | Simplifying complex topics for beginners | Teaching, onboarding, concept explanation |
| **Business Consultant** | Strategic business analysis and recommendations | Strategy planning, business decisions, market analysis |
| **Debug Detective** | Systematic debugging and troubleshooting | Bug hunting, system troubleshooting, root cause analysis |

## 🏪 Marketplace Integration

DollhouseMCP includes a complete GitHub-powered marketplace:

- **Browse by Category**: creative, professional, educational, gaming, personal
- **Search Content**: Find personas by keywords and descriptions
- **One-Click Install**: Download and integrate marketplace personas
- **Community Submissions**: Submit your personas via automated GitHub workflow
- **Version Control**: Full Git history for all marketplace content

## 💼 Business Model & Legal

### Licensing
- **Core Server**: AGPL-3.0 (prevents proprietary competing platforms)
- **Platform Terms**: Creator-friendly 80/20 revenue split framework
- **Persona Content**: CC-BY-SA-4.0 for free personas

### Platform Stability Commitments
- 90-day advance notice for monetization changes
- 12-month revenue sharing locks
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

### Common Issues

| Issue | Solution |
|-------|----------|
| **Personas not loading** | Check `personas/` directory and file permissions |
| **Server won't start** | Run `npm run rebuild` to clean and rebuild |
| **Marketplace not working** | Check internet connection and GitHub API access |
| **User identity not saving** | Verify environment variables are set correctly |

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
   
   # Verify Node.js version (requires 18+)
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

## 🤝 Contributing

We welcome contributions! Here's how to help:

### Adding Personas

1. Fork the repository
2. Create a new persona file in `personas/`
3. Follow the established format and naming conventions
4. Test your persona thoroughly with `validate_persona` tool
5. Submit a pull request with a clear description

### Community Contributions
1. Create personas following the enhanced metadata format
2. Test thoroughly with `validate_persona` tool
3. Submit via `submit_persona` tool for community review
4. Participate in GitHub discussions and issue reviews

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
cd DollhouseMCP

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

#### Marketplace Integration
```typescript
// browse_marketplace - { category?: string }
// search_marketplace - { query: string }
// get_marketplace_persona - { path: string }
// install_persona - { path: string }
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
- **Network errors** - GitHub API and marketplace connectivity issues
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

### Phase 2B+ (Current) - July 3, 2025
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

For support, please [open an issue](https://github.com/mickdarling/DollhouseMCP/issues) or visit our [marketplace](https://github.com/mickdarling/DollhouseMCP-Personas).
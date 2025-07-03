# DollhouseMCP

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

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

## 🏗️ Project Structure

```
DollhouseMCP/
├── src/
│   └── index.ts              # Main MCP server (DollhouseMCPServer class)
├── dist/                     # Compiled JavaScript (auto-generated)
├── personas/                 # Local persona collection
│   ├── creative-writer.md    # Enhanced with unique ID system
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── package.json              # Project config (dollhousemcp, AGPL-3.0)
├── tsconfig.json             # TypeScript configuration
├── LICENSE                   # AGPL-3.0 with platform stability terms
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
```bash
npm run build        # Compile TypeScript
npm run start        # Run compiled server
npm run dev         # Development mode with auto-reload
npm run clean       # Remove compiled files
npm run rebuild     # Clean and rebuild
npm run setup       # Install dependencies and build
```

### Environment Variables
```bash
export PERSONAS_DIR="/custom/path/to/personas"  # Custom personas directory
export DOLLHOUSE_USER="your-username"          # User attribution
export DOLLHOUSE_EMAIL="your-email"            # Contact email (optional)
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
1. **Check build**: `npm run build`
2. **Verify personas**: `ls -la personas/*.md`
3. **Test server**: `node dist/index.js`
4. **Reload personas**: Use `reload_personas` tool

## 🤝 Contributing

### Community Contributions
1. Create personas following the enhanced format
2. Test thoroughly with `validate_persona` tool
3. Submit via `submit_persona` tool for community review
4. Participate in GitHub discussions and issue reviews

### Development Contributions
1. Fork the repository
2. Follow TypeScript best practices
3. Test changes thoroughly
4. Submit pull requests with clear descriptions

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
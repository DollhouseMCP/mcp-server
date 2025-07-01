# Persona MCP Server

[![CI/CD Pipeline](https://github.com/mickdarling/persona-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mickdarling/persona-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/persona-mcp-server.svg)](https://www.npmjs.com/package/persona-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[![Platform Support](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/mickdarling/persona-mcp-server/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://github.com/mickdarling/persona-mcp-server/blob/main/Dockerfile)
[![Test Coverage](https://img.shields.io/badge/Coverage-Automated-green)](https://github.com/mickdarling/persona-mcp-server/actions/workflows/ci.yml)

A professional Model Context Protocol (MCP) server that enables dynamic AI persona management from markdown files. This server allows Claude and other compatible AI assistants to activate and switch between different behavioral personas, transforming how they respond and interact.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎭 **Multiple Personas** | Load different AI personalities from markdown files |
| 📝 **Markdown-Based** | Easy to create and edit persona files with YAML frontmatter |
| 🔄 **Hot Reload** | Dynamically reload personas without restarting the server |
| 🎯 **Flexible Activation** | Activate personas by name or filename |
| 📊 **Rich Metadata** | Support for versioning, authors, triggers, and detailed descriptions |
| 🔧 **Professional Structure** | Clean TypeScript codebase with proper build pipeline |

## 🚀 Quick Start

### Installation

```bash
# Clone or download the repository
git clone https://github.com/mickdarling/persona-mcp-server.git
cd persona-mcp-server

# Install dependencies and build
npm run setup
```

### Project Structure

```
persona-mcp-server/
├── src/
│   └── index.ts              # Main server implementation
├── dist/                     # Compiled JavaScript (auto-generated)
├── personas/                 # Persona definition files
│   ├── creative-writer.md
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── package.json              # Project configuration
├── tsconfig.json             # TypeScript configuration
├── LICENSE                   # MIT license
└── README.md                 # This file
```

### Claude Desktop Configuration

Add the persona server to your Claude Desktop configuration file:

**Location:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

#### If you have no existing MCP servers:
```json
{
  "mcpServers": {
    "persona-mcp-server": {
      "command": "node",
      "args": ["/path/to/persona-mcp-server/dist/index.js"]
    }
  }
}
```

#### If you already have other MCP servers:
Add the persona server entry to your existing `mcpServers` section:

```json
{
  "mcpServers": {
    "your-existing-server": {
      "command": "node",
      "args": ["/path/to/your/existing/server.js"]
    },
    "another-server": {
      "command": "npx",
      "args": ["-y", "@some/mcp-package@latest"]
    },
    "persona-mcp-server": {
      "command": "node",
      "args": ["/path/to/persona-mcp-server/dist/index.js"]
    }
  }
}
```

**🔄 After updating the configuration:**
1. Save the file
2. Restart Claude Desktop completely
3. The persona tools will be available in your next conversation

## 📖 Usage

### Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_personas` | Display all available personas with metadata | None |
| `activate_persona` | Activate a specific persona by name or filename | `persona`: string |
| `get_active_persona` | Get information about the currently active persona | None |
| `deactivate_persona` | Deactivate current persona and return to default mode | None |
| `get_persona_details` | View complete details and content of a persona | `persona`: string |
| `reload_personas` | Refresh personas from the filesystem | None |

### Example Workflow

1. **📋 List available personas:**
   ```
   Use the list_personas tool to see all available personas
   ```

2. **🎭 Activate a persona:**
   ```
   Use activate_persona with "Creative Writer" or "creative-writer.md"
   ```

3. **💬 Interact in persona mode:**
   ```
   Ask questions - Claude will respond using the activated persona's style and instructions
   ```

4. **🔄 Switch or deactivate:**
   ```
   Use activate_persona for a different persona, or deactivate_persona to return to default
   ```

## 📝 Creating Custom Personas

### Persona File Format

Create a `.md` file in the `personas/` directory using this structure:

```markdown
---
name: "Your Persona Name"
description: "Brief description of what this persona does"
triggers: ["keyword1", "keyword2", "keyword3"]
version: "1.0"
author: "Your Name"
---

# Your Persona Name

Your persona instructions go here. This content will be injected as context when the persona is activated.

## Response Style
- Guideline 1: How to communicate
- Guideline 2: Tone and approach
- Guideline 3: Specific behaviors

## Key Techniques
- Technique 1: Specific method or approach
- Technique 2: Problem-solving strategy

Remember to end with key reminders that ensure consistent persona behavior.
```

### Metadata Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Display name for the persona |
| `description` | ✅ | Brief description of the persona's purpose |
| `triggers` | ❌ | Keywords that suggest this persona |
| `version` | ❌ | Version number for tracking changes |
| `author` | ❌ | Creator of the persona |

### Best Practices

1. **🎯 Clear Purpose**: Each persona should have a distinct, focused role
2. **📋 Specific Instructions**: Be explicit about how the persona should behave
3. **🗣️ Consistent Voice**: Define communication style and tone clearly
4. **💡 Include Examples**: Show expected transformations or response patterns
5. **⚡ Actionable Guidelines**: Provide implementable instructions, not just descriptions

## 🏗️ Development

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run the compiled server |
| `npm run dev` | Run in development mode with auto-reload |
| `npm run clean` | Remove compiled files |
| `npm run rebuild` | Clean and rebuild the project |
| `npm run setup` | Install dependencies and build |

### Environment Variables

Customize server behavior with these environment variables:

```bash
export PERSONAS_DIR="/custom/path/to/personas"  # Custom personas directory
```

### Building from Source

```bash
# Development setup
npm install
npm run build

# Development with auto-reload
npm run dev

# Production build
npm run rebuild
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

# Run tests for CI/CD
npm run test:ci
```

### Manual Verification

Verify your setup works correctly:

```bash
# Build the project
npm run build

# Test the server (should output server info)
node dist/index.js --help 2>/dev/null || echo "Server compiled successfully"

# Verify personas directory
ls -la personas/
```

### Cross-Platform Testing

The test suite validates:
- ✅ Windows, macOS, and Linux compatibility
- ✅ Path handling across different file systems
- ✅ Environment variable configuration
- ✅ Package integrity and dependencies
- ✅ Build process and artifacts

## 🐳 Docker Support

### Quick Start with Docker

```bash
# Build the Docker image
docker build -t persona-mcp-server .

# Run the container
docker run -d --name persona-mcp-server \
  -v $(pwd)/custom-personas:/app/custom-personas:ro \
  persona-mcp-server

# Using Docker Compose
docker-compose up -d

# Development mode
docker-compose --profile dev up
```

### Docker Configuration

The Docker image is optimized for:
- **Multi-stage builds** for smaller production images
- **Non-root user** for security
- **Health checks** for monitoring
- **Custom persona mounting** via volumes
- **Cross-platform support** (linux/amd64, linux/arm64)

### Environment Variables for Docker

```bash
# Set custom personas directory
docker run -e PERSONAS_DIR=/app/custom-personas persona-mcp-server

# Production mode
docker run -e NODE_ENV=production persona-mcp-server
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
  "family": "persona-mcp-server",
  "containerDefinitions": [{
    "name": "persona-mcp-server",
    "image": "ghcr.io/mickdarling/persona-mcp-server:latest",
    "memory": 512,
    "cpu": 256,
    "environment": [
      {"name": "NODE_ENV", "value": "production"},
      {"name": "PERSONAS_DIR", "value": "/app/personas"}
    ]
  }]
}
```

#### Google Cloud Run
```bash
gcloud run deploy persona-mcp-server \
  --image ghcr.io/mickdarling/persona-mcp-server:latest \
  --platform managed \
  --region us-central1 \
  --set-env-vars NODE_ENV=production
```

#### Azure Container Instances
```bash
az container create \
  --name persona-mcp-server \
  --resource-group myResourceGroup \
  --image ghcr.io/mickdarling/persona-mcp-server:latest \
  --environment-variables NODE_ENV=production
```

## 🛠️ Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **Personas not loading** | Files not in `personas/` directory | Check file location and permissions |
| **Persona won't activate** | Name/filename mismatch | Use exact name from `list_personas` |
| **Server won't start** | Build errors or missing dependencies | Run `npm run rebuild` |
| **Path issues** | Incorrect personas directory | Verify `PERSONAS_DIR` or use default |

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

4. **Validate personas:**
   Use the `reload_personas` tool to check for loading errors

## 🤝 Contributing

We welcome contributions! Here's how to help:

### Adding Personas

1. Fork the repository
2. Create a new persona file in `personas/`
3. Follow the established format and naming conventions
4. Test your persona thoroughly
5. Submit a pull request with a clear description

### Reporting Issues

Please include:
- Node.js version (`node --version`)
- Operating system
- Complete error messages
- Steps to reproduce the issue
- Relevant persona files (if applicable)

### Development Guidelines

1. Follow TypeScript best practices
2. Maintain existing code style
3. Add appropriate error handling
4. Update documentation for new features
5. Test thoroughly before submitting PRs

## 📄 API Reference

### MCP Tool Specifications

Each tool follows the MCP specification:

```typescript
interface PersonaTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}
```

### Error Handling

The server provides detailed error messages for:
- Invalid persona identifiers
- File system issues
- Malformed persona files
- Runtime errors

## 📚 Built-in Personas

| Persona | Purpose | Best For |
|---------|---------|----------|
| **Creative Writer** | Imaginative storytelling and creative content | Brainstorming, creative writing, engaging narratives |
| **Technical Analyst** | Deep technical analysis and systematic problem-solving | Architecture decisions, debugging, technical docs |
| **ELI5 Explainer** | Simplifying complex topics for beginners | Teaching, onboarding, concept explanation |
| **Business Consultant** | Strategic business analysis and recommendations | Strategy planning, business decisions, market analysis |
| **Debug Detective** | Systematic debugging and troubleshooting | Bug hunting, system troubleshooting, root cause analysis |

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🏷️ Version History

### v1.0.0
- Initial professional release
- TypeScript implementation with proper build pipeline
- Comprehensive persona library
- Hot reload functionality
- Full MCP integration
- Professional project structure

---

**Made with ❤️ for the MCP community**

For support, please [open an issue](https://github.com/mickdarling/persona-mcp-server/issues) on GitHub.
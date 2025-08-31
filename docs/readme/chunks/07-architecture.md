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
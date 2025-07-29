# DollhouseMCP Architecture Overview

This document describes how all DollhouseMCP repositories work together to create a complete AI persona management ecosystem.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        End Users                             │
│                 (Claude Desktop, AI Apps)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (Core)                         │
│                 @dollhousemcp/mcp-server                     │
│  • Tool Management (23+ tools)                               │
│  • Customization Element Installation & Activation           │
│  • Security & Validation                                     │
│  • Auto-update System                                        │
└──────┬──────────────┬──────────────────┬────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Collection  │ │   Catalog    │ │ Experimental │
│   (Public)   │ │  (Private)   │ │  (Private)   │
│              │ │              │ │              │
│ • Personas   │ │ • Premium    │ │ • Future     │
│ • Templates  │ │   Elements   │ │   Features   │
│ • Skills     │ │ • Enterprise │ │ • R&D        │
│ • Tools      │ │   Features   │ │ • Coming     │
│              │ │              │ │   Soon       │
└──────────────┘ └──────────────┘ └──────────────┘
```

## Repository Relationships

### 1. Core Platform
**mcp-server** is the heart of the system:
- Implements the MCP protocol
- Manages all element types (personas, templates, skills, tools)
- Handles security, validation, and updates
- Provides the CLI and programmatic interfaces

### 2. Content Sources

#### Collection (Community Content)
- Public repository for community-contributed elements
- Free to use and contribute
- Integrated with mcp-server via GitHub API
- Customization Elements validated before acceptance

#### Catalog (Premium Content)
- Private repository for premium elements
- Enterprise features and professional content
- Subscription-based access (coming soon)
- Enhanced security and support

#### Experimental (Innovation Lab)
- Private R&D repository
- Next-generation features under development
- Not accessible to public
- Testing ground for future enhancements

### 3. Developer Ecosystem

#### Developer Kit
- Templates for creating new elements
- Integration examples
- Testing utilities
- Documentation for external developers

## Data Flow

```
1. User requests element → MCP Server
2. MCP Server checks:
   - Local portfolio
   - Collection (public)
   - Catalog (if authorized)
3. Customization Element downloaded → Validated → Installed
4. Customization Element activated → Tools available to AI
5. AI uses tools → Results returned to user
```

## Security Architecture

### Public Customization Elements (Collection)
- Community review process
- Automated security scanning
- Signature verification
- Rate limiting

### Premium Customization Elements (Catalog)
- Enhanced validation
- Encrypted storage
- License verification
- Usage tracking

### Experimental Features
- Isolated development environment
- Limited access testing
- Future feature validation
- Innovation pipeline

## Integration Points

### For AI Platforms
- **MCP Protocol**: Standard interface for AI integration
- **Tool Discovery**: Dynamic tool registration
- **Context Management**: Stateful interactions

### For Developers
- **NPM Package**: Easy installation and updates
- **GitHub API**: Element discovery and installation
- **REST API**: Future cloud services (planned)

### For Enterprise
- **Private Registries**: Self-hosted element stores (roadmap)
- **Bespoke Customization Elements**: Organization-specific tools
- **Compliance**: Audit logs and access control (roadmap)

## Future Architecture

### Planned Enhancements
1. **Cloud Sync**: Cross-device element synchronization
2. **Team Collaboration**: Shared element libraries
3. **Advanced Analytics**: Usage insights and optimization
4. **Enhanced Capabilities**: New element types and features

### Scalability Considerations
- Distributed element storage
- CDN for global delivery
- Microservices architecture
- Container-based deployment
- Edge Deployment

## Development Workflow

### Customization Element Creation Flow
1. Developer creates element using developer-kit
2. Tests locally with mcp-server
3. Submits to collection via PR
4. Review and validation
5. Merged and available to all users

### Release Process
1. Features developed in feature branches
2. Merged to develop for integration testing
3. Release candidates from develop
4. Production releases to main
5. Auto-update distributes to users

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines on:
- Code standards
- Testing requirements
- PR process
- Community guidelines

---

*This architecture is designed for scalability, security, and community growth while maintaining simplicity for end users.*

**Last updated**: July 29, 2025
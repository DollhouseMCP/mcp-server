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
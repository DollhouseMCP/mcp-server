## 🎨 Portfolio System

The DollhouseMCP Portfolio system provides a comprehensive framework for managing AI elements locally and in the cloud.

### Portfolio Structure

Your portfolio is organized by element type:

```
~/.dollhouse/portfolio/
├── personas/       # Behavioral profiles (Markdown files)
├── skills/         # Discrete capabilities (Markdown files)
├── templates/      # Reusable content structures (Markdown files)
├── agents/         # Goal-oriented actors (Markdown files)
├── memories/       # Persistent context (YAML files with date folders)
│   ├── 2025-09-18/
│   │   └── project-context.yaml
│   └── 2025-09-19/
│       ├── meeting-notes.yaml
│       └── code-review.yaml
└── ensembles/      # Element combinations (Markdown files)
```

**Note on File Types:**
- **Markdown (.md)**: Used for personas, skills, templates, agents, and ensembles - human-readable with YAML frontmatter
- **YAML (.yaml)**: Used exclusively for memories - structured data optimized for context storage

**Memory Organization:**
- Memories use automatic **YYYY-MM-DD** folder structure to prevent flat directory performance issues
- Each memory file can grow up to ~100KB before creating a new file
- Folder structure enables unlimited memory collections without degradation

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
# Modular README System

This directory contains the modular README building system for DollhouseMCP.

## Overview

Instead of maintaining a single large README file, we use a modular approach where:
- Content is split into small, focused chunks
- Different README versions are built for different audiences (NPM vs GitHub)
- Version numbers and outdated content are eliminated
- Changes to one section don't require editing the entire file

## Structure

```
docs/readme/
├── chunks/                 # Individual content pieces
│   ├── 00-header.md       # Basic header for NPM
│   ├── 00-header-extended.md  # Extended header for GitHub
│   ├── 01-installation.md # Installation instructions
│   ├── 02-quick-start.md  # Getting started guide
│   ├── 03-features.md     # Feature table
│   ├── 04-portfolio-brief.md  # Brief portfolio overview
│   ├── 05-troubleshooting-brief.md  # Common issues
│   ├── 06-resources.md    # Links and resources
│   ├── 07-changelog-recent.md  # Recent changes only
│   └── 08-license.md      # License information
├── config.json            # Build configuration
└── README.md             # This file
```

## Usage

### Building README Files

```bash
# Build all README versions
npm run build:readme

# Build NPM version only
npm run build:readme:npm

# Build GitHub version only
npm run build:readme:github
```

### Output Files

- `README.npm.md` - Concise version for NPM package page
- `README.github.md` - Complete version for GitHub repository

### Publishing Workflow

When publishing to NPM, the scripts automatically:
1. Build the NPM-optimized README
2. Copy it to README.md (what NPM reads)
3. Build and publish the package
4. Restore the original README.md after publishing

## Adding New Content

### Creating a New Chunk

1. Create a new markdown file in `chunks/` directory
2. Name it with a number prefix for ordering (e.g., `09-new-section.md`)
3. Add the chunk name to `config.json` for the appropriate target(s)

### Editing Existing Content

Simply edit the relevant chunk file. The changes will be included next time you build.

## Configuration

The `config.json` file controls:
- Which chunks are included in each README version
- The order of chunks
- Output file locations
- Separator between chunks

## Best Practices

1. **No Version Numbers**: Avoid hardcoded version numbers in chunks
2. **Keep Chunks Focused**: Each chunk should cover one topic
3. **Use Clear Names**: Chunk names should indicate their content
4. **Test Builds**: Always test after making changes
5. **NPM vs GitHub**: Remember NPM users want quick usage info, GitHub users want complete docs

## Maintenance

### Regular Tasks

- Review and update chunks when features change
- Keep troubleshooting section current
- Update changelog chunk for releases
- Remove outdated information

### Before Releases

1. Update changelog chunk with new version info
2. Review all chunks for accuracy
3. Build and review both README versions
4. Commit changes before tagging release
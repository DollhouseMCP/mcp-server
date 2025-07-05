# Auto-Update System Quick Reference

## Overview
The DollhouseMCP auto-update system allows users to update the server directly through MCP tools. It includes version checking, backup creation, and rollback capabilities.

## Architecture

### Core Components
```
src/update/
├── UpdateManager.ts      # Main orchestrator
├── UpdateChecker.ts      # GitHub API version checking
├── UpdateTools.ts        # MCP tool implementations
├── VersionManager.ts     # Version comparison logic
├── DependencyChecker.ts  # Git/npm validation
├── BackupManager.ts      # Backup/rollback handling
└── types.ts             # TypeScript interfaces
```

### MCP Tools Available
1. `check_for_updates` - Check GitHub for new releases
2. `update_server` - Perform update with optional backup
3. `rollback_update` - Restore from backup
4. `get_server_status` - View current version info

## Key Classes

### UpdateManager
- Main entry point for update operations
- Coordinates all other components
- Handles progress reporting

### UpdateChecker
- Fetches latest release from GitHub API
- Compares versions
- Formats update messages

### BackupManager
- Creates timestamped backups
- Manages backup cleanup (keeps 5 most recent)
- Handles rollback operations

### DependencyChecker
- Validates git and npm availability
- Checks version requirements
- Reports missing dependencies

## Update Flow
1. User runs `check_for_updates` tool
2. UpdateChecker queries GitHub releases API
3. Version comparison determines if update available
4. User runs `update_server` with backup option
5. BackupManager creates backup
6. Git pull + npm install + build
7. Success confirmation or rollback option

## Configuration
- GitHub repo: `mickdarling/DollhouseMCP`
- Backup location: `.backup-{timestamp}` directories
- Max backups: 5 (configurable in BackupManager)

## Testing Status
⚠️ **NO TESTS EXIST** - See Issue #61

The auto-update system is functional but lacks test coverage. The original tests in `auto-update.test.ts` were removed because they tested a different implementation pattern.

## Security Considerations
- Uses `safeExec` for command execution
- Validates all inputs
- No shell execution (uses spawn with arrays)
- GitHub API rate limiting implemented

## Next Steps
1. Write integration tests (Issue #61)
2. Document user guide (Issue #62)
3. Add progress indicators to UI
4. Consider automated update checks
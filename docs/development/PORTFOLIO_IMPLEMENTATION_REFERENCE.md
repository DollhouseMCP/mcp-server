# Portfolio Implementation Reference

## Overview
This document serves as a technical reference for the portfolio system implemented in PR #301. Use this when working with or extending the portfolio functionality.

## Architecture

### PortfolioManager
Singleton class managing the portfolio directory structure.

**Key Features:**
- Singleton pattern with race condition protection
- Environment variable support (`DOLLHOUSE_PORTFOLIO_DIR`)
- Type-safe element directory management
- Cross-platform path handling

**Security Features:**
- Path traversal prevention in `getElementPath()`
- Environment variable validation
- Filename sanitization
- Protection against malicious paths

**Usage:**
```typescript
const portfolioManager = PortfolioManager.getInstance();
const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
const personaPath = portfolioManager.getElementPath(ElementType.PERSONA, 'my-persona.md');
```

### MigrationManager
Handles migration from legacy personas directory to portfolio structure.

**Key Features:**
- Non-destructive migration (preserves originals)
- Optional backup with timestamps
- Unicode normalization during migration
- Detailed error reporting
- Progress tracking

**Usage:**
```typescript
const migrationManager = new MigrationManager(portfolioManager);
if (await migrationManager.needsMigration()) {
  const result = await migrationManager.migrate({ backup: true });
  console.log(`Migrated ${result.migratedCount} personas`);
}
```

## Directory Structure
```
~/.dollhouse/portfolio/
├── personas/       # Behavioral profiles
├── skills/         # Discrete capabilities
├── templates/      # Reusable structures
├── ensembles/      # Element groups
├── agents/         # Autonomous actors
│   └── .state/     # Agent state storage
└── memories/       # Persistent context
    └── .storage/   # Memory backends
```

## Security Considerations

### Path Validation
The system validates all paths to prevent:
- Directory traversal (`../`)
- Absolute paths
- Hidden files (`.hidden`)
- Null bytes
- Path separators in filenames

### Environment Variables
`DOLLHOUSE_PORTFOLIO_DIR` must be:
- An absolute path
- Not contain `..`
- Not start with `/etc` or `/sys`

### Unicode Security
All filenames and content are normalized using `UnicodeValidator` to prevent:
- Homograph attacks
- Direction override attacks
- Zero-width character injection

## Error Handling

### Filesystem Errors
The system handles:
- `ENOENT` - Directory doesn't exist (returns empty array)
- `EACCES`/`EPERM` - Permission denied (logs and returns empty)
- `ENOTDIR` - Path is not a directory (throws error)
- Other errors - Logged with full context

### Migration Errors
- Individual file failures don't stop migration
- Errors are collected and reported
- Stack traces preserved in logs
- Backup created before migration

## Testing

### Test Files
- `PortfolioManager.test.ts` - Core functionality (19 tests)
- `PortfolioManager.security.test.ts` - Security tests (17 tests)
- `MigrationManager.test.ts` - Migration logic (12 tests)

### Key Test Scenarios
- Path traversal prevention
- Environment variable validation
- Race condition handling
- Migration with/without legacy personas
- Error handling and recovery

## Integration Points

### Main Server (`src/index.ts`)
```typescript
// Initialize portfolio system
this.portfolioManager = PortfolioManager.getInstance();
this.migrationManager = new MigrationManager(this.portfolioManager);

// Use portfolio personas directory
this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);

// Initialize and migrate on startup
await this.initializePortfolio();
```

### PersonaLoader
Updated to optionally use portfolio directory:
```typescript
constructor(personasDir?: string) {
  this.portfolioManager = PortfolioManager.getInstance();
  this.personasDir = personasDir || this.portfolioManager.getElementDir(ElementType.PERSONA);
}
```

## Future Enhancements

### High Priority
- File locking (#302)
- Atomic operations (#303)

### Medium Priority
- Pagination (#304)
- Security tests (#305)
- Concurrent testing (#306)
- Migration recovery (#308)

### Low Priority
- Performance testing (#307)
- Backup enhancements (#309)

## Migration Strategy
1. Check for legacy personas in `~/.dollhouse/personas/`
2. Create backup if requested
3. Initialize portfolio structure
4. Copy each persona with Unicode normalization
5. Preserve original files
6. Report results

## Best Practices
1. Always use `PortfolioManager` for paths
2. Validate user input before passing to element methods
3. Handle errors gracefully with user-friendly messages
4. Log security events for audit trails
5. Test with various Unicode inputs
6. Consider concurrent access in future features

---
*This reference will be updated as the portfolio system evolves.*
# Auto-Update API Reference

## Core Classes

### UpdateManager

The main orchestrator for update operations.

```typescript
class UpdateManager {
  constructor(
    rootDir: string = process.cwd(),
    options?: UpdateManagerOptions
  )
}
```

#### Methods

##### performUpdate(autoConfirm: boolean = false): Promise<void>
Performs a complete update cycle including backup, download, and installation.

**Parameters:**
- `autoConfirm`: Skip user confirmation prompts

**Throws:**
- `Error` if update fails at any stage

**Example:**
```typescript
const updateManager = new UpdateManager();
await updateManager.performUpdate(true);
```

##### rollback(autoConfirm: boolean = false): Promise<void>
Restores from a previous backup.

**Parameters:**
- `autoConfirm`: Skip user confirmation prompts

**Example:**
```typescript
await updateManager.rollback(false);
```

### UpdateChecker

Checks GitHub for available updates.

```typescript
class UpdateChecker {
  constructor(options?: UpdateCheckerOptions)
}
```

#### Methods

##### checkForUpdate(): Promise<UpdateCheckResult>
Checks if an update is available.

**Returns:**
```typescript
interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  isUpdateAvailable: boolean;
  releaseDate: string;
  releaseNotes: string;
  releaseUrl: string;
  tagName?: string;
  signatureVerified?: boolean;
  signerInfo?: string;
}
```

**Example:**
```typescript
const checker = new UpdateChecker();
const result = await checker.checkForUpdate();
if (result.isUpdateAvailable) {
  console.log(`Update available: ${result.latestVersion}`);
}
```

### BackupManager

Manages backup operations.

```typescript
class BackupManager {
  constructor(
    rootDir: string = process.cwd(),
    backupBaseDir: string = '.backup'
  )
}
```

#### Methods

##### createBackup(): Promise<string>
Creates a timestamped backup of the current installation.

**Returns:** Path to the created backup

**Example:**
```typescript
const backupManager = new BackupManager();
const backupPath = await backupManager.createBackup();
console.log(`Backup created at: ${backupPath}`);
```

##### restoreBackup(backupPath: string): Promise<void>
Restores from a specific backup.

**Parameters:**
- `backupPath`: Path to the backup directory

**Example:**
```typescript
await backupManager.restoreBackup('.backup-2025-01-08-1600');
```

##### listBackups(): string[]
Lists available backups sorted by date (newest first).

**Returns:** Array of backup directory names

##### cleanupOldBackups(keepCount: number = 5): Promise<void>
Removes old backups, keeping only the most recent ones.

### VersionManager

Handles version parsing and comparison.

```typescript
class VersionManager {
  constructor(packageJsonPath?: string)
}
```

#### Methods

##### getCurrentVersion(): string
Gets the current version from package.json.

##### parseVersion(version: string): ParsedVersion
Parses a semantic version string.

**Returns:**
```typescript
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}
```

##### compareVersions(v1: string, v2: string): number
Compares two version strings.

**Returns:**
- `-1` if v1 < v2
- `0` if v1 === v2
- `1` if v1 > v2

### RateLimiter

Implements token bucket rate limiting.

```typescript
class RateLimiter {
  constructor(options?: RateLimiterOptions)
  
  static getInstance(options?: RateLimiterOptions): RateLimiter
}
```

#### Configuration

```typescript
interface RateLimiterOptions {
  maxTokens?: number;      // Default: 10
  refillRate?: number;     // Default: 10 per minute
  initialTokens?: number;  // Default: 5
}
```

#### Methods

##### tryConsume(tokens: number = 1): boolean
Attempts to consume tokens from the bucket.

**Returns:** `true` if tokens were available, `false` otherwise

##### async consumeAsync(tokens: number = 1): Promise<void>
Waits until tokens are available, then consumes them.

##### getAvailableTokens(): number
Returns the current number of available tokens.

### SignatureVerifier

Verifies GPG signatures on releases.

```typescript
class SignatureVerifier {
  constructor(options?: SignatureVerifierOptions)
}
```

#### Methods

##### verifyGitHubRelease(releaseData: any): Promise<SignatureResult>
Verifies a GitHub release signature.

**Returns:**
```typescript
interface SignatureResult {
  verified: boolean;
  signerInfo?: string;
  error?: string;
}
```

### DependencyChecker

Validates system dependencies.

```typescript
class DependencyChecker {
  validateGitVersion(): Promise<void>
  validateNpmVersion(): Promise<void>
  validateAllDependencies(): Promise<void>
}
```

## MCP Tool Handlers

### Update Tools Configuration

```typescript
const updateTools = [
  {
    name: "check_for_updates",
    description: "Check if a newer version is available",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "update_server",
    description: "Update the server to the latest version",
    inputSchema: {
      type: "object",
      properties: {
        autoConfirm: {
          type: "boolean",
          description: "Automatically confirm update"
        }
      }
    }
  },
  {
    name: "rollback_update",
    description: "Rollback to a previous version",
    inputSchema: {
      type: "object",
      properties: {
        autoConfirm: {
          type: "boolean",
          description: "Automatically confirm rollback"
        }
      }
    }
  },
  {
    name: "get_server_status",
    description: "Get current server version and status",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];
```

## Error Types

### UpdateError
Base error class for update-related errors.

```typescript
class UpdateError extends Error {
  constructor(message: string, public code: string)
}
```

### Common Error Codes

- `VERSION_CHECK_FAILED` - Failed to check for updates
- `BACKUP_FAILED` - Backup creation failed
- `DOWNLOAD_FAILED` - Update download failed
- `INSTALL_FAILED` - Dependency installation failed
- `BUILD_FAILED` - Project build failed
- `ROLLBACK_FAILED` - Rollback operation failed
- `RATE_LIMITED` - Too many requests
- `DEPENDENCY_ERROR` - System dependency not met

## Events

The UpdateManager emits events during the update process:

```typescript
updateManager.on('progress', (stage: string, progress: number) => {
  console.log(`${stage}: ${progress}%`);
});

updateManager.on('error', (error: Error) => {
  console.error('Update error:', error);
});

updateManager.on('complete', () => {
  console.log('Update completed successfully');
});
```

## Configuration Options

### UpdateManagerOptions

```typescript
interface UpdateManagerOptions {
  backupDir?: string;          // Default: '.backup'
  autoCleanup?: boolean;       // Default: true
  maxBackups?: number;         // Default: 5
  skipSignature?: boolean;     // Default: false
  updateChannel?: string;      // Default: 'stable'
}
```

### UpdateCheckerOptions

```typescript
interface UpdateCheckerOptions {
  cacheTimeout?: number;       // Default: 900000 (15 min)
  apiTimeout?: number;         // Default: 30000 (30 sec)
  maxRetries?: number;         // Default: 3
  userAgent?: string;          // Custom User-Agent
  skipPrerelease?: boolean;    // Default: true
}
```

## Usage Examples

### Basic Update Flow

```typescript
import { UpdateManager, UpdateChecker } from './update/index.js';

async function performUpdate() {
  const checker = new UpdateChecker();
  const manager = new UpdateManager();
  
  // Check for updates
  const updateInfo = await checker.checkForUpdate();
  
  if (updateInfo.isUpdateAvailable) {
    console.log(`Update available: ${updateInfo.latestVersion}`);
    
    // Perform update
    await manager.performUpdate(false);
  } else {
    console.log('Already on latest version');
  }
}
```

### Custom Rate Limiting

```typescript
import { RateLimiter } from './update/RateLimiter.js';

// Configure custom rate limits
const rateLimiter = RateLimiter.getInstance({
  maxTokens: 20,
  refillRate: 20,  // 20 per minute
  initialTokens: 10
});

// Check before making requests
if (rateLimiter.tryConsume(1)) {
  // Make API request
} else {
  console.log('Rate limited, please wait');
}
```

### Error Handling

```typescript
try {
  await updateManager.performUpdate(true);
} catch (error) {
  if (error.code === 'RATE_LIMITED') {
    console.log('Too many requests, try again later');
  } else if (error.code === 'BUILD_FAILED') {
    console.log('Build failed, rolling back...');
    await updateManager.rollback(true);
  } else {
    console.error('Update failed:', error.message);
  }
}
```
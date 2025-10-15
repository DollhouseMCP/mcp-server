# Telemetry Best Practices and Recommendations for DollhouseMCP

**Date**: October 15, 2025
**Version**: 1.0
**Status**: Investigation and Recommendations
**Related Issues**: #739 (OAuth Telemetry), #441 (Update Success Rate Telemetry)

---

## Executive Summary

This document provides comprehensive guidance for implementing privacy-respecting, opt-in installation telemetry for DollhouseMCP. The goal is to track installation metrics, platform distribution, AI tool usage, and crash information to improve user experience without compromising privacy or trust.

### Key Recommendations

1. **Opt-in by default with explicit consent** - Never collect data without user knowledge
2. **Minimal data collection** - Only collect what's necessary for improving the product
3. **Anonymous by design** - No personally identifiable information (PII)
4. **Transparent disclosure** - Clear documentation of what is collected and why
5. **User control** - Easy opt-out, data viewing, and deletion
6. **AGPL-compliant** - Ensure telemetry respects dual-license requirements

---

## Table of Contents

1. [What to Collect](#what-to-collect)
2. [What NOT to Collect](#what-not-to-collect)
3. [Privacy-First Design Principles](#privacy-first-design-principles)
4. [Technical Implementation](#technical-implementation)
5. [AGPL and Dual-License Considerations](#agpl-and-dual-license-considerations)
6. [User Communication](#user-communication)
7. [Industry Examples](#industry-examples)
8. [Implementation Roadmap](#implementation-roadmap)
9. [Legal and Compliance](#legal-and-compliance)
10. [FAQ](#faq)

---

## What to Collect

### Installation Metrics (Core Priority)

#### Basic Installation Data
```typescript
interface InstallationMetrics {
  // Unique installation ID (generated locally, never linked to user)
  installId: string; // UUID v4, generated on first install

  // Installation timestamp
  installedAt: string; // ISO 8601 format

  // Package version
  version: string; // e.g., "1.9.16"

  // Installation method
  installMethod: 'npm' | 'npx' | 'git-clone' | 'docker' | 'unknown';

  // First-time install vs upgrade
  installType: 'new' | 'upgrade' | 'reinstall';

  // Previous version (if upgrade)
  previousVersion?: string;
}
```

#### Platform Information
```typescript
interface PlatformMetrics {
  // Operating system (generic)
  os: 'windows' | 'macos' | 'linux' | 'unknown';

  // OS version (major version only, no specific builds)
  osVersion: string; // e.g., "Windows 11", "macOS 14", "Ubuntu 22"

  // Node.js version (major.minor only)
  nodeVersion: string; // e.g., "20.10"

  // Architecture
  arch: 'x64' | 'arm64' | 'x86' | 'unknown';

  // MCP client being used
  mcpClient: 'claude-desktop' | 'claude-code' | 'gemini' | 'other' | 'unknown';

  // MCP client version (if detectable, major.minor only)
  mcpClientVersion?: string;
}
```

#### Usage Context (Optional, User-Controlled)
```typescript
interface UsageContext {
  // Installation environment
  environment: 'development' | 'production' | 'ci' | 'unknown';

  // Is this a CI/CD installation?
  isCi: boolean;

  // Package manager used
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'unknown';
}
```

### Update and Upgrade Metrics

```typescript
interface UpdateMetrics {
  // Update attempt
  updateAttemptId: string; // UUID for this specific update
  installId: string; // Link to installation

  // Version transition
  fromVersion: string;
  toVersion: string;

  // Update result
  success: boolean;

  // Error category (if failed)
  errorCategory?: 'network' | 'permissions' | 'dependencies' | 'corruption' | 'unknown';

  // Update duration (milliseconds)
  durationMs: number;

  // Timestamp
  timestamp: string; // ISO 8601
}
```

### Crash and Error Reporting

```typescript
interface CrashReport {
  // Crash ID
  crashId: string; // UUID
  installId: string; // Link to installation

  // Crash timestamp
  timestamp: string; // ISO 8601

  // Error category (sanitized, no stack traces with PII)
  errorType: 'startup' | 'runtime' | 'shutdown' | 'unknown';

  // Error category details
  errorCategory: string; // e.g., "MODULE_NOT_FOUND", "PERMISSION_DENIED"

  // Sanitized error message (no paths, no usernames)
  errorMessage: string; // e.g., "Failed to load configuration"

  // Component that crashed
  component: string; // e.g., "PortfolioManager", "MCPServer", "GitHubAuth"

  // Was recovery possible?
  recovered: boolean;

  // Platform context (same as installation)
  platform: PlatformMetrics;
}
```

### Aggregated Usage Statistics (Weekly Summary)

```typescript
interface WeeklySummary {
  // Installation ID
  installId: string;

  // Week identifier
  weekStart: string; // ISO 8601, Monday of the week

  // Usage frequency (counts, not detailed logs)
  activeDays: number; // How many days was it used this week?
  sessionCount: number; // How many distinct sessions?

  // Feature usage (aggregate counts)
  features: {
    personasUsed: number;
    skillsUsed: number;
    templatesUsed: number;
    agentsUsed: number;
    memoriesUsed: number;
    portfolioSyncs: number;
    collectionBrowses: number;
  };

  // Performance indicators
  avgStartupTime: number; // milliseconds
  avgResponseTime: number; // milliseconds

  // Health indicators
  crashCount: number;
  errorCount: number;
}
```

---

## What NOT to Collect

### Absolutely NO Collection of:

1. **Personal Identifiable Information (PII)**
   - Usernames
   - Email addresses
   - GitHub usernames or OAuth tokens
   - Real names
   - IP addresses (even anonymized)
   - Geographic location (beyond country-level aggregation)

2. **User Content**
   - Persona content or descriptions
   - Skill definitions
   - Template content
   - Memory content
   - File paths containing usernames
   - Any user-generated content

3. **Detailed System Information**
   - Full OS version strings (e.g., "Windows 11 Pro Build 22621.2428")
   - Computer name or hostname
   - CPU model or serial numbers
   - MAC addresses
   - Disk serial numbers
   - Network adapter information

4. **Behavioral Tracking**
   - Specific commands executed
   - Detailed interaction logs
   - Screen recordings or screenshots
   - Keystroke logging
   - Mouse movement tracking

5. **Third-Party Integrations**
   - GitHub API keys or tokens
   - OAuth credentials
   - Other service credentials
   - Private repository information

### Privacy-First Rules

```typescript
// GOOD: Generic, anonymous
{
  os: "macos",
  nodeVersion: "20.10",
  installMethod: "npm"
}

// BAD: Contains PII
{
  os: "macOS 14.1.2 on John's MacBook Pro",
  nodeVersion: "20.10.0",
  installPath: "/Users/john.doe/mcp-servers/",
  githubUser: "johndoe123"
}
```

---

## Privacy-First Design Principles

### 1. Opt-In by Default

**Never collect telemetry without explicit user consent.**

```typescript
// First-run experience
interface TelemetryConsent {
  // Show clear, non-intrusive prompt on first run
  promptShown: boolean;
  consentGiven: boolean;
  consentTimestamp: string;

  // What they consented to (version of privacy policy)
  policyVersion: string; // e.g., "1.0"
}
```

**Implementation:**
```typescript
// On first run or upgrade
async function promptForTelemetryConsent(): Promise<boolean> {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    DollhouseMCP Telemetry                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Help us improve DollhouseMCP by sharing anonymous usage    ║
║  data. We collect:                                           ║
║                                                              ║
║  ✓ Installation platform (OS, Node version)                 ║
║  ✓ Installation success/failure                             ║
║  ✓ Crash reports (sanitized, no personal info)             ║
║  ✓ Weekly usage summaries (feature counts only)            ║
║                                                              ║
║  We DO NOT collect:                                         ║
║  ✗ Personal information (names, emails, usernames)         ║
║  ✗ Your content (personas, skills, templates)              ║
║  ✗ Detailed usage logs or commands                         ║
║  ✗ IP addresses or location data                           ║
║                                                              ║
║  Full details: https://dollhousemcp.com/privacy/telemetry   ║
║                                                              ║
║  Enable anonymous telemetry? [Y/n]                          ║
║  (You can change this anytime with:                         ║
║   dollhousemcp telemetry enable/disable)                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

  const response = await prompt('Enable telemetry? [Y/n]: ');
  return response.toLowerCase() !== 'n';
}
```

### 2. Data Minimization

**Only collect what's necessary to improve the product.**

```typescript
// Principle: Can we answer the question without this data?
// Question: "How many macOS users are experiencing startup crashes?"
// Needed: os="macos", errorType="startup", errorCategory="MODULE_NOT_FOUND"
// NOT needed: specific module path, user home directory, exact timestamp

interface MinimalCrashReport {
  os: 'macos'; // Generic OS type
  errorCategory: 'MODULE_NOT_FOUND'; // Error category
  component: 'PortfolioManager'; // Component
  // NO: Full error message with paths
  // NO: Stack trace with file paths
  // NO: Environment variables
}
```

### 3. Anonymous by Design

**No way to link telemetry data back to individual users.**

```typescript
// Installation ID generation
function generateInstallId(): string {
  // UUID v4 - cryptographically random
  // Generated locally, never linked to user identity
  // Can't be reversed to find user
  return crypto.randomUUID();
}

// Example: Two installations by same user = two different IDs
// Installation 1: 550e8400-e29b-41d4-a716-446655440000
// Installation 2: f47ac10b-58cc-4372-a567-0e02b2c3d479
// No way to know these are the same person
```

### 4. Transparent Collection

**Users know exactly what is collected and when.**

```typescript
// Local telemetry log (user can view anytime)
interface TelemetryLog {
  timestamp: string;
  eventType: string;
  data: object;
  sentToServer: boolean;
}

// Command: dollhousemcp telemetry show
function showTelemetryLog(): void {
  const log = loadLocalTelemetryLog();
  console.log('Last 30 days of telemetry events:');
  console.log(JSON.stringify(log, null, 2));
}
```

### 5. User Control

**Users can opt-out, view data, and delete data at any time.**

```typescript
// Telemetry management commands
interface TelemetryCommands {
  // Enable/disable
  enable(): Promise<void>;
  disable(): Promise<void>;

  // View collected data (locally)
  show(): Promise<TelemetryLog[]>;

  // Delete local data
  deleteLocal(): Promise<void>;

  // Request server-side deletion
  deleteRemote(): Promise<void>;

  // Check status
  status(): Promise<TelemetryStatus>;
}

// Implementation
dollhousemcp telemetry enable
dollhousemcp telemetry disable
dollhousemcp telemetry show
dollhousemcp telemetry delete
dollhousemcp telemetry status
```

---

## Technical Implementation

### 1. Architecture

```
┌─────────────────┐
│   User System   │
│   (DollhouseMCP)│
└────────┬────────┘
         │
         │ 1. Event occurs (install, crash, etc.)
         │
         ▼
┌─────────────────┐
│ Telemetry Client│
│  (Local Buffer) │
├─────────────────┤
│ - Validates     │
│ - Sanitizes     │
│ - Anonymizes    │
│ - Batches       │
└────────┬────────┘
         │
         │ 2. Batched, sanitized data
         │    (if user opted in)
         │
         ▼
┌─────────────────┐
│ Telemetry Server│
│   (Anonymous)   │
├─────────────────┤
│ - Aggregates    │
│ - Analyzes      │
│ - Stores        │
└────────┬────────┘
         │
         │ 3. Aggregated insights
         │
         ▼
┌─────────────────┐
│   Dashboard     │
│  (Developers)   │
└─────────────────┘
```

### 2. Local Telemetry Client

```typescript
// src/telemetry/TelemetryClient.ts

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  batchSize: number; // Send in batches to reduce network calls
  flushInterval: number; // Send every N seconds
  retryAttempts: number;
  timeout: number;
}

export class TelemetryClient {
  private config: TelemetryConfig;
  private buffer: TelemetryEvent[] = [];
  private installId: string;

  constructor(config: TelemetryConfig) {
    this.config = config;
    this.installId = this.loadOrGenerateInstallId();
  }

  /**
   * Load existing install ID or generate new one
   */
  private loadOrGenerateInstallId(): string {
    const configPath = path.join(os.homedir(), '.dollhouse', 'telemetry.json');

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.installId;
    } catch {
      const newId = crypto.randomUUID();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        installId: newId,
        createdAt: new Date().toISOString()
      }));
      return newId;
    }
  }

  /**
   * Record an event (sanitized before storage)
   */
  public async trackEvent(event: TelemetryEvent): Promise<void> {
    if (!this.config.enabled) {
      return; // Telemetry disabled, do nothing
    }

    // Sanitize event before adding to buffer
    const sanitized = this.sanitizeEvent(event);

    // Add to local buffer
    this.buffer.push(sanitized);

    // Log locally for user transparency
    this.logEventLocally(sanitized);

    // Flush if batch size reached
    if (this.buffer.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  /**
   * Sanitize event to remove PII
   */
  private sanitizeEvent(event: TelemetryEvent): TelemetryEvent {
    const sanitized = { ...event };

    // Remove any paths with potential usernames
    if (sanitized.errorMessage) {
      sanitized.errorMessage = this.sanitizePath(sanitized.errorMessage);
    }

    // Validate no PII in fields
    this.validateNoPII(sanitized);

    return sanitized;
  }

  /**
   * Remove usernames from file paths
   */
  private sanitizePath(message: string): string {
    // Replace /Users/username with /Users/<user>
    message = message.replace(/\/Users\/[^\/]+/g, '/Users/<user>');
    // Replace C:\Users\username with C:\Users\<user>
    message = message.replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\<user>');
    // Replace /home/username with /home/<user>
    message = message.replace(/\/home\/[^\/]+/g, '/home/<user>');

    return message;
  }

  /**
   * Validate no PII in event
   */
  private validateNoPII(event: TelemetryEvent): void {
    const str = JSON.stringify(event);

    // Check for email patterns
    if (/@.+\..+/.test(str)) {
      throw new Error('Telemetry event contains email address');
    }

    // Check for potential usernames in paths
    if (/\/Users\/(?!<user>)[a-z]/.test(str) || /C:\\Users\\(?!<user>)[a-z]/i.test(str)) {
      throw new Error('Telemetry event contains unsanitized path');
    }
  }

  /**
   * Log event locally for user transparency
   */
  private logEventLocally(event: TelemetryEvent): void {
    const logPath = path.join(os.homedir(), '.dollhouse', 'telemetry.log');
    const logEntry = {
      timestamp: new Date().toISOString(),
      event,
      sentToServer: false
    };

    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  }

  /**
   * Send buffered events to server
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const batch = [...this.buffer];
    this.buffer = [];

    try {
      await this.sendBatch(batch);
      this.updateLocalLogAsSent(batch);
    } catch (error) {
      // Failed to send, add back to buffer for retry
      this.buffer.unshift(...batch);
      console.error('Failed to send telemetry (will retry):', error.message);
    }
  }

  /**
   * Send batch to telemetry server
   */
  private async sendBatch(events: TelemetryEvent[]): Promise<void> {
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telemetry-Version': '1.0'
      },
      body: JSON.stringify({
        installId: this.installId,
        events
      }),
      signal: AbortSignal.timeout(this.config.timeout)
    });

    if (!response.ok) {
      throw new Error(`Telemetry server error: ${response.status}`);
    }
  }

  /**
   * Update local log to mark events as sent
   */
  private updateLocalLogAsSent(events: TelemetryEvent[]): void {
    // Update local log to show these were sent successfully
    // (Implementation details omitted for brevity)
  }
}
```

### 3. Event Types

```typescript
// src/telemetry/types.ts

export type TelemetryEventType =
  | 'installation'
  | 'update'
  | 'crash'
  | 'error'
  | 'weekly_summary';

export interface BaseTelemetryEvent {
  eventType: TelemetryEventType;
  timestamp: string; // ISO 8601
  installId: string;
  version: string;
  platform: PlatformMetrics;
}

export interface InstallationEvent extends BaseTelemetryEvent {
  eventType: 'installation';
  installMethod: 'npm' | 'npx' | 'git-clone' | 'docker';
  installType: 'new' | 'upgrade' | 'reinstall';
  previousVersion?: string;
}

export interface UpdateEvent extends BaseTelemetryEvent {
  eventType: 'update';
  fromVersion: string;
  toVersion: string;
  success: boolean;
  errorCategory?: string;
  durationMs: number;
}

export interface CrashEvent extends BaseTelemetryEvent {
  eventType: 'crash';
  errorType: 'startup' | 'runtime' | 'shutdown';
  errorCategory: string;
  component: string;
  recovered: boolean;
  // errorMessage is sanitized (no paths, no usernames)
  errorMessage: string;
}

export interface WeeklySummaryEvent extends BaseTelemetryEvent {
  eventType: 'weekly_summary';
  weekStart: string;
  activeDays: number;
  sessionCount: number;
  features: {
    personasUsed: number;
    skillsUsed: number;
    templatesUsed: number;
    agentsUsed: number;
    memoriesUsed: number;
  };
  performance: {
    avgStartupTime: number;
    avgResponseTime: number;
  };
  health: {
    crashCount: number;
    errorCount: number;
  };
}
```

### 4. Usage in Code

```typescript
// Example: Track installation
import { TelemetryClient } from './telemetry/TelemetryClient';

async function onInstallComplete(): Promise<void> {
  const telemetry = TelemetryClient.getInstance();

  await telemetry.trackEvent({
    eventType: 'installation',
    timestamp: new Date().toISOString(),
    installId: telemetry.getInstallId(),
    version: packageJson.version,
    platform: {
      os: process.platform === 'darwin' ? 'macos' :
          process.platform === 'win32' ? 'windows' : 'linux',
      osVersion: getOSVersion(), // Major version only
      nodeVersion: process.version.split('.').slice(0, 2).join('.'),
      arch: process.arch as 'x64' | 'arm64',
      mcpClient: detectMCPClient()
    },
    installMethod: 'npm',
    installType: 'new'
  });
}

// Example: Track crash
process.on('uncaughtException', async (error) => {
  const telemetry = TelemetryClient.getInstance();

  await telemetry.trackEvent({
    eventType: 'crash',
    timestamp: new Date().toISOString(),
    installId: telemetry.getInstallId(),
    version: packageJson.version,
    platform: getPlatformMetrics(),
    errorType: 'runtime',
    errorCategory: error.code || 'UNKNOWN',
    component: extractComponentFromStack(error.stack),
    recovered: false,
    errorMessage: sanitizeErrorMessage(error.message)
  });

  // Re-throw after telemetry sent
  throw error;
});
```

### 5. Server-Side (Recommendations)

```typescript
// Telemetry server should:
// 1. Accept ONLY anonymized data
// 2. Aggregate data before storage
// 3. Delete installation-level data after aggregation
// 4. Never log raw events

interface TelemetryServer {
  // Endpoint for receiving events
  POST /api/v1/telemetry

  // Aggregated statistics (public dashboard)
  GET /api/v1/stats/installations
  GET /api/v1/stats/platforms
  GET /api/v1/stats/errors

  // Deletion endpoint (user-initiated)
  DELETE /api/v1/telemetry/:installId
}

// Server aggregation example
async function aggregateInstallations(events: InstallationEvent[]): Promise<void> {
  // Group by platform
  const byPlatform = groupBy(events, e => e.platform.os);

  // Store only aggregates
  await db.insert('daily_installations', {
    date: today,
    windows: byPlatform.windows?.length || 0,
    macos: byPlatform.macos?.length || 0,
    linux: byPlatform.linux?.length || 0
  });

  // Delete individual events after aggregation
  await db.delete('raw_events', { eventType: 'installation', date: today });
}
```

### 6. Telemetry Configuration File

```typescript
// ~/.dollhouse/telemetry.json
interface TelemetryLocalConfig {
  // Installation ID (generated once)
  installId: string;
  createdAt: string;

  // User preferences
  enabled: boolean;
  consentGiven: boolean;
  consentTimestamp: string;
  policyVersion: string;

  // Collection preferences
  collectCrashReports: boolean;
  collectUsageStats: boolean;
  collectPerformanceMetrics: boolean;

  // Privacy settings
  maxDataRetention: number; // days
}

// Example
{
  "installId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": "2025-10-15T10:30:00Z",
  "enabled": true,
  "consentGiven": true,
  "consentTimestamp": "2025-10-15T10:30:00Z",
  "policyVersion": "1.0",
  "collectCrashReports": true,
  "collectUsageStats": true,
  "collectPerformanceMetrics": false,
  "maxDataRetention": 90
}
```

---

## AGPL and Dual-License Considerations

### AGPL-3.0 Requirements

The AGPL-3.0 license has specific implications for telemetry:

1. **Network Use Disclosure**
   - AGPL requires source code availability for "network use"
   - Telemetry server code must be open source
   - Users must be able to self-host telemetry server

2. **Modifications Must Be Shared**
   - If you modify telemetry code, modifications must be shared
   - Applies to both client and server components

3. **User Freedom**
   - Users must be able to disable telemetry
   - Users must be able to run modified versions without telemetry
   - No "telemetry lock-in" - software must work fully without it

### Dual-License Considerations

DollhouseMCP uses dual licensing (AGPL-3.0 + Commercial):

1. **AGPL Users**
   - Must have full control over telemetry
   - Can disable, modify, or remove telemetry code
   - Can self-host telemetry server

2. **Commercial License Users**
   - May have different telemetry terms
   - Could include mandatory telemetry for support purposes
   - Document differences clearly in commercial license

### Recommendations for AGPL Compliance

```typescript
// 1. Make telemetry completely optional
export const TELEMETRY_ENABLED = process.env.DOLLHOUSE_TELEMETRY !== 'false';

// 2. Document telemetry server source
// README.md
/**
 * Telemetry Server
 *
 * The telemetry server source code is available at:
 * https://github.com/DollhouseMCP/telemetry-server
 *
 * You can self-host the telemetry server by:
 * 1. Clone the repository
 * 2. Follow setup instructions
 * 3. Set DOLLHOUSE_TELEMETRY_ENDPOINT environment variable
 */

// 3. Allow endpoint override
export const TELEMETRY_ENDPOINT =
  process.env.DOLLHOUSE_TELEMETRY_ENDPOINT ||
  'https://telemetry.dollhousemcp.com/api/v1/events';

// 4. Provide easy disable
// Command: dollhousemcp telemetry disable --permanent
// Environment: DOLLHOUSE_TELEMETRY=false
// Config file: telemetry.enabled = false
```

### License-Specific Telemetry Documentation

```markdown
# Telemetry and Licensing

## AGPL-3.0 Users

Under the AGPL-3.0 license, telemetry is:
- **Opt-in by default** - You choose whether to enable it
- **Completely optional** - All features work without telemetry
- **Open source** - Telemetry server code is available
- **Self-hostable** - You can run your own telemetry server
- **Removable** - You can modify code to remove telemetry entirely

## Commercial License Users

Commercial license users may have different telemetry terms:
- See your commercial license agreement for details
- Contact sales@dollhousemcp.com for questions

## Privacy Commitment

Regardless of license:
- We never collect personal information
- All telemetry data is anonymous
- You have full control over your data
- Transparent disclosure of what is collected
```

---

## User Communication

### 1. Installation Prompt

Show during first installation or upgrade:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│           Welcome to DollhouseMCP v1.9.16!                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Help Improve DollhouseMCP                   │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │                                                     │   │
│  │  Would you like to share anonymous usage data to   │   │
│  │  help us improve DollhouseMCP?                      │   │
│  │                                                     │   │
│  │  We collect:                                        │   │
│  │  ✓ Platform (OS, Node version, MCP client)         │   │
│  │  ✓ Installation success/failure rates              │   │
│  │  ✓ Crash reports (no personal info)               │   │
│  │  ✓ Feature usage statistics (counts only)         │   │
│  │                                                     │   │
│  │  We NEVER collect:                                 │   │
│  │  ✗ Your name, email, or GitHub username           │   │
│  │  ✗ Your content (personas, skills, etc.)          │   │
│  │  ✗ Detailed logs or commands                      │   │
│  │  ✗ IP addresses or location                       │   │
│  │                                                     │   │
│  │  Learn more: https://dollhousemcp.com/telemetry    │   │
│  │                                                     │   │
│  │  [ Enable Telemetry ]  [ No, Thanks ]             │   │
│  │                                                     │   │
│  │  (You can change this anytime with:                │   │
│  │   dollhousemcp telemetry enable/disable)           │   │
│  │                                                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2. README Documentation

Add to README.md:

```markdown
## Telemetry

DollhouseMCP includes **optional, anonymous telemetry** to help us improve the project.

### What We Collect

- **Platform information**: OS, Node version, MCP client
- **Installation metrics**: Success/failure, installation method
- **Crash reports**: Sanitized error categories (no personal info)
- **Usage statistics**: Weekly feature counts (no detailed logs)

### What We DON'T Collect

- Personal information (names, emails, usernames)
- Your content (personas, skills, templates, memories)
- Detailed usage logs or commands
- IP addresses or geographic location
- Any personally identifiable information

### Enabling/Disabling Telemetry

**Opt-in during installation:**
```bash
npm install @dollhousemcp/mcp-server
# You'll be prompted to enable/disable telemetry
```

**Change anytime:**
```bash
# Enable telemetry
dollhousemcp telemetry enable

# Disable telemetry
dollhousemcp telemetry disable

# Check status
dollhousemcp telemetry status

# View collected data
dollhousemcp telemetry show

# Delete local data
dollhousemcp telemetry delete
```

**Environment variable:**
```bash
# Disable telemetry completely
export DOLLHOUSE_TELEMETRY=false
```

**Configuration file:**
```json
{
  "telemetry": {
    "enabled": false
  }
}
```

### Privacy Policy

For complete details, see our [Telemetry Privacy Policy](https://dollhousemcp.com/privacy/telemetry).

### Self-Hosting

The telemetry server is open source. You can self-host it:

```bash
git clone https://github.com/DollhouseMCP/telemetry-server
cd telemetry-server
# Follow setup instructions in README

# Point DollhouseMCP to your server
export DOLLHOUSE_TELEMETRY_ENDPOINT=https://your-server.com/api/v1/events
```
```

### 3. Dedicated Privacy Policy Page

Create `docs/privacy/TELEMETRY_PRIVACY_POLICY.md`:

```markdown
# Telemetry Privacy Policy

**Last Updated**: October 15, 2025
**Version**: 1.0

## Overview

This privacy policy describes how DollhouseMCP collects, uses, and protects telemetry data.

## What We Collect

### Platform Information
- Operating system type (Windows, macOS, Linux)
- Operating system major version (e.g., "macOS 14", not specific builds)
- Node.js major version (e.g., "20.x")
- System architecture (x64, arm64)
- MCP client being used (Claude Desktop, Claude Code, Gemini, Other)

### Installation Metrics
- Installation timestamp
- Package version installed
- Installation method (npm, npx, git, docker)
- Installation type (new install, upgrade, reinstall)
- Previous version (for upgrades)
- Update success/failure status

### Error and Crash Reports
- Error category (e.g., "MODULE_NOT_FOUND", "PERMISSION_DENIED")
- Component that encountered the error
- Sanitized error message (no file paths, no usernames)
- Whether recovery was successful
- Timestamp of error

### Usage Statistics (Weekly Aggregates)
- Number of active days per week
- Number of sessions
- Feature usage counts (e.g., "5 personas used this week")
- Average startup time
- Average response time
- Crash and error counts

### Unique Installation ID
- A randomly generated UUID (version 4)
- Created locally on first installation
- Cannot be linked back to any user identity
- Used only to aggregate events from the same installation

## What We DON'T Collect

We **never** collect:

- Personal information (names, emails, addresses, phone numbers)
- GitHub usernames or OAuth tokens
- IP addresses (not even anonymized)
- Geographic location (not even country-level)
- User content (personas, skills, templates, memories)
- File paths containing usernames
- Detailed command logs
- Keystroke or interaction logs
- Computer or hostname
- Network information (MAC addresses, etc.)
- Any information that could identify you

## How We Use Telemetry Data

### Aggregate Analysis
- Calculate installation success rates
- Identify common error patterns
- Understand platform distribution
- Track feature adoption
- Measure performance trends

### Product Improvements
- Prioritize bug fixes based on crash frequency
- Optimize for most common platforms
- Improve installation experience
- Enhance error messages
- Guide feature development

### What We Don't Do
- We never sell telemetry data
- We never share data with third parties (except aggregate public statistics)
- We never use data for advertising
- We never link data to individual users

## Data Storage and Retention

### Local Storage
- Telemetry events are logged locally in `~/.dollhouse/telemetry.log`
- You can view this file anytime
- Local logs are kept for 90 days by default
- You can delete local logs anytime

### Server Storage
- Events are sent in batches to our telemetry server
- Events are aggregated within 24 hours
- Individual events are deleted after aggregation
- Aggregated statistics are kept indefinitely (no PII)
- You can request deletion of your installation's data

## Your Rights and Controls

### Opt-In/Opt-Out
- Telemetry is **opt-in by default**
- You are prompted during installation
- You can enable/disable anytime
- Disabling stops all collection immediately

### View Your Data
```bash
# View local telemetry log
dollhousemcp telemetry show

# View configuration
cat ~/.dollhouse/telemetry.json
```

### Delete Your Data
```bash
# Delete local telemetry data
dollhousemcp telemetry delete --local

# Request server-side deletion
dollhousemcp telemetry delete --remote

# Or both
dollhousemcp telemetry delete --all
```

### Self-Host Telemetry Server
- Telemetry server code is open source
- You can run your own telemetry server
- Point DollhouseMCP to your server via environment variable
- Full control over all data

## Security

### Data Transmission
- All telemetry data sent over HTTPS
- No sensitive information transmitted
- Failed transmissions are logged (for retry)

### Data Validation
- All events validated before sending
- Automatic PII detection and removal
- Path sanitization (removes usernames)
- Error message sanitization

### Server Security
- Data encrypted at rest
- Access logs monitored
- Regular security audits
- Minimal data retention

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be:
- Announced on GitHub (release notes)
- Documented in CHANGELOG
- Shown in application on next launch
- Posted at https://dollhousemcp.com/privacy/telemetry

If we make significant changes:
- You will be re-prompted for consent
- You can review changes before agreeing
- Previous consent becomes invalid

## Contact

Questions about telemetry or privacy:
- Email: privacy@dollhousemcp.com
- GitHub Issues: https://github.com/DollhouseMCP/mcp-server/issues
- GitHub Discussions: https://github.com/DollhouseMCP/mcp-server/discussions

## Open Source Commitment

Under AGPL-3.0:
- All telemetry code is open source
- Telemetry server code is open source
- You can audit all telemetry code
- You can modify or remove telemetry
- You can self-host telemetry infrastructure

---

**Summary**: We collect minimal, anonymous telemetry to improve DollhouseMCP. You have full control. We never collect personal information. All data is transparent and deletable.
```

### 4. In-App Notifications

```typescript
// Show notification when telemetry helps fix a bug
function showTelemetryImpactNotification(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  Thank You for Your Help!                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Your anonymous telemetry data helped us fix a critical     ║
║  startup crash affecting macOS 14 users.                    ║
║                                                              ║
║  This fix is in v1.9.17 (just released).                    ║
║                                                              ║
║  Community-powered bug fixes like this are only possible    ║
║  with your help. Thank you!                                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
}
```

---

## Industry Examples

### 1. VS Code Telemetry

**What they do right:**
- Clear documentation of what is collected
- Opt-out via setting: `"telemetry.telemetryLevel": "off"`
- Detailed telemetry viewer in UI
- Open source telemetry code
- Regular transparency reports

**What we can learn:**
- Provide GUI for telemetry settings (not just CLI)
- Show telemetry data in real-time
- Publish regular transparency reports

**VS Code telemetry settings:**
```json
{
  "telemetry.telemetryLevel": "all" | "error" | "crash" | "off",
  "telemetry.enableCrashReporter": true | false,
  "telemetry.enableTelemetry": true | false
}
```

### 2. Homebrew Analytics

**What they do right:**
- Opt-out by default for CI environments
- Anonymous by design (no user IDs at all)
- Public analytics dashboard
- Simple opt-out: `brew analytics off`
- Clear documentation

**What we can learn:**
- Auto-disable in CI environments
- Publish public dashboard with aggregated statistics
- Keep opt-out extremely simple

**Homebrew approach:**
```bash
# Opt-out
brew analytics off

# Check status
brew analytics

# What they collect (from their docs)
# - Command counts (e.g., "brew install" ran 1M times)
# - Formula install counts
# - macOS version distribution
# - Homebrew version distribution
```

### 3. Next.js Telemetry

**What they do right:**
- Zero personal data collection
- Completely anonymous
- Public disclosure of all events
- Easy opt-out: `npx next telemetry disable`
- Show example telemetry data in docs

**What we can learn:**
- Show real examples of telemetry events in documentation
- Use simple, friendly command names
- Focus on product improvement use cases

**Next.js telemetry events:**
```typescript
// They openly publish their telemetry events
{
  "eventName": "NEXT_BUILD_COMPLETED",
  "payload": {
    "durationInSeconds": 34,
    "totalPageCount": 15,
    "hasDunderPages": false
  }
}
```

### 4. npm CLI

**What they do right:**
- Opt-out via config: `npm config set send-metrics false`
- Minimal data collection
- Focus on error reporting
- Clear privacy policy

**What we can learn:**
- Use config system for persistence
- Focus on actionable data (errors, crashes)
- Keep data collection minimal

### 5. Sentry (Error Tracking)

**What they do right:**
- Specialized in crash/error reporting
- Automatic PII scrubbing
- User feedback collection (optional)
- Source map support for debugging
- Open source client libraries

**What we can learn:**
- Consider using Sentry for crash reports
- Automatic PII detection is critical
- Allow users to add context to crashes

### 6. Plausible Analytics (Privacy-First)

**What they do right:**
- No cookies, no tracking
- Completely anonymous
- EU/GDPR compliant
- Open source
- Public dashboards by default

**What we can learn:**
- Privacy-first analytics is possible
- Open source builds trust
- Public dashboards increase transparency

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

**Goals:**
- Set up telemetry infrastructure
- Implement basic event tracking
- Create opt-in/opt-out mechanism

**Tasks:**
1. Create `TelemetryClient` class with sanitization
2. Implement local telemetry log
3. Add opt-in prompt to installation
4. Create `dollhousemcp telemetry` CLI commands
5. Write privacy policy documentation

**Deliverables:**
- Working telemetry client (local only, no server yet)
- CLI commands for enable/disable/show/delete
- Documentation in README
- Privacy policy document

### Phase 2: Server Infrastructure (Week 3-4)

**Goals:**
- Set up telemetry server
- Implement event ingestion
- Create aggregation pipeline

**Tasks:**
1. Create telemetry server repository (open source)
2. Implement event ingestion API
3. Set up data aggregation (24-hour batches)
4. Implement deletion endpoint
5. Deploy server infrastructure

**Deliverables:**
- Open source telemetry server
- Public API documentation
- Self-hosting guide
- Aggregation working

### Phase 3: Event Implementation (Week 5-6)

**Goals:**
- Track key events
- Validate data collection
- Test privacy measures

**Tasks:**
1. Implement installation event tracking
2. Implement crash/error reporting
3. Implement update tracking
4. Implement weekly usage summaries
5. Add PII detection tests

**Deliverables:**
- All event types implemented
- Comprehensive test coverage
- PII detection working
- Local testing complete

### Phase 4: Dashboard and Reporting (Week 7-8)

**Goals:**
- Create public dashboard
- Generate insights
- Document findings

**Tasks:**
1. Create public analytics dashboard
2. Implement charts and graphs
3. Add export functionality
4. Create weekly/monthly reports
5. Document how data is used

**Deliverables:**
- Public dashboard at https://stats.dollhousemcp.com
- Weekly transparency reports
- Data usage documentation

### Phase 5: Iteration and Feedback (Ongoing)

**Goals:**
- Gather user feedback
- Improve privacy measures
- Add requested features

**Tasks:**
1. Monitor opt-in rates
2. Collect user feedback
3. Iterate on privacy measures
4. Add transparency features
5. Regular privacy audits

---

## Legal and Compliance

### GDPR Compliance (EU Users)

Even though telemetry is anonymous, GDPR still applies:

1. **Lawful Basis**
   - Consent (user opts in)
   - Legitimate interest (product improvement)

2. **User Rights**
   - Right to access (show command)
   - Right to deletion (delete command)
   - Right to data portability (export command)
   - Right to object (disable command)

3. **Requirements**
   - Clear consent mechanism ✓
   - Easy opt-out ✓
   - Privacy policy ✓
   - Data minimization ✓

### CCPA Compliance (California)

California Consumer Privacy Act requirements:

1. **Disclosure**
   - What data is collected ✓
   - Purpose of collection ✓
   - Categories of data ✓

2. **User Rights**
   - Right to know ✓
   - Right to delete ✓
   - Right to opt-out ✓

3. **Do Not Sell**
   - We don't sell data ✓
   - Clear disclosure ✓

### Other Regulations

**COPPA (Children's Privacy):**
- Don't target children under 13
- No age collection
- If children use product, need parental consent

**PIPEDA (Canada):**
- Similar to GDPR
- Consent required
- Reasonable security measures

**LGPD (Brazil):**
- Based on GDPR principles
- User consent
- Data minimization

### Recommendations

1. **Consult Legal Counsel**
   - Have lawyer review telemetry implementation
   - Ensure compliance with all applicable laws
   - Review privacy policy

2. **Document Everything**
   - What data is collected
   - Why it's collected
   - How it's used
   - How long it's retained

3. **Regular Audits**
   - Annual privacy audit
   - Update privacy policy as needed
   - Monitor regulatory changes

4. **Transparency**
   - Publish regular transparency reports
   - Disclose any data breaches immediately
   - Be proactive about privacy

---

## FAQ

### Q: Why collect telemetry at all?

**A:** Telemetry helps us:
- Understand what platforms to prioritize
- Identify and fix bugs faster
- Make data-driven decisions about features
- Improve installation success rates

Without telemetry, we're flying blind and making decisions based on assumptions.

### Q: Can you really not identify users?

**A:** Correct. The installation ID is a random UUID generated locally. We never collect:
- GitHub usernames
- Email addresses
- IP addresses
- Computer names
- Any other identifying information

Even if we wanted to, we couldn't link an installation ID back to a specific person.

### Q: What if I don't trust you?

**A:** You don't have to!
- All telemetry code is open source - audit it yourself
- Telemetry is opt-in - you choose whether to enable it
- You can self-host the telemetry server
- You can modify or remove telemetry code entirely (AGPL allows this)

### Q: Will features be locked behind telemetry?

**A:** Absolutely not. All features work fully without telemetry. Telemetry is purely for product improvement.

### Q: How often is data sent?

**A:** Events are batched and sent:
- Every 1 hour (if batch size reached)
- Every 24 hours (scheduled sync)
- On shutdown (flush remaining events)

Failed sends are retried with exponential backoff.

### Q: Can I see what data is being sent?

**A:** Yes! Run `dollhousemcp telemetry show` to see all local telemetry events. The format is identical to what is sent to the server.

### Q: Can I partially opt-in?

**A:** Yes! You can enable/disable specific telemetry types:

```bash
# Enable crash reports only
dollhousemcp telemetry enable --only-crashes

# Enable installation metrics only
dollhousemcp telemetry enable --only-installations

# Enable everything except performance metrics
dollhousemcp telemetry enable --no-performance
```

### Q: What about enterprise/corporate users?

**A:** Enterprise users often have strict data policies. We recommend:
- Disable telemetry in corporate environments
- Self-host telemetry server for internal metrics
- Use environment variable `DOLLHOUSE_TELEMETRY=false` in CI/CD

### Q: How do you prevent data breaches?

**A:** Multiple layers:
- No PII means no sensitive data to breach
- HTTPS for all transmission
- Encryption at rest
- Regular security audits
- Minimal data retention (aggregate and delete)

### Q: Will you ever change what data is collected?

**A:** If we add new telemetry events:
- We'll announce it in release notes
- We'll update the privacy policy
- You'll be re-prompted for consent
- Previous consent doesn't automatically apply to new data types

### Q: Can I export my telemetry data?

**A:** Yes:

```bash
# Export local telemetry log
dollhousemcp telemetry export --output telemetry.json

# Request server-side export
dollhousemcp telemetry export --remote --output server-data.json
```

### Q: What if I find a privacy issue?

**A:** Please report it immediately:
- Email: security@dollhousemcp.com
- GitHub Security Advisory (private)
- We'll fix it ASAP and notify all users

### Q: Do you use third-party analytics services?

**A:** No. We run our own telemetry infrastructure. No data goes to Google Analytics, Mixpanel, or similar services.

### Q: How long do you keep data?

**A:** - Individual events: 24 hours (then aggregated and deleted)
- Aggregated statistics: Indefinitely (no PII in aggregates)
- Local logs: 90 days by default (user configurable)

### Q: Can I contribute to the telemetry server?

**A:** Yes! The telemetry server is open source at:
https://github.com/DollhouseMCP/telemetry-server

We welcome contributions to improve privacy, security, and functionality.

---

## Conclusion

Implementing telemetry for DollhouseMCP requires careful balance between:
- **Product Improvement**: Gathering data to make informed decisions
- **User Privacy**: Protecting user information and building trust
- **Transparency**: Being open about what is collected and why
- **Compliance**: Following AGPL, GDPR, CCPA, and other regulations

### Key Principles to Remember

1. **Opt-in by default** - Never assume consent
2. **Minimal collection** - Only what's needed
3. **Anonymous by design** - No way to identify users
4. **Transparent disclosure** - Clear documentation
5. **User control** - Easy opt-out, view, and delete
6. **Open source** - Audit able telemetry code and server
7. **Regular audits** - Continuous privacy improvements

### Next Steps

1. Review this document with team
2. Get legal counsel review
3. Implement Phase 1 (foundation)
4. Test with small group of users
5. Gather feedback and iterate
6. Roll out to all users

### Success Metrics

- High opt-in rate (target: >60%)
- Low complaint rate (target: <1%)
- Actionable insights from data
- User trust maintained
- AGPL compliance maintained

---

**Document Version**: 1.0
**Last Updated**: October 15, 2025
**Next Review**: January 15, 2026
**Owner**: DollhouseMCP Core Team

For questions or feedback on this document:
- GitHub Issue: https://github.com/DollhouseMCP/mcp-server/issues
- Email: privacy@dollhousemcp.com

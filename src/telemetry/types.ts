/**
 * Telemetry type definitions for operational analytics
 *
 * Privacy-first design:
 * - No user data collection
 * - No personally identifiable information
 * - No telemetry from elements or user content
 * - Anonymous installation tracking only
 * - Easy opt-out via DOLLHOUSE_TELEMETRY=false
 *
 * Data collected:
 * - Installation ID (anonymous UUID)
 * - Server version
 * - Operating system type
 * - Node.js version
 * - MCP client type
 * - Timestamp
 */

/**
 * Installation event recorded on first run or version upgrade
 * Contains only technical metadata for operational insights
 */
export interface InstallationEvent {
  /** Event type identifier */
  event: 'install';

  /** Anonymous installation UUID (persistent per installation) */
  install_id: string;

  /** Server version (semver) */
  version: string;

  /** Operating system platform */
  os: string;

  /** Node.js version string */
  node_version: string;

  /** MCP client environment */
  mcp_client: string;

  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Telemetry system configuration
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled (respects DOLLHOUSE_TELEMETRY env var) */
  enabled: boolean;

  /** Path to persistent installation ID file */
  installIdPath: string;

  /** Path to telemetry log file */
  logPath: string;
}

/**
 * Auto-load metrics recorded on server startup
 */
export interface AutoLoadMetrics {
  /** ISO 8601 timestamp */
  timestamp: string;

  /** Server version (semver) */
  version: string;

  /** Number of memories loaded */
  memoryCount: number;

  /** Total estimated tokens loaded */
  totalTokens: number;

  /** Time taken to load memories (milliseconds) */
  loadTimeMs: number;

  /** Number of memories skipped */
  skippedCount: number;

  /** Number of warnings issued */
  warningCount: number;

  /** Whether budget was exceeded */
  budgetExceeded: boolean;

  /** Whether auto-load was emergency disabled */
  emergencyDisabled: boolean;
}

/**
 * Union type of all telemetry event types
 */
export type TelemetryEventType = 'install' | 'autoload_metrics';

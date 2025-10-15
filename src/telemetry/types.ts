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
  os: 'darwin' | 'win32' | 'linux' | string;

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
 * Union type of all telemetry event types
 * Currently only supports installation events
 */
export type TelemetryEventType = 'install';

/**
 * Operational Telemetry System
 *
 * Privacy-first anonymous installation analytics
 *
 * What is collected:
 * - Anonymous installation UUID (generated locally, persistent per install)
 * - Server version, OS type, Node.js version, MCP client type
 * - Installation timestamp
 *
 * What is NOT collected:
 * - User identity, personal information, or identifiable data
 * - Element content, persona data, or user-created content
 * - Usage patterns, commands, or interactions
 * - Network data, file paths, or system details beyond OS type
 *
 * Opt-out:
 * - Set environment variable: DOLLHOUSE_TELEMETRY=false (disables all telemetry)
 * - Set environment variable: DOLLHOUSE_TELEMETRY_NO_REMOTE=true (local only, no PostHog)
 * - Delete telemetry files: rm ~/.dollhouse/.telemetry-id ~/.dollhouse/telemetry.log
 *
 * Data storage:
 * - Local: ~/.dollhouse/.telemetry-id (UUID) and ~/.dollhouse/telemetry.log (events)
 * - Remote (automatic): PostHog analytics for basic installation metrics (opt-out available)
 *
 * Design principles:
 * - Fail gracefully: errors never crash the server
 * - Debug-only logging: no user-facing telemetry noise
 * - Check opt-out early: no file operations if disabled
 * - Remote telemetry is automatic: basic metrics sent to help project sustainability (opt-out available)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { PostHog } from 'posthog-node';
import { logger } from '../utils/logger.js';
import { VERSION } from '../constants/version.js';
import type { InstallationEvent, TelemetryConfig } from './types.js';
import { detectMCPClient } from './clientDetector.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export class OperationalTelemetry {
  private static installId: string | null = null;
  private static initialized = false;
  private static posthog: PostHog | null = null;

  /**
   * Check if telemetry is enabled
   * Respects DOLLHOUSE_TELEMETRY environment variable (default: true)
   * @returns true if telemetry is enabled, false if opted out
   */
  public static isEnabled(): boolean {
    const envValue = process.env.DOLLHOUSE_TELEMETRY;

    // If explicitly set to false, 0, or 'false', disable
    if (envValue === 'false' || envValue === '0' || envValue === 'FALSE') {
      return false;
    }

    // If explicitly set to true, 1, or 'true', enable
    if (envValue === 'true' || envValue === '1' || envValue === 'TRUE') {
      return true;
    }

    // Default: enabled (opt-out model)
    return true;
  }

  /**
   * Check if debug mode is enabled
   * Debug mode shows telemetry events before transmission (like Next.js and Nuxt)
   * @returns true if DOLLHOUSE_TELEMETRY_DEBUG=true
   */
  private static isDebugMode(): boolean {
    return process.env.DOLLHOUSE_TELEMETRY_DEBUG === 'true';
  }

  /**
   * Log debug information about telemetry events
   * Only outputs if debug mode is enabled
   * Uses console.error to avoid interfering with stdout (MCP protocol uses stdout)
   * @param message - Debug message to display
   * @param data - Optional data object to display (will be JSON.stringified)
   */
  private static debugLog(message: string, data?: unknown): void {
    if (this.isDebugMode()) {
      console.error(`[Telemetry Debug] ${message}`);
      if (data) {
        console.error(JSON.stringify(data, null, 2));
      }
    }
  }

  /**
   * Initialize PostHog client for remote telemetry
   *
   * PostHog Project API Key Security (phc_*):
   * This is a PUBLIC PROJECT KEY that is safe to expose in code. PostHog project keys are
   * designed by PostHog to be client-side safe and are used in browser JavaScript, mobile apps,
   * and public repositories across the industry.
   *
   * What it CAN do (write-only):
   * - Send telemetry events
   * - Evaluate feature flags
   *
   * What it CANNOT do:
   * - Read existing analytics data
   * - Access user information or private data
   * - Modify project settings
   * - Compromise security in any way
   *
   * This is the same security model as:
   * - Google Analytics tracking IDs (visible in every website's source)
   * - Sentry public DSNs (embedded in client-side error reporting)
   * - Mixpanel project tokens (standard client-side analytics)
   *
   * For more details, see:
   * - PostHog docs: https://posthog.com/docs/api
   * - Project documentation: docs/development/TELEMETRY_RESPONSE.md
   *
   * User control options:
   * - Opt out of remote: DOLLHOUSE_TELEMETRY_NO_REMOTE=true
   * - Use own key: POSTHOG_API_KEY=phc_your_key_here
   * - Debug mode: DOLLHOUSE_TELEMETRY_DEBUG=true (see what's sent)
   * - Disable all: DOLLHOUSE_TELEMETRY=false
   */
  private static initPostHog(): void {
    try {
      // Skip if PostHog already initialized
      if (this.posthog) {
        return;
      }

      // Skip if remote telemetry is explicitly disabled
      if (process.env.DOLLHOUSE_TELEMETRY_NO_REMOTE === 'true') {
        logger.debug('Telemetry: Remote telemetry disabled via DOLLHOUSE_TELEMETRY_NO_REMOTE');
        return;
      }

      // PostHog Project API Key (public, write-only)
      // This provides automatic installation metrics for platform support and optimization.
      // Helps us prioritize testing platforms, Node.js versions, and MCP client compatibility.
      // Users can override with their own key or disable with DOLLHOUSE_TELEMETRY_NO_REMOTE=true
      const apiKey = process.env.POSTHOG_API_KEY || 'phc_xFJKIHAqRX1YLa0TSdTGwGj19d1JeoXDKjJNYq492vq';

      if (!apiKey) {
        logger.debug('Telemetry: PostHog not configured');
        return;
      }

      // Initialize PostHog client
      const host = process.env.POSTHOG_HOST || 'https://app.posthog.com';
      this.posthog = new PostHog(apiKey, {
        host,
        flushAt: 1, // Flush immediately for server environments
        flushInterval: 10000, // Flush every 10 seconds as backup
      });

      logger.debug(`Telemetry: PostHog initialized with host: ${host}`);
    } catch (error) {
      // Fail gracefully - log but don't throw
      logger.debug(`Telemetry: Failed to initialize PostHog: ${error instanceof Error ? error.message : String(error)}`);
      this.posthog = null;
    }
  }

  /**
   * Get telemetry configuration paths
   * @returns Configuration with paths to telemetry files
   */
  private static getConfig(): TelemetryConfig {
    const dollhouseDir = path.join(os.homedir(), '.dollhouse');
    return {
      enabled: this.isEnabled(),
      installIdPath: path.join(dollhouseDir, '.telemetry-id'),
      logPath: path.join(dollhouseDir, 'telemetry.log'),
    };
  }

  /**
   * Ensure installation UUID exists, generating if needed
   * UUID is persistent across server restarts but unique per installation
   * @returns Installation UUID or null if telemetry disabled or error
   */
  private static async ensureUUID(): Promise<string | null> {
    try {
      const config = this.getConfig();

      // Return cached UUID if already loaded
      if (this.installId) {
        return this.installId;
      }

      // Check if UUID file exists
      try {
        const existingId = await fs.readFile(config.installIdPath, 'utf-8');

        // FIX: DMCP-SEC-004 - Normalize Unicode in file content to prevent attacks
        const normalizedResult = UnicodeValidator.normalize(existingId);
        const trimmedId = normalizedResult.normalizedContent.trim();

        // FIX: DMCP-SEC-006 - Log security-relevant UUID validation operation
        // Validate UUID format (basic check)
        if (trimmedId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmedId)) {
          this.installId = trimmedId;
          logger.debug(`Telemetry: Loaded existing installation ID: ${trimmedId.substring(0, 8)}...`);

          SecurityMonitor.logSecurityEvent({
            type: 'TOKEN_VALIDATION_SUCCESS',
            severity: 'LOW',
            source: 'telemetry',
            details: 'Installation UUID validated successfully from persistent storage'
          });

          return this.installId;
        } else {
          // Log validation failure if UUID format is invalid
          SecurityMonitor.logSecurityEvent({
            type: 'TOKEN_VALIDATION_FAILURE',
            severity: 'MEDIUM',
            source: 'telemetry',
            details: 'Invalid UUID format detected in telemetry ID file'
          });
        }
      } catch {
        // File doesn't exist or is unreadable, will generate new UUID
        logger.debug('Telemetry: No existing installation ID found, generating new one');
      }

      // Generate new UUID v4
      this.installId = uuidv4();

      // Ensure directory exists
      await fs.mkdir(path.dirname(config.installIdPath), { recursive: true });

      // Write UUID to file
      await fs.writeFile(config.installIdPath, this.installId, 'utf-8');

      logger.debug(`Telemetry: Generated new installation ID: ${this.installId.substring(0, 8)}...`);
      return this.installId;
    } catch (error) {
      // Fail gracefully - log but don't throw
      logger.debug(`Telemetry: Failed to ensure UUID: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Check if this is the first run for current version
   * Looks for existing installation event with current UUID and version
   * @returns true if this is the first run (no matching install event found)
   */
  private static async isFirstRun(): Promise<boolean> {
    try {
      const config = this.getConfig();

      // Check if telemetry log exists
      try {
        const logContent = await fs.readFile(config.logPath, 'utf-8');

        // FIX: DMCP-SEC-004 - Normalize Unicode in log content before processing
        const normalizedResult = UnicodeValidator.normalize(logContent);
        const lines = normalizedResult.normalizedContent.trim().split('\n');

        // Check if any line contains an install event with current UUID and version
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as InstallationEvent;

            // Found matching install event for this UUID and version
            if (
              event.event === 'install' &&
              event.install_id === this.installId &&
              event.version === VERSION
            ) {
              logger.debug(`Telemetry: Found existing installation event for version ${VERSION}`);
              return false;
            }
          } catch {
            // Skip malformed lines
            continue;
          }
        }

        // No matching install event found
        logger.debug(`Telemetry: No installation event found for version ${VERSION}`);
        return true;
      } catch {
        // Log file doesn't exist or is unreadable - treat as first run
        logger.debug('Telemetry: No existing log file, treating as first run');
        return true;
      }
    } catch (error) {
      // Fail gracefully - if we can't determine, assume not first run to avoid duplicate events
      logger.debug(`Telemetry: Error checking first run status: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Detect MCP client environment
   * Uses dedicated clientDetector module for consistency
   * @returns Client identifier string
   */
  private static getMCPClient(): string {
    return detectMCPClient();
  }

  /**
   * Record installation event to telemetry log
   * Appends JSON line to log file (JSONL format)
   * Also sends to PostHog if configured
   *
   * Debug mode (DOLLHOUSE_TELEMETRY_DEBUG=true):
   * - Shows exactly what's being logged locally
   * - Shows exactly what's being sent to PostHog
   * - Displays transmission status
   */
  private static async recordInstallation(): Promise<void> {
    try {
      if (!this.installId) {
        logger.debug('Telemetry: Cannot record installation - no installation ID');
        return;
      }

      const config = this.getConfig();

      // Create installation event
      const event: InstallationEvent = {
        event: 'install',
        install_id: this.installId,
        version: VERSION,
        os: os.platform(),
        node_version: process.version,
        mcp_client: this.getMCPClient(),
        timestamp: new Date().toISOString(),
      };

      // Debug mode: Show what will be logged locally
      if (this.isDebugMode()) {
        this.debugLog('Local event (writing to ~/.dollhouse/telemetry.log):', event);
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(config.logPath), { recursive: true });

      // Append event as JSON line (JSONL format) to local log
      const logLine = JSON.stringify(event) + '\n';
      await fs.appendFile(config.logPath, logLine, 'utf-8');

      logger.debug(
        `Telemetry: Recorded installation event - version=${event.version}, os=${event.os}, client=${event.mcp_client}`
      );

      // Send to PostHog if enabled and remote telemetry not disabled
      if (this.posthog && process.env.DOLLHOUSE_TELEMETRY_NO_REMOTE !== 'true') {
        try {
          const posthogEvent = {
            distinctId: this.installId,
            event: 'server_installation',
            properties: {
              version: VERSION,
              os: os.platform(),
              node_version: process.version,
              mcp_client: this.getMCPClient(),
            },
          };

          // Debug mode: Show what will be sent to PostHog
          if (this.isDebugMode()) {
            this.debugLog('Remote event (sending to PostHog):', posthogEvent);
          }

          this.posthog.capture(posthogEvent);

          // Flush immediately to ensure event is sent
          await this.posthog.flush();

          if (this.isDebugMode()) {
            this.debugLog('Event sent to PostHog successfully');
          }

          logger.debug('Telemetry: Sent installation event to PostHog');
        } catch (posthogError) {
          // Fail gracefully - PostHog errors shouldn't break telemetry
          const errorMsg = posthogError instanceof Error ? posthogError.message : String(posthogError);
          logger.debug(`Telemetry: Failed to send to PostHog: ${errorMsg}`);

          if (this.isDebugMode()) {
            this.debugLog(`Failed to send to PostHog: ${errorMsg}`);
          }
        }
      } else if (this.isDebugMode()) {
        if (process.env.DOLLHOUSE_TELEMETRY_NO_REMOTE === 'true') {
          this.debugLog('Remote telemetry disabled (DOLLHOUSE_TELEMETRY_NO_REMOTE=true)');
        } else {
          this.debugLog('PostHog not configured (no POSTHOG_API_KEY)');
        }
      }
    } catch (error) {
      // Fail gracefully - log but don't throw
      logger.debug(
        `Telemetry: Failed to record installation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Write telemetry event to log file
   * Internal method for appending events to telemetry.log
   * @param event - Event object to write
   */
  private static async writeEvent(event: InstallationEvent): Promise<void> {
    try {
      const config = this.getConfig();

      // Ensure directory exists
      await fs.mkdir(path.dirname(config.logPath), { recursive: true });

      // Append event as JSON line (JSONL format)
      const logLine = JSON.stringify(event) + '\n';
      await fs.appendFile(config.logPath, logLine, 'utf-8');
    } catch (error) {
      // Fail gracefully - log but don't throw
      logger.debug(`Telemetry: Failed to write event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize telemetry system
   * Checks opt-out status, generates UUID if needed, records installation event on first run
   *
   * Safe to call multiple times - will only initialize once
   * Always fails gracefully - errors are logged but never thrown
   */
  public static async initialize(): Promise<void> {
    try {
      // Only initialize once
      if (this.initialized) {
        logger.debug('Telemetry: Already initialized, skipping');
        return;
      }

      // Check if telemetry is enabled
      if (!this.isEnabled()) {
        logger.debug('Telemetry: Disabled via DOLLHOUSE_TELEMETRY environment variable');
        this.initialized = true;
        return;
      }

      logger.debug('Telemetry: Initializing operational telemetry system');

      // Initialize PostHog for remote telemetry (automatic with opt-out)
      this.initPostHog();

      // Ensure installation UUID exists
      const uuid = await this.ensureUUID();
      if (!uuid) {
        logger.debug('Telemetry: Failed to ensure UUID, skipping initialization');
        this.initialized = true;
        return;
      }

      // Check if this is the first run
      const firstRun = await this.isFirstRun();
      if (firstRun) {
        logger.debug('Telemetry: First run detected, recording installation event');
        await this.recordInstallation();
      } else {
        logger.debug('Telemetry: Installation event already recorded for this version');
      }

      this.initialized = true;
      logger.debug('Telemetry: Initialization complete');
    } catch (error) {
      // Fail gracefully - log error but mark as initialized to prevent retry loops
      logger.debug(`Telemetry: Initialization error: ${error instanceof Error ? error.message : String(error)}`);
      this.initialized = true;
    }
  }

  /**
   * Shutdown telemetry system
   * Flushes any pending PostHog events and cleans up resources
   * Safe to call even if not initialized
   */
  public static async shutdown(): Promise<void> {
    try {
      if (this.posthog) {
        logger.debug('Telemetry: Shutting down PostHog client');
        await this.posthog.shutdown();
        this.posthog = null;
      }
    } catch (error) {
      // Fail gracefully - log but don't throw
      logger.debug(`Telemetry: Error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

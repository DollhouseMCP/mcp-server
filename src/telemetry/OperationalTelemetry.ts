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
 * Telemetry control:
 * - DOLLHOUSE_TELEMETRY=true  - Enables local telemetry (default: OFF)
 * - DOLLHOUSE_TELEMETRY=false - Disables all telemetry (local and remote)
 * - DOLLHOUSE_TELEMETRY_OPTIN=true - Enables remote telemetry with default PostHog project
 * - DOLLHOUSE_TELEMETRY_NO_REMOTE=true - Local telemetry only, no PostHog
 * - POSTHOG_API_KEY - Custom PostHog project key (overrides default)
 * - Delete telemetry files: rm ~/.dollhouse/.telemetry-id ~/.dollhouse/telemetry.log
 *
 * Data storage (only when enabled):
 * - Local: ~/.dollhouse/.telemetry-id (UUID) and ~/.dollhouse/telemetry.log (events)
 * - Remote (opt-in): PostHog analytics when DOLLHOUSE_TELEMETRY_OPTIN=true or POSTHOG_API_KEY is set
 *
 * Design principles:
 * - Fail gracefully: errors never crash the server
 * - Debug-only logging: no user-facing telemetry noise
 * - Check opt-out early: no file operations if disabled
 * - Remote telemetry is opt-in: requires DOLLHOUSE_TELEMETRY_OPTIN=true or explicit POSTHOG_API_KEY
 * - Local telemetry is opt-in: requires DOLLHOUSE_TELEMETRY=true
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { PostHog } from 'posthog-node';
import { logger } from '../utils/logger.js';
import { PACKAGE_VERSION as VERSION } from '../generated/version.js';
import type { InstallationEvent, TelemetryConfig, AutoLoadMetrics } from './types.js';
import { detectMCPClient } from './clientDetector.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';

// PostHog Project API Key (safe to expose publicly - write-only)
// Used for opt-in telemetry when DOLLHOUSE_TELEMETRY_OPTIN=true
// Can be overridden with POSTHOG_API_KEY for custom installations
const DEFAULT_POSTHOG_PROJECT_KEY = 'phc_xFJKIHAqRX1YLa0TSdTGwGj19d1JeoXDKjJNYq492vq';

export class OperationalTelemetry {
  private installId: string | null = null;
  private initialized = false;
  private posthog: PostHog | null = null;
  private logListener?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

  addLogListener(fn: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void): () => void {
    this.logListener = fn;
    return () => { this.logListener = undefined; };
  }

  constructor(private readonly fileOperations: IFileOperationsService, private readonly stateDir?: string) {}

  /**
   * Check if telemetry is enabled
   * Respects DOLLHOUSE_TELEMETRY environment variable (default: false/opt-in)
   * @returns true if telemetry is enabled, false otherwise
   */
  public isEnabled(): boolean {
    const envValue = process.env.DOLLHOUSE_TELEMETRY;

    if (!envValue) {
      return false;
    }

    const normalized = envValue.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }

    if (normalized === 'false' || normalized === '0') {
      return false;
    }

    // Unrecognized values are treated as disabled in opt-in model
    return false;
  }

  /**
   * Initialize PostHog client for remote telemetry
   *
   * Three ways to enable remote telemetry:
   * 1. DOLLHOUSE_TELEMETRY_OPTIN=true - Uses default PostHog project (simplest opt-in)
   * 2. POSTHOG_API_KEY=<key> - Uses custom PostHog project (backward compatibility)
   * 3. DOLLHOUSE_TELEMETRY_OPTIN=true with POSTHOG_API_KEY=<key> - Custom key takes precedence
   *
   * PostHog project keys are safe to expose publicly - they are write-only and cannot
   * be used to read data. This allows embedding a default key for simple opt-in telemetry.
   *
   * Respects DOLLHOUSE_TELEMETRY_NO_REMOTE=true to disable all remote telemetry
   */
  private initPostHog(): void {
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

      // Determine if user has opted in and which API key to use
      const optedIn = process.env.DOLLHOUSE_TELEMETRY_OPTIN === 'true';
      const customApiKey = process.env.POSTHOG_API_KEY;

      // Select API key: custom key takes precedence, then default if opted in
      let apiKey: string | null = null;
      if (customApiKey) {
        apiKey = customApiKey;
        logger.debug('Telemetry: Using custom POSTHOG_API_KEY');
      } else if (optedIn) {
        apiKey = DEFAULT_POSTHOG_PROJECT_KEY;
        logger.debug('Telemetry: Using default PostHog project key (opted in via DOLLHOUSE_TELEMETRY_OPTIN)');
      }

      // Skip if no API key available (not opted in and no custom key)
      if (!apiKey) {
        logger.debug('Telemetry: Remote telemetry not enabled (no opt-in or API key)');
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
  private getConfig(): TelemetryConfig {
    // Use DI-provided stateDir (from PathService) when available;
    // fall back to legacy path for direct construction (tests).
    const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
    const dir = this.stateDir ?? path.join(homeDir, '.dollhouse');
    return {
      enabled: this.isEnabled(),
      installIdPath: path.join(dir, '.telemetry-id'),
      logPath: path.join(dir, 'telemetry.log'),
    };
  }

  /**
   * Ensure installation UUID exists, generating if needed
   * UUID is persistent across server restarts but unique per installation
   * @returns Installation UUID or null if telemetry disabled or error
   */
  private async ensureUUID(): Promise<string | null> {
    try {
      const config = this.getConfig();

      // Return cached UUID if already loaded
      if (this.installId) {
        return this.installId;
      }

      // Check if UUID file exists
      try {
        const existingId = await this.fileOperations.readFile(config.installIdPath, {
          source: 'OperationalTelemetry.ensureUUID'
        });

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
      await this.fileOperations.createDirectory(path.dirname(config.installIdPath));

      // Write UUID to file
      await this.fileOperations.writeFile(config.installIdPath, this.installId, {
        source: 'OperationalTelemetry.ensureUUID'
      });

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
  private async isFirstRun(): Promise<boolean> {
    try {
      const config = this.getConfig();

      // Check if telemetry log exists
      try {
        const logContent = await this.fileOperations.readFile(config.logPath, {
          source: 'OperationalTelemetry.isFirstRun'
        });

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
  private getMCPClient(): string {
    return detectMCPClient();
  }

  /**
   * Record installation event to telemetry log
   * Appends JSON line to log file (JSONL format)
   * Also sends to PostHog if configured
   */
  private async recordInstallation(): Promise<void> {
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

      // Ensure directory exists
      await this.fileOperations.createDirectory(path.dirname(config.logPath));

      // Append event as JSON line (JSONL format) to local log
      const logLine = JSON.stringify(event) + '\n';
      await this.fileOperations.appendFile(config.logPath, logLine, {
        source: 'OperationalTelemetry.recordInstallation'
      });

      logger.debug(
        `Telemetry: Recorded installation event - version=${event.version}, os=${event.os}, client=${event.mcp_client}`
      );
      this.logListener?.('info', 'Record installation', {
        version: event.version,
        os: event.os,
        mcp_client: event.mcp_client,
      });

      // Send to PostHog if enabled and remote telemetry not disabled
      if (this.posthog && process.env.DOLLHOUSE_TELEMETRY_NO_REMOTE !== 'true') {
        try {
          this.posthog.capture({
            distinctId: this.installId,
            event: 'server_installation',
            properties: {
              version: VERSION,
              os: os.platform(),
              node_version: process.version,
              mcp_client: this.getMCPClient(),
            },
          });

          // Flush immediately to ensure event is sent
          await this.posthog.flush();
          logger.debug('Telemetry: Sent installation event to PostHog');
        } catch (posthogError) {
          // Fail gracefully - PostHog errors shouldn't break telemetry
          logger.debug(
            `Telemetry: Failed to send to PostHog: ${posthogError instanceof Error ? posthogError.message : String(posthogError)}`
          );
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
  private async writeEvent(event: InstallationEvent): Promise<void> {
    try {
      const config = this.getConfig();

      // Ensure directory exists
      await this.fileOperations.createDirectory(path.dirname(config.logPath));

      // Append event as JSON line (JSONL format)
      const logLine = JSON.stringify(event) + '\n';
      await this.fileOperations.appendFile(config.logPath, logLine, {
        source: 'OperationalTelemetry.writeEvent'
      });
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
  public async initialize(): Promise<void> {
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

      // Initialize PostHog for remote telemetry (optional, opt-in)
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
   * Record auto-load metrics to telemetry log
   * @param metrics Auto-load performance metrics
   */
  public async recordAutoLoadMetrics(metrics: AutoLoadMetrics): Promise<void> {
    try {
      if (!this.isEnabled()) {
        return;
      }

      const config = this.getConfig();

      // Append to telemetry log (JSONL format)
      const logEntry = {
        event: 'autoload_metrics',
        ...metrics,
        installId: this.installId
      };

      await this.fileOperations.appendFile(
        config.logPath,
        JSON.stringify(logEntry) + '\n',
        { source: 'OperationalTelemetry.recordAutoLoadMetrics' }
      );

      // Send to PostHog if configured
      if (this.posthog && this.installId) {
        this.posthog.capture({
          distinctId: this.installId,
          event: 'autoload_metrics',
          properties: metrics
        });
      }

      logger.debug('[Telemetry] Recorded auto-load metrics:', metrics);
      this.logListener?.('debug', 'Record auto-load metrics', metrics as unknown as Record<string, unknown>);
    } catch (error) {
      // Fail gracefully
      logger.debug(`[Telemetry] Failed to record auto-load metrics: ${error}`);
    }
  }

  /**
   * Shutdown telemetry system
   * Flushes any pending PostHog events and cleans up resources
   * Safe to call even if not initialized
   */
  public async shutdown(): Promise<void> {
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

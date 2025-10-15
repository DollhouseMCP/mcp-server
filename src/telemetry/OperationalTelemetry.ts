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
 * - Set environment variable: DOLLHOUSE_TELEMETRY=false
 * - Delete telemetry files: rm ~/.dollhouse/.telemetry-id ~/.dollhouse/telemetry.log
 *
 * Data storage:
 * - Local only: ~/.dollhouse/.telemetry-id (UUID) and ~/.dollhouse/telemetry.log (events)
 * - No network transmission (reserved for future opt-in feature)
 *
 * Design principles:
 * - Fail gracefully: errors never crash the server
 * - Debug-only logging: no user-facing telemetry noise
 * - Check opt-out early: no file operations if disabled
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { VERSION } from '../constants/version.js';
import type { InstallationEvent, TelemetryConfig } from './types.js';
import { detectMCPClient } from './clientDetector.js';

export class OperationalTelemetry {
  private static installId: string | null = null;
  private static initialized = false;

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
        const trimmedId = existingId.trim();

        // Validate UUID format (basic check)
        if (trimmedId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmedId)) {
          this.installId = trimmedId;
          logger.debug(`Telemetry: Loaded existing installation ID: ${trimmedId.substring(0, 8)}...`);
          return this.installId;
        }
      } catch (error) {
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
        const lines = logContent.trim().split('\n');

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
          } catch (parseError) {
            // Skip malformed lines
            continue;
          }
        }

        // No matching install event found
        logger.debug(`Telemetry: No installation event found for version ${VERSION}`);
        return true;
      } catch (readError) {
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

      // Ensure directory exists
      await fs.mkdir(path.dirname(config.logPath), { recursive: true });

      // Append event as JSON line (JSONL format)
      const logLine = JSON.stringify(event) + '\n';
      await fs.appendFile(config.logPath, logLine, 'utf-8');

      logger.debug(
        `Telemetry: Recorded installation event - version=${event.version}, os=${event.os}, client=${event.mcp_client}`
      );
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
}

/**
 * Integration tests for Operational Telemetry System
 *
 * Tests REAL file I/O operations with temporary test directories.
 * Verifies end-to-end telemetry behavior including:
 * - First run scenario (UUID generation, event logging)
 * - Subsequent runs (UUID reuse, no duplicate events)
 * - Opt-out scenario (DOLLHOUSE_TELEMETRY=false)
 * - Error recovery (missing directories, read-only filesystem)
 *
 * Issue #1358: Add minimal installation telemetry for v1.9.19
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { OperationalTelemetry } from '../../../src/telemetry/OperationalTelemetry.js';
import type { InstallationEvent } from '../../../src/telemetry/types.js';

// Test directory setup
const TEST_HOME = path.join(os.tmpdir(), 'dollhouse-telemetry-test-' + Date.now());
const TEST_TELEMETRY_DIR = path.join(TEST_HOME, '.dollhouse');
const TEST_TELEMETRY_ID_PATH = path.join(TEST_TELEMETRY_DIR, '.telemetry-id');
const TEST_TELEMETRY_LOG_PATH = path.join(TEST_TELEMETRY_DIR, 'telemetry.log');

// Store original environment
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalTelemetryEnv: string | undefined;

describe('Telemetry Integration Tests', () => {
  beforeEach(async () => {
    // Store original environment variables
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalTelemetryEnv = process.env.DOLLHOUSE_TELEMETRY;

    // Set HOME to test directory (Unix)
    process.env.HOME = TEST_HOME;
    // Set USERPROFILE to test directory (Windows)
    process.env.USERPROFILE = TEST_HOME;

    // Enable telemetry by default
    delete process.env.DOLLHOUSE_TELEMETRY;

    // Create test directory structure
    await fs.mkdir(TEST_TELEMETRY_DIR, { recursive: true });

    // Reset telemetry singleton state
    // This uses reflection to access private static fields for testing
    // In production, OperationalTelemetry.initialize() handles state correctly
    const telemetryClass = OperationalTelemetry as any;
    telemetryClass.installId = null;
    telemetryClass.initialized = false;
  });

  afterEach(async () => {
    // Restore original environment variables
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }

    if (originalTelemetryEnv !== undefined) {
      process.env.DOLLHOUSE_TELEMETRY = originalTelemetryEnv;
    } else {
      delete process.env.DOLLHOUSE_TELEMETRY;
    }

    // Clean up test files
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  describe('First Run Scenario', () => {
    it('should create .telemetry-id with valid UUID on first run', async () => {
      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify UUID file was created
      const fileExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      // Read and validate UUID
      const uuid = await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8');
      const trimmedUuid = uuid.trim();

      // Validate UUID v4 format
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidV4Regex.test(trimmedUuid)).toBe(true);
    });

    it('should create telemetry.log with installation event on first run', async () => {
      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify log file was created
      const fileExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      // Read log file
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const lines = logContent.trim().split('\n');

      // Should have exactly one event
      expect(lines.length).toBe(1);

      // Parse and validate event
      const event = JSON.parse(lines[0]) as InstallationEvent;
      expect(event.event).toBe('install');
      expect(event.install_id).toBeTruthy();
      expect(event.version).toBeTruthy();
      expect(event.os).toBeTruthy();
      expect(event.node_version).toBeTruthy();
      expect(event.mcp_client).toBeTruthy();
      expect(event.timestamp).toBeTruthy();

      // Validate UUID format in event
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidV4Regex.test(event.install_id)).toBe(true);

      // Validate timestamp format (ISO 8601)
      const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(isoDateRegex.test(event.timestamp)).toBe(true);

      // Validate platform is a known value
      expect(['darwin', 'win32', 'linux']).toContain(event.os);

      // Validate Node version format
      expect(event.node_version).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('should write valid JSON to telemetry.log', async () => {
      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Read log file
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const lines = logContent.trim().split('\n');

      // Verify each line is valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('should contain all required fields in installation event', async () => {
      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Read and parse event
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const event = JSON.parse(logContent.trim()) as InstallationEvent;

      // Check required fields exist
      expect(event).toHaveProperty('event');
      expect(event).toHaveProperty('install_id');
      expect(event).toHaveProperty('version');
      expect(event).toHaveProperty('os');
      expect(event).toHaveProperty('node_version');
      expect(event).toHaveProperty('mcp_client');
      expect(event).toHaveProperty('timestamp');

      // Check field values are non-empty
      expect(event.event).toBe('install');
      expect(event.install_id.length).toBeGreaterThan(0);
      expect(event.version.length).toBeGreaterThan(0);
      expect(event.os.length).toBeGreaterThan(0);
      expect(event.node_version.length).toBeGreaterThan(0);
      expect(event.mcp_client.length).toBeGreaterThan(0);
      expect(event.timestamp.length).toBeGreaterThan(0);
    });

    it('should create directory if ~/.dollhouse does not exist', async () => {
      // Remove test directory
      await fs.rm(TEST_TELEMETRY_DIR, { recursive: true, force: true });

      // Verify directory doesn't exist
      const existsBefore = await fs
        .access(TEST_TELEMETRY_DIR)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(false);

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify directory was created
      const existsAfter = await fs
        .access(TEST_TELEMETRY_DIR)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(true);

      // Verify files were created
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(uuidExists).toBe(true);
      expect(logExists).toBe(true);
    });
  });

  describe('Subsequent Run Scenario', () => {
    it('should reuse existing UUID on subsequent runs', async () => {
      // First run
      await OperationalTelemetry.initialize();

      // Read UUID from first run
      const firstUuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();

      // Reset telemetry state
      const telemetryClass = OperationalTelemetry as any;
      telemetryClass.installId = null;
      telemetryClass.initialized = false;

      // Second run
      await OperationalTelemetry.initialize();

      // Read UUID from second run
      const secondUuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();

      // UUIDs should match
      expect(firstUuid).toBe(secondUuid);
    });

    it('should NOT write duplicate installation event on subsequent runs', async () => {
      // First run
      await OperationalTelemetry.initialize();

      // Read log after first run
      const firstRunLog = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const firstRunLines = firstRunLog.trim().split('\n');
      expect(firstRunLines.length).toBe(1);

      // Reset telemetry state
      const telemetryClass = OperationalTelemetry as any;
      telemetryClass.installId = null;
      telemetryClass.initialized = false;

      // Second run
      await OperationalTelemetry.initialize();

      // Read log after second run
      const secondRunLog = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const secondRunLines = secondRunLog.trim().split('\n');

      // Should still have only one event
      expect(secondRunLines.length).toBe(1);

      // Events should be identical
      expect(firstRunLog).toBe(secondRunLog);
    });

    it('should leave log file unchanged on subsequent runs', async () => {
      // First run
      await OperationalTelemetry.initialize();

      // Get file stats after first run
      const firstStats = await fs.stat(TEST_TELEMETRY_LOG_PATH);

      // Reset telemetry state
      const telemetryClass = OperationalTelemetry as any;
      telemetryClass.installId = null;
      telemetryClass.initialized = false;

      // Wait a bit to ensure timestamp would be different if file was modified
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second run
      await OperationalTelemetry.initialize();

      // Get file stats after second run
      const secondStats = await fs.stat(TEST_TELEMETRY_LOG_PATH);

      // File modification time should be unchanged
      expect(firstStats.mtime.getTime()).toBe(secondStats.mtime.getTime());

      // File size should be unchanged
      expect(firstStats.size).toBe(secondStats.size);
    });
  });

  describe('Opt-Out Scenario', () => {
    it('should NOT create files when DOLLHOUSE_TELEMETRY=false', async () => {
      // Set opt-out environment variable
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify UUID file was NOT created
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      expect(uuidExists).toBe(false);

      // Verify log file was NOT created
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);
      expect(logExists).toBe(false);
    });

    it('should NOT create files when DOLLHOUSE_TELEMETRY=0', async () => {
      // Set opt-out environment variable (numeric false)
      process.env.DOLLHOUSE_TELEMETRY = '0';

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify no files were created
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(uuidExists).toBe(false);
      expect(logExists).toBe(false);
    });

    it('should NOT create files when DOLLHOUSE_TELEMETRY=FALSE (uppercase)', async () => {
      // Set opt-out environment variable (uppercase)
      process.env.DOLLHOUSE_TELEMETRY = 'FALSE';

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify no files were created
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(uuidExists).toBe(false);
      expect(logExists).toBe(false);
    });

    it('should perform NO file operations when opted out', async () => {
      // Set opt-out environment variable
      process.env.DOLLHOUSE_TELEMETRY = 'false';

      // Remove test directory entirely
      await fs.rm(TEST_TELEMETRY_DIR, { recursive: true, force: true });

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify directory was NOT created
      const dirExists = await fs
        .access(TEST_TELEMETRY_DIR)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(false);
    });

    it('should respect opt-in when DOLLHOUSE_TELEMETRY=true', async () => {
      // Explicitly opt in
      process.env.DOLLHOUSE_TELEMETRY = 'true';

      // Initialize telemetry
      await OperationalTelemetry.initialize();

      // Verify files were created
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(uuidExists).toBe(true);
      expect(logExists).toBe(true);
    });
  });

  describe('Error Recovery', () => {
    it('should gracefully handle missing ~/.dollhouse directory (creates it)', async () => {
      // Remove test directory
      await fs.rm(TEST_TELEMETRY_DIR, { recursive: true, force: true });

      // Initialize telemetry - should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Verify directory and files were created
      const dirExists = await fs
        .access(TEST_TELEMETRY_DIR)
        .then(() => true)
        .catch(() => false);
      const uuidExists = await fs
        .access(TEST_TELEMETRY_ID_PATH)
        .then(() => true)
        .catch(() => false);
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);

      expect(dirExists).toBe(true);
      expect(uuidExists).toBe(true);
      expect(logExists).toBe(true);
    });

    it('should gracefully handle read-only filesystem (no crash)', async () => {
      // Create test files first
      await OperationalTelemetry.initialize();

      // Reset telemetry state
      const telemetryClass = OperationalTelemetry as any;
      telemetryClass.installId = null;
      telemetryClass.initialized = false;

      // Make directory read-only (simulate permission error)
      // Note: This test may behave differently on different platforms
      // On some systems, read-only parent directory still allows file operations
      // The important part is that telemetry doesn't crash regardless
      try {
        await fs.chmod(TEST_TELEMETRY_DIR, 0o444);
      } catch (chmodError) {
        // If chmod fails, skip this test (may not have permission to change permissions)
        return;
      }

      // Try to initialize again - should not throw even if file operations fail
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Restore permissions for cleanup
      await fs.chmod(TEST_TELEMETRY_DIR, 0o755);
    });

    it('should handle corrupted UUID file gracefully', async () => {
      // Write invalid UUID to file
      await fs.writeFile(TEST_TELEMETRY_ID_PATH, 'not-a-valid-uuid\n', 'utf-8');

      // Initialize telemetry - should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should generate a new valid UUID
      const uuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuidV4Regex.test(uuid)).toBe(true);

      // Should still write installation event
      const logExists = await fs
        .access(TEST_TELEMETRY_LOG_PATH)
        .then(() => true)
        .catch(() => false);
      expect(logExists).toBe(true);
    });

    it('should handle corrupted telemetry log gracefully', async () => {
      // Write invalid JSON to log file
      await fs.writeFile(TEST_TELEMETRY_LOG_PATH, 'invalid json line\n', 'utf-8');

      // Initialize telemetry - should not throw
      await expect(OperationalTelemetry.initialize()).resolves.not.toThrow();

      // Should append valid event to log
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const lines = logContent.trim().split('\n');

      // Should have at least 2 lines (corrupted + new valid event)
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // Last line should be valid JSON
      const lastLine = lines[lines.length - 1];
      expect(() => JSON.parse(lastLine)).not.toThrow();

      // Parse and validate last event
      const event = JSON.parse(lastLine) as InstallationEvent;
      expect(event.event).toBe('install');
    });

    it('should not crash when multiple initializations are called concurrently', async () => {
      // Call initialize multiple times concurrently
      const promises = [
        OperationalTelemetry.initialize(),
        OperationalTelemetry.initialize(),
        OperationalTelemetry.initialize(),
      ];

      // All should resolve without throwing
      await expect(Promise.all(promises)).resolves.not.toThrow();

      // Should still only have one event in log
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const lines = logContent.trim().split('\n').filter((line) => line.trim());

      // May have 1 event (if first init completed before others started)
      // or possibly more (if race condition occurred)
      // But should not crash
      expect(lines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('UUID Persistence', () => {
    it('should persist UUID across multiple initialization cycles', async () => {
      // First initialization
      await OperationalTelemetry.initialize();
      const firstUuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();

      // Reset and reinitialize multiple times
      for (let i = 0; i < 5; i++) {
        const telemetryClass = OperationalTelemetry as any;
        telemetryClass.installId = null;
        telemetryClass.initialized = false;

        await OperationalTelemetry.initialize();

        const currentUuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();
        expect(currentUuid).toBe(firstUuid);
      }
    });

    it('should use the same UUID in all installation events', async () => {
      // First run
      await OperationalTelemetry.initialize();

      // Get UUID from file
      const uuid = (await fs.readFile(TEST_TELEMETRY_ID_PATH, 'utf-8')).trim();

      // Get UUID from log event
      const logContent = await fs.readFile(TEST_TELEMETRY_LOG_PATH, 'utf-8');
      const event = JSON.parse(logContent.trim()) as InstallationEvent;

      // UUIDs should match
      expect(event.install_id).toBe(uuid);
    });
  });
});

/**
 * Integration tests for ServerStartup auto-load functionality (Issue #1430)
 *
 * Tests the complete end-to-end flow:
 * 1. ServerStartup.initialize() installs seed memories
 * 2. Auto-load memories are identified via metadata.autoLoad
 * 3. Memories are activated during startup
 * 4. Activation persists across restarts via metadata
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { ServerStartup } from '../../src/server/startup.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { MigrationManager } from '../../src/portfolio/MigrationManager.js';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { SerializationService } from '../../src/services/SerializationService.js';
import { MetadataService } from '../../src/services/MetadataService.js';
import { ValidationService } from '../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../src/services/validation/TriggerValidationService.js';
import { ValidationRegistry } from '../../src/services/validation/ValidationRegistry.js';
import { OperationalTelemetry } from '../../src/telemetry/OperationalTelemetry.js';
import { ElementEventDispatcher } from '../../src/events/ElementEventDispatcher.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

describe('ServerStartup - Auto-Load Integration (Issue #1430)', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  let memoryManager: MemoryManager;
  let serverStartup: ServerStartup;
  let originalPortfolioDir: string | undefined;
  let fileLockManager: FileLockManager;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-startup-autoload-'));

    // Save original portfolio dir
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Set test directory as portfolio dir
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
  });

  afterAll(async () => {
    // Restore original portfolio dir
    if (originalPortfolioDir) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Clean test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fs.mkdir(testDir, { recursive: true });

    // Create fresh instances for each test using proper DI pattern
    fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const configManager = new ConfigManager(fileOperationsService, os);

    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: testDir });
    await portfolioManager.initialize();

    // Create services for MemoryManager (service-layer DI pattern)
    const serializationService = new SerializationService();
    const metadataService = new MetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Create MemoryManager with all required dependencies
    memoryManager = new MemoryManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    });

    // Create MigrationManager and OperationalTelemetry for ServerStartup
    const migrationManager = new MigrationManager(portfolioManager, fileLockManager);
    const operationalTelemetry = new OperationalTelemetry();

    // Create ServerStartup with all required dependencies
    serverStartup = new ServerStartup(
      portfolioManager,
      fileLockManager,
      configManager,
      migrationManager,
      memoryManager,
      operationalTelemetry
    );
  });

  afterEach(async () => {
    // Dispose ServerStartup to clean up file watchers and telemetry
    // This prevents "Jest did not exit" warnings and potential timeouts
    if (serverStartup) {
      await serverStartup.dispose();
    }
  });

  describe('End-to-End Auto-Load Flow', () => {
    it('should install seed memories on initialize (Issue #1430)', async () => {
      // Initialize server (installs seeds)
      // NOTE: ServerStartup.initialize() installs seeds but does NOT activate them
      // Activation is handled by MemoryManager.loadAndActivateAutoLoadMemories()
      await serverStartup.initialize();

      // Verify seed memory was installed
      const memories = await memoryManager.list();
      const seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      expect(seedMemory).toBeDefined();
      expect((seedMemory?.metadata as any).autoLoad).toBe(true);
      expect((seedMemory?.metadata as any).priority).toBe(1);

      // Verify seed has content
      const entries = seedMemory!.getAllEntries();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].content).toContain('DollhouseMCP');
    });

    it('should install and activate auto-load memories when using ServerStartup (Issue #1430)', async () => {
      // Initialize server
      // ServerStartup.initialize() calls initializeAutoLoadMemories() which activates memories
      await serverStartup.initialize();

      // FIX #1430: The memory objects returned by getAutoLoadMemories() are fresh instances
      // loaded from disk. The activation happened on different instances during initialize().
      // Since _status is transient (not persisted to YAML), these fresh instances will have
      // _status = 'inactive' even though the memories were activated during startup.
      //
      // The correct source of truth is metadata.autoLoad (persists to YAML), not _status.
      // Testing _status here would require getting the SAME instance that was activated,
      // which is stored in MemoryManager's cache. Let's test via the cache instead.

      // Get all memories from cache (includes activated instances)
      const allMemories = await memoryManager.list();
      const seedMemory = allMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      expect(seedMemory).toBeDefined();
      // The cached instance should be active
      expect(seedMemory?.getStatus()).toBe('active');
      // And metadata.autoLoad should be true (this is what persists)
      expect((seedMemory?.metadata as any).autoLoad).toBe(true);
    });

    it('should identify active memories via metadata after cache clear (Issue #1430)', async () => {
      // Initialize server and activate memories
      await serverStartup.initialize();

      // FIX #1430: Verify memory is active after ServerStartup activation
      // Get memories from cache (these are the activated instances)
      let memories = await memoryManager.list();
      let seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      // The cached instance should be active
      expect(seedMemory?.getStatus()).toBe('active');

      // Clear cache to simulate server restart
      memoryManager.clearCache();

      // FIX: After fixing the MemoryManager injection, list() after clearCache()
      // now returns freshly loaded instances from disk. Since we're using the same
      // MemoryManager instance throughout the test (not separate instances), the
      // cache clear actually clears the activated instances.
      // Reload memories - instance status will be reset to inactive
      memories = await memoryManager.list();
      seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      // Instance status is INACTIVE after cache clear (expected)
      // Fresh instances loaded from disk have default _status = 'inactive'
      // because _status is a transient property that doesn't persist to YAML
      expect(seedMemory?.getStatus()).toBe('inactive');

      // But metadata.autoLoad is still true (this is what matters!)
      expect((seedMemory?.metadata as any).autoLoad).toBe(true);

      // And getAutoLoadMemories still finds it
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      const autoLoadSeed = autoLoadMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(autoLoadSeed).toBeDefined();
    });

    it('should skip seed reinstallation on second initialize (Issue #1430)', async () => {
      // First initialize
      await serverStartup.initialize();

      // Get initial memory
      let memories = await memoryManager.list();
      const initialSeed = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(initialSeed).toBeDefined();

      // Second initialize (should skip reinstallation)
      await serverStartup.initialize();

      // Verify seed still exists and wasn't duplicated
      memories = await memoryManager.list();
      const seeds = memories.filter(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seeds.length).toBe(1);

      // No backups should be created
      const backups = memories.filter(m => m.metadata.name?.startsWith('dollhousemcp-baseline-knowledge.backup-'));
      expect(backups.length).toBe(0);
    });

    it('should handle missing seed file gracefully (Issue #1430)', async () => {
      // Delete the bundled seed file to simulate it being missing
      const seedPath = path.join(process.cwd(), 'data', 'memories', 'system', 'dollhousemcp-baseline-knowledge.yaml');
      const seedExists = await fs.access(seedPath).then(() => true).catch(() => false);

      if (seedExists) {
        const seedBackup = seedPath + '.backup-test';
        await fs.copyFile(seedPath, seedBackup);
        await fs.unlink(seedPath);

        try {
          // Initialize should not throw even if seed file is missing
          await expect(serverStartup.initialize()).resolves.not.toThrow();
        } finally {
          // Restore seed file
          await fs.copyFile(seedBackup, seedPath);
          await fs.unlink(seedBackup);
        }
      }
    });

    it('should activate multiple auto-load memories in priority order (Issue #1430)', async () => {
      // Create additional auto-load memory with higher priority
      const customMemoryContent = `---
name: custom-autoload-memory
type: memory
description: Custom auto-load memory for testing
version: 1.0.0
autoLoad: true
priority: 2
---

# Custom Memory

This is a custom auto-load memory for testing.
`;
      const memoriesDir = path.join(testDir, 'memories');
      await fs.mkdir(memoriesDir, { recursive: true });
      await fs.writeFile(
        path.join(memoriesDir, 'custom-autoload-memory.yaml'),
        customMemoryContent
      );

      // Initialize server
      await serverStartup.initialize();

      // Get auto-load memories (should be sorted by priority)
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories.length).toBeGreaterThanOrEqual(2);

      // Verify both memories are present and sorted
      const seedMemory = autoLoadMemories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      const customMemory = autoLoadMemories.find(m => m.metadata.name === 'custom-autoload-memory');

      expect(seedMemory).toBeDefined();
      expect(customMemory).toBeDefined();

      // Verify priority ordering (lower priority number = higher priority)
      const seedIndex = autoLoadMemories.indexOf(seedMemory!);
      const customIndex = autoLoadMemories.indexOf(customMemory!);
      expect(seedIndex).toBeLessThan(customIndex); // priority 1 comes before priority 2
    });
  });

  describe('Metadata-Based Active Detection', () => {
    it('should detect active memories using metadata.autoLoad (Issue #1430)', async () => {
      // Initialize and activate memories
      await serverStartup.initialize();

      // Get all memories
      const allMemories = await memoryManager.list();

      // Filter by metadata.autoLoad (the correct approach)
      const activeViaMetadata = allMemories.filter(m => {
        const metadata = m.metadata as any;
        return metadata?.autoLoad === true;
      });

      // Should find seed memory
      expect(activeViaMetadata.length).toBeGreaterThan(0);
      const seedMemory = activeViaMetadata.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect(seedMemory).toBeDefined();
    });

    it('should persist autoLoad flag across save/load cycle (Issue #1430)', async () => {
      // Initialize
      await serverStartup.initialize();

      // Get seed memory
      let memories = await memoryManager.list();
      let seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');
      expect((seedMemory?.metadata as any).autoLoad).toBe(true);

      // Force save/load cycle by clearing cache and reloading
      memoryManager.clearCache();
      memories = await memoryManager.list();
      seedMemory = memories.find(m => m.metadata.name === 'dollhousemcp-baseline-knowledge');

      // autoLoad should still be true after reload
      expect((seedMemory?.metadata as any).autoLoad).toBe(true);
      expect((seedMemory?.metadata as any).priority).toBe(1);
    });
  });
});

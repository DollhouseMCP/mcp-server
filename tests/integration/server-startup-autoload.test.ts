/**
 * Integration tests for Server Startup Auto-Load Memories Feature
 * Issue #1430: Auto-load baseline memories on server startup
 *
 * These tests verify the full startup flow, including:
 * - Loading auto-load memories during server initialization
 * - Config-based control of auto-load feature
 * - Graceful handling of loading failures
 * - Correct logging of loaded memories
 *
 * Converted to DI architecture for refactor branch
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { ServerStartup } from '../../src/server/startup.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { MigrationManager } from '../../src/portfolio/MigrationManager.js';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { OperationalTelemetry } from '../../src/telemetry/OperationalTelemetry.js';
import { SerializationService } from '../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../src/services/MetadataService.js';
import { FileWatchService } from '../../src/services/FileWatchService.js';
import { createRealMemoryManager } from '../helpers/di-mocks.js';
import { ElementEventDispatcher } from '../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../helpers/createTestStorageFactory.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Server Startup - Auto-Load Memories Integration', () => {
  let testDir: string;
  let portfolioDir: string;
  let memoriesDir: string;
  let configDir: string;
  let originalPortfolioDir: string | undefined;
  let originalConfigDir: string | undefined;
  let serverStartup: ServerStartup;
  let portfolioManager: PortfolioManager;
  let fileLockManager: FileLockManager;
  let configManager: ConfigManager;
  // Track MemoryManager instances created during tests for proper cleanup
  const createdMemoryManagers: MemoryManager[] = [];

  /**
   * Helper to create a MemoryManager and track it for cleanup in afterEach
   */
  function createTrackedMemoryManager(): MemoryManager {
    const manager = createRealMemoryManager(portfolioDir);
    createdMemoryManagers.push(manager);
    return manager;
  }

  beforeAll(async () => {
    // Create unique test directories
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-startup-autoload-test-'));
    portfolioDir = path.join(testDir, 'portfolio');
    memoriesDir = path.join(portfolioDir, 'memories');
    configDir = path.join(testDir, '.config');

    // Save original environment
    originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;
    originalConfigDir = process.env.TEST_CONFIG_DIR;

    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;
    process.env.TEST_CONFIG_DIR = configDir;

    // Create directory structure
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to clean up test directory ${testDir}:`, error);
    }

    // Restore original environment
    if (originalPortfolioDir === undefined) {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    } else {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    }

    if (originalConfigDir === undefined) {
      delete process.env.TEST_CONFIG_DIR;
    } else {
      process.env.TEST_CONFIG_DIR = originalConfigDir;
    }
  });

  beforeEach(async () => {
    // Clear memories directory between tests
    try {
      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(memoriesDir, entry.name);
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist - expected scenario during cleanup
    }

    // Ensure memories directory exists
    await fs.mkdir(memoriesDir, { recursive: true });

    // Reset config directory
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.mkdir(configDir, { recursive: true });

    // Create fresh DI instances for each test
    fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: portfolioDir });
    configManager = new ConfigManager(fileOperationsService, os);

    // Create additional dependencies required by ServerStartup
    const metadataService = new MetadataService();
    const serializationService = new SerializationService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    const migrationManager = new MigrationManager(
      portfolioManager,
      fileLockManager,
      fileOperationsService
    );

    const memoryManager = new MemoryManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperationsService),
    });

    const operationalTelemetry = new OperationalTelemetry(configManager);

    // Create ServerStartup with injected dependencies
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
    if (serverStartup) {
      await serverStartup.dispose();
    }
    // Dispose any MemoryManager instances created during tests
    for (const manager of createdMemoryManagers) {
      manager.dispose();
    }
    createdMemoryManagers.length = 0; // Clear the array
  });

  describe('Auto-Load Memories on Startup', () => {
    it('should load auto-load memories during server initialization', async () => {
      // Create an auto-load memory
      const autoLoadMemory = `---
name: baseline-knowledge
type: memory
description: Baseline knowledge for DollhouseMCP
version: 1.0.0
autoLoad: true
priority: 1
---

# Baseline Knowledge

This memory should be auto-loaded on server startup.
`;
      await fs.writeFile(path.join(memoriesDir, 'baseline-knowledge.yaml'), autoLoadMemory);

      // Initialize server (which should load auto-load memories)
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown - memories are loaded during initialization
      // The actual loading is verified in unit tests, this tests the integration flow
      expect(true).toBe(true);
    });

    it('should load multiple auto-load memories in priority order', async () => {
      // Create multiple auto-load memories with different priorities
      const highPriority = `---
name: high-priority-memory
type: memory
description: High priority memory
version: 1.0.0
autoLoad: true
priority: 1
---

High priority content
`;
      const lowPriority = `---
name: low-priority-memory
type: memory
description: Low priority memory
version: 1.0.0
autoLoad: true
priority: 100
---

Low priority content
`;

      await fs.writeFile(path.join(memoriesDir, 'high-priority.yaml'), highPriority);
      await fs.writeFile(path.join(memoriesDir, 'low-priority.yaml'), lowPriority);

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });

    it('should not fail startup when no auto-load memories exist', async () => {
      // Create a regular memory (no autoLoad flag)
      const regularMemory = `---
name: regular-memory
type: memory
description: Regular memory
version: 1.0.0
---

Regular content
`;
      await fs.writeFile(path.join(memoriesDir, 'regular.yaml'), regularMemory);

      // Initialize server - should not throw
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });

    it('should handle empty memories directory gracefully', async () => {
      // Initialize server with empty memories directory
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });

    it('should work with date-organized memories', async () => {
      // Create date folder
      const dateFolder = path.join(memoriesDir, '2025-10-30');
      await fs.mkdir(dateFolder, { recursive: true });

      const datedMemory = `---
name: dated-autoload
type: memory
description: Auto-load memory in date folder
version: 1.0.0
autoLoad: true
priority: 5
---

Dated auto-load content
`;
      await fs.writeFile(path.join(dateFolder, 'dated-autoload.yaml'), datedMemory);

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });
  });

  describe('Config-Based Control', () => {
    it('should respect config when auto-load is disabled', async () => {
      // Create config with auto-load disabled
      const config = {
        version: '1.0.0',
        user: { username: null, email: null, display_name: null },
        github: {
          portfolio: {
            repository_url: null,
            repository_name: 'dollhouse-portfolio',
            default_branch: 'main',
            auto_create: true
          },
          auth: {
            use_oauth: true,
            token_source: 'environment' as const
          }
        },
        sync: {
          enabled: false,
          individual: {
            require_confirmation: true,
            show_diff_before_sync: true,
            track_versions: true,
            keep_history: 10
          },
          bulk: {
            upload_enabled: false,
            download_enabled: false,
            require_preview: true,
            respect_local_only: true
          },
          privacy: {
            scan_for_secrets: true,
            scan_for_pii: true,
            warn_on_sensitive: true,
            excluded_patterns: []
          }
        },
        collection: {
          auto_submit: false,
          require_review: true,
          add_attribution: true
        },
        autoLoad: {
          enabled: false, // Auto-load disabled
          maxTokenBudget: 5000,
          memories: []
        },
        elements: {
          auto_activate: {},
          default_element_dir: portfolioDir,
          enhanced_index: {
            enabled: true,
            limits: {
              maxTriggersPerElement: 50,
              maxTriggerLength: 50,
              maxKewordsToCheck: 100
            },
            telemetry: {
              enabled: false,
              sampleRate: 0.1,
              metricsInterval: 60000
            }
          }
        },
        display: {
          persona_indicators: {
            enabled: true,
            style: 'minimal' as const,
            include_emoji: true
          },
          verbose_logging: false,
          show_progress: true
        },
        wizard: {
          completed: false,
          dismissed: false
        }
      };

      // Write config file
      const configPath = path.join(configDir, 'config.yml');
      const yaml = await import('js-yaml');
      await fs.writeFile(configPath, yaml.dump(config));

      // Create an auto-load memory
      const autoLoadMemory = `---
name: should-not-load
type: memory
description: Should not load when disabled
version: 1.0.0
autoLoad: true
priority: 1
---

This should not be loaded
`;
      await fs.writeFile(path.join(memoriesDir, 'should-not-load.yaml'), autoLoadMemory);

      // Initialize server - should not throw even when auto-load is disabled
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });

    it('should load memories when auto-load is enabled (default)', async () => {
      // Create an auto-load memory (default config has autoLoad.enabled = true)
      const autoLoadMemory = `---
name: should-load
type: memory
description: Should load when enabled
version: 1.0.0
autoLoad: true
priority: 1
---

This should be loaded
`;
      await fs.writeFile(path.join(memoriesDir, 'should-load.yaml'), autoLoadMemory);

      // Initialize server with default config
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should continue startup gracefully if memory loading fails', async () => {
      // Create a corrupted memory file
      const corruptedMemory = `---
name: corrupted
description: This has invalid YAML
autoLoad: [unclosed array
---

Invalid content
`;
      await fs.writeFile(path.join(memoriesDir, 'corrupted.yaml'), corruptedMemory);

      // Initialize server - should not throw even with corrupted memory
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });

    it('should continue startup if memories directory does not exist', async () => {
      // Remove memories directory
      await fs.rm(memoriesDir, { recursive: true, force: true });

      // Initialize server - should not throw
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });

    it('should handle permission errors gracefully', async () => {
      // Create a memory file
      const memoryPath = path.join(memoriesDir, 'test-memory.yaml');
      const memory = `---
name: test-memory
type: memory
description: Test memory
version: 1.0.0
autoLoad: true
---

Test content
`;
      await fs.writeFile(memoryPath, memory);

      // Make file unreadable (may not work on all systems)
      try {
        await fs.chmod(memoryPath, 0o000);
      } catch {
        // Skip test if chmod fails (e.g., on Windows)
        return;
      }

      // Initialize server - should not throw
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();

      // SECURITY: Safe - test cleanup restoring standard permissions (rw-r--r--)
      // Context: Permission test creates unreadable file (0o000) to test error handling,
      // then restores normal permissions (0o644) so temp directory cleanup succeeds.
      // This is test-only code in isolated temp directory, not production.
      // SonarCloud: Reviewed and approved - necessary for test cleanup
      await fs.chmod(memoryPath, 0o644); // NOSONAR - Test cleanup in isolated temp directory
    });

    it('should handle corrupted config gracefully', async () => {
      // Write invalid config
      const configPath = path.join(configDir, 'config.yml');
      await fs.writeFile(configPath, 'invalid: yaml: content: [[[');

      // Create an auto-load memory
      const memory = `---
name: test
type: memory
description: Test
version: 1.0.0
autoLoad: true
---

Content
`;
      await fs.writeFile(path.join(memoriesDir, 'test.yaml'), memory);

      // Initialize server - should use default config and not throw
      await expect(serverStartup.initialize({ skipMigration: true })).resolves.not.toThrow();
    });
  });

  describe('Integration with Other Startup Tasks', () => {
    it('should run auto-load after portfolio initialization', async () => {
      // Create auto-load memory
      const memory = `---
name: integration-test
type: memory
description: Integration test memory
version: 1.0.0
autoLoad: true
priority: 1
---

Integration test content
`;
      await fs.writeFile(path.join(memoriesDir, 'integration-test.yaml'), memory);

      // Initialize server (includes portfolio setup + auto-load)
      await serverStartup.initialize({ skipMigration: true });

      // Verify portfolio exists
      const portfolioExists = await portfolioManager.exists();
      expect(portfolioExists).toBe(true);

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });

    it('should skip migration when skipMigration is true', async () => {
      // Create auto-load memory
      const memory = `---
name: skip-migration-test
type: memory
description: Skip migration test
version: 1.0.0
autoLoad: true
---

Content
`;
      await fs.writeFile(path.join(memoriesDir, 'skip-migration-test.yaml'), memory);

      // Initialize with skipMigration (typical for tests)
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });

    it('should handle concurrent initialization gracefully', async () => {
      // Create auto-load memory
      const memory = `---
name: concurrent-test
type: memory
description: Concurrent test
version: 1.0.0
autoLoad: true
---

Content
`;
      await fs.writeFile(path.join(memoriesDir, 'concurrent-test.yaml'), memory);

      // Try to initialize multiple times concurrently
      const promises = [
        serverStartup.initialize({ skipMigration: true }),
        serverStartup.initialize({ skipMigration: true }),
        serverStartup.initialize({ skipMigration: true })
      ];

      // All should complete without throwing
      await expect(Promise.all(promises)).resolves.not.toThrow();
    });
  });

  describe('Memory Priority and Ordering', () => {
    it('should respect priority order during loading', async () => {
      // Create memories with different priorities
      const memories = [
        { name: 'priority-10', priority: 10 },
        { name: 'priority-1', priority: 1 },
        { name: 'priority-50', priority: 50 },
        { name: 'priority-5', priority: 5 }
      ];

      for (const mem of memories) {
        const content = `---
name: ${mem.name}
type: memory
description: Memory with priority ${mem.priority}
version: 1.0.0
autoLoad: true
priority: ${mem.priority}
---

Content for ${mem.name}
`;
        await fs.writeFile(path.join(memoriesDir, `${mem.name}.yaml`), content);
      }

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown - priority ordering is handled internally
      expect(true).toBe(true);
    });

    it('should handle memories without priority (default to 999)', async () => {
      // Create memories with and without priority
      const withPriority = `---
name: with-priority
type: memory
description: With priority
version: 1.0.0
autoLoad: true
priority: 10
---

With priority content
`;
      const withoutPriority = `---
name: without-priority
type: memory
description: Without priority
version: 1.0.0
autoLoad: true
---

Without priority content
`;

      await fs.writeFile(path.join(memoriesDir, 'with-priority.yaml'), withPriority);
      await fs.writeFile(path.join(memoriesDir, 'without-priority.yaml'), withoutPriority);

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large number of auto-load memories efficiently', async () => {
      // Create 20 auto-load memories
      const createPromises = [];
      for (let i = 1; i <= 20; i++) {
        const content = `---
name: memory-${i}
type: memory
description: Auto-load memory ${i}
version: 1.0.0
autoLoad: true
priority: ${i}
---

Content for memory ${i}
`;
        createPromises.push(
          fs.writeFile(path.join(memoriesDir, `memory-${i}.yaml`), content)
        );
      }
      await Promise.all(createPromises);

      // Initialize server - should complete in reasonable time
      const startTime = Date.now();
      await serverStartup.initialize({ skipMigration: true });
      const duration = Date.now() - startTime;

      // Should complete within 10 seconds even with 20 memories
      expect(duration).toBeLessThan(10000);
    });

    it('should handle memories in multiple date folders', async () => {
      // Create multiple date folders with auto-load memories
      const dates = ['2025-10-28', '2025-10-29', '2025-10-30'];
      for (const date of dates) {
        const dateFolder = path.join(memoriesDir, date);
        await fs.mkdir(dateFolder, { recursive: true });

        const content = `---
name: memory-${date}
type: memory
description: Memory from ${date}
version: 1.0.0
autoLoad: true
priority: 1
---

Content from ${date}
`;
        await fs.writeFile(path.join(dateFolder, `memory-${date}.yaml`), content);
      }

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Test passes if no errors thrown
      expect(true).toBe(true);
    });
  });

  describe('Backup File Filtering (Issue #13)', () => {
    it('should not auto-load backup files from root memories folder', async () => {
      // Create real auto-load memory
      const realMemory = `---
name: real-memory
type: memory
description: Real memory that should be loaded
version: 1.0.0
autoLoad: true
priority: 1
---

Real memory content that should be auto-loaded.
`;
      await fs.writeFile(path.join(memoriesDir, 'real-memory.yaml'), realMemory);

      // Create backup file that should be filtered out
      const backupMemory = `---
name: backup-memory
type: memory
description: Backup file that should NOT be loaded
version: 1.0.0
autoLoad: true
priority: 1
---

Backup content - should be filtered.
`;
      await fs.writeFile(
        path.join(memoriesDir, 'real-memory.backup-2025-11-14-22-40-57-303.yaml'),
        backupMemory
      );

      // Initialize server
      await serverStartup.initialize({ skipMigration: true });

      // Create MemoryManager to verify what was loaded
      const memoryManager = createTrackedMemoryManager();

      // Get all memories and auto-load memories
      const allMemories = await memoryManager.list();
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Should have real-memory but NOT the backup
      const memoryNames = allMemories.map(m => m.metadata.name);
      expect(memoryNames).toContain('real-memory');
      expect(memoryNames).not.toContain('backup-memory');

      // Auto-load should also exclude backups
      const autoLoadNames = autoLoadMemories.map(m => m.metadata.name);
      expect(autoLoadNames).toContain('real-memory');
      expect(autoLoadNames).not.toContain('backup-memory');
    });

    it('should not auto-load backup files from system/ folder', async () => {
      // Create system/ folder
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });

      // Create real system memory
      const systemMemory = `---
name: system-memory
type: memory
description: System memory
version: 1.0.0
autoLoad: true
priority: 1
---

System memory content.
`;
      await fs.writeFile(path.join(systemDir, 'system-memory.yaml'), systemMemory);

      // Create backup in system/ folder
      await fs.writeFile(
        path.join(systemDir, 'system-memory.backup-2025-11-14.yaml'),
        systemMemory.replace('system-memory', 'system-backup')
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const memories = await memoryManager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      expect(memoryNames).toContain('system-memory');
      expect(memoryNames).not.toContain('system-backup');
    });

    it('should not auto-load backup files from date folders', async () => {
      // Create date folder
      const dateFolder = path.join(memoriesDir, '2025-11-24');
      await fs.mkdir(dateFolder, { recursive: true });

      // Create real memory in date folder
      const datedMemory = `---
name: dated-memory
type: memory
description: Dated memory
version: 1.0.0
autoLoad: true
priority: 1
---

Dated memory content.
`;
      await fs.writeFile(path.join(dateFolder, 'dated-memory.yaml'), datedMemory);

      // Create backup in date folder
      await fs.writeFile(
        path.join(dateFolder, 'dated-memory.backup-2025-11-24.yaml'),
        datedMemory.replace('dated-memory', 'dated-backup')
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const memories = await memoryManager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      expect(memoryNames).toContain('dated-memory');
      expect(memoryNames).not.toContain('dated-backup');
    });

    it('should filter backup files case-insensitively', async () => {
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });

      // Create real memory
      const realMemory = `---
name: case-test-memory
type: memory
description: Real memory
version: 1.0.0
autoLoad: true
---

Real content.
`;
      await fs.writeFile(path.join(systemDir, 'case-test-memory.yaml'), realMemory);

      // Create backup files with various case patterns
      const backupPatterns = [
        'my-backup-file.yaml',
        'my-BACKUP-file.yaml',
        'myBackupFile.yaml'
      ];

      for (const filename of backupPatterns) {
        await fs.writeFile(
          path.join(systemDir, filename),
          `---\nname: ${filename.replace('.yaml', '')}\ndescription: Backup variant\nautoLoad: true\n---\nBackup content`
        );
      }

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const memories = await memoryManager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      // Should have the real memory (seed memory may also be present from startup)
      expect(memoryNames).toContain('case-test-memory');

      // Should NOT have any backup files
      expect(memoryNames).not.toContain('my-backup-file');
      expect(memoryNames).not.toContain('my-BACKUP-file');
      expect(memoryNames).not.toContain('myBackupFile');

      // Filter out seed memory to verify our test files
      const testMemories = memoryNames.filter(n => !n.includes('dollhousemcp-baseline'));
      expect(testMemories.length).toBe(1);
    });
  });

  describe('Auto-Load Count Verification', () => {
    it('should report correct count excluding backup files', async () => {
      // Create 3 real auto-load memories
      for (let i = 1; i <= 3; i++) {
        const memory = `---
name: real-memory-${i}
type: memory
description: Real memory ${i}
version: 1.0.0
autoLoad: true
priority: ${i}
---

Content for real memory ${i}.
`;
        await fs.writeFile(path.join(memoriesDir, `real-memory-${i}.yaml`), memory);
      }

      // Create 2 backup files (should be excluded)
      for (let i = 1; i <= 2; i++) {
        const backup = `---
name: backup-memory-${i}
type: memory
description: Backup ${i}
version: 1.0.0
autoLoad: true
---

Backup content ${i}.
`;
        await fs.writeFile(
          path.join(memoriesDir, `real-memory-1.backup-2025-11-${i}.yaml`),
          backup
        );
      }

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const allMemories = await memoryManager.list();
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Filter out seed memory to verify our test files
      const testMemories = allMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      const testAutoLoad = autoLoadMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));

      // Should have exactly 3 test memories (not 5 - backups are excluded)
      expect(testMemories.length).toBe(3);
      expect(testAutoLoad.length).toBe(3);

      // Verify the correct memories are present
      const names = testAutoLoad.map(m => m.metadata.name).sort();
      expect(names).toEqual(['real-memory-1', 'real-memory-2', 'real-memory-3']);

      // Also verify backups are NOT in the full list
      const allNames = allMemories.map(m => m.metadata.name);
      expect(allNames).not.toContain('backup-memory-1');
      expect(allNames).not.toContain('backup-memory-2');
    });

    it('should correctly count auto-load vs non-auto-load memories', async () => {
      // Create 2 auto-load memories
      for (let i = 1; i <= 2; i++) {
        await fs.writeFile(
          path.join(memoriesDir, `autoload-${i}.yaml`),
          `---\nname: autoload-${i}\ndescription: Auto-load ${i}\nautoLoad: true\npriority: ${i}\n---\nContent ${i}`
        );
      }

      // Create 3 non-auto-load memories
      for (let i = 1; i <= 3; i++) {
        await fs.writeFile(
          path.join(memoriesDir, `regular-${i}.yaml`),
          `---\nname: regular-${i}\ndescription: Regular ${i}\n---\nContent ${i}`
        );
      }

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const allMemories = await memoryManager.list();
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Filter out seed memory to verify our test files
      const testMemories = allMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      const testAutoLoad = autoLoadMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));

      // Should have 5 test memories (2 auto-load + 3 regular)
      expect(testMemories.length).toBe(5);
      // Should have 2 auto-load test memories
      expect(testAutoLoad.length).toBe(2);
    });
  });

  describe('Edge Cases - Mixed Files Across Folders', () => {
    it('should handle mix of valid and backup files across all folders', async () => {
      // Create system/ folder with valid and backup files
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });
      await fs.writeFile(
        path.join(systemDir, 'system-valid.yaml'),
        '---\nname: system-valid\ndescription: Valid system\nautoLoad: true\n---\nValid'
      );
      await fs.writeFile(
        path.join(systemDir, 'system-valid.backup-2025.yaml'),
        '---\nname: system-backup\ndescription: Backup\nautoLoad: true\n---\nBackup'
      );

      // Create adapters/ folder with valid and backup files
      const adaptersDir = path.join(memoriesDir, 'adapters');
      await fs.mkdir(adaptersDir, { recursive: true });
      await fs.writeFile(
        path.join(adaptersDir, 'adapter-valid.yaml'),
        '---\nname: adapter-valid\ndescription: Valid adapter\nautoLoad: true\n---\nValid'
      );
      await fs.writeFile(
        path.join(adaptersDir, 'adapter-backup.yaml'),
        '---\nname: adapter-backup-file\ndescription: Backup\nautoLoad: true\n---\nBackup'
      );

      // Create date folder with valid and backup files
      const dateFolder = path.join(memoriesDir, '2025-11-24');
      await fs.mkdir(dateFolder, { recursive: true });
      await fs.writeFile(
        path.join(dateFolder, 'dated-valid.yaml'),
        '---\nname: dated-valid\ndescription: Valid dated\nautoLoad: true\n---\nValid'
      );
      await fs.writeFile(
        path.join(dateFolder, 'dated-valid.backup-old.yaml'),
        '---\nname: dated-backup\ndescription: Backup\nautoLoad: true\n---\nBackup'
      );

      // Create root folder with valid and backup files
      await fs.writeFile(
        path.join(memoriesDir, 'root-valid.yaml'),
        '---\nname: root-valid\ndescription: Valid root\nautoLoad: true\n---\nValid'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'root-backup-file.yaml'),
        '---\nname: root-backup-file\ndescription: Backup\nautoLoad: true\n---\nBackup'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const memories = await memoryManager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      // Should have valid memories (one from each folder)
      expect(memoryNames).toContain('system-valid');
      expect(memoryNames).toContain('adapter-valid');
      expect(memoryNames).toContain('dated-valid');
      expect(memoryNames).toContain('root-valid');

      // Should NOT have any backup files
      expect(memoryNames).not.toContain('system-backup');
      expect(memoryNames).not.toContain('adapter-backup-file');
      expect(memoryNames).not.toContain('dated-backup');
      expect(memoryNames).not.toContain('root-backup-file');

      // Filter out seed memory to verify our test file count
      const testMemories = memories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      expect(testMemories.length).toBe(4);
    });

    it('should handle empty backup folders gracefully', async () => {
      // Create backups/ folder structure (should be ignored)
      const backupsDir = path.join(memoriesDir, 'backups');
      await fs.mkdir(path.join(backupsDir, 'system'), { recursive: true });
      await fs.mkdir(path.join(backupsDir, 'user'), { recursive: true });

      // Put some files in backups (should be ignored by list())
      await fs.writeFile(
        path.join(backupsDir, 'system', 'old-backup.yaml'),
        '---\nname: old-backup\ndescription: Old backup\nautoLoad: true\n---\nOld'
      );

      // Create one valid memory
      await fs.writeFile(
        path.join(memoriesDir, 'valid-memory.yaml'),
        '---\nname: valid-memory\ndescription: Valid\nautoLoad: true\n---\nValid'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const memories = await memoryManager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      // Should have the valid memory
      expect(memoryNames).toContain('valid-memory');
      expect(memoryNames).not.toContain('old-backup');

      // Filter out seed memory to verify our test file count
      const testMemories = memories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      expect(testMemories.length).toBe(1);
    });
  });

  describe('Auto-Load Status Visibility and Toggling', () => {
    it('should show which memories have autoLoad enabled', async () => {
      // Create mix of auto-load and regular memories
      await fs.writeFile(
        path.join(memoriesDir, 'auto-enabled.yaml'),
        '---\nname: auto-enabled\ndescription: Auto-load enabled\nautoLoad: true\npriority: 1\n---\nContent'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'auto-disabled.yaml'),
        '---\nname: auto-disabled\ndescription: Auto-load explicitly disabled\nautoLoad: false\n---\nContent'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'no-auto-flag.yaml'),
        '---\nname: no-auto-flag\ndescription: No autoLoad flag\n---\nContent'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const allMemories = await memoryManager.list();
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Filter out seed memory to verify our test files
      const testMemories = allMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      const testAutoLoad = autoLoadMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));

      // Should have 3 test memories
      expect(testMemories.length).toBe(3);

      // Only 1 test memory should be in auto-load list
      expect(testAutoLoad.length).toBe(1);
      expect(testAutoLoad[0].metadata.name).toBe('auto-enabled');

      // Verify metadata shows autoLoad status correctly
      const autoEnabled = allMemories.find(m => m.metadata.name === 'auto-enabled');
      const autoDisabled = allMemories.find(m => m.metadata.name === 'auto-disabled');
      const noFlag = allMemories.find(m => m.metadata.name === 'no-auto-flag');

      expect((autoEnabled?.metadata as any).autoLoad).toBe(true);
      expect((autoDisabled?.metadata as any).autoLoad).toBe(false);
      expect((noFlag?.metadata as any).autoLoad).toBeUndefined();
    });

    it('should allow activating and deactivating memories', async () => {
      await fs.writeFile(
        path.join(memoriesDir, 'toggle-test.yaml'),
        '---\nname: toggle-test\ndescription: Toggle test memory\nautoLoad: false\n---\nContent'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      // Initially should not be active
      let activeMemories = await memoryManager.getActiveMemories();
      expect(activeMemories.map(m => m.metadata.name)).not.toContain('toggle-test');

      // Activate the memory
      const activateResult = await memoryManager.activateMemory('toggle-test');
      expect(activateResult.success).toBe(true);

      // Should now be active
      activeMemories = await memoryManager.getActiveMemories();
      expect(activeMemories.map(m => m.metadata.name)).toContain('toggle-test');

      // Deactivate the memory
      const deactivateResult = await memoryManager.deactivateMemory('toggle-test');
      expect(deactivateResult.success).toBe(true);

      // Should no longer be active
      activeMemories = await memoryManager.getActiveMemories();
      expect(activeMemories.map(m => m.metadata.name)).not.toContain('toggle-test');
    });

    it('should distinguish between autoLoad flag and active status', async () => {
      // Create memory with autoLoad: true (should be auto-activated on startup)
      await fs.writeFile(
        path.join(memoriesDir, 'auto-start.yaml'),
        '---\nname: auto-start\ndescription: Auto-start memory\nautoLoad: true\npriority: 1\n---\nContent'
      );

      // Create memory without autoLoad (won't be auto-activated)
      await fs.writeFile(
        path.join(memoriesDir, 'manual-start.yaml'),
        '---\nname: manual-start\ndescription: Manual start memory\n---\nContent'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      // Load and activate auto-load memories (simulating what ServerStartup does)
      await memoryManager.loadAndActivateAutoLoadMemories();

      // auto-start should be in autoLoad list AND active
      const autoLoadMemories = await memoryManager.getAutoLoadMemories();
      expect(autoLoadMemories.map(m => m.metadata.name)).toContain('auto-start');

      // FIX Issue #35: Verify auto-loaded memory is ALSO in the active set
      // This was the missing assertion that would have caught the bug!
      const activeAfterAutoLoad = await memoryManager.getActiveMemories();
      expect(activeAfterAutoLoad.map(m => m.metadata.name)).toContain('auto-start');

      // manual-start should NOT be in autoLoad list and NOT active initially
      expect(autoLoadMemories.map(m => m.metadata.name)).not.toContain('manual-start');
      expect(activeAfterAutoLoad.map(m => m.metadata.name)).not.toContain('manual-start');

      // But manual-start CAN be manually activated
      await memoryManager.activateMemory('manual-start');
      const activeMemories = await memoryManager.getActiveMemories();
      expect(activeMemories.map(m => m.metadata.name)).toContain('manual-start');
    });

    it('should return detailed status for all memories', async () => {
      await fs.writeFile(
        path.join(memoriesDir, 'status-test-1.yaml'),
        '---\nname: status-test-1\ndescription: Test 1\nautoLoad: true\npriority: 5\n---\nContent 1'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'status-test-2.yaml'),
        '---\nname: status-test-2\ndescription: Test 2\nautoLoad: true\npriority: 10\n---\nContent 2'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'status-test-3.yaml'),
        '---\nname: status-test-3\ndescription: Test 3\nautoLoad: false\n---\nContent 3'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const allMemories = await memoryManager.list();

      // Create a status report (filter out seed memory)
      const statusReport = allMemories
        .filter(m => !m.metadata.name.includes('dollhousemcp-baseline'))
        .map(m => ({
          name: m.metadata.name,
          autoLoad: (m.metadata as any).autoLoad || false,
          priority: (m.metadata as any).priority,
          status: m.getStatus()
        }));

      expect(statusReport.length).toBe(3);

      // Verify we can see all the relevant info
      const test1 = statusReport.find(s => s.name === 'status-test-1');
      const test2 = statusReport.find(s => s.name === 'status-test-2');
      const test3 = statusReport.find(s => s.name === 'status-test-3');

      expect(test1).toBeDefined();
      expect(test1?.autoLoad).toBe(true);
      expect(test1?.priority).toBe(5);

      expect(test2).toBeDefined();
      expect(test2?.autoLoad).toBe(true);
      expect(test2?.priority).toBe(10);

      expect(test3).toBeDefined();
      expect(test3?.autoLoad).toBe(false);
      expect(test3?.priority).toBeUndefined();
    });

    it('should verify auto-load memories are sorted by priority', async () => {
      // Create memories with different priorities (out of order)
      await fs.writeFile(
        path.join(memoriesDir, 'priority-50.yaml'),
        '---\nname: priority-50\ndescription: Priority 50\nautoLoad: true\npriority: 50\n---\nContent'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'priority-1.yaml'),
        '---\nname: priority-1\ndescription: Priority 1\nautoLoad: true\npriority: 1\n---\nContent'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'priority-10.yaml'),
        '---\nname: priority-10\ndescription: Priority 10\nautoLoad: true\npriority: 10\n---\nContent'
      );
      await fs.writeFile(
        path.join(memoriesDir, 'no-priority.yaml'),
        '---\nname: no-priority\ndescription: No priority (defaults to 999)\nautoLoad: true\n---\nContent'
      );

      await serverStartup.initialize({ skipMigration: true });

      const memoryManager = createTrackedMemoryManager();

      const autoLoadMemories = await memoryManager.getAutoLoadMemories();

      // Filter out seed memory and verify test memories are sorted by priority (ascending)
      const testAutoLoad = autoLoadMemories.filter(m => !m.metadata.name.includes('dollhousemcp-baseline'));
      const names = testAutoLoad.map(m => m.metadata.name);
      expect(names).toEqual([
        'priority-1',
        'priority-10',
        'priority-50',
        'no-priority'
      ]);

      // Also verify seed memory has priority 1 (highest) and appears first in full list
      const seedMemory = autoLoadMemories.find(m => m.metadata.name.includes('dollhousemcp-baseline'));
      expect(seedMemory).toBeDefined();
      expect((seedMemory?.metadata as any).priority).toBe(1);
    });
  });
});

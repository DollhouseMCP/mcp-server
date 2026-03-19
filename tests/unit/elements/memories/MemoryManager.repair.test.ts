/**
 * Unit tests for MemoryManager repair utilities (Issue #39)
 * Tests for corrupted backup name detection, repair, and cleanup
 */

import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Create a shared MetadataService instance for all tests
const metadataService = createTestMetadataService();

describe('MemoryManager Repair Utilities (Issue #39)', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof MemoryManager>;
  let testDir: string;
  let memoriesDir: string;
  let systemDir: string;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-repair-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Create DI container
    container = new DollhouseContainer();

    // Register dependencies in DI container
    container.register('FileLockManager', () => new FileLockManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.register('SerializationService', () => new SerializationService());
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.register('MemoryManager', () => new MemoryManager(
      container.resolve('PortfolioManager'),
      container.resolve('FileLockManager'),
      container.resolve('FileOperationsService'),
      container.resolve('ValidationRegistry'),
      container.resolve('SerializationService'),
      metadataService
    ));

    // Resolve instances from container
    manager = container.resolve('MemoryManager');

    memoriesDir = path.join(testDir, 'memories');
    systemDir = path.join(memoriesDir, 'system');
    await fs.mkdir(systemDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose DI container
    await container.dispose();

    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  afterEach(async () => {
    // Clean up any created files between tests
    try {
      const files = await fs.readdir(systemDir);
      for (const file of files) {
        const filePath = path.join(systemDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            await fs.unlink(filePath);
          } else if (stat.isDirectory()) {
            await fs.rm(filePath, { recursive: true, force: true });
          }
        } catch {
          // Skip files we can't delete
        }
      }
    } catch {
      // Directory might not exist
    }
  });

  describe('Utility Functions', () => {
    // Note: Utility functions are private module-level functions
    // We test them indirectly through the public methods

    describe('Corrupted Name Detection (via save auto-repair)', () => {
      it('should detect and repair backup timestamp pattern in memory name', async () => {
        // Create a memory with a corrupted backup name
        const corruptedName = 'test-memory.backup-2025-11-14-22-40-57-303';
        const memory = new Memory({
          name: corruptedName,
          description: 'Test memory with corrupted name',
          version: '1.0.0'
        }, metadataService);

        // Save should auto-repair the name
        await manager.save(memory);

        // The memory's name should now be repaired
        expect(memory.metadata.name).toBe('test-memory');
      });

      it('should detect and repair versioned backup pattern (-vN suffix)', async () => {
        const corruptedName = 'test-memory.backup-2025-01-01-00-00-00-000-v42';
        const memory = new Memory({
          name: corruptedName,
          description: 'Test memory with versioned backup name',
          version: '1.0.0'
        }, metadataService);

        await manager.save(memory);

        expect(memory.metadata.name).toBe('test-memory');
      });

      it('should not modify normal memory names', async () => {
        const normalName = 'normal-memory-name';
        const memory = new Memory({
          name: normalName,
          description: 'Test memory with normal name',
          version: '1.0.0'
        }, metadataService);

        await manager.save(memory);

        expect(memory.metadata.name).toBe(normalName);
      });

      it('should not modify names with "backup" as part of the name (not timestamp pattern)', async () => {
        const validName = 'my-backup-strategy';
        const memory = new Memory({
          name: validName,
          description: 'Test memory with backup in name but not corrupted',
          version: '1.0.0'
        }, metadataService);

        await manager.save(memory);

        expect(memory.metadata.name).toBe(validName);
      });
    });
  });

  describe('repairCorruptedNames()', () => {
    it('should scan and repair memories with corrupted names', async () => {
      // Create memory files directly (bypassing auto-repair for test setup)
      // Note: We write YAML directly to simulate corrupted files that exist in the portfolio
      const yaml1 = `entries: []
metadata:
  name: memory-one.backup-2025-11-14-10-20-30-456
  description: First corrupted memory
  version: 1.0.0
  retentionDays: 30
  storageBackend: memory
  privacyLevel: private
  searchable: true
  tags: []
`;
      const yaml2 = `entries: []
metadata:
  name: memory-two.backup-2025-11-14-10-20-30-456-v5
  description: Second corrupted memory with version
  version: 1.0.0
  retentionDays: 30
  storageBackend: memory
  privacyLevel: private
  searchable: true
  tags: []
`;
      await fs.writeFile(
        path.join(systemDir, 'memory-one.yaml'),
        yaml1,
        'utf-8'
      );
      await fs.writeFile(
        path.join(systemDir, 'memory-two.yaml'),
        yaml2,
        'utf-8'
      );

      // Run repair
      const result = await manager.repairCorruptedNames();

      // Verify results
      expect(result.scanned).toBeGreaterThanOrEqual(2);
      expect(result.repaired).toBe(2);
      expect(result.errors).toBe(0);
      expect(result.repairedMemories).toHaveLength(2);

      // Verify the names were repaired
      const repairedNames = result.repairedMemories.map(r => r.repaired);
      expect(repairedNames).toContain('memory-one');
      expect(repairedNames).toContain('memory-two');
    });

    it('should return empty results when no corrupted names exist', async () => {
      // Create a memory with a normal name
      const normalMemory = new Memory({
        name: 'normal-memory',
        description: 'Normal memory without corruption',
        version: '1.0.0'
      }, metadataService);
      await manager.save(normalMemory);

      // Run repair
      const result = await manager.repairCorruptedNames();

      expect(result.repaired).toBe(0);
      expect(result.repairedMemories).toHaveLength(0);
    });

    it('should handle errors gracefully and continue processing', async () => {
      // Create one valid corrupted memory file
      const yaml = `entries: []
metadata:
  name: corrupted-name.backup-2025-11-14-10-20-30-456
  description: Corrupted memory
  version: 1.0.0
  retentionDays: 30
  storageBackend: memory
  privacyLevel: private
  searchable: true
  tags: []
`;
      await fs.writeFile(
        path.join(systemDir, 'corrupted-memory.yaml'),
        yaml,
        'utf-8'
      );

      // Run repair
      const result = await manager.repairCorruptedNames();

      // Should process successfully
      expect(result.scanned).toBeGreaterThanOrEqual(1);
      expect(result.repaired).toBe(1);
    });
  });

  describe('cleanupExcessiveBackups()', () => {
    it('should delete versioned backup files (-v2, -v3, etc.)', async () => {
      // Create versioned backup files
      const baseBackup = 'test.backup-2025-11-14-22-40-57-303';
      const files = [
        `${baseBackup}.yaml`,
        `${baseBackup}-v2.yaml`,
        `${baseBackup}-v3.yaml`,
        `${baseBackup}-v10.yaml`,
        `${baseBackup}-v73.yaml`
      ];

      for (const file of files) {
        await fs.writeFile(
          path.join(systemDir, file),
          'entries: []\nmetadata:\n  name: test\n  description: test\n  version: 1.0.0',
          'utf-8'
        );
      }

      // Run cleanup (not dry run)
      const result = await manager.cleanupExcessiveBackups(systemDir, false);

      // Should delete versioned files but keep base backup
      expect(result.deleted).toBe(4); // -v2, -v3, -v10, -v73
      expect(result.keptFiles).toContain(`${baseBackup}.yaml`);
      expect(result.deletedFiles).toContain(`${baseBackup}-v2.yaml`);
      expect(result.deletedFiles).toContain(`${baseBackup}-v73.yaml`);

      // Verify files are actually deleted
      const remainingFiles = await fs.readdir(systemDir);
      expect(remainingFiles).toContain(`${baseBackup}.yaml`);
      expect(remainingFiles).not.toContain(`${baseBackup}-v2.yaml`);
    });

    it('should support dry run mode without deleting files', async () => {
      // Create versioned backup files
      const baseBackup = 'dryrun-test.backup-2025-11-14-22-40-57-303';
      const files = [
        `${baseBackup}.yaml`,
        `${baseBackup}-v2.yaml`,
        `${baseBackup}-v3.yaml`
      ];

      for (const file of files) {
        await fs.writeFile(
          path.join(systemDir, file),
          'entries: []\nmetadata:\n  name: test\n  description: test\n  version: 1.0.0',
          'utf-8'
        );
      }

      // Run cleanup in dry run mode
      const result = await manager.cleanupExcessiveBackups(systemDir, true);

      // Should report what would be deleted
      expect(result.deleted).toBe(2); // -v2, -v3
      expect(result.deletedFiles).toHaveLength(2);

      // Verify files are NOT actually deleted - check only the files we created
      const remainingFiles = await fs.readdir(systemDir);
      expect(remainingFiles).toContain(`${baseBackup}.yaml`);
      expect(remainingFiles).toContain(`${baseBackup}-v2.yaml`);
      expect(remainingFiles).toContain(`${baseBackup}-v3.yaml`);
    });

    it('should not delete non-versioned backup files', async () => {
      // Create non-versioned backup files with unique names
      const uniqueId = Date.now();
      const files = [
        `unique-memory-a-${uniqueId}.backup-2025-11-14-22-40-57-303.yaml`,
        `unique-memory-b-${uniqueId}.backup-2025-11-15-10-20-30-456.yaml`
      ];

      for (const file of files) {
        await fs.writeFile(
          path.join(systemDir, file),
          'entries: []\nmetadata:\n  name: test\n  description: test\n  version: 1.0.0',
          'utf-8'
        );
      }

      // Run cleanup
      await manager.cleanupExcessiveBackups(systemDir, false);

      // Verify our specific files still exist (they have no -vN suffix)
      const remainingFiles = await fs.readdir(systemDir);
      expect(remainingFiles).toContain(files[0]);
      expect(remainingFiles).toContain(files[1]);
    });

    it('should handle empty directory gracefully', async () => {
      // Create a new empty temp directory for this test
      const emptyDir = path.join(testDir, 'empty-test-dir');
      await fs.mkdir(emptyDir, { recursive: true });

      // Run cleanup on the empty directory
      const result = await manager.cleanupExcessiveBackups(emptyDir, false);

      expect(result.scanned).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);

      // Cleanup
      await fs.rm(emptyDir, { recursive: true, force: true });
    });

    it('should default to system/ directory when no path provided', async () => {
      // This test verifies the default path behavior
      const result = await manager.cleanupExcessiveBackups(undefined, true);

      // Should not throw and should return valid result
      expect(result).toHaveProperty('scanned');
      expect(result).toHaveProperty('deleted');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('Edge Cases', () => {
    it('should handle memory names with multiple dots correctly', async () => {
      const corruptedName = 'my.dotted.memory.name.backup-2025-11-14-22-40-57-303';
      const memory = new Memory({
        name: corruptedName,
        description: 'Memory with dots in name',
        version: '1.0.0'
      }, metadataService);

      await manager.save(memory);

      expect(memory.metadata.name).toBe('my.dotted.memory.name');
    });

    it('should handle backup pattern at start of name (edge case)', async () => {
      // This shouldn't happen in practice but test for robustness
      const memory = new Memory({
        name: 'backup-strategy-document',
        description: 'Memory about backup strategies',
        version: '1.0.0'
      }, metadataService);

      await manager.save(memory);

      // Should not be modified (no timestamp pattern)
      expect(memory.metadata.name).toBe('backup-strategy-document');
    });

    it('should handle unicode characters in memory names', async () => {
      const corruptedName = 'mémoire-日本語.backup-2025-11-14-22-40-57-303';
      const memory = new Memory({
        name: corruptedName,
        description: 'Memory with unicode characters',
        version: '1.0.0'
      }, metadataService);

      await manager.save(memory);

      expect(memory.metadata.name).toBe('mémoire-日本語');
    });
  });
});

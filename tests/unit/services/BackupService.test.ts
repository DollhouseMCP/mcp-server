import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { BackupService, BackupConfig } from '../../../src/services/BackupService.js';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

/** Normalize to forward slashes for cross-platform path assertions. */
function normPath(p: string | undefined): string {
  return (p ?? '').replace(/\\/g, '/');
}

function createMockFileOps(): jest.Mocked<Pick<IFileOperationsService, 'exists' | 'copyFile' | 'renameFile' | 'createDirectory' | 'listDirectory' | 'deleteFile'>> {
  return {
    exists: jest.fn<(p: string) => Promise<boolean>>().mockResolvedValue(true),
    copyFile: jest.fn<(s: string, d: string) => Promise<void>>().mockResolvedValue(undefined),
    renameFile: jest.fn<(o: string, n: string) => Promise<void>>().mockResolvedValue(undefined),
    createDirectory: jest.fn<(d: string) => Promise<void>>().mockResolvedValue(undefined),
    listDirectory: jest.fn<(d: string) => Promise<string[]>>().mockResolvedValue([]),
    deleteFile: jest.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createConfig(overrides: Partial<BackupConfig> = {}): BackupConfig {
  return {
    backupRootDir: '/test/.backups',
    maxBackupsPerElement: 3,
    enabled: true,
    ...overrides,
  };
}

describe('BackupService', () => {
  let fileOps: ReturnType<typeof createMockFileOps>;
  let service: BackupService;

  beforeEach(() => {
    fileOps = createMockFileOps();
    service = new BackupService(fileOps as unknown as IFileOperationsService, createConfig());
  });

  describe('backupBeforeSave', () => {
    it('copies the file when it exists', async () => {
      fileOps.exists.mockResolvedValue(true);

      const result = await service.backupBeforeSave('/portfolio/personas/writer.md', 'personas');

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(fileOps.createDirectory).toHaveBeenCalled();
      expect(fileOps.copyFile).toHaveBeenCalledWith(
        '/portfolio/personas/writer.md',
        expect.stringContaining('writer.backup-')
      );
    });

    it('is a no-op when file does not exist (new element)', async () => {
      fileOps.exists.mockResolvedValue(false);

      const result = await service.backupBeforeSave('/portfolio/personas/new.md', 'personas');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
      expect(fileOps.copyFile).not.toHaveBeenCalled();
    });

    it('is a no-op when backups are disabled', async () => {
      service = new BackupService(
        fileOps as unknown as IFileOperationsService,
        createConfig({ enabled: false })
      );

      const result = await service.backupBeforeSave('/portfolio/personas/writer.md', 'personas');

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
      expect(fileOps.exists).not.toHaveBeenCalled();
    });

    it('is non-fatal on copy failure', async () => {
      fileOps.exists.mockResolvedValue(true);
      fileOps.copyFile.mockRejectedValue(new Error('disk full'));

      const result = await service.backupBeforeSave('/portfolio/personas/writer.md', 'personas');

      expect(result.success).toBe(false);
      expect(result.error).toContain('disk full');
    });
  });

  describe('backupBeforeDelete', () => {
    it('moves file to backup via rename', async () => {
      fileOps.exists.mockResolvedValue(true);

      const result = await service.backupBeforeDelete('/portfolio/skills/review.md', 'skills');

      expect(result.success).toBe(true);
      expect(result.movedOriginal).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(normPath(result.backupPath)).toContain('.backups/skills/');
      expect(normPath(result.backupPath)).toContain('review.backup-');
      expect(fileOps.renameFile).toHaveBeenCalled();
    });

    it('is a no-op when backups are disabled', async () => {
      service = new BackupService(
        fileOps as unknown as IFileOperationsService,
        createConfig({ enabled: false })
      );

      const result = await service.backupBeforeDelete('/portfolio/skills/review.md', 'skills');

      expect(result.success).toBe(false);
      expect(fileOps.renameFile).not.toHaveBeenCalled();
    });

    it('is a no-op when source file does not exist', async () => {
      fileOps.exists.mockResolvedValue(false);

      const result = await service.backupBeforeDelete('/portfolio/skills/gone.md', 'skills');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('falls back to copy when rename fails (cross-device)', async () => {
      fileOps.exists.mockResolvedValue(true);
      fileOps.renameFile.mockRejectedValue(new Error('EXDEV: cross-device link'));

      const result = await service.backupBeforeDelete('/portfolio/skills/review.md', 'skills');

      // Falls back to copy — backup created but original not moved
      expect(result.success).toBe(true);
      expect(result.movedOriginal).toBe(false);
      expect(result.backupPath).toBeDefined();
      expect(fileOps.copyFile).toHaveBeenCalled();
      // Must NOT prune on copy fallback — the backup is the safety net
      // for the original that hasn't been deleted yet
      expect(fileOps.listDirectory).not.toHaveBeenCalled();
    });
  });

  describe('pruneBackups', () => {
    it('keeps only maxBackupsPerElement newest backups', async () => {
      fileOps.listDirectory.mockResolvedValue([
        'writer.backup-2026-03-01T10-00-00-000Z.md',
        'writer.backup-2026-03-02T10-00-00-000Z.md',
        'writer.backup-2026-03-03T10-00-00-000Z.md',
        'writer.backup-2026-03-04T10-00-00-000Z.md',
        'writer.backup-2026-03-05T10-00-00-000Z.md',
      ]);

      await service.pruneBackups('/test/.backups/personas/2026-03-04', 'writer.md');

      // Should delete 2 oldest (5 - 3 = 2)
      expect(fileOps.deleteFile).toHaveBeenCalledTimes(2);
      expect(fileOps.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('2026-03-01')
      );
      expect(fileOps.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('2026-03-02')
      );
    });

    it('handles empty directory', async () => {
      fileOps.listDirectory.mockResolvedValue([]);

      await service.pruneBackups('/test/.backups/personas/2026-03-04', 'writer.md');

      expect(fileOps.deleteFile).not.toHaveBeenCalled();
    });

    it('does not prune when count is within limit', async () => {
      fileOps.listDirectory.mockResolvedValue([
        'writer.backup-2026-03-04T10-00-00-000Z.md',
        'writer.backup-2026-03-04T11-00-00-000Z.md',
      ]);

      await service.pruneBackups('/test/.backups/personas/2026-03-04', 'writer.md');

      expect(fileOps.deleteFile).not.toHaveBeenCalled();
    });

    it('only matches backups for the same element', async () => {
      fileOps.listDirectory.mockResolvedValue([
        'writer.backup-2026-03-01T10-00-00-000Z.md',
        'writer.backup-2026-03-02T10-00-00-000Z.md',
        'writer.backup-2026-03-03T10-00-00-000Z.md',
        'writer.backup-2026-03-04T10-00-00-000Z.md',
        'reviewer.backup-2026-03-01T10-00-00-000Z.md', // different element
      ]);

      await service.pruneBackups('/test/.backups/skills/2026-03-04', 'writer.md');

      // Only 4 writer backups, so prune 1
      expect(fileOps.deleteFile).toHaveBeenCalledTimes(1);
      expect(fileOps.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('writer.backup-2026-03-01')
      );
    });
  });

  describe('backup filename format', () => {
    it('generates correct backup filename with ISO timestamp', async () => {
      fileOps.exists.mockResolvedValue(true);

      const result = await service.backupBeforeSave('/portfolio/agents/poster.md', 'agents');

      expect(normPath(result.backupPath)).toMatch(
        /\.backups\/agents\/\d{4}-\d{2}-\d{2}\/poster\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/
      );
    });

    it('preserves original file extension', async () => {
      fileOps.exists.mockResolvedValue(true);

      const result = await service.backupBeforeSave('/portfolio/memories/notes.yaml', 'memories');

      expect(result.backupPath).toMatch(/\.yaml$/);
    });
  });

  describe('backup directory structure', () => {
    it('creates type-specific date-partitioned directory', async () => {
      fileOps.exists.mockResolvedValue(true);

      await service.backupBeforeSave('/portfolio/ensembles/full-stack.md', 'ensembles');

      const createDirCall = fileOps.createDirectory.mock.calls[0][0] as string;
      expect(normPath(createDirCall)).toMatch(/\.backups\/ensembles\/\d{4}-\d{2}-\d{2}$/);
    });
  });
});

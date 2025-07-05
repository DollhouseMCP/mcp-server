import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

// Create manual mocks
const mockReaddir = jest.fn() as any;
const mockStat = jest.fn() as any;
const mockRm = jest.fn() as any;
const mockMkdir = jest.fn() as any;
const mockCopyFile = jest.fn() as any;
const mockReadFile = jest.fn() as any;
const mockWriteFile = jest.fn() as any;
const mockRename = jest.fn() as any;
const mockAccess = jest.fn() as any;
const mockExecSync = jest.fn() as any;

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readdir: mockReaddir,
  stat: mockStat,
  rm: mockRm,
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rename: mockRename,
  access: mockAccess,
  constants: {
    F_OK: 0
  }
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: mockExecSync
}));

// Import after mocking
import { BackupManager } from '../../../src/update/BackupManager';

describe('BackupManager', () => {
  let backupManager: BackupManager;
  const mockDate = new Date('2025-01-05T12:00:00Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
    backupManager = new BackupManager();

    // Default mock behaviors
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ 
      isDirectory: () => true,
      mtime: new Date()
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createBackup', () => {
    it('should create a backup with timestamp', async () => {
      const expectedBackupName = '.backup-20250105-120000';
      
      // Mock directory listing to simulate files to backup
      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === '.') {
          return ['src', 'package.json', 'tsconfig.json', '.git', 'node_modules', '.backup-old'];
        }
        if (dir === 'src') {
          return ['index.ts', 'update'];
        }
        return [];
      });

      mockStat.mockImplementation(async (filePath: string) => ({
        isDirectory: () => filePath.includes('src') || filePath.includes('.git') || filePath.includes('node_modules'),
        isFile: () => !filePath.includes('src') && !filePath.includes('.git') && !filePath.includes('node_modules'),
        mtime: new Date()
      }));

      mockExecSync.mockReturnValue(Buffer.from(''));

      const result = await backupManager.createBackup();

      expect(result.path).toBe(expectedBackupName);
      expect(result.timestamp).toBeDefined();
      expect(mockMkdir).toHaveBeenCalledWith(expectedBackupName, { recursive: true });
      
      // Should use rsync for efficient copying
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('rsync'),
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('should exclude node_modules, .git, and other backups', async () => {
      mockReaddir.mockResolvedValue(['src', 'node_modules', '.git', '.backup-old', 'package.json']);
      
      const result = await backupManager.createBackup();

      expect(result.path).toBeDefined();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--exclude=node_modules'),
        expect.any(Object)
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--exclude=.git'),
        expect.any(Object)
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--exclude=.backup-*'),
        expect.any(Object)
      );
    });

    it('should fall back to manual copy if rsync is not available', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('rsync')) {
          throw new Error('rsync not found');
        }
        return Buffer.from('');
      });

      mockReaddir.mockResolvedValue(['package.json', 'src']);
      mockStat.mockImplementation(async (path: string) => ({
        isDirectory: () => path === 'src',
        isFile: () => path === 'package.json'
      }));

      const result = await backupManager.createBackup();

      expect(result.path).toBeDefined();
      expect(mockCopyFile).toHaveBeenCalled();
    });

    it('should handle backup creation errors', async () => {
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(backupManager.createBackup()).rejects.toThrow('Permission denied');
    });

    it('should create metadata file in backup', async () => {
      mockReaddir.mockResolvedValue(['package.json']);
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));

      const result = await backupManager.createBackup('1.0.0');

      expect(result.path).toBeDefined();
      expect(result.version).toBe('1.0.0');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.backup-metadata.json'),
        expect.stringContaining('"version":"1.0.0"')
      );
    });
  });

  describe('listBackups', () => {
    it('should list all backups sorted by date', async () => {
      const backups = [
        '.backup-20250105-120000',
        '.backup-20250104-120000',
        '.backup-20250103-120000',
        'not-a-backup',
        'src'
      ];

      mockReaddir.mockResolvedValue(backups);
      mockStat.mockImplementation(async (dir: string) => ({
        isDirectory: () => dir.startsWith('.backup-'),
        mtime: new Date(dir.includes('20250105') ? '2025-01-05' : 
                       dir.includes('20250104') ? '2025-01-04' : '2025-01-03')
      }));

      const result = await backupManager.listBackups();

      expect(result).toHaveLength(3);
      expect(result[0].path).toBe('.backup-20250105-120000');
      expect(result[1].path).toBe('.backup-20250104-120000');
      expect(result[2].path).toBe('.backup-20250103-120000');
    });

    it('should handle empty backup directory', async () => {
      mockReaddir.mockResolvedValue([]);

      const result = await backupManager.listBackups();

      expect(result).toEqual([]);
    });

    it('should include version if available', async () => {
      mockReaddir.mockResolvedValue(['.backup-20250105-120000']);
      mockStat.mockResolvedValue({ 
        isDirectory: () => true,
        mtime: new Date('2025-01-05')
      });
      
      mockAccess.mockResolvedValue(undefined); // metadata file exists
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: '1.0.0',
        createdAt: '2025-01-05T12:00:00Z'
      }));

      const result = await backupManager.listBackups();

      expect(result[0].version).toBe('1.0.0');
      expect(result[0].timestamp).toBeDefined();
    });
  });

  describe('cleanupOldBackups', () => {
    it('should keep only the most recent backups', async () => {
      const backups = Array.from({ length: 8 }, (_, i) => ({
        path: `.backup-2025010${8-i}-120000`,
        timestamp: new Date(`2025-01-0${8-i}`)
      }));

      jest.spyOn(backupManager, 'listBackups').mockResolvedValue(backups as any);

      const deletedCount = await backupManager.cleanupOldBackups(5);

      expect(deletedCount).toBe(3);
      expect(mockRm).toHaveBeenCalledTimes(3);
      expect(mockRm).toHaveBeenCalledWith('.backup-20250103-120000', { recursive: true, force: true });
      expect(mockRm).toHaveBeenCalledWith('.backup-20250102-120000', { recursive: true, force: true });
      expect(mockRm).toHaveBeenCalledWith('.backup-20250101-120000', { recursive: true, force: true });
    });

    it('should not delete backups if under the limit', async () => {
      const backups = Array.from({ length: 3 }, (_, i) => ({
        path: `.backup-2025010${3-i}-120000`,
        timestamp: new Date(`2025-01-0${3-i}`)
      }));

      jest.spyOn(backupManager, 'listBackups').mockResolvedValue(backups as any);

      const deletedCount = await backupManager.cleanupOldBackups(5);

      expect(deletedCount).toBe(0);
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('should handle deletion errors gracefully', async () => {
      const backups = Array.from({ length: 6 }, (_, i) => ({
        path: `.backup-2025010${6-i}-120000`,
        timestamp: new Date(`2025-01-0${6-i}`)
      }));

      jest.spyOn(backupManager, 'listBackups').mockResolvedValue(backups as any);
      mockRm.mockRejectedValueOnce(new Error('Permission denied'));

      const deletedCount = await backupManager.cleanupOldBackups(5);

      expect(deletedCount).toBe(0); // Failed to delete any
    });
  });

  describe('restoreBackup', () => {
    it('should restore from specified backup', async () => {
      const backupPath = '.backup-20250105-120000';
      
      // Mock backup exists and has files
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === backupPath) {
          return ['src', 'package.json', 'tsconfig.json'];
        }
        return [];
      });

      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockExecSync.mockReturnValue(Buffer.from(''));

      await backupManager.restoreBackup(backupPath);

      expect(mockExecSync).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('.pre-restore-backup')
      );
    });

    it('should verify backup exists before restoring', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await expect(backupManager.restoreBackup('.backup-nonexistent')).rejects.toThrow();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('should handle restore errors and keep pre-restore backup', async () => {
      const backupPath = '.backup-20250105-120000';
      mockAccess.mockResolvedValue(undefined);
      mockRename.mockResolvedValueOnce(undefined); // First rename succeeds
      mockExecSync.mockImplementation(() => {
        throw new Error('Copy failed');
      });

      await expect(backupManager.restoreBackup(backupPath)).rejects.toThrow('Copy failed');
    });

    it('should get latest backup', async () => {
      const backups = [
        { path: '.backup-20250105-120000', timestamp: '2025-01-05T12:00:00Z' },
        { path: '.backup-20250104-120000', timestamp: '2025-01-04T12:00:00Z' }
      ];

      jest.spyOn(backupManager, 'listBackups').mockResolvedValue(backups as any);

      const latest = await backupManager.getLatestBackup();

      expect(latest).not.toBeNull();
      expect(latest!.path).toBe('.backup-20250105-120000');
    });

    it('should return null if no backups available', async () => {
      jest.spyOn(backupManager, 'listBackups').mockResolvedValue([]);

      const latest = await backupManager.getLatestBackup();

      expect(latest).toBeNull();
    });

    it('should clean up pre-restore backup after successful restore', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecSync.mockReturnValue(Buffer.from(''));
      mockReaddir.mockResolvedValue(['package.json']);

      await backupManager.restoreBackup('.backup-20250105-120000');
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('.pre-restore-backup'),
        { recursive: true, force: true }
      );
    });

    it('should run post-restore commands', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecSync.mockReturnValue(Buffer.from(''));
      mockReaddir.mockResolvedValue(['package.json']);

      await backupManager.restoreBackup('.backup-20250105-120000');
      expect(mockExecSync).toHaveBeenCalledWith('npm install', expect.any(Object));
      expect(mockExecSync).toHaveBeenCalledWith('npm run build', expect.any(Object));
    });
  });
});
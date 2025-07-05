import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

// Create manual mocks
const mockSpawn = jest.fn() as any;
const mockReadFile = jest.fn() as any;
const mockWriteFile = jest.fn() as any;
const mockAccess = jest.fn() as any;
const mockMkdir = jest.fn() as any;
const mockReaddir = jest.fn() as any;
const mockRename = jest.fn() as any;
const mockRm = jest.fn() as any;
const mockStat = jest.fn() as any;

// Mock child_process
jest.mock('child_process', () => ({
  spawn: mockSpawn
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  access: mockAccess,
  mkdir: mockMkdir,
  readdir: mockReaddir,
  rename: mockRename,
  rm: mockRm,
  stat: mockStat,
  constants: {
    F_OK: 0
  }
}));

// Mock other update modules
const mockCheckForUpdates = jest.fn() as any;
const mockFormatUpdateCheckResult = jest.fn() as any;
const mockCreateBackup = jest.fn() as any;
const mockListBackups = jest.fn() as any;
const mockGetLatestBackup = jest.fn() as any;
const mockRestoreBackup = jest.fn() as any;
const mockCleanupOldBackups = jest.fn() as any;
const mockCheckDependencies = jest.fn() as any;
const mockFormatDependencyStatus = jest.fn() as any;
const mockGetCurrentVersion = jest.fn() as any;
const mockCompareVersions = jest.fn() as any;

// Mock VersionManager
const mockVersionManager = {
  getCurrentVersion: mockGetCurrentVersion,
  compareVersions: mockCompareVersions
};

jest.mock('../../../src/update/VersionManager', () => ({
  VersionManager: jest.fn().mockImplementation(() => mockVersionManager)
}));

jest.mock('../../../src/update/UpdateChecker', () => ({
  UpdateChecker: jest.fn().mockImplementation(() => ({
    checkForUpdates: mockCheckForUpdates,
    formatUpdateCheckResult: mockFormatUpdateCheckResult
  }))
}));

jest.mock('../../../src/update/BackupManager', () => ({
  BackupManager: jest.fn().mockImplementation(() => ({
    createBackup: mockCreateBackup,
    listBackups: mockListBackups,
    getLatestBackup: mockGetLatestBackup,
    restoreBackup: mockRestoreBackup,
    cleanupOldBackups: mockCleanupOldBackups
  }))
}));

jest.mock('../../../src/update/DependencyChecker', () => ({
  DependencyChecker: jest.fn().mockImplementation(() => ({
    checkDependencies: mockCheckDependencies,
    formatDependencyStatus: mockFormatDependencyStatus
  }))
}));

// Import after mocking
import { UpdateManager } from '../../../src/update/UpdateManager';

describe('UpdateManager', () => {
  let updateManager: UpdateManager;
  let mockChildProcess: any;

  beforeEach(() => {
    jest.clearAllMocks();
    updateManager = new UpdateManager();

    // Setup default mock behavior
    mockGetCurrentVersion.mockResolvedValue('1.0.0');
    mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    
    // Mock child process
    mockChildProcess = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn()
    };
    mockSpawn.mockReturnValue(mockChildProcess);

    // Mock dependency checker to return success
    mockCheckDependencies.mockResolvedValue({
      git: { installed: true, version: '2.30.0', valid: true },
      npm: { installed: true, version: '8.5.0', valid: true }
    });
    mockFormatDependencyStatus.mockReturnValue('All dependencies satisfied');
    
    // Mock update checker
    mockFormatUpdateCheckResult.mockReturnValue('Update check result');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkForUpdates', () => {
    it('should check for updates and return formatted result', async () => {
      const mockUpdateInfo = {
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true,
        releaseDate: '2025-01-05',
        releaseNotes: '- New features',
        releaseUrl: 'https://github.com/mickdarling/DollhouseMCP/releases/tag/v1.1.0'
      };

      mockCheckForUpdates.mockResolvedValue(mockUpdateInfo);
      mockFormatUpdateCheckResult.mockReturnValue('Update available: 1.0.0 → 1.1.0\n\nRelease Notes:\n- New features');

      const result = await updateManager.checkForUpdates();

      expect(result.text).toContain('Update available: 1.0.0 → 1.1.0');
      expect(mockCheckForUpdates).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockCheckForUpdates.mockRejectedValue(new Error('Network error'));
      mockFormatUpdateCheckResult.mockReturnValue('Failed to check for updates: Network error');

      const result = await updateManager.checkForUpdates();

      expect(result.text).toContain('Failed to check for updates');
    });
  });

  describe('updateServer', () => {
    beforeEach(() => {
      // Setup successful update flow
      mockCheckForUpdates.mockResolvedValue({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        isUpdateAvailable: true
      });

      mockCreateBackup.mockResolvedValue({
        path: '.backup-123456',
        timestamp: '2025-01-05T12:00:00Z',
        version: '1.0.0'
      });

      mockCleanupOldBackups.mockResolvedValue(2);
    });

    it('should perform update with backup when requested', async () => {
      // Mock successful command execution
      const setupMockCommand = (stdout: string = '', stderr: string = '') => {
        mockChildProcess.stdout.on.mockImplementation((event: string, cb: Function) => {
          if (event === 'data') cb(Buffer.from(stdout));
        });
        mockChildProcess.stderr.on.mockImplementation((event: string, cb: Function) => {
          if (event === 'data' && stderr) cb(Buffer.from(stderr));
        });
        mockChildProcess.on.mockImplementation((event: string, cb: Function) => {
          if (event === 'close') cb(0);
        });
      };

      setupMockCommand('Success');

      const result = await updateManager.updateServer(true);

      expect(result.text).toContain('completed successfully');
      expect(mockCreateBackup).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith('git', ['pull', 'origin', 'main']);
      expect(mockSpawn).toHaveBeenCalledWith('npm', ['install']);
      expect(mockSpawn).toHaveBeenCalledWith('npm', ['run', 'build']);
    });

    it('should perform update without backup when not requested', async () => {
      // Mock successful command execution
      mockChildProcess.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'close') cb(0);
      });

      const result = await updateManager.updateServer(false);

      expect(result.text).toContain('completed successfully');
      expect(mockCreateBackup).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(3); // git pull, npm install, npm build
    });

    it('should handle git pull failure', async () => {
      // Mock git pull failure
      mockChildProcess.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'close') cb(1);
      });
      mockChildProcess.stderr.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'data') cb(Buffer.from('fatal: not a git repository'));
      });

      const result = await updateManager.updateServer(true);

      expect(result.text).toContain('Update failed');
      expect(mockSpawn).toHaveBeenCalledWith('git', ['pull', 'origin', 'main']);
      expect(mockSpawn).not.toHaveBeenCalledWith('npm', ['install']);
    });

    it('should handle npm install failure and suggest rollback', async () => {
      // First command succeeds
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const proc = {
          stdout: { on: jest.fn() },
          stderr: { on: jest.fn() },
          on: jest.fn((event: string, cb: Function) => {
            if (event === 'close') {
              cb(callCount === 0 ? 0 : 1); // First succeeds, second fails
            }
          })
        };
        callCount++;
        return proc;
      });

      const result = await updateManager.updateServer(true);

      expect(result.text).toContain('can rollback');
      expect(result.text).toContain('.backup-123456');
    });

    it('should handle dependency check failure', async () => {
      mockCheckDependencies.mockResolvedValue({
        git: { installed: true, version: '2.19.0', valid: false, error: 'Git version 2.19.0 found, but 2.20.0+ required' },
        npm: { installed: true, version: '8.5.0', valid: true }
      });
      mockFormatDependencyStatus.mockReturnValue('Dependency check failed:\nGit version 2.19.0 found, but 2.20.0+ required');

      const result = await updateManager.updateServer(true);

      expect(result.text).toContain('Dependency check failed');
      expect(result.text).toContain('Git version 2.19.0 found');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should include progress information in output', async () => {
      // Mock successful commands
      mockChildProcess.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'close') cb(0);
      });

      const result = await updateManager.updateServer(true);

      expect(result.text).toContain('Step 1');
      expect(result.text).toContain('Step 2');
      expect(result.text).toContain('Step 3');
    });
  });

  describe('rollbackUpdate', () => {
    it('should rollback to latest backup', async () => {
      mockListBackups.mockResolvedValue([
        { path: '.backup-123456', timestamp: '2025-01-05T12:00:00Z', version: '1.0.0' },
        { path: '.backup-123455', timestamp: '2025-01-04T12:00:00Z', version: '0.9.0' }
      ]);
      mockGetLatestBackup.mockResolvedValue({ path: '.backup-123456', timestamp: '2025-01-05T12:00:00Z', version: '1.0.0' });

      mockRestoreBackup.mockResolvedValue(undefined);

      const result = await updateManager.rollbackUpdate();

      expect(result.text).toContain('Rollback completed');
      expect(mockRestoreBackup).toHaveBeenCalledWith('.backup-123456');
    });

    it('should handle no backups available', async () => {
      mockListBackups.mockResolvedValue([]);
      mockGetLatestBackup.mockResolvedValue(null);

      const result = await updateManager.rollbackUpdate();

      expect(result.text).toContain('No backups available');
      expect(mockRestoreBackup).not.toHaveBeenCalled();
    });

    it('should handle rollback errors', async () => {
      mockGetLatestBackup.mockResolvedValue({ path: '.backup-123456', timestamp: '2025-01-05T12:00:00Z' });
      mockRestoreBackup.mockRejectedValue(new Error('Restore failed'));

      const result = await updateManager.rollbackUpdate();

      expect(result.text).toContain('Rollback failed');
    });
  });

  describe('getServerStatus', () => {
    it('should return formatted server status', async () => {
      mockGetCurrentVersion.mockResolvedValue('1.0.0');
      mockListBackups.mockResolvedValue([
        { path: '.backup-123456', timestamp: '2025-01-05T12:00:00Z' }
      ]);
      mockCheckDependencies.mockResolvedValue({
        git: { installed: true, version: '2.30.0', valid: true },
        npm: { installed: true, version: '8.5.0', valid: true }
      });
      mockAccess.mockResolvedValue(undefined); // .git exists

      const status = await updateManager.getServerStatus();

      expect(status.text).toContain('Server Status');
      expect(status.text).toContain('Version: 1.0.0');
      expect(status.text).toContain('Git: ✓');
      expect(status.text).toContain('Backups: 1');
    });

    it('should detect when not in git repository', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockListBackups.mockResolvedValue([]);

      const status = await updateManager.getServerStatus();

      expect(status.text).toContain('Git repository: ✗');
    });
  });
});
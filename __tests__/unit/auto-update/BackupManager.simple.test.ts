import { describe, it, expect } from '@jest/globals';
import { BackupManager } from '../../../src/update/BackupManager.js';

// Simple integration test - runs against real implementation
describe('BackupManager (Simple)', () => {
  let backupManager: BackupManager;

  beforeEach(() => {
    backupManager = new BackupManager();
  });

  describe('basic functionality', () => {
    it('should create a BackupManager instance', () => {
      expect(backupManager).toBeDefined();
      expect(backupManager).toBeInstanceOf(BackupManager);
    });

    it('should have required methods', () => {
      expect(typeof backupManager.createBackup).toBe('function');
      expect(typeof backupManager.listBackups).toBe('function');
      expect(typeof backupManager.restoreBackup).toBe('function');
      expect(typeof backupManager.getLatestBackup).toBe('function');
      expect(typeof backupManager.cleanupOldBackups).toBe('function');
    });

    it('should list backups (may be empty)', async () => {
      const backups = await backupManager.listBackups();
      expect(Array.isArray(backups)).toBe(true);
      
      // Each backup should have the expected structure
      backups.forEach(backup => {
        expect(backup).toHaveProperty('path');
        expect(backup).toHaveProperty('timestamp');
        expect(typeof backup.path).toBe('string');
      });
    });

    it('should get latest backup (may be null)', async () => {
      const latest = await backupManager.getLatestBackup();
      
      if (latest !== null) {
        expect(latest).toHaveProperty('path');
        expect(latest).toHaveProperty('timestamp');
        expect(typeof latest.path).toBe('string');
      }
    });
  });
});
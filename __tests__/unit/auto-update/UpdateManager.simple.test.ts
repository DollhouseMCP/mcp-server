import { describe, it, expect } from '@jest/globals';
import { UpdateManager } from '../../../src/update/UpdateManager.js';

// Simple integration test - runs against real implementation
describe('UpdateManager (Simple)', () => {
  let updateManager: UpdateManager;

  beforeEach(() => {
    updateManager = new UpdateManager();
  });

  describe('basic functionality', () => {
    it('should create an UpdateManager instance', () => {
      expect(updateManager).toBeDefined();
      expect(updateManager).toBeInstanceOf(UpdateManager);
    });

    it('should have required methods', () => {
      expect(typeof updateManager.checkForUpdates).toBe('function');
      expect(typeof updateManager.updateServer).toBe('function');
      expect(typeof updateManager.rollbackUpdate).toBe('function');
      expect(typeof updateManager.getServerStatus).toBe('function');
    });

    it('should return text objects from main methods', async () => {
      // Check for updates - should return { text: string }
      const checkResult = await updateManager.checkForUpdates();
      expect(checkResult).toHaveProperty('text');
      expect(typeof checkResult.text).toBe('string');

      // Get server status - should return { text: string }
      const statusResult = await updateManager.getServerStatus();
      expect(statusResult).toHaveProperty('text');
      expect(typeof statusResult.text).toBe('string');

      // Rollback (without confirmation) - should return { text: string }
      const rollbackResult = await updateManager.rollbackUpdate();
      expect(rollbackResult).toHaveProperty('text');
      expect(typeof rollbackResult.text).toBe('string');
    });
  });
});
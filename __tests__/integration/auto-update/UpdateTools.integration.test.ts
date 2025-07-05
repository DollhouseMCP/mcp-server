import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UpdateManager } from '../../../src/update/UpdateManager';
import { UpdateTools } from '../../../src/server/tools/UpdateTools';

// Create manual mocks for the UpdateManager
const mockCheckForUpdates = jest.fn() as any;
const mockPerformUpdate = jest.fn() as any;
const mockRollbackUpdate = jest.fn() as any;
const mockGetServerStatus = jest.fn() as any;

jest.mock('../../../src/update/UpdateManager', () => ({
  UpdateManager: jest.fn().mockImplementation(() => ({
    checkForUpdates: mockCheckForUpdates,
    performUpdate: mockPerformUpdate,
    rollbackUpdate: mockRollbackUpdate,
    getServerStatus: mockGetServerStatus
  }))
}));

describe('UpdateTools Integration Tests', () => {
  let updateTools: UpdateTools;

  beforeEach(() => {
    jest.clearAllMocks();
    updateTools = new UpdateTools();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('check_for_updates tool', () => {
    it('should return update available message', async () => {
      mockCheckForUpdates.mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        message: 'Update available: 1.0.0 → 1.1.0\n\nRelease Notes:\n- New features\n- Bug fixes',
        releaseNotes: '- New features\n- Bug fixes'
      });

      const tool = updateTools.getTools().find(t => t.name === 'check_for_updates');
      expect(tool).toBeDefined();

      const result = await tool!.execute({});

      expect(result.success).toBe(true);
      expect(result.message).toContain('Update available: 1.0.0 → 1.1.0');
      expect(result.message).toContain('New features');
      expect(result.updateAvailable).toBe(true);
      expect(result.currentVersion).toBe('1.0.0');
      expect(result.latestVersion).toBe('1.1.0');
    });

    it('should handle no update available', async () => {
      mockCheckForUpdates.mockResolvedValue({
        hasUpdate: false,
        currentVersion: '1.1.0',
        latestVersion: '1.1.0',
        message: 'You are running the latest version (1.1.0)'
      });

      const tool = updateTools.getTools().find(t => t.name === 'check_for_updates');
      const result = await tool!.execute({});

      expect(result.success).toBe(true);
      expect(result.updateAvailable).toBe(false);
      expect(result.message).toContain('latest version');
    });

    it('should handle check errors', async () => {
      mockCheckForUpdates.mockResolvedValue({
        hasUpdate: false,
        message: 'Failed to check for updates',
        error: 'Network timeout'
      });

      const tool = updateTools.getTools().find(t => t.name === 'check_for_updates');
      const result = await tool!.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('update_server tool', () => {
    it('should perform update with backup', async () => {
      mockPerformUpdate.mockResolvedValue({
        success: true,
        message: 'Update completed successfully',
        backupPath: '.backup-123456'
      });

      const tool = updateTools.getTools().find(t => t.name === 'update_server');
      expect(tool).toBeDefined();

      const result = await tool!.execute({ createBackup: true });

      expect(mockPerformUpdate).toHaveBeenCalledWith(true);
      expect(result.success).toBe(true);
      expect(result.backupPath).toBe('.backup-123456');
    });

    it('should perform update without backup', async () => {
      mockPerformUpdate.mockResolvedValue({
        success: true,
        message: 'Update completed successfully'
      });

      const tool = updateTools.getTools().find(t => t.name === 'update_server');
      const result = await tool!.execute({ createBackup: false });

      expect(mockPerformUpdate).toHaveBeenCalledWith(false);
      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
    });

    it('should handle update failures', async () => {
      mockPerformUpdate.mockResolvedValue({
        success: false,
        message: 'Update failed: npm install error',
        error: 'npm ERR! network timeout',
        backupPath: '.backup-123456'
      });

      const tool = updateTools.getTools().find(t => t.name === 'update_server');
      const result = await tool!.execute({ createBackup: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('npm ERR! network timeout');
      expect(result.message).toContain('rollback');
    });

    it('should default to creating backup', async () => {
      mockPerformUpdate.mockResolvedValue({
        success: true,
        message: 'Update completed'
      });

      const tool = updateTools.getTools().find(t => t.name === 'update_server');
      const result = await tool!.execute({}); // No createBackup specified

      expect(mockPerformUpdate).toHaveBeenCalledWith(true); // Defaults to true
    });
  });

  describe('rollback_update tool', () => {
    it('should rollback to specified backup', async () => {
      mockRollbackUpdate.mockResolvedValue({
        success: true,
        message: 'Successfully rolled back to .backup-123456'
      });

      const tool = updateTools.getTools().find(t => t.name === 'rollback_update');
      expect(tool).toBeDefined();

      const result = await tool!.execute({ backupPath: '.backup-123456' });

      expect(mockRollbackUpdate).toHaveBeenCalledWith('.backup-123456');
      expect(result.success).toBe(true);
    });

    it('should list backups when no path specified', async () => {
      mockRollbackUpdate.mockResolvedValue({
        success: false,
        message: 'Available backups:\n- .backup-123456 (2025-01-05)\n- .backup-123455 (2025-01-04)',
        availableBackups: ['.backup-123456', '.backup-123455']
      });

      const tool = updateTools.getTools().find(t => t.name === 'rollback_update');
      const result = await tool!.execute({});

      expect(mockRollbackUpdate).toHaveBeenCalledWith(undefined);
      expect(result.success).toBe(false);
      expect(result.availableBackups).toHaveLength(2);
    });

    it('should handle rollback errors', async () => {
      mockRollbackUpdate.mockResolvedValue({
        success: false,
        message: 'Rollback failed',
        error: 'Backup corrupted'
      });

      const tool = updateTools.getTools().find(t => t.name === 'rollback_update');
      const result = await tool!.execute({ backupPath: '.backup-123456' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Backup corrupted');
    });

    it('should confirm restore with specific message', async () => {
      mockRollbackUpdate.mockResolvedValue({
        success: true,
        message: 'Rollback completed'
      });

      const tool = updateTools.getTools().find(t => t.name === 'rollback_update');
      const result = await tool!.execute({ 
        backupPath: '.backup-123456',
        confirm: true 
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('npm install');
      expect(result.message).toContain('npm run build');
    });
  });

  describe('get_server_status tool', () => {
    it('should return comprehensive server status', async () => {
      mockGetServerStatus.mockResolvedValue({
        version: '1.1.0',
        node: '18.12.0',
        npm: '8.5.0',
        gitInstalled: true,
        isGitRepo: true,
        hasBackups: true,
        backupCount: 3,
        lastCheckForUpdates: '2025-01-05T12:00:00Z',
        updateAvailable: false
      });

      const tool = updateTools.getTools().find(t => t.name === 'get_server_status');
      expect(tool).toBeDefined();

      const result = await tool!.execute({});

      expect(result.version).toBe('1.1.0');
      expect(result.dependencies.node).toBe('18.12.0');
      expect(result.dependencies.npm).toBe('8.5.0');
      expect(result.gitStatus.installed).toBe(true);
      expect(result.gitStatus.isRepository).toBe(true);
      expect(result.backups.available).toBe(true);
      expect(result.backups.count).toBe(3);
    });

    it('should handle missing dependencies', async () => {
      mockGetServerStatus.mockResolvedValue({
        version: '1.1.0',
        node: '18.12.0',
        npm: 'not found',
        gitInstalled: false,
        isGitRepo: false,
        hasBackups: false
      });

      const tool = updateTools.getTools().find(t => t.name === 'get_server_status');
      const result = await tool!.execute({});

      expect(result.dependencies.npm).toBe('not found');
      expect(result.gitStatus.installed).toBe(false);
      expect(result.backups.available).toBe(false);
    });

    it('should include update check information', async () => {
      mockGetServerStatus.mockResolvedValue({
        version: '1.0.0',
        updateAvailable: true,
        latestVersion: '1.1.0',
        lastCheckForUpdates: new Date().toISOString()
      });

      const tool = updateTools.getTools().find(t => t.name === 'get_server_status');
      const result = await tool!.execute({});

      expect(result.updates.available).toBe(true);
      expect(result.updates.latestVersion).toBe('1.1.0');
      expect(result.updates.lastCheck).toBeDefined();
    });
  });

  describe('tool metadata and schemas', () => {
    it('should have proper tool definitions', () => {
      const tools = updateTools.getTools();

      expect(tools).toHaveLength(4);
      
      const checkTool = tools.find(t => t.name === 'check_for_updates');
      expect(checkTool?.description).toContain('Check for available updates');
      expect(checkTool?.inputSchema).toBeDefined();

      const updateTool = tools.find(t => t.name === 'update_server');
      expect(updateTool?.description).toContain('Update the server');
      expect(updateTool?.inputSchema.properties).toHaveProperty('createBackup');

      const rollbackTool = tools.find(t => t.name === 'rollback_update');
      expect(rollbackTool?.description).toContain('Rollback to a previous version');
      expect(rollbackTool?.inputSchema.properties).toHaveProperty('backupPath');

      const statusTool = tools.find(t => t.name === 'get_server_status');
      expect(statusTool?.description).toContain('Get current server status');
    });

    it('should validate input schemas', async () => {
      const updateTool = updateTools.getTools().find(t => t.name === 'update_server');
      
      // Test with invalid input type
      mockPerformUpdate.mockResolvedValue({ success: true });
      
      const result = await updateTool!.execute({ 
        createBackup: 'yes' as any // Should be boolean
      });

      // The tool should handle type coercion or validation
      expect(mockPerformUpdate).toHaveBeenCalledWith(true);
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle unexpected errors gracefully', async () => {
      mockCheckForUpdates.mockRejectedValue(new Error('Unexpected error'));

      const tool = updateTools.getTools().find(t => t.name === 'check_for_updates');
      const result = await tool!.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected error');
    });

    it('should handle missing update manager', async () => {
      // Simulate UpdateManager constructor failure
      const FailingUpdateTools = new UpdateTools();
      const tool = FailingUpdateTools.getTools().find(t => t.name === 'check_for_updates');
      
      mockCheckForUpdates.mockImplementation(() => {
        throw new Error('UpdateManager not initialized');
      });

      const result = await tool!.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('UpdateManager not initialized');
    });
  });
});
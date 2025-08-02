import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UpdateManager } from '../../../../src/update/UpdateManager.js';
import { InstallationDetector } from '../../../../src/utils/installation.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock modules
jest.mock('../../../../src/utils/installation.js');
jest.mock('../../../../src/utils/git.js');
jest.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

import { safeExec } from '../../../../src/utils/git.js';

describe('Convert to Git Installation', () => {
  let updateManager: UpdateManager;
  const testDir = path.join(os.tmpdir(), 'dollhouse-convert-test', Date.now().toString());
  
  const mockSafeExec = safeExec as jest.MockedFunction<typeof safeExec>;
  const mockInstallationDetector = InstallationDetector as jest.Mocked<typeof InstallationDetector>;
  
  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.mkdir(testDir, { recursive: true });
    updateManager = new UpdateManager(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('convertToGitInstallation', () => {
    it('should check if already git installation', async () => {
      // Mock as already git
      mockInstallationDetector.getInstallationType.mockReturnValue('git');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, '/target/path');
      
      expect(result.text).toContain('Already a Git Installation');
      expect(mockSafeExec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['clone']));
    });
    
    it('should validate target directory', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      
      // Test invalid paths
      const invalidPaths = [
        '',
        '/',
        '/etc',
        '/usr',
        '/System',
        'C:\\Windows',
        'C:\\Program Files'
      ];
      
      for (const invalidPath of invalidPaths) {
        const result = await convertMethod.call(updateManager, invalidPath);
        expect(result.text).toContain('Invalid Target Directory');
      }
    });
    
    it('should check git dependency', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      // Mock git not installed
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: false, error: 'git not found' },
        npm: { installed: true }
      });
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, path.join(testDir, 'target'));
      
      expect(result.text).toContain('Git Required');
      expect(result.text).toContain('git not found');
    });
    
    it('should handle existing target directory', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      // Create existing directory
      const targetPath = path.join(testDir, 'existing-target');
      await fs.mkdir(targetPath);
      await fs.writeFile(path.join(targetPath, 'file.txt'), 'existing');
      
      // Mock dependencies OK
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: true },
        npm: { installed: true }
      });
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      expect(result.text).toContain('Directory Already Exists');
      expect(result.text).toContain('Choose a different directory');
    });
    
    it('should perform conversion successfully', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      const targetPath = path.join(testDir, 'new-git-install');
      
      // Mock dependencies OK
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: true },
        npm: { installed: true }
      });
      
      // Mock git clone success
      mockSafeExec.mockImplementation(async (command: string, args: string[]) => {
        if (command === 'git' && args.includes('clone')) {
          // Create mock git directory
          await fs.mkdir(path.join(targetPath, '.git'), { recursive: true });
          return { stdout: 'Cloning into...', stderr: '' };
        }
        if (command === 'npm' && args.includes('install')) {
          return { stdout: 'added 100 packages', stderr: '' };
        }
        if (command === 'npm' && args.includes('run') && args.includes('build')) {
          await fs.mkdir(path.join(targetPath, 'dist'), { recursive: true });
          return { stdout: 'Build complete', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      expect(result.text).toContain('✅ **Conversion Complete!**');
      expect(mockSafeExec).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/DollhouseMCP/mcp-server.git', targetPath],
        expect.any(Object)
      );
      expect(mockSafeExec).toHaveBeenCalledWith(
        'npm',
        ['install'],
        expect.objectContaining({ cwd: targetPath })
      );
      expect(mockSafeExec).toHaveBeenCalledWith(
        'npm',
        ['run', 'build'],
        expect.objectContaining({ cwd: targetPath })
      );
    });
    
    it('should handle clone failure', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      const targetPath = path.join(testDir, 'failed-clone');
      
      // Mock dependencies OK
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: true },
        npm: { installed: true }
      });
      
      // Mock git clone failure
      mockSafeExec.mockRejectedValue(new Error('Failed to connect to GitHub'));
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      expect(result.text).toContain('❌ **Conversion Failed**');
      expect(result.text).toContain('Failed to connect to GitHub');
    });
    
    it('should suggest updating Claude config', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      const targetPath = path.join(testDir, 'successful-install');
      
      // Mock everything successful
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: true },
        npm: { installed: true }
      });
      
      mockSafeExec.mockResolvedValue({ stdout: 'Success', stderr: '' });
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      expect(result.text).toContain('Update Claude Desktop configuration');
      expect(result.text).toContain(targetPath);
      expect(result.text).toContain('dist/index.js');
    });
  });
  
  describe('edge cases', () => {
    it('should handle paths with spaces', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      const targetPath = path.join(testDir, 'path with spaces', 'mcp server');
      
      // Mock dependencies OK
      const dependencyChecker = (updateManager as any).dependencyChecker;
      jest.spyOn(dependencyChecker, 'checkDependencies').mockResolvedValue({
        git: { installed: true },
        npm: { installed: true }
      });
      
      mockSafeExec.mockResolvedValue({ stdout: 'Success', stderr: '' });
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      // Should handle spaces properly
      expect(mockSafeExec).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/DollhouseMCP/mcp-server.git', targetPath],
        expect.any(Object)
      );
    });
    
    it('should handle very long paths', async () => {
      mockInstallationDetector.getInstallationType.mockReturnValue('npm');
      
      // Create a very long path
      const longSegment = 'very-long-directory-name-segment';
      const segments = Array(10).fill(longSegment);
      const targetPath = path.join(testDir, ...segments);
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      // Should either work or fail gracefully
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });
  });
});
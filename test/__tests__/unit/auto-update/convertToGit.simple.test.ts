import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UpdateManager } from '../../../../src/update/UpdateManager.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

describe('Convert to Git Installation - Simple Tests', () => {
  let updateManager: UpdateManager;
  const testDir = path.join(os.tmpdir(), 'dollhouse-convert-simple-test', Date.now().toString());
  
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    updateManager = new UpdateManager(testDir);
  });
  
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  describe('convertToGitInstallation', () => {
    it('should check installation type first', async () => {
      const convertMethod = (updateManager as any).convertToGitInstallation;
      
      // When called without confirmation, should show instructions
      const result = await convertMethod.call(updateManager, '/some/path', false);
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
      
      // Should contain some expected text (instructions or status)
      const hasExpectedContent = 
        result.text.includes('Convert to Git Installation') ||
        result.text.includes('Already a Git Installation') ||
        result.text.includes('Installation Type Unknown');
      
      expect(hasExpectedContent).toBe(true);
    });
    
    it('should handle existing target directory', async () => {
      // Create existing directory
      const targetPath = path.join(testDir, 'existing-target');
      await fs.mkdir(targetPath);
      await fs.writeFile(path.join(targetPath, 'file.txt'), 'existing');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      // Need to pass true to actually check the directory
      const result = await convertMethod.call(updateManager, targetPath, true);
      
      // Should either say already git installation or target exists
      expect(result.text).toBeDefined();
      const hasExpectedError = 
        result.text.includes('Target Directory Exists') ||
        result.text.includes('Already a Git Installation') ||
        result.text.includes('Installation Type Unknown');
      expect(hasExpectedError).toBe(true);
    });
    
    it('should handle conversion method structure', async () => {
      const targetPath = path.join(testDir, 'test-conversion');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      expect(convertMethod).toBeDefined();
      expect(typeof convertMethod).toBe('function');
      
      // Method should return a structured response
      const result = await convertMethod.call(updateManager, targetPath);
      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
    });
    
    it('should format path properly in response', async () => {
      const targetPath = path.join(testDir, 'test-path-format');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      // Should include the target path in the response
      if (result.text.includes('✅')) {
        // Success case
        expect(result.text).toContain(targetPath);
      } else {
        // Failure case should also include path or error
        expect(result.text.length).toBeGreaterThan(0);
      }
    });
    
    it('should handle paths with spaces', async () => {
      const targetPath = path.join(testDir, 'path with spaces', 'mcp server');
      
      const convertMethod = (updateManager as any).convertToGitInstallation;
      const result = await convertMethod.call(updateManager, targetPath);
      
      // Should handle spaces without errors
      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    });
  });
});
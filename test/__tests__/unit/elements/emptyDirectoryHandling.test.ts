/**
 * Tests for empty directory handling across all element managers
 * Addresses Issue #370: Handle empty element directories gracefully
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the modules before importing
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

// Import managers after mocking
import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { logger } from '../../../../src/utils/logger.js';

describe('Empty Directory Handling', () => {
  let testDir: string;
  
  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-dir-test-'));
    
    // Set up mocks
    jest.clearAllMocks();
    
    // Mock FileLockManager - simplified for Jest compatibility
    (FileLockManager as any).atomicWriteFile = jest.fn(() => Promise.resolve(undefined));
    (FileLockManager as any).atomicReadFile = jest.fn(() => Promise.resolve(''));
    (FileLockManager as any).withLock = jest.fn((resource: string, operation: () => Promise<any>) => operation());
    
    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();
    
    // Mock logger
    (logger as any).debug = jest.fn();
    (logger as any).error = jest.fn();
    (logger as any).warn = jest.fn();
    (logger as any).info = jest.fn();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
    // Reset all mocks
    jest.restoreAllMocks();
  });

  describe('AgentManager', () => {
    it('should return empty array when agents directory does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      const manager = new AgentManager(nonExistentDir);
      
      // list() should return empty array
      const agents = await manager.list();
      expect(agents).toEqual([]);
      
      // Should log debug message
      expect(logger.debug).toHaveBeenCalledWith(
        'Agents directory does not exist yet, returning empty array'
      );
    });

    it('should handle EACCES permission errors gracefully', async () => {
      const manager = new AgentManager(testDir);
      
      // Mock fs.readdir to throw permission error
      const originalReaddir = fs.readdir;
      jest.spyOn(fs, 'readdir').mockRejectedValue(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      );
      
      const agents = await manager.list();
      expect(agents).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
      
      // Restore original
      fs.readdir = originalReaddir;
    });
  });

  describe('TemplateManager', () => {
    it('should return empty array when templates directory does not exist', async () => {
      // Since TemplateManager uses PortfolioManager, we'll test with a real directory structure
      const templatesDir = path.join(testDir, 'templates');
      
      // Mock fs.readdir to throw ENOENT
      const originalReaddir = fs.readdir;
      jest.spyOn(fs, 'readdir').mockRejectedValue(
        Object.assign(new Error('Directory does not exist'), { code: 'ENOENT' })
      );
      
      // Create a TemplateManager instance (it will use mocked fs.readdir)
      const manager = new TemplateManager();
      const templates = await manager.list();
      
      expect(templates).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith(
        'Templates directory does not exist yet, returning empty array'
      );
      
      // Restore original
      fs.readdir = originalReaddir;
    });
  });

  // Memory and Ensemble managers have been removed from the codebase

  describe('Remaining Managers', () => {
    it('should handle empty directories consistently', async () => {
      // Create empty directories
      const agentsDir = path.join(testDir, 'agents');
      const templatesDir = path.join(testDir, 'templates');
      
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.mkdir(templatesDir, { recursive: true });
      
      // Mock fs.readdir to return empty array for templates
      const originalReaddir = fs.readdir;
      jest.spyOn(fs, 'readdir').mockImplementation(async (dir) => {
        const dirStr = String(dir);
        if (dirStr.includes('templates')) {
          return [] as any;
        }
        return originalReaddir(dir as any) as any;
      });
      
      // All managers should return empty arrays
      const agentManager = new AgentManager(testDir);
      const templateManager = new TemplateManager();
      
      // Initialize agent manager
      await agentManager.initialize();
      
      expect(await agentManager.list()).toEqual([]);
      expect(await templateManager.list()).toEqual([]);
      
      // Restore original
      fs.readdir = originalReaddir;
    });
  });
});
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
import { EnsembleManager } from '../../../../src/elements/ensembles/EnsembleManager.js';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
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
    
    // Mock FileLockManager
    (FileLockManager as any).atomicWriteFile = jest.fn().mockResolvedValue(undefined);
    (FileLockManager as any).atomicReadFile = jest.fn().mockResolvedValue('');
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

  describe('EnsembleManager', () => {
    it('should return empty array when ensembles directory does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      const manager = new EnsembleManager(nonExistentDir);
      
      // list() should return empty array
      const ensembles = await manager.list();
      expect(ensembles).toEqual([]);
      
      // Should log debug message
      expect(logger.debug).toHaveBeenCalledWith(
        'Ensembles directory does not exist yet, returning empty array'
      );
    });
  });

  describe('MemoryManager', () => {
    it('should return empty array when memories directory does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      const manager = new MemoryManager(nonExistentDir);
      
      // list() should return empty array
      const memories = await manager.list();
      expect(memories).toEqual([]);
      
      // MemoryManager already handled ENOENT, shouldn't throw
      expect(memories).toEqual([]);
    });
  });

  describe('All Managers', () => {
    it('should handle empty directories consistently', async () => {
      // Create empty directories
      const agentsDir = path.join(testDir, 'agents');
      const ensemblesDir = path.join(testDir, 'ensembles');
      const memoriesDir = path.join(testDir, 'memories');
      
      await fs.mkdir(agentsDir);
      await fs.mkdir(ensemblesDir);
      await fs.mkdir(memoriesDir);
      
      // All managers should return empty arrays
      const agentManager = new AgentManager(testDir);
      const ensembleManager = new EnsembleManager(ensemblesDir);
      const memoryManager = new MemoryManager(memoriesDir);
      
      // Initialize agent manager
      await agentManager.initialize();
      
      expect(await agentManager.list()).toEqual([]);
      expect(await ensembleManager.list()).toEqual([]);
      expect(await memoryManager.list()).toEqual([]);
    });
  });
});
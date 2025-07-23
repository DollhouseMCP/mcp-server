/**
 * Tests for EnsembleManager
 * Tests CRUD operations and security measures
 */

import { jest } from '@jest/globals';

import { EnsembleManager } from '../../../../../src/elements/ensembles/EnsembleManager.js';
import { Ensemble } from '../../../../../src/elements/ensembles/Ensemble.js';
import { FileLockManager } from '../../../../../src/security/fileLockManager.js';
import { SecureYamlParser } from '../../../../../src/security/SecureYamlParser.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

// Mock dependencies
jest.mock('../../../../../src/security/fileLockManager.js');
jest.mock('../../../../../src/security/secureYamlParser.js');
jest.mock('../../../../../src/security/securityMonitor.js');
jest.mock('../../../../../src/utils/logger.js');

describe('EnsembleManager', () => {
  let testDir: string;
  let manager: EnsembleManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Create temporary test directory
    testDir = path.join(tmpdir(), `ensemble-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    manager = new EnsembleManager(testDir);
    
    // Setup mocks
    (SecurityMonitor.logSecurityEvent as jest.Mock).mockImplementation(() => {});
    (FileLockManager.atomicReadFile as jest.Mock).mockImplementation(
      async (filePath: string) => {
        return fs.readFile(filePath, 'utf-8');
      }
    );
    (FileLockManager.atomicWriteFile as jest.Mock).mockImplementation(
      async (filePath: string, content: string) => {
        return fs.writeFile(filePath, content, 'utf-8');
      }
    );
    (SecureYamlParser.parse as jest.Mock).mockImplementation(
      async (content: string) => {
        // Simple YAML parsing for tests
        const lines = content.split('\n').filter(line => line.trim());
        const result: any = {};
        
        for (const line of lines) {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match) {
            result[match[1]] = match[2].replace(/^["']|["']$/g, '');
          }
        }
        
        return result;
      }
    );
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should validate base directory', () => {
      expect(() => new EnsembleManager('../../../etc'))
        .toThrow('Invalid base directory path');
    });

    it('should accept valid directory path', () => {
      expect(() => new EnsembleManager(testDir)).not.toThrow();
    });
  });

  describe('save and load', () => {
    it('should save and load an ensemble', async () => {
      const ensemble = new Ensemble({
        name: 'Test Ensemble',
        description: 'A test ensemble',
        activationStrategy: 'sequential'
      });
      ensemble.addElement('persona1', 'persona', 'primary');
      ensemble.addElement('skill1', 'skill', 'support', {
        priority: 80,
        dependencies: ['persona1']
      });

      // Save ensemble
      await manager.save(ensemble, 'test-ensemble.yaml');

      // Verify atomic write was used
      expect(FileLockManager.atomicWriteFile).toHaveBeenCalledWith(
        path.join(testDir, 'test-ensemble.yaml'),
        expect.any(String),
        { encoding: 'utf-8' }
      );

      // Mock the load response
      (SecureYamlParser.parse as jest.Mock).mockResolvedValueOnce({
        name: 'Test Ensemble',
        description: 'A test ensemble',
        activationStrategy: 'sequential',
        elements: [
          { elementId: 'persona1', elementType: 'persona', role: 'primary' },
          { elementId: 'skill1', elementType: 'skill', role: 'support', priority: 80, dependencies: ['persona1'] }
        ]
      });

      // Load ensemble
      const loaded = await manager.load('test-ensemble.yaml');

      // Verify atomic read was used
      expect(FileLockManager.atomicReadFile).toHaveBeenCalledWith(
        path.join(testDir, 'test-ensemble.yaml'),
        { encoding: 'utf-8' }
      );

      // Verify SecureYamlParser was used
      expect(SecureYamlParser.parse).toHaveBeenCalledWith(
        expect.any(String),
        {
          maxYamlSize: 64 * 1024,
          validateContent: true
        }
      );

      expect(loaded.metadata.name).toBe('Test Ensemble');
      expect(loaded.getElements().size).toBe(2);
    });

    it('should handle markdown files with frontmatter', async () => {
      const content = `---
name: "Markdown Ensemble"
activationStrategy: "parallel"
---
# Ensemble Content`;

      await fs.writeFile(path.join(testDir, 'test.md'), content);

      (SecureYamlParser.parse as jest.Mock).mockResolvedValueOnce({
        name: 'Markdown Ensemble',
        activationStrategy: 'parallel'
      });

      const loaded = await manager.load('test.md');
      
      expect(loaded.metadata.name).toBe('Markdown Ensemble');
      expect(SecureYamlParser.parse).toHaveBeenCalledWith(
        'name: "Markdown Ensemble"\nactivationStrategy: "parallel"',
        expect.any(Object)
      );
    });

    it('should reject invalid file paths', async () => {
      await expect(manager.load('../../../etc/passwd'))
        .rejects.toThrow('Invalid file path');
      
      await expect(manager.save(new Ensemble(), '../../../tmp/evil.yaml'))
        .rejects.toThrow('Invalid file path');
    });

    it('should log security events on save', async () => {
      const ensemble = new Ensemble({ name: 'Test' });
      await manager.save(ensemble, 'test.yaml');

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ENSEMBLE_SAVED',
        severity: 'LOW',
        source: 'EnsembleManager.save',
        details: expect.stringContaining('Ensemble saved to')
      });
    });
  });

  describe('list', () => {
    it('should list all ensemble files', async () => {
      // Create test files
      await fs.writeFile(path.join(testDir, 'ensemble1.yaml'), '---\nname: "Ensemble 1"\n---');
      await fs.writeFile(path.join(testDir, 'ensemble2.md'), '---\nname: "Ensemble 2"\n---\nContent');
      await fs.writeFile(path.join(testDir, 'not-ensemble.txt'), 'Should be ignored');

      (SecureYamlParser.parse as jest.Mock)
        .mockResolvedValueOnce({ name: 'Ensemble 1' })
        .mockResolvedValueOnce({ name: 'Ensemble 2' });

      const ensembles = await manager.list();
      
      expect(ensembles.length).toBe(2);
      expect(ensembles[0].metadata.name).toBe('Ensemble 1');
      expect(ensembles[1].metadata.name).toBe('Ensemble 2');
    });

    it('should handle errors gracefully when listing', async () => {
      // Create a file that will fail to parse
      await fs.writeFile(path.join(testDir, 'bad.yaml'), 'invalid yaml content');
      
      (SecureYamlParser.parse as jest.Mock).mockRejectedValueOnce(new Error('Parse error'));

      const ensembles = await manager.list();
      
      // Should return empty array on error
      expect(ensembles.length).toBe(0);
    });
  });

  describe('find', () => {
    it('should find ensemble matching predicate', async () => {
      await fs.writeFile(path.join(testDir, 'ensemble1.yaml'), '---\nname: "Target"\n---');
      await fs.writeFile(path.join(testDir, 'ensemble2.yaml'), '---\nname: "Other"\n---');

      (SecureYamlParser.parse as jest.Mock)
        .mockResolvedValueOnce({ name: 'Target' })
        .mockResolvedValueOnce({ name: 'Other' });

      const found = await manager.find(e => e.metadata.name === 'Target');
      
      expect(found?.metadata.name).toBe('Target');
    });

    it('should return undefined if no match', async () => {
      const found = await manager.find(e => e.metadata.name === 'NonExistent');
      expect(found).toBeUndefined();
    });
  });

  describe('importElement', () => {
    it('should import ensemble from JSON', async () => {
      const jsonData = JSON.stringify({
        metadata: {
          name: 'Imported Ensemble',
          activationStrategy: 'sequential'
        },
        elements: [
          { elementId: 'elem1', elementType: 'persona', role: 'primary' },
          { elementId: 'elem2', elementType: 'skill', role: 'support' }
        ]
      });

      const imported = await manager.importElement(jsonData, 'imported.yaml');
      
      expect(imported.metadata.name).toBe('Imported Ensemble');
      expect(imported.getElements().size).toBe(2);
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ENSEMBLE_IMPORTED',
        severity: 'MEDIUM',
        source: 'EnsembleManager.importElement',
        details: expect.stringContaining('Ensemble imported as imported.yaml')
      });
    });

    it('should reject invalid JSON', async () => {
      await expect(manager.importElement('not json', 'bad.yaml'))
        .rejects.toThrow('Invalid JSON format');
    });

    it('should validate required fields', async () => {
      const jsonData = JSON.stringify({ invalid: 'data' });
      
      await expect(manager.importElement(jsonData, 'bad.yaml'))
        .rejects.toThrow('Missing or invalid metadata');
    });

    it('should skip invalid elements during import', async () => {
      const jsonData = JSON.stringify({
        metadata: { name: 'Test' },
        elements: [
          { elementId: 'valid', elementType: 'persona' },
          { invalid: 'element' }, // Missing required fields
          { elementId: 'valid2', elementType: 'skill' }
        ]
      });

      const imported = await manager.importElement(jsonData, 'test.yaml');
      
      // Should only import valid elements
      expect(imported.getElements().size).toBe(2);
    });
  });

  describe('exportElement', () => {
    it('should export ensemble to JSON', async () => {
      const ensemble = new Ensemble({ 
        name: 'Export Test',
        activationStrategy: 'parallel'
      });
      ensemble.addElement('elem1', 'persona', 'primary');

      const exported = await manager.exportElement(ensemble);
      const parsed = JSON.parse(exported);
      
      expect(parsed.metadata.name).toBe('Export Test');
      expect(parsed.elements.length).toBe(1);
      expect(parsed.elements[0].elementId).toBe('elem1');
    });
  });

  describe('delete', () => {
    it('should delete ensemble file', async () => {
      const filePath = path.join(testDir, 'delete-me.yaml');
      await fs.writeFile(filePath, 'content');
      
      await manager.delete('delete-me.yaml');
      
      await expect(fs.access(filePath)).rejects.toThrow();
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ENSEMBLE_DELETED',
        severity: 'MEDIUM',
        source: 'EnsembleManager.delete',
        details: expect.stringContaining('Ensemble deleted')
      });
    });

    it('should reject invalid delete paths', async () => {
      await expect(manager.delete('../../../etc/passwd'))
        .rejects.toThrow('Invalid file path');
    });
  });

  describe('validate', () => {
    it('should validate ensemble using its validate method', () => {
      const ensemble = new Ensemble({ name: 'Test' });
      const spy = jest.spyOn(ensemble, 'validate');
      
      manager.validate(ensemble);
      
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('security scenarios', () => {
    it('should handle YAML bomb attempts', async () => {
      const yamlBomb = `---
name: "Test"
bomb: &a ["test", *a]
---`;

      await fs.writeFile(path.join(testDir, 'bomb.yaml'), yamlBomb);
      
      // SecureYamlParser should reject this
      (SecureYamlParser.parse as jest.Mock).mockRejectedValueOnce(
        new Error('YAML contains recursive references')
      );

      await expect(manager.load('bomb.yaml'))
        .rejects.toThrow('Invalid ensemble file format');
    });

    it('should enforce YAML size limits', async () => {
      const largeYaml = 'x'.repeat(100 * 1024); // 100KB
      
      await fs.writeFile(path.join(testDir, 'large.yaml'), largeYaml);
      
      // SecureYamlParser should enforce size limit
      (SecureYamlParser.parse as jest.Mock).mockRejectedValueOnce(
        new Error('YAML content exceeds size limit')
      );

      await expect(manager.load('large.yaml'))
        .rejects.toThrow('Invalid ensemble file format');
    });
  });
});
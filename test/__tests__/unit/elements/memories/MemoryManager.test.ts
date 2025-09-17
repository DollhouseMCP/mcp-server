/**
 * Unit tests for MemoryManager
 */

import { MemoryManager } from '../../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../../src/elements/memories/Memory.js';
import { ElementType } from '../../../../../src/portfolio/types.js';
import { PortfolioManager } from '../../../../../src/portfolio/PortfolioManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('MemoryManager', () => {
  let manager: MemoryManager;
  let testDir: string;
  let memoriesDir: string;
  
  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-manager-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    
    // Reset PortfolioManager singleton
    (PortfolioManager as any).instance = null;
    
    // Initialize manager
    manager = new MemoryManager();
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });
  
  afterAll(async () => {
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    (PortfolioManager as any).instance = null;
  });
  
  afterEach(async () => {
    // Clean memories directory between tests
    const files = await fs.readdir(memoriesDir).catch(() => []);
    for (const file of files) {
      await fs.unlink(path.join(memoriesDir, file)).catch(() => {});
    }
  });
  
  describe('save and load', () => {
    it('should save and load a memory', async () => {
      const memory = new Memory({
        name: 'Test Memory',
        description: 'A test memory'
      });
      
      await memory.addEntry('First entry', ['test']);
      await memory.addEntry('Second entry', ['test', 'important']);
      
      await manager.save(memory, 'test-memory.yaml');
      
      const loaded = await manager.load('test-memory.yaml');
      expect(loaded.metadata.name).toBe('Test Memory');
      expect(loaded.metadata.description).toBe('A test memory');
      
      const entries = await loaded.search({});
      expect(entries).toHaveLength(2);
      // Entries should be sorted newest first
      const contents = entries.map(e => e.content);
      expect(contents).toContain('First entry');
      expect(contents).toContain('Second entry');
    });
    
    it('should handle file not found', async () => {
      await expect(manager.load('non-existent.yaml')).rejects.toThrow();
    });
    
    it('should validate memory before saving', async () => {
      const invalidMemory = new Memory({ retentionDays: 500 });
      await expect(manager.save(invalidMemory, 'invalid.yaml')).rejects.toThrow('Invalid memory');
    });
    
    it('should prevent path traversal in load', async () => {
      await expect(manager.load('../../../etc/passwd')).rejects.toThrow('Path traversal detected');
      await expect(manager.load('/absolute/path/memory.yaml')).rejects.toThrow('Path traversal detected');
    });
    
    it('should prevent path traversal in save', async () => {
      const memory = new Memory();
      await expect(manager.save(memory, '../../../etc/passwd')).rejects.toThrow('Path traversal detected');
    });
    
    it('should cache loaded memories', async () => {
      const memory = new Memory({ name: 'Cached Memory' });
      await manager.save(memory, 'cached.yaml');
      
      const loaded1 = await manager.load('cached.yaml');
      const loaded2 = await manager.load('cached.yaml');
      
      // Should be the same instance
      expect(loaded1).toBe(loaded2);
    });
  });
  
  describe('list', () => {
    it('should list all memory files', async () => {
      const memory1 = new Memory({ name: 'Memory 1' });
      const memory2 = new Memory({ name: 'Memory 2' });
      
      await manager.save(memory1, 'memory1.yaml');
      await manager.save(memory2, 'memory2.yaml');
      
      const memories = await manager.list();
      expect(memories).toHaveLength(2);
      expect(memories.map(m => m.metadata.name).sort()).toEqual(['Memory 1', 'Memory 2']);
    });
    
    it('should handle empty directory', async () => {
      const memories = await manager.list();
      expect(memories).toHaveLength(0);
    });
    
    it('should skip non-memory files', async () => {
      const memory = new Memory({ name: 'Valid Memory' });
      await manager.save(memory, 'valid.yaml');
      
      // Create non-memory file
      await fs.writeFile(path.join(memoriesDir, 'readme.txt'), 'Not a memory');
      
      const memories = await manager.list();
      expect(memories).toHaveLength(1);
      expect(memories[0].metadata.name).toBe('Valid Memory');
    });
    
    it('should continue on corrupted files', async () => {
      const memory = new Memory({ name: 'Good Memory' });
      await manager.save(memory, 'good.yaml');
      
      // Create corrupted file that will fail metadata validation
      await fs.writeFile(path.join(memoriesDir, 'bad.yaml'), `
metadata:
  # Missing required name field
  description: Corrupted memory
data:
  entries: []
`);
      
      const memories = await manager.list();
      // Should only load memories with valid metadata
      const validMemories = memories.filter(m => m.metadata.name && m.metadata.name !== 'Unnamed Memory');
      expect(validMemories).toHaveLength(1);
      expect(validMemories[0].metadata.name).toBe('Good Memory');
    });
  });
  
  describe('find and findMany', () => {
    beforeEach(async () => {
      const memory1 = new Memory({ name: 'Work Memory', tags: ['work'] });
      const memory2 = new Memory({ name: 'Personal Memory', tags: ['personal'] });
      const memory3 = new Memory({ name: 'Work Notes', tags: ['work', 'important'] });
      
      await manager.save(memory1, 'work-memory.yaml');
      await manager.save(memory2, 'personal-memory.yaml');
      await manager.save(memory3, 'work-notes.yaml');
    });
    
    it('should find single memory matching predicate', async () => {
      const found = await manager.find(m => m.metadata.name === 'Personal Memory');
      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Personal Memory');
    });
    
    it('should return undefined when no match', async () => {
      const found = await manager.find(m => m.metadata.name === 'Non-existent');
      expect(found).toBeUndefined();
    });
    
    it('should find multiple memories matching predicate', async () => {
      const found = await manager.findMany(m => 
        m.metadata.tags?.includes('work') || false
      );
      expect(found).toHaveLength(2);
      expect(found.map(m => m.metadata.name).sort()).toEqual(['Work Memory', 'Work Notes']);
    });
  });
  
  describe('delete', () => {
    it('should delete memory file', async () => {
      const memory = new Memory({ name: 'To Delete' });
      await manager.save(memory, 'delete-me.yaml');
      
      await manager.delete('delete-me.yaml');
      
      const exists = await manager.exists('delete-me.yaml');
      expect(exists).toBe(false);
    });
    
    it('should not throw when deleting non-existent file', async () => {
      // Should not throw
      await expect(manager.delete('non-existent.yaml')).resolves.not.toThrow();
    });
    
    it('should remove from cache on delete', async () => {
      const memory = new Memory({ name: 'Cached' });
      await manager.save(memory, 'cached.yaml');
      
      // Load to cache
      await manager.load('cached.yaml');
      
      // Delete
      await manager.delete('cached.yaml');
      
      // Should fail to load
      await expect(manager.load('cached.yaml')).rejects.toThrow();
    });
  });
  
  describe('exists', () => {
    it('should return true for existing file', async () => {
      const memory = new Memory();
      await manager.save(memory, 'exists.yaml');
      
      const exists = await manager.exists('exists.yaml');
      expect(exists).toBe(true);
    });
    
    it('should return false for non-existent file', async () => {
      const exists = await manager.exists('does-not-exist.yaml');
      expect(exists).toBe(false);
    });
  });
  
  describe('create', () => {
    it('should create new memory instance', async () => {
      const memory = await manager.create({
        name: 'New Memory',
        description: 'Created by manager'
      });
      
      expect(memory).toBeInstanceOf(Memory);
      expect(memory.metadata.name).toBe('New Memory');
      expect(memory.metadata.description).toBe('Created by manager');
    });
  });
  
  describe('import and export', () => {
    it('should export memory to YAML', async () => {
      const memory = new Memory({ name: 'Export Test' });
      await memory.addEntry('Test entry', ['export']);
      
      const exported = await manager.exportElement(memory);
      expect(exported).toContain('name: Export Test');
      expect(exported).toContain('Test entry');
      expect(exported).toContain('export');
    });
    
    it('should import memory from YAML', async () => {
      const yaml = `
metadata:
  name: Imported Memory
  description: From YAML
  tags:
    - imported
data:
  entries:
    - id: entry-1
      content: Imported content
      tags:
        - test
      timestamp: ${new Date().toISOString()}
`;
      
      const memory = await manager.importElement(yaml);
      expect(memory.metadata.name).toBe('Imported Memory');
      expect(memory.metadata.description).toBe('From YAML');
      
      const entries = await memory.search({});
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Imported content');
    });
    
    it('should import memory from JSON', async () => {
      const json = JSON.stringify({
        metadata: {
          name: 'JSON Memory'
        },
        entries: [{
          id: 'json-1',
          content: 'From JSON',
          timestamp: new Date().toISOString()
        }]
      });
      
      const memory = await manager.importElement(json, 'json');
      expect(memory.metadata.name).toBe('JSON Memory');
      
      const entries = await memory.search({});
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('From JSON');
    });
    
    it('should reject import without name', async () => {
      const yaml = 'metadata:\n  description: No name';
      await expect(manager.importElement(yaml)).rejects.toThrow('must have metadata with name');
    });
  });
  
  describe('validate', () => {
    it('should validate memory element', async () => {
      const validMemory = new Memory({ name: 'Valid', retentionDays: 30 });
      const result = await manager.validate(validMemory);
      expect(result.valid).toBe(true);
      
      const invalidMemory = new Memory({ retentionDays: 500 });
      const invalidResult = await manager.validate(invalidMemory);
      expect(invalidResult.valid).toBe(false);
    });
  });
  
  describe('validatePath', () => {
    it('should validate safe paths', async () => {
      expect(await manager.validatePath('memory.yaml')).toBe(true);
      expect(await manager.validatePath('subfolder/memory.yaml')).toBe(true); // Subfolders are allowed
      expect(await manager.validatePath('memory.md')).toBe(true);
    });
    
    it('should reject dangerous paths', async () => {
      expect(await manager.validatePath('../../../etc/passwd')).toBe(false);
      expect(await manager.validatePath('/absolute/path')).toBe(false);
      expect(await manager.validatePath('memory.txt')).toBe(false); // Wrong extension
    });
  });
  
  describe('getElementType and getFileExtension', () => {
    it('should return correct element type', () => {
      expect(manager.getElementType()).toBe(ElementType.MEMORY);
    });
    
    it('should return correct file extension', () => {
      expect(manager.getFileExtension()).toBe('.yaml');
    });
  });
  
  describe('Security Tests', () => {
    it('should prevent YAML bombs', async () => {
      const yamlBomb = `
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
`;
      await expect(manager.importElement(yamlBomb)).rejects.toThrow();
    });
    
    it('should handle malformed YAML safely', async () => {
      const badYaml = `
metadata:
  name: Test
  invalid: *undefined_anchor
`;
      await expect(manager.importElement(badYaml)).rejects.toThrow();
    });
    
    it('should sanitize imported data', async () => {
      const yaml = `
metadata:
  name: <script>alert('xss')</script>Test Memory
data:
  entries:
    - id: test
      content: <img src=x onerror=alert('xss')>Some content
      timestamp: ${new Date().toISOString()}
`;
      
      const memory = await manager.importElement(yaml);
      expect(memory.metadata.name).not.toContain('<script>');
      
      const entries = await memory.search({});
      expect(entries[0].content).not.toContain('<img');
    });
  });
});
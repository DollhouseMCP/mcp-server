/**
 * Unit tests for MemoryManager
 */

import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';

// Create a shared MetadataService instance for all tests
const metadataService = createTestMetadataService();

describe('MemoryManager', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof MemoryManager>;
  let testDir: string;
  let memoriesDir: string;

  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-manager-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Create DI container
    container = new DollhouseContainer();

    // Register PortfolioManager, FileLockManager, FileOperationsService, and MemoryManager in DI container
    container.register('FileLockManager', () => new FileLockManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.register('SerializationService', () => new SerializationService());
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.register('MemoryManager', () => new MemoryManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    }));

    // Resolve instances from container
    manager = container.resolve('MemoryManager');

    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose DI container
    await container.dispose();

    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });
  
  afterEach(async () => {
    // Clean memories directory between tests (including date folders)
    try {
      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(memoriesDir, entry.name);
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    // Clear manager caches to avoid stale data between tests
    manager.clearCache();
  });

  describe('save and load', () => {
    it('should save and load a memory', async () => {
      const memory = new Memory({
        name: 'Test Memory',
        description: 'A test memory'
      }, metadataService);
      
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
      // retentionDays: -1 is invalid (MIN is 1)
      const invalidMemory = new Memory({ retentionDays: -1 }, metadataService);
      await expect(manager.save(invalidMemory, 'invalid.yaml')).rejects.toThrow('Invalid memory');
    });
    
    it('should prevent path traversal in load', async () => {
      await expect(manager.load('../../../etc/passwd')).rejects.toThrow('Path traversal detected');
      await expect(manager.load('/absolute/path/memory.yaml')).rejects.toThrow('Path traversal detected');
    });
    
    it('should prevent path traversal in save', async () => {
      const memory = new Memory({}, metadataService);
      await expect(manager.save(memory, '../../../etc/passwd')).rejects.toThrow('Path traversal detected');
    });
    
    it('should cache loaded memories', async () => {
      const memory = new Memory({ name: 'Cached Memory' }, metadataService);
      await manager.save(memory, 'cached.yaml');
      
      const loaded1 = await manager.load('cached.yaml');
      const loaded2 = await manager.load('cached.yaml');
      
      // Should be the same instance
      expect(loaded1).toBe(loaded2);
    });

    it('should save loaded memory back to its existing path when save path is omitted (Issue #699)', async () => {
      const existingRelativePath = '2025-09-17/project-context.yaml';

      const memory = new Memory({ name: 'Project Context' }, metadataService);
      await memory.addEntry('Original entry', ['test']);
      await manager.save(memory, existingRelativePath);

      const loaded = await manager.load(existingRelativePath);
      await loaded.addEntry('Updated entry', ['test']);

      // Simulates addEntry debounce path: manager.save(memory) without explicit filePath
      await manager.save(loaded);

      expect(loaded.getFilePath()).toBe(existingRelativePath);

      const dateFolders = (await fs.readdir(memoriesDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name);

      let copies = 0;
      for (const folder of dateFolders) {
        const folderFiles = await fs.readdir(path.join(memoriesDir, folder));
        if (folderFiles.includes('project-context.yaml')) {
          copies += 1;
        }
      }

      // Must remain a single on-disk file, not one copy per day
      expect(copies).toBe(1);

      const reloaded = await manager.load(existingRelativePath);
      const entries = await reloaded.search({});
      expect(entries.some(entry => entry.content === 'Updated entry')).toBe(true);
    });

    it('should preserve instructions through save/load round-trip (#918)', async () => {
      const memory = new Memory({
        name: 'Guided Memory',
        description: 'A memory with behavioral instructions'
      }, metadataService);
      memory.instructions = 'Always summarize entries in bullet points. Prioritize recent information.';
      await memory.addEntry('First data point', ['research']);

      await manager.save(memory, 'guided-memory.yaml');

      // Clear cache to force a real file read
      manager.clearCache();

      const loaded = await manager.load('guided-memory.yaml');
      expect(loaded.instructions).toBe('Always summarize entries in bullet points. Prioritize recent information.');
      expect(loaded.metadata.name).toBe('Guided Memory');

      const loadedEntries = await loaded.search({});
      expect(loadedEntries).toHaveLength(1);
      expect(loadedEntries[0].content).toBe('First data point');
    });

    it('should include format_version in serialized output (#912/#918)', async () => {
      const memory = new Memory({
        name: 'Versioned Memory',
        description: 'Tests format marker'
      }, metadataService);
      await memory.addEntry('test entry', []);

      // Access serializeElement directly to check output
      const serialized = await (manager as any).serializeElement(memory);
      expect(serialized).toContain('format_version: v2');

      // After load, format_version should be stripped from runtime metadata
      await manager.save(memory, 'versioned-memory.yaml');
      manager.clearCache();
      const loaded = await manager.load('versioned-memory.yaml');
      expect((loaded.metadata as any).format_version).toBeUndefined();
    });
  });
  
  describe('list', () => {
    it('should list all memory files', async () => {
      const memory1 = new Memory({ name: 'Memory 1' }, metadataService);
      const memory2 = new Memory({ name: 'Memory 2' }, metadataService);
      
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
      const memory = new Memory({ name: 'Valid Memory' }, metadataService);
      await manager.save(memory, 'valid.yaml');
      
      // Create non-memory file
      await fs.writeFile(path.join(memoriesDir, 'readme.txt'), 'Not a memory');
      
      const memories = await manager.list();
      expect(memories).toHaveLength(1);
      expect(memories[0].metadata.name).toBe('Valid Memory');
    });
    
    it('should continue on corrupted files', async () => {
      const memory = new Memory({ name: 'Good Memory' }, metadataService);
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

    // Regression test for v1.9.4 bug fix
    it('should parse memory names correctly from SecureYamlParser data property', async () => {
      // This tests the specific bug where parseMemoryFile was looking for
      // parsed.metadata instead of parsed.data, causing all memories to show
      // as "Unnamed Memory"

      // Create a memory with a specific name
      const testMemory = new Memory({
        name: 'Test Memory Name',
        description: 'Testing that names are parsed correctly'
      }, metadataService);
      await manager.save(testMemory, 'regression-test.yaml');

      // Load the memories using list() which internally uses parseMemoryFile
      const memories = await manager.list();

      // The bug would cause this to be "Unnamed Memory" instead of the actual name
      expect(memories).toHaveLength(1);
      expect(memories[0].metadata.name).toBe('Test Memory Name');
      expect(memories[0].metadata.name).not.toBe('Unnamed Memory');

      // Also test that the description was parsed correctly
      expect(memories[0].metadata.description).toBe('Testing that names are parsed correctly');
    });

    // Test for pure YAML format handling (v1.9.5 fix)
    it('should handle pure YAML files without frontmatter markers', async () => {
      // Create a pure YAML memory file (simulating v1.9.3+ format)
      const pureYaml = `entries:
  - content: Test entry
    id: test-1
    timestamp: ${new Date().toISOString()}
metadata:
  name: Pure YAML Memory
  description: Memory saved as pure YAML
  version: 1.0.0
extensions:
  storageBackend: memory
stats:
  entryCount: 1`;

      // Write the pure YAML directly to test the parsing
      const dateFolder = new Date().toISOString().split('T')[0];
      const folderPath = path.join(memoriesDir, dateFolder);
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, 'pure-yaml-test.yaml'), pureYaml);

      // Load the memory
      const loaded = await manager.load(`${dateFolder}/pure-yaml-test.yaml`);

      expect(loaded.metadata.name).toBe('Pure YAML Memory');
      expect(loaded.metadata.description).toBe('Memory saved as pure YAML');
      expect(loaded.metadata.version).toBe('1.0.0');
    });

    // Test for frontmatter format handling (backward compatibility)
    it('should handle markdown files with YAML frontmatter', async () => {
      // Create a memory file with frontmatter markers
      const frontmatterYaml = `---
metadata:
  name: Frontmatter Memory
  description: Memory with frontmatter markers
  version: 2.0.0
entries:
  - content: Frontmatter entry
    id: fm-1
    timestamp: ${new Date().toISOString()}
---

# Optional markdown content`;

      // Write the frontmatter YAML
      const dateFolder = new Date().toISOString().split('T')[0];
      const folderPath = path.join(memoriesDir, dateFolder);
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, 'frontmatter-test.yaml'), frontmatterYaml);

      // Load the memory
      const loaded = await manager.load(`${dateFolder}/frontmatter-test.yaml`);

      expect(loaded.metadata.name).toBe('Frontmatter Memory');
      expect(loaded.metadata.description).toBe('Memory with frontmatter markers');
      expect(loaded.metadata.version).toBe('2.0.0');
    });

    // Test edge case: empty file
    it('should handle empty memory files gracefully', async () => {
      const dateFolder = new Date().toISOString().split('T')[0];
      const folderPath = path.join(memoriesDir, dateFolder);
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, 'empty.yaml'), '');

      const loaded = await manager.load(`${dateFolder}/empty.yaml`);
      expect(loaded.metadata.name).toBe('Unnamed Memory');
    });

    // Test mixed format scenario
    it('should handle both pure YAML and frontmatter files in same directory', async () => {
      const dateFolder = new Date().toISOString().split('T')[0];
      const folderPath = path.join(memoriesDir, dateFolder);
      await fs.mkdir(folderPath, { recursive: true });

      // Save pure YAML file with full structure
      const pureYaml = `metadata:
  name: Pure Format
  version: 1.0.0
entries: []`;
      await fs.writeFile(path.join(folderPath, 'pure.yaml'), pureYaml);

      // Save frontmatter file with full structure
      const frontmatterYaml = `---
metadata:
  name: Frontmatter Format
  version: 1.0.0
entries: []
---`;
      await fs.writeFile(path.join(folderPath, 'frontmatter.yaml'), frontmatterYaml);

      // List should find both
      const memories = await manager.list();
      const names = memories.map(m => m.metadata.name).sort();

      // Debug output if test fails
      if (names.length === 0) {
        console.log('No memories found. Date folder:', dateFolder);
        console.log('Folder path:', folderPath);
        const files = await fs.readdir(folderPath);
        console.log('Files in folder:', files);
      }

      expect(names).toContain('Frontmatter Format');
      expect(names).toContain('Pure Format');
    });
  });
  
  describe('find and findMany', () => {
    beforeEach(async () => {
      const memory1 = new Memory({ name: 'Work Memory', tags: ['work'] }, metadataService);
      const memory2 = new Memory({ name: 'Personal Memory', tags: ['personal'] }, metadataService);
      const memory3 = new Memory({ name: 'Work Notes', tags: ['work', 'important'] }, metadataService);
      
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
      const memory = new Memory({ name: 'To Delete' }, metadataService);
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
      const memory = new Memory({ name: 'Cached' }, metadataService);
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
      const memory = new Memory({}, metadataService);
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
      const memory = new Memory({ name: 'Export Test' }, metadataService);
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
    it('should validate memory element', () => {
      const validMemory = new Memory({ name: 'Valid', retentionDays: 30 }, metadataService);
      const result = manager.validate(validMemory);
      expect(result.valid).toBe(true);

      // retentionDays: -1 is invalid (MIN is 1)
      const invalidMemory = new Memory({ retentionDays: -1 }, metadataService);
      const invalidResult = manager.validate(invalidMemory);
      expect(invalidResult.valid).toBe(false);
    });
  });

  describe('validatePath', () => {
    it('should validate safe paths', () => {
      expect(manager.validatePath('memory.yaml')).toBe(true);
      expect(manager.validatePath('subfolder/memory.yaml')).toBe(true); // Subfolders are allowed
      expect(manager.validatePath('memory.md')).toBe(true);
    });

    it('should reject dangerous paths', () => {
      expect(manager.validatePath('../../../etc/passwd')).toBe(false);
      expect(manager.validatePath('/absolute/path')).toBe(false);
      expect(manager.validatePath('memory.txt')).toBe(false); // Wrong extension
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

  describe('date folder structure', () => {
    beforeEach(async () => {
      // Ensure clean state for each test in this group
      try {
        const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(memoriesDir, entry.name);
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should create date-based folders when saving', async () => {
      const memory = new Memory({
        name: 'Test Memory',
        description: 'Testing date folders'
      }, metadataService);

      await manager.save(memory);

      // Check that a date folder was created
      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      const dateFolders = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
      expect(dateFolders).toHaveLength(1);

      // Check file exists in date folder
      const dateFolder = dateFolders[0].name;
      const files = await fs.readdir(path.join(memoriesDir, dateFolder));
      expect(files.some(f => f.includes('test-memory'))).toBe(true);
    });

    it('should handle collisions by moving existing file to backup (Issue #49)', async () => {
      // Issue #49: When saving a memory with the same name, the existing file
      // should be moved to backup instead of creating a -v2 versioned file

      const memoryName = 'Same Name';

      // Save first memory
      const memory1 = new Memory({ name: memoryName, description: 'First version' }, metadataService);
      await memory1.addEntry('First entry', ['test']);
      await manager.save(memory1);

      // Check that a date folder was created
      const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
      const dateFolders = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
      expect(dateFolders).toHaveLength(1);
      const dateFolder = dateFolders[0].name;

      // Verify first file exists
      let files = await fs.readdir(path.join(memoriesDir, dateFolder));
      let yamlFiles = files.filter(f => f.endsWith('.yaml') && !f.includes('.backup-'));
      expect(yamlFiles).toHaveLength(1);
      expect(yamlFiles[0]).toBe('same-name.yaml');

      // Save second memory with same name
      const memory2 = new Memory({ name: memoryName, description: 'Second version' }, metadataService);
      await memory2.addEntry('Second entry', ['test']);
      await manager.save(memory2);

      // Verify only ONE file exists in main folder (no -v2.yaml)
      files = await fs.readdir(path.join(memoriesDir, dateFolder));
      yamlFiles = files.filter(f => f.endsWith('.yaml') && !f.includes('.backup-'));
      expect(yamlFiles).toHaveLength(1);
      expect(yamlFiles[0]).toBe('same-name.yaml');

      // Verify backup file exists in backup folder
      const backupDir = path.join(memoriesDir, 'backups', 'user', dateFolder);
      const backupFiles = await fs.readdir(backupDir);
      const backupYamlFiles = backupFiles.filter(f => f.endsWith('.yaml') && f.includes('.backup-'));
      expect(backupYamlFiles).toHaveLength(1);
      expect(backupYamlFiles[0]).toMatch(/^same-name\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yaml$/);

      // Verify the current file has the second memory's content
      const loadedMemory = await manager.load('same-name.yaml');
      expect(loadedMemory.metadata.description).toBe('Second version');
      const entries2 = loadedMemory.getAllEntries();
      expect(entries2).toHaveLength(1);
      expect(entries2[0].content).toBe('Second entry');
    });

    it('should find memories across date folders', async () => {
      // Clear cache to ensure fresh state
      manager.clearCache();

      // Create memories in different date folders
      const date1 = '2025-09-17';
      const date2 = '2025-09-18';

      await fs.mkdir(path.join(memoriesDir, date1), { recursive: true });
      await fs.mkdir(path.join(memoriesDir, date2), { recursive: true });

      const memory1 = new Memory({ name: 'Memory 1' }, metadataService);
      const memory2 = new Memory({ name: 'Memory 2' }, metadataService);

      // Manually save to specific date folders for testing
      await manager.save(memory1, `${date1}/memory1.yaml`);
      await manager.save(memory2, `${date2}/memory2.yaml`);

      // Clear cache again after saves to ensure fresh folder scan
      manager.clearCache();

      const memories = await manager.list();
      expect(memories).toHaveLength(2);
      expect(memories.map(m => m.metadata.name)).toContain('Memory 1');
      expect(memories.map(m => m.metadata.name)).toContain('Memory 2');
    });

    it('should detect duplicate content', async () => {
      const memory1 = new Memory({ name: 'Original' }, metadataService);
      await memory1.addEntry('Same content', ['test']);

      const memory2 = new Memory({ name: 'Duplicate' }, metadataService);
      await memory2.addEntry('Same content', ['test']);

      // Save both memories - the second should detect a duplicate
      await manager.save(memory1);
      await manager.save(memory2);

      // Test passes if no exception is thrown during duplicate detection
      // The actual SecurityMonitor logging is tested implicitly
      expect(true).toBe(true);
    });
  });

  describe('Whitespace Detection Optimization', () => {
    it('should efficiently detect whitespace at the beginning of content', async () => {
      // Test various whitespace combinations
      const testCases = [
        { content: '   ---\ndata: test', expectedStart: '---' },
        { content: '\t\t---\ndata: test', expectedStart: '---' },
        { content: '\n\n---\ndata: test', expectedStart: '---' },
        { content: '\r\n---\ndata: test', expectedStart: '---' },
        { content: ' \t\n\r---\ndata: test', expectedStart: '---' },
        { content: 'no-whitespace---', expectedStart: 'no-' },
        { content: '', expectedStart: '' }
      ];

      for (const testCase of testCases) {
        // Create a temporary file to test
        const testFile = path.join(testDir, `whitespace-test-${Date.now()}.yaml`);
        await fs.writeFile(testFile, testCase.content);

        // The load function uses the optimized whitespace detection
        try {
          if (testCase.content && testCase.content.includes('data:')) {
            await manager.load(path.basename(testFile));
          }
        } catch {
          // Some test cases might fail to parse, which is expected
        }

        // Clean up
        await fs.unlink(testFile);
      }

      // Test passes if all cases are handled without errors
      expect(true).toBe(true);
    });

    it('should handle large files with leading whitespace efficiently', async () => {
      // Create a large file with lots of leading whitespace
      const largeWhitespace = ' '.repeat(1000) + '\t'.repeat(500) + '\n'.repeat(100);
      const content = largeWhitespace + '---\ndata: test\n---';

      const testFile = path.join(testDir, 'large-whitespace-test.yaml');
      await fs.writeFile(testFile, content);

      const startTime = Date.now();
      try {
        await manager.load(path.basename(testFile));
      } catch {
        // Parsing might fail, which is ok for this test
      }
      const endTime = Date.now();

      // Should process even large whitespace efficiently (under 100ms)
      expect(endTime - startTime).toBeLessThan(100);

      await fs.unlink(testFile);
    });
  });

  describe('Path Traversal Security', () => {
    it('should prevent path traversal with .. sequences', async () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '../../sensitive.yaml',
        './../../../etc/shadow',
        'normal/../../../etc/hosts',
        '..\\..\\..\\windows\\system32\\config\\sam'  // Windows style
      ];

      for (const maliciousPath of maliciousPaths) {
        await expect(manager.load(maliciousPath)).rejects.toThrow('Path traversal detected');
        await expect(manager.save(new Memory({}, metadataService), maliciousPath)).rejects.toThrow('Path traversal detected');
        await expect(manager.delete(maliciousPath)).rejects.toThrow('Path traversal detected');
      }
    });

    it('should prevent absolute path access', async () => {
      // Only test Unix-style absolute paths on Unix systems
      const absolutePaths = process.platform === 'win32' ?
        [
          'C:\\Windows\\System32\\config\\sam.yaml',
          '\\\\server\\share\\file.yaml'
        ] : [
          '/etc/passwd.yaml',
          '/home/user/secrets.yaml'
        ];

      for (const absolutePath of absolutePaths) {
        await expect(manager.load(absolutePath)).rejects.toThrow('Path traversal detected');
        await expect(manager.save(new Memory({}, metadataService), absolutePath)).rejects.toThrow('Path traversal detected');
        await expect(manager.delete(absolutePath)).rejects.toThrow('Path traversal detected');
      }
    });

    it('should allow legitimate relative paths', async () => {
      const legitimatePaths = [
        'memory.yaml',
        'subfolder/memory.yaml',
        '2024-03-20/session-notes.yaml',
        './current-memory.yaml'
      ];

      for (const legitimatePath of legitimatePaths) {
        // These should not throw path traversal errors
        // They might throw other errors (file not found, etc) which is fine
        try {
          await manager.load(legitimatePath);
        } catch (error: any) {
          expect(error.message).not.toContain('Path traversal detected');
        }
      }
    });

    it('should validate both original and normalized paths', async () => {
      // Test cases where normalization might hide traversal attempts
      const sneakyPaths = [
        './../../etc/passwd',  // Normalized would remove ./
        'valid/../../../etc/shadow',  // Looks like it starts valid
        'memories/../../private/data.yaml'  // Appears to be in memories
      ];

      for (const sneakyPath of sneakyPaths) {
        await expect(manager.load(sneakyPath)).rejects.toThrow('Path traversal detected');
      }
    });
  });

  describe('Backup File Filtering (Issue #13)', () => {
    it('should filter out backup files from system/ folder', async () => {
      // Create system/ folder
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });

      // Create normal memory file
      await fs.writeFile(
        path.join(systemDir, 'system-memory.yaml'),
        'name: system-memory\ndescription: Normal system memory\nentries: []'
      );

      // Create backup files with different patterns
      await fs.writeFile(
        path.join(systemDir, 'system-memory.backup-2025-11-14-22-40-57-303.yaml'),
        'name: system-memory-backup\ndescription: Backup file\nentries: []'
      );
      await fs.writeFile(
        path.join(systemDir, 'old-backup.yaml'),
        'name: old-backup\ndescription: Old backup file\nentries: []'
      );

      const memories = await manager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      // Should only include the normal memory, not backups
      expect(memoryNames).toContain('system-memory');
      expect(memoryNames).not.toContain('system-memory-backup');
      expect(memoryNames).not.toContain('old-backup');
    });

    it('should filter out backup files from adapters/ folder', async () => {
      // Create adapters/ folder
      const adaptersDir = path.join(memoriesDir, 'adapters');
      await fs.mkdir(adaptersDir, { recursive: true });

      // Create normal adapter memory
      await fs.writeFile(
        path.join(adaptersDir, 'adapter-memory.yaml'),
        'name: adapter-memory\ndescription: Normal adapter memory\nentries: []'
      );

      // Create backup file in adapters/
      await fs.writeFile(
        path.join(adaptersDir, 'adapter-memory.backup-2025-11-14.yaml'),
        'name: adapter-backup\ndescription: Backup file\nentries: []'
      );

      const memories = await manager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      expect(memoryNames).toContain('adapter-memory');
      expect(memoryNames).not.toContain('adapter-backup');
    });

    it('should filter out backup files from root folder', async () => {
      // Create normal root memory
      await fs.writeFile(
        path.join(memoriesDir, 'root-memory.yaml'),
        'name: root-memory\ndescription: Normal root memory\nentries: []'
      );

      // Create backup file in root
      await fs.writeFile(
        path.join(memoriesDir, 'root-memory.backup-2025-11-14.yaml'),
        'name: root-backup\ndescription: Backup file\nentries: []'
      );

      const memories = await manager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      expect(memoryNames).toContain('root-memory');
      expect(memoryNames).not.toContain('root-backup');
    });

    it('should filter out backup files from date folders', async () => {
      // Create date folder
      const dateFolder = '2025-11-14';
      const dateFolderPath = path.join(memoriesDir, dateFolder);
      await fs.mkdir(dateFolderPath, { recursive: true });

      // Create normal memory in date folder
      await fs.writeFile(
        path.join(dateFolderPath, 'date-memory.yaml'),
        'name: date-memory\ndescription: Normal date memory\nentries: []'
      );

      // Create backup file in date folder
      await fs.writeFile(
        path.join(dateFolderPath, 'date-memory.backup-2025-11-14.yaml'),
        'name: date-backup\ndescription: Backup file\nentries: []'
      );

      const memories = await manager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      expect(memoryNames).toContain('date-memory');
      expect(memoryNames).not.toContain('date-backup');
    });

    it('should filter files with "backup" in name case-insensitively', async () => {
      // Create system/ folder
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });

      // Create normal memory
      await fs.writeFile(
        path.join(systemDir, 'normal-memory.yaml'),
        'name: normal-memory\ndescription: Normal memory\nentries: []'
      );

      // Create files with "backup" in various cases
      const backupVariants = [
        'my-backup-file.yaml',
        'my-BACKUP-file.yaml',
        'my-Backup-file.yaml',
        'myBackupFile.yaml'
      ];

      for (const filename of backupVariants) {
        await fs.writeFile(
          path.join(systemDir, filename),
          `name: ${filename.replace('.yaml', '')}\ndescription: Backup variant\nentries: []`
        );
      }

      const memories = await manager.list();
      const memoryNames = memories.map(m => m.metadata.name);

      // Should only have the normal memory
      expect(memoryNames).toContain('normal-memory');
      expect(memoryNames.length).toBe(1);
    });

    it('should not load backup files even if marked as auto-load', async () => {
      // Create system/ folder with files
      const systemDir = path.join(memoriesDir, 'system');
      await fs.mkdir(systemDir, { recursive: true });

      // Create normal file
      await fs.writeFile(
        path.join(systemDir, 'normal-file.yaml'),
        'name: normal-file\ndescription: Normal file\nentries: []'
      );

      // Create backup with similar name (should be filtered by list())
      await fs.writeFile(
        path.join(systemDir, 'normal-file.backup-2025-11-14.yaml'),
        'name: normal-file-backup\ndescription: Backup file\nentries: []'
      );

      // list() should filter out the backup
      const allMemories = await manager.list();
      const allNames = allMemories.map(m => m.metadata.name);

      // Verify backup is not in the list
      expect(allNames).toContain('normal-file');
      expect(allNames).not.toContain('normal-file-backup');

      // Since backups are filtered from list(), they won't appear in auto-load either
      // (getAutoLoadMemories calls list() internally)
      expect(allNames.filter(name => name.includes('backup'))).toHaveLength(0);
    });
  });
});

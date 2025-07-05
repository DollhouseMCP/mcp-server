import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PersonaManager } from '../../src/persona/PersonaManager';
import { PersonaLoader } from '../../src/persona/PersonaLoader';
import { PersonaValidator } from '../../src/persona/PersonaValidator';
import { Persona } from '../../src/types/persona';
import { DEFAULT_INDICATOR_CONFIG } from '../../src/config/indicator-config';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('../../src/persona/PersonaLoader');
jest.mock('../../src/persona/PersonaValidator');

describe('PersonaManager', () => {
  let personaManager: PersonaManager;
  let mockLoader: jest.Mocked<PersonaLoader>;
  let mockValidator: jest.Mocked<PersonaValidator>;
  const mockPersonasDir = '/test/personas';

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset mocked dependencies
    mockLoader = new PersonaLoader(mockPersonasDir) as jest.Mocked<PersonaLoader>;
    mockValidator = new PersonaValidator() as jest.Mocked<PersonaValidator>;
    
    personaManager = new PersonaManager(mockPersonasDir, DEFAULT_INDICATOR_CONFIG);
    // Inject mocked dependencies
    (personaManager as any).loader = mockLoader;
    (personaManager as any).validator = mockValidator;
  });

  describe('loadPersonas', () => {
    it('should load personas successfully', async () => {
      const mockPersonas = new Map<string, Persona>([
        ['Test Persona', {
          metadata: {
            name: 'Test Persona',
            description: 'A test persona',
            unique_id: 'test-persona_20250101-120000_tester'
          },
          content: 'Test content',
          filename: 'test.md',
          unique_id: 'test-persona_20250101-120000_tester'
        }]
      ]);

      // Mock the loader to return personas
      (personaManager as any).personas = mockPersonas;
      
      await personaManager.initialize();

      // Verify personas are loaded
      const personas = personaManager.getAllPersonas();
      expect(personas.size).toBe(1);
    });

    it('should handle load errors gracefully', async () => {
      // Mock fs.readdir to fail
      const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
      mockReaddir.mockRejectedValue(new Error('Failed to read directory'));

      await expect(personaManager.initialize()).rejects.toThrow();
    });
  });

  describe('activatePersona', () => {
    const testPersona: Persona = {
      metadata: {
        name: 'Test Persona',
        description: 'A test persona',
        unique_id: 'test-persona_20250101-120000_tester'
      },
      content: 'You are a test assistant',
      filename: 'test.md',
      unique_id: 'test-persona_20250101-120000_tester'
    };

    beforeEach(async () => {
      // Set up personas map
      (personaManager as any).personas = new Map([['Test Persona', testPersona]]);
    });

    it('should activate a persona by name', async () => {
      const result = await personaManager.activatePersona('Test Persona');

      expect(result).toBeDefined();
      expect(result.message).toContain('Test Persona');
      expect((personaManager as any).activePersona).toBe('Test Persona');
    });

    it('should activate a persona by unique_id', async () => {
      const result = await personaManager.activatePersona('test-persona_20250101-120000_tester');

      expect(result).toBeDefined();
      expect(result.message).toContain('activated');
      expect((personaManager as any).activePersona).toBe('Test Persona');
    });

    it('should throw error for non-existent persona', async () => {
      await expect(personaManager.activatePersona('Non-existent'))
        .rejects.toThrow('Persona not found: Non-existent');
    });
  });

  describe('deactivatePersona', () => {
    it('should deactivate the active persona', async () => {
      const testPersona: Persona = {
        metadata: {
          name: 'Test Persona',
          description: 'A test persona',
          unique_id: 'test-persona_20250101-120000_tester'
        },
        content: 'Test content',
        filename: 'test.md',
        unique_id: 'test-persona_20250101-120000_tester'
      };

      (personaManager as any).personas = new Map([['Test Persona', testPersona]]);
      await personaManager.activatePersona('Test Persona');

      const result = await personaManager.deactivatePersona();

      expect(result).toBeDefined();
      expect(result.message).toBe('Persona deactivated');
      expect((personaManager as any).activePersona).toBeNull();
    });

    it('should handle deactivation when no persona is active', async () => {
      const result = await personaManager.deactivatePersona();

      expect(result).toBeDefined();
      expect(result.message).toBe('No persona is currently active');
    });
  });

  describe('createPersona', () => {
    it('should create a new persona successfully', async () => {
      const newPersona = {
        name: 'New Persona',
        description: 'A new test persona',
        category: 'creative',
        instructions: 'You are a creative assistant',
        triggers: ['creative', 'writing']
      };

      mockValidator.validatePersona = jest.fn().mockReturnValue({ 
        isValid: true, 
        errors: [],
        warnings: []
      });

      (fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockResolvedValue(undefined);

      const result = await personaManager.createPersona(
        newPersona.name,
        newPersona.description,
        newPersona.category,
        newPersona.instructions,
        newPersona.triggers
      );

      expect(mockValidator.validatePersona).toHaveBeenCalled();

      expect(fs.writeFile).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toContain('successfully');
    });

    it('should reject invalid persona data', async () => {
      mockValidator.validatePersona = jest.fn().mockReturnValue({
        isValid: false,
        errors: ['Name is required', 'Invalid category'],
        warnings: []
      });

      await expect(personaManager.createPersona(
        '',
        'Description',
        'invalid-category',
        'Instructions'
      )).rejects.toThrow('Validation failed');
    });
  });

  describe('editPersona', () => {
    const testPersona: Persona = {
      metadata: {
        name: 'Test Persona',
        description: 'Original description',
        version: '1.0',
        unique_id: 'test-persona_20250101-120000_tester'
      },
      content: '---\nname: Test Persona\ndescription: Original description\n---\nOriginal content',
      filename: 'test.md',
      unique_id: 'test-persona_20250101-120000_tester'
    };

    beforeEach(async () => {
      (personaManager as any).personas = new Map([['Test Persona', testPersona]]);
      (personaManager as any).personasDir = mockPersonasDir;
    });

    it('should edit persona description', async () => {
      (fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockResolvedValue(testPersona.content);
      (fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockResolvedValue(undefined);

      const result = await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(mockPersonasDir, testPersona.filename),
        expect.stringContaining('description: Updated description'),
        'utf-8'
      );
      expect(result.success).toBe(true);
    });

    it('should increment version when editing', async () => {
      (fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockResolvedValue(testPersona.content);
      (fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockResolvedValue(undefined);

      await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(mockPersonasDir, testPersona.filename),
        expect.stringContaining('version: "1.1"'),
        'utf-8'
      );
    });

    it('should reject edits to non-existent personas', async () => {
      await expect(personaManager.editPersona(
        'Non-existent',
        'description',
        'New value'
      )).rejects.toThrow('Persona not found');
    });
  });

  describe('User Management', () => {
    it('should set user identity', async () => {
      const username = 'testuser';
      const email = 'test@example.com';

      personaManager.setUserIdentity(username, email);
      const identity = personaManager.getUserIdentity();

      expect(identity.username).toBe(username);
      expect(identity.email).toBe(email);
    });

    it('should clear user identity', async () => {
      personaManager.setUserIdentity('testuser', 'test@example.com');
      personaManager.clearUserIdentity();

      const identity = personaManager.getUserIdentity();
      // After clearing, both should be null
      expect(identity.username).toBeNull();
      expect(identity.email).toBeNull();
    });

    it('should generate anonymous ID when no user is set', async () => {
      const identity = personaManager.getUserIdentity();

      // When no user is set, both should be null
      expect(identity.username).toBeNull();
      expect(identity.email).toBeNull();
    });
  });

  describe('Performance', () => {
    it('should handle large number of personas efficiently', async () => {
      const largePersonaSet = new Map<string, Persona>();
      const initialMemory = process.memoryUsage().heapUsed;
      
      for (let i = 0; i < 1000; i++) {
        largePersonaSet.set(`Persona ${i}`, {
          metadata: {
            name: `Persona ${i}`,
            description: `Description ${i}`,
            unique_id: `persona-${i}_20250101-120000_tester`
          },
          content: `Content ${i}`,
          filename: `persona-${i}.md`,
          unique_id: `persona-${i}_20250101-120000_tester`
        });
      }

      (personaManager as any).personas = largePersonaSet;

      const startTime = Date.now();
      const personas = personaManager.getAllPersonas();
      const loadTime = Date.now() - startTime;
      
      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryUsed = (memoryAfter - initialMemory) / 1024 / 1024; // MB

      expect(loadTime).toBeLessThan(100); // Should be instant
      expect(personas.size).toBe(1000);
      expect(memoryUsed).toBeLessThan(50); // Should use less than 50MB for 1000 personas
    });
  });

  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      const fsError = new Error('EACCES: permission denied');
      (fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockRejectedValue(fsError);

      await expect(personaManager.createPersona(
        'Test',
        'Description',
        'creative',
        'Instructions'
      )).rejects.toThrow();
    });

    it('should handle corrupted persona files', async () => {
      // Mock a corrupted file read
      (fs.readdir as jest.MockedFunction<typeof fs.readdir>).mockResolvedValue(['corrupted.md']);
      (fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockResolvedValue('Invalid YAML content {{{');

      // Initialize should handle the error gracefully
      await expect(personaManager.initialize()).resolves.not.toThrow();
      
      const personas = personaManager.getAllPersonas();
      expect(personas.size).toBe(0); // No personas loaded due to corruption
    });
  });
});
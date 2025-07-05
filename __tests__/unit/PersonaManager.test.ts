import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PersonaManager } from '../../src/persona/PersonaManager';
import { PersonaLoader } from '../../src/persona/PersonaLoader';
import { PersonaValidator } from '../../src/persona/PersonaValidator';
import { Persona } from '../../src/types/persona';

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
    
    personaManager = new PersonaManager(mockPersonasDir);
    // Inject mocked dependencies
    (personaManager as any).loader = mockLoader;
    (personaManager as any).validator = mockValidator;
  });

  describe('loadPersonas', () => {
    it('should load personas successfully', async () => {
      const mockPersonas: Persona[] = [
        {
          name: 'Test Persona',
          content: 'Test content',
          path: '/test/personas/test.md',
          metadata: {
            name: 'Test Persona',
            description: 'A test persona',
            unique_id: 'test-persona_20250101-120000_tester'
          }
        }
      ];

      mockLoader.loadAllPersonas.mockResolvedValue(mockPersonas);

      const result = await personaManager.loadPersonas();

      expect(mockLoader.loadAllPersonas).toHaveBeenCalled();
      expect(result).toEqual(mockPersonas);
    });

    it('should handle load errors gracefully', async () => {
      const error = new Error('Failed to load personas');
      mockLoader.loadAllPersonas.mockRejectedValue(error);

      await expect(personaManager.loadPersonas()).rejects.toThrow('Failed to load personas');
    });
  });

  describe('activatePersona', () => {
    const testPersona: Persona = {
      name: 'Test Persona',
      content: 'You are a test assistant',
      path: '/test/personas/test.md',
      metadata: {
        name: 'Test Persona',
        description: 'A test persona',
        unique_id: 'test-persona_20250101-120000_tester'
      }
    };

    beforeEach(async () => {
      mockLoader.loadAllPersonas.mockResolvedValue([testPersona]);
      await personaManager.loadPersonas();
    });

    it('should activate a persona by name', async () => {
      const result = await personaManager.activatePersona('Test Persona');

      expect(result.active).toBe(true);
      expect(result.message).toContain('Test Persona');
      expect(personaManager.getActivePersona()).toEqual(testPersona);
    });

    it('should activate a persona by unique_id', async () => {
      const result = await personaManager.activatePersona('test-persona_20250101-120000_tester');

      expect(result.active).toBe(true);
      expect(personaManager.getActivePersona()).toEqual(testPersona);
    });

    it('should throw error for non-existent persona', async () => {
      await expect(personaManager.activatePersona('Non-existent'))
        .rejects.toThrow('Persona not found: Non-existent');
    });
  });

  describe('deactivatePersona', () => {
    it('should deactivate the active persona', async () => {
      const testPersona: Persona = {
        name: 'Test Persona',
        content: 'Test content',
        path: '/test/personas/test.md',
        metadata: {
          name: 'Test Persona',
          description: 'A test persona'
        }
      };

      mockLoader.loadAllPersonas.mockResolvedValue([testPersona]);
      await personaManager.loadPersonas();
      await personaManager.activatePersona('Test Persona');

      const result = await personaManager.deactivatePersona();

      expect(result.active).toBe(false);
      expect(result.message).toBe('Persona deactivated');
      expect(personaManager.getActivePersona()).toBeUndefined();
    });

    it('should handle deactivation when no persona is active', async () => {
      const result = await personaManager.deactivatePersona();

      expect(result.active).toBe(false);
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

      mockValidator.validatePersonaData.mockReturnValue({ 
        isValid: true, 
        errors: [] 
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await personaManager.createPersona(
        newPersona.name,
        newPersona.description,
        newPersona.category,
        newPersona.instructions,
        newPersona.triggers
      );

      expect(mockValidator.validatePersonaData).toHaveBeenCalledWith(
        expect.objectContaining({
          name: newPersona.name,
          description: newPersona.description,
          category: newPersona.category
        })
      );

      expect(fs.writeFile).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.message).toContain('successfully');
    });

    it('should reject invalid persona data', async () => {
      mockValidator.validatePersonaData.mockReturnValue({
        isValid: false,
        errors: ['Name is required', 'Invalid category']
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
      name: 'Test Persona',
      content: '---\nname: Test Persona\ndescription: Original description\n---\nOriginal content',
      path: '/test/personas/test.md',
      metadata: {
        name: 'Test Persona',
        description: 'Original description',
        version: '1.0'
      }
    };

    beforeEach(async () => {
      mockLoader.loadAllPersonas.mockResolvedValue([testPersona]);
      await personaManager.loadPersonas();
    });

    it('should edit persona description', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue(testPersona.content);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const result = await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      expect(fs.writeFile).toHaveBeenCalledWith(
        testPersona.path,
        expect.stringContaining('description: Updated description'),
        'utf-8'
      );
      expect(result.success).toBe(true);
    });

    it('should increment version when editing', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue(testPersona.content);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      expect(fs.writeFile).toHaveBeenCalledWith(
        testPersona.path,
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

      const result = await personaManager.setUserIdentity(username, email);

      expect(result.username).toBe(username);
      expect(result.email).toBe(email);
      expect(result.anonymous).toBe(false);
    });

    it('should clear user identity', async () => {
      await personaManager.setUserIdentity('testuser', 'test@example.com');
      await personaManager.clearUserIdentity();

      const identity = await personaManager.getUserIdentity();
      expect(identity.anonymous).toBe(true);
      expect(identity.username).toMatch(/^anon-/);
    });

    it('should generate anonymous ID when no user is set', async () => {
      const identity = await personaManager.getUserIdentity();

      expect(identity.anonymous).toBe(true);
      expect(identity.username).toMatch(/^anon-[a-z]+-[a-z]+-[a-z0-9]+$/);
    });
  });

  describe('Performance', () => {
    it('should handle large number of personas efficiently', async () => {
      const largePersonaSet = Array.from({ length: 1000 }, (_, i) => ({
        name: `Persona ${i}`,
        content: `Content ${i}`,
        path: `/test/personas/persona-${i}.md`,
        metadata: {
          name: `Persona ${i}`,
          description: `Description ${i}`,
          unique_id: `persona-${i}_20250101-120000_tester`
        }
      }));

      mockLoader.loadAllPersonas.mockResolvedValue(largePersonaSet);

      const startTime = Date.now();
      await personaManager.loadPersonas();
      const loadTime = Date.now() - startTime;

      expect(loadTime).toBeLessThan(1000); // Should load in under 1 second

      // Test search performance
      const searchStart = Date.now();
      const personas = await personaManager.listPersonas();
      const searchTime = Date.now() - searchStart;

      expect(searchTime).toBeLessThan(100); // Should list in under 100ms
      expect(personas).toHaveLength(1000);
    });
  });

  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      const fsError = new Error('EACCES: permission denied');
      (fs.writeFile as jest.Mock).mockRejectedValue(fsError);

      await expect(personaManager.createPersona(
        'Test',
        'Description',
        'creative',
        'Instructions'
      )).rejects.toThrow();
    });

    it('should handle corrupted persona files', async () => {
      const corruptedPersona = {
        name: 'Corrupted',
        content: 'Invalid YAML content {{{',
        path: '/test/personas/corrupted.md',
        metadata: null
      };

      mockLoader.loadAllPersonas.mockResolvedValue([corruptedPersona as any]);

      await personaManager.loadPersonas();
      const personas = await personaManager.listPersonas();

      // Should skip corrupted personas
      expect(personas.some(p => p.name === 'Corrupted')).toBe(false);
    });
  });
});
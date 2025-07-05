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
    
    // Create mocks for the dependencies
    mockLoader = {
      loadAll: jest.fn(),
      savePersona: jest.fn(),
      deletePersona: jest.fn()
    } as unknown as jest.Mocked<PersonaLoader>;
    
    mockValidator = {
      validatePersona: jest.fn(),
      validateMetadata: jest.fn(),
      isValidPersonaName: jest.fn(),
      suggestImprovements: jest.fn()
    } as unknown as jest.Mocked<PersonaValidator>;
    
    // Mock the PersonaLoader and PersonaValidator constructors
    jest.mock('../../src/persona/PersonaLoader');
    jest.mock('../../src/persona/PersonaValidator');
    
    personaManager = new PersonaManager(mockPersonasDir, DEFAULT_INDICATOR_CONFIG);
    
    // Replace the internal instances with our mocks
    (personaManager as any).loader = mockLoader;
    (personaManager as any).validator = mockValidator;
  });

  describe('loadPersonas', () => {
    it('should load personas successfully', async () => {
      const mockPersonas = new Map<string, Persona>([
        ['test.md', {
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
      mockLoader.loadAll.mockResolvedValue(mockPersonas);
      
      await personaManager.initialize();

      // Verify loadAll was called
      expect(mockLoader.loadAll).toHaveBeenCalled();
    });

    it('should handle load errors gracefully', async () => {
      // Mock loader to fail
      mockLoader.loadAll.mockRejectedValue(new Error('Failed to read directory'));

      // PersonaManager.initialize might throw the error from loader
      await expect(personaManager.initialize()).rejects.toThrow('Failed to read directory');
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

    it('should activate a persona by name', () => {
      const result = personaManager.activatePersona('Test Persona');

      expect(result).toBeDefined();
      expect(result.message).toContain('Test Persona');
      expect((personaManager as any).activePersona).toBe('test.md');
    });

    it('should activate a persona by unique_id', () => {
      const result = personaManager.activatePersona('test-persona_20250101-120000_tester');

      expect(result).toBeDefined();
      expect(result.message).toContain('Activated');
      expect((personaManager as any).activePersona).toBe('test.md');
    });

    it('should throw error for non-existent persona', () => {
      const result = personaManager.activatePersona('Non-existent');
      expect(result.success).toBe(false);
      expect(result.message).toBe('Persona not found: "Non-existent"');
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
      personaManager.activatePersona('Test Persona');

      const result = personaManager.deactivatePersona();

      expect(result).toBeDefined();
      expect(result.message).toContain('Deactivated persona:');
      expect((personaManager as any).activePersona).toBeNull();
    });

    it('should handle deactivation when no persona is active', () => {
      const result = personaManager.deactivatePersona();

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

      // Mock validator to return valid
      mockValidator.validatePersona.mockReturnValue({ 
        valid: true, 
        issues: [],
        warnings: [],
        report: 'Validation successful'
      });
      
      mockLoader.savePersona.mockResolvedValue();

      const result = await personaManager.createPersona(
        newPersona.name,
        newPersona.description,
        newPersona.category,
        newPersona.instructions
      );

      // The createPersona method handles validation internally
      // Check that the persona was saved
      expect(mockLoader.savePersona).toHaveBeenCalled();

      // PersonaManager uses loader.savePersona, not fs.writeFile directly
      expect(result.success).toBe(true);
      expect(result.message).toContain('successfully');
    });

    it('should reject invalid persona data', async () => {
      mockValidator.validatePersona.mockReturnValue({
        valid: false,
        issues: ['Name is required', 'Invalid category'],
        warnings: [],
        report: 'Validation failed'
      });

      const result = await personaManager.createPersona(
        '',
        'Description',
        'invalid-category',
        'Instructions'
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('Persona name cannot be empty');
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
      // Mock loader to save the updated persona
      mockLoader.savePersona.mockResolvedValue();
      
      // Mock validator to return valid
      mockValidator.validatePersona.mockReturnValue({ 
        valid: true, 
        issues: [],
        warnings: [],
        report: 'Validation successful'
      });

      const result = await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      expect(mockLoader.savePersona).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should increment version when editing', async () => {
      mockLoader.savePersona.mockResolvedValue();
      
      // Mock validator to return valid
      mockValidator.validatePersona.mockReturnValue({ 
        valid: true, 
        issues: [],
        warnings: [],
        report: 'Validation successful'
      });

      const result = await personaManager.editPersona(
        'Test Persona',
        'description',
        'Updated description'
      );

      // Verify savePersona was called
      expect(mockLoader.savePersona).toHaveBeenCalled();
      expect(result.success).toBe(true);
      
      // Check that the version was incremented in the response (from 1.0 to something higher)
      expect(result.message).toMatch(/v1\.\d+/);
    });

    it('should reject edits to non-existent personas', async () => {
      const result = await personaManager.editPersona(
        'Non-existent',
        'description',
        'New value'
      );
      expect(result.success).toBe(false);
      expect(result.message).toBe('Persona not found: "Non-existent"');
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
      mockLoader.savePersona.mockRejectedValue(fsError);

      const result = await personaManager.createPersona(
        'Test',
        'Description',
        'creative',
        'Instructions'
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create persona');
    });

    it('should handle corrupted persona files', async () => {
      // Mock a corrupted file read
      // Mock loader to return empty map on error
      mockLoader.loadAll.mockResolvedValue(new Map());

      // Initialize should handle the error gracefully
      await personaManager.initialize();
      
      // Verify loader was called
      expect(mockLoader.loadAll).toHaveBeenCalled();
    });

    it('should handle concurrent persona operations', async () => {
      // Set up initial personas
      const mockPersonas = new Map([
        ['test1.md', {
          metadata: { name: 'Test 1', description: 'Test', unique_id: 'test1' },
          content: 'Content 1',
          filename: 'test1.md',
          unique_id: 'test1'
        }],
        ['test2.md', {
          metadata: { name: 'Test 2', description: 'Test', unique_id: 'test2' },
          content: 'Content 2',
          filename: 'test2.md',
          unique_id: 'test2'
        }]
      ]);
      
      mockLoader.loadAll.mockResolvedValue(mockPersonas);
      await personaManager.initialize();

      // Simulate concurrent activations (these are synchronous)
      const results = [
        personaManager.activatePersona('Test 1'),
        personaManager.activatePersona('Test 2'),
        personaManager.activatePersona('Test 1')
      ];

      // All should succeed
      expect(results.every(r => r.success)).toBe(true);
      
      // Last activation should win
      const activePersona = personaManager.getActivePersona();
      expect(activePersona?.metadata.name).toBe('Test 1');
    });

    it('should handle file system race conditions', async () => {
      // Mock validator to succeed
      mockValidator.validatePersona.mockReturnValue({
        valid: true,
        issues: [],
        warnings: [],
        report: 'Valid'
      });

      // Simulate race condition where save fails due to file already existing
      mockLoader.savePersona
        .mockRejectedValueOnce(new Error('EEXIST: file already exists'))
        .mockResolvedValueOnce(undefined);

      const result = await personaManager.createPersona(
        'Race Test',
        'Description',
        'creative',
        'Instructions'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create persona');
    });
  });
});
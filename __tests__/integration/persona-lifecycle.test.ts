/**
 * Integration test for complete persona lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TestServer } from './helpers/test-server.js';
import { 
  createTestPersonaFile, 
  cleanDirectory, 
  fileExists,
  readPersonaFile,
  waitForFile
} from './helpers/file-utils.js';
import { TEST_PERSONAS, createTestPersona } from './helpers/test-fixtures.js';
import * as path from 'path';

describe('Persona Lifecycle Integration', () => {
  let testServer: TestServer;
  let personasDir: string;
  
  beforeEach(async () => {
    personasDir = process.env.TEST_PERSONAS_DIR!;
    await cleanDirectory(personasDir);
    
    testServer = new TestServer();
    await testServer.initialize();
  });
  
  afterEach(async () => {
    await testServer.cleanup();
    await cleanDirectory(personasDir);
  });
  
  describe('Persona Loading', () => {
    it('should load personas from file system on initialization', async () => {
      // Create test personas
      await createTestPersonaFile(personasDir, TEST_PERSONAS.creative);
      await createTestPersonaFile(personasDir, TEST_PERSONAS.technical);
      
      // Reinitialize to load personas
      await testServer.personaManager.reload();
      
      // Verify personas are loaded
      const personas = testServer.personaManager.getAllPersonas();
      expect(personas.size).toBe(2);
      
      // Check persona details
      const creative = testServer.personaManager.findPersona('Creative Writer');
      expect(creative).toBeDefined();
      expect(creative?.metadata.name).toBe('Creative Writer');
      expect(creative?.metadata.category).toBe('creative');
    });
    
    it('should handle empty personas directory', async () => {
      const personas = testServer.personaManager.getAllPersonas();
      expect(personas.size).toBe(0);
    });
    
    it('should generate unique IDs for legacy personas', async () => {
      // Create a persona file without unique_id
      const legacyPersona = createTestPersona({
        metadata: {
          ...TEST_PERSONAS.creative.metadata,
          unique_id: undefined
        }
      });
      
      await createTestPersonaFile(personasDir, legacyPersona);
      await testServer.personaManager.reload();
      
      const loaded = testServer.personaManager.findPersona('Creative Writer');
      expect(loaded?.unique_id).toBeDefined();
      expect(loaded?.unique_id).toMatch(/^creative-writer_\d{8}-\d{6}_/);
    });
  });
  
  describe('Persona Creation', () => {
    it('should create a new persona and save to file system', async () => {
      const result = await testServer.personaManager.createPersona(
        'Test Assistant',
        'A helpful test assistant',
        'general',
        'You are a helpful assistant for testing.'
      );
      
      expect(result.success).toBe(true);
      expect(result.filename).toBe('test-assistant.md');
      
      // Verify file was created
      const filePath = path.join(personasDir, 'test-assistant.md');
      expect(await fileExists(filePath)).toBe(true);
      
      // Verify file content
      const fileContent = await readPersonaFile(filePath);
      expect(fileContent.metadata.name).toBe('Test Assistant');
      expect(fileContent.metadata.description).toBe('A helpful test assistant');
      expect(fileContent.content).toBe('You are a helpful assistant for testing.');
      
      // Verify persona is in memory
      const persona = testServer.personaManager.findPersona('Test Assistant');
      expect(persona).toBeDefined();
    });
    
    it('should prevent duplicate persona creation', async () => {
      // Create first persona
      await testServer.personaManager.createPersona(
        'Duplicate Test',
        'First version',
        'general',
        'First content'
      );
      
      // Try to create duplicate
      const result = await testServer.personaManager.createPersona(
        'Duplicate Test',
        'Second version',
        'general',
        'Second content'
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });
  });
  
  describe('Persona Activation', () => {
    beforeEach(async () => {
      await createTestPersonaFile(personasDir, TEST_PERSONAS.creative);
      await createTestPersonaFile(personasDir, TEST_PERSONAS.technical);
      await testServer.personaManager.reload();
    });
    
    it('should activate and deactivate personas', async () => {
      // Initially no persona active
      expect(testServer.personaManager.getActivePersona()).toBeNull();
      
      // Activate creative persona
      const activateResult = testServer.personaManager.activatePersona('Creative Writer');
      expect(activateResult.success).toBe(true);
      expect(activateResult.persona?.metadata.name).toBe('Creative Writer');
      
      // Verify active persona
      const active = testServer.personaManager.getActivePersona();
      expect(active?.metadata.name).toBe('Creative Writer');
      
      // Get persona indicator
      const indicator = testServer.personaManager.getPersonaIndicator();
      expect(indicator).toContain('Creative Writer');
      
      // Deactivate
      const deactivateResult = testServer.personaManager.deactivatePersona();
      expect(deactivateResult.success).toBe(true);
      expect(testServer.personaManager.getActivePersona()).toBeNull();
    });
    
    it('should switch between personas', async () => {
      // Activate first persona
      testServer.personaManager.activatePersona('Creative Writer');
      expect(testServer.personaManager.getActivePersona()?.metadata.name)
        .toBe('Creative Writer');
      
      // Switch to second persona
      testServer.personaManager.activatePersona('Technical Assistant');
      expect(testServer.personaManager.getActivePersona()?.metadata.name)
        .toBe('Technical Assistant');
    });
  });
  
  describe('Persona Editing', () => {
    beforeEach(async () => {
      await createTestPersonaFile(personasDir, TEST_PERSONAS.creative);
      await testServer.personaManager.reload();
    });
    
    it('should edit persona and update file', async () => {
      const result = await testServer.personaManager.editPersona(
        'Creative Writer',
        'description',
        'An enhanced creative writing assistant'
      );
      
      expect(result.success).toBe(true);
      
      // Verify in-memory update
      const persona = testServer.personaManager.findPersona('Creative Writer');
      expect(persona?.metadata.description).toBe('An enhanced creative writing assistant');
      expect(persona?.metadata.version).toBe('1.1'); // Auto-incremented
      
      // Verify file update
      const filePath = path.join(personasDir, 'creative-writer.md');
      const fileContent = await readPersonaFile(filePath);
      expect(fileContent.metadata.description).toBe('An enhanced creative writing assistant');
      expect(fileContent.metadata.version).toBe('1.1');
    });
    
    it('should handle concurrent edits gracefully', async () => {
      // Simulate concurrent edits
      const edits = [
        testServer.personaManager.editPersona('Creative Writer', 'description', 'Edit 1'),
        testServer.personaManager.editPersona('Creative Writer', 'category', 'enhanced'),
        testServer.personaManager.editPersona('Creative Writer', 'version', '2.0')
      ];
      
      const results = await Promise.all(edits);
      
      // All edits should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
      
      // Verify final state
      const persona = testServer.personaManager.findPersona('Creative Writer');
      expect(persona?.metadata.description).toBe('Edit 1');
      expect(persona?.metadata.category).toBe('enhanced');
      expect(persona?.metadata.version).toBe('2.0');
    });
  });
  
  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      // Create a persona
      await testServer.personaManager.createPersona(
        'Error Test',
        'Test persona',
        'general',
        'Test content'
      );
      
      // Make the file read-only (simulate permission error)
      const filePath = path.join(personasDir, 'error-test.md');
      const fs = await import('fs/promises');
      await fs.chmod(filePath, 0o444);
      
      // Try to edit (should fail gracefully)
      const result = await testServer.personaManager.editPersona(
        'Error Test',
        'description',
        'Updated description'
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to edit persona');
      
      // Restore permissions for cleanup
      await fs.chmod(filePath, 0o644);
    });
    
    it('should recover from corrupted persona files', async () => {
      // Create a corrupted file
      const fs = await import('fs/promises');
      const corruptedPath = path.join(personasDir, 'corrupted.md');
      await fs.writeFile(corruptedPath, 'This is not valid YAML frontmatter');
      
      // Should handle gracefully during reload
      await expect(testServer.personaManager.reload()).resolves.not.toThrow();
      
      // Other personas should still work
      await testServer.personaManager.createPersona(
        'Working Persona',
        'This should work',
        'general',
        'Despite the corrupted file'
      );
      
      const persona = testServer.personaManager.findPersona('Working Persona');
      expect(persona).toBeDefined();
    });
  });
});
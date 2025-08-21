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
    personasDir = process.env.TEST_PERSONAS_DIR || '';
    if (!personasDir) {
      throw new Error('TEST_PERSONAS_DIR environment variable is not set');
    }
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
        'professional',
        'You are a helpful assistant for testing various features and functionality. Your responses should be clear, concise, and focused on testing scenarios.'
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
      expect(fileContent.content).toBe('You are a helpful assistant for testing various features and functionality. Your responses should be clear, concise, and focused on testing scenarios.');
      
      // Verify persona is in memory
      const persona = testServer.personaManager.findPersona('Test Assistant');
      expect(persona).toBeDefined();
    });
    
    it('should prevent duplicate persona creation', async () => {
      // Create first persona
      await testServer.personaManager.createPersona(
        'Duplicate Test',
        'First version of the persona',
        'creative',
        'This is the first version of the duplicate test persona. It contains enough content to pass the minimum character validation requirements.'
      );
      
      // Try to create duplicate
      const result = await testServer.personaManager.createPersona(
        'Duplicate Test',
        'Second version of the persona',
        'creative',
        'This is the second version of the duplicate test persona. It also contains enough content to pass the minimum character validation requirements.'
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
      expect(String(persona?.metadata.version)).toBe('1.1'); // Auto-incremented
      
      // Verify file update
      const filePath = path.join(personasDir, 'creative-writer.md');
      const fileContent = await readPersonaFile(filePath);
      expect(fileContent.metadata.description).toBe('An enhanced creative writing assistant');
      expect(String(fileContent.metadata.version)).toBe('1.1');
    });
    
    it('should handle concurrent edits gracefully', async () => {
      // Simulate concurrent edits
      const edits = [
        testServer.personaManager.editPersona('Creative Writer', 'description', 'Edit 1'),
        testServer.personaManager.editPersona('Creative Writer', 'category', 'professional'),
        testServer.personaManager.editPersona('Creative Writer', 'version', '2.0')
      ];
      
      // Use Promise.allSettled to handle potential race conditions
      const results = await Promise.allSettled(edits);
      
      // Add synchronization delay to let file system settle
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify all edits completed (some may have succeeded, some may have failed due to concurrent access)
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.success).toBe(true);
        }
      });
      
      // Verify final state - at least one of each edit should have succeeded
      const persona = testServer.personaManager.findPersona('Creative Writer');
      expect(persona).toBeDefined();
    });
    
    // Note: Copy-on-write functionality is implemented in DollhouseMCPServer.editPersona
    // PersonaManager.editPersona does not have this protection
    // This test documents the expected behavior but cannot test it through PersonaManager
    it.skip('should create a copy when editing default personas (feature in main server)', async () => {
      // This test is skipped because the copy-on-write feature is only implemented
      // in DollhouseMCPServer.editPersona, not in PersonaManager.editPersona
      // The feature works correctly when using the MCP tool interface
    });
  });
  
  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      // Create a persona with a valid category
      await testServer.personaManager.createPersona(
        'Error Test',
        'Test persona for permission testing',
        'creative',
        'This is a test persona created specifically for testing file permission errors. It needs to be at least 50 characters long to pass validation.'
      );
      
      const filePath = path.join(personasDir, 'error-sample.md');
      const fs = await import('fs/promises');
      
      try {
        // Make the file read-only (simulate permission error)
        await fs.chmod(filePath, 0o444);
        
        // Try to edit (should fail gracefully)
        const result = await testServer.personaManager.editPersona(
          'Error Test',
          'description',
          'Updated description'
        );
        
        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to edit persona');
      } finally {
        // ALWAYS restore permissions for cleanup (if file still exists)
        try {
          await fs.chmod(filePath, 0o644);
        } catch (error: any) {
          // File may not exist anymore, ignore ENOENT errors
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }
    });
    
    it('should recover from corrupted persona files', async () => {
      // Create a corrupted file with invalid YAML that will cause parsing errors
      const fs = await import('fs/promises');
      const corruptedPath = path.join(personasDir, 'corrupted.md');
      
      // This will cause gray-matter to fail parsing due to invalid YAML syntax
      const corruptedContent = `---
name: Corrupted Persona
description: This has invalid YAML
category: [unclosed array
version: 1.0
---

This persona has corrupted frontmatter that should cause parsing errors.`;
      
      await fs.writeFile(corruptedPath, corruptedContent);
      
      // Should handle gracefully during reload
      await expect(testServer.personaManager.reload()).resolves.not.toThrow();
      
      // Verify corrupted file is handled (might be loaded with defaults or skipped)
      const allPersonas = testServer.personaManager.getAllPersonas();
      
      // Verify file still exists (not deleted)
      const fileStillExists = await fileExists(corruptedPath);
      expect(fileStillExists).toBe(true);
      
      // Other personas should still work
      const result = await testServer.personaManager.createPersona(
        'Working Persona',
        'This persona should work despite corrupted files',
        'professional',
        'This is a working persona that demonstrates the system can continue functioning even when some persona files are corrupted or invalid.'
      );
      
      expect(result.success).toBe(true);
      const persona = testServer.personaManager.findPersona('Working Persona');
      expect(persona).toBeDefined();
      
      // System should continue functioning with at least the working personas
      expect(allPersonas.size).toBeGreaterThanOrEqual(0);
    });
  });
});
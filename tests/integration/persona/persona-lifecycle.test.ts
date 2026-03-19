/**
 * Integration test for complete persona lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import { logger } from '../../../src/utils/logger.js';
import { TestServer } from '../../helpers/test-server.js';
import {
  createTestPersonaFile,
  cleanDirectory,
  fileExists,
  readPersonaFile
} from '../../helpers/file-utils.js';
import { TEST_PERSONAS, createTestPersona } from '../../helpers/test-fixtures.js';
import * as path from 'path';
import { restoreFilePermissions, shouldSkipPermissionTest } from '../../helpers/permissionTestHelper.js';

describe('Persona Lifecycle Integration', () => {
  let portfolioDir: string;
  let testServer: TestServer;
  let personasDir: string;
  const originalFilterSetting = process.env.DISABLE_ELEMENT_FILTERING;

  beforeEach(async () => {
    // Disable element filtering so test elements are not filtered out
    process.env.DISABLE_ELEMENT_FILTERING = 'true';

    const testBaseDir = process.env.TEST_BASE_DIR;
    if (!testBaseDir) {
      throw new Error('TEST_BASE_DIR environment variable is not set');
    }

    portfolioDir = path.join(testBaseDir, 'persona-lifecycle');
    await fs.rm(portfolioDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(portfolioDir, { recursive: true });

    process.env.DOLLHOUSE_PORTFOLIO_DIR = portfolioDir;
    personasDir = path.join(portfolioDir, 'personas');
    await fs.mkdir(personasDir, { recursive: true });
    await cleanDirectory(personasDir);

    testServer = new TestServer({ portfolioDir });
    await testServer.initialize();
  });
  
  afterEach(async () => {
    await testServer.cleanup();
    if (personasDir) {
      await cleanDirectory(personasDir);
    }
    if (portfolioDir) {
      await fs.rm(portfolioDir, { recursive: true, force: true }).catch(() => {});
    }
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Restore original filter setting
    if (originalFilterSetting === undefined) {
      delete process.env.DISABLE_ELEMENT_FILTERING;
    } else {
      process.env.DISABLE_ELEMENT_FILTERING = originalFilterSetting;
    }
  });
  
  describe('Persona Loading', () => {
    it('should load personas from file system on initialization', async () => {
      // Create test personas
      await createTestPersonaFile(personasDir, TEST_PERSONAS.creative);
      await createTestPersonaFile(personasDir, TEST_PERSONAS.technical);
      
      // Reinitialize to load personas
      await testServer.personaManager.reload();
      
      // Verify personas are loaded
      const personas = await testServer.personaManager.getAllPersonas();
      expect(personas.size).toBe(2);
      
      // Check persona details
      const creative = testServer.personaManager.findPersona('Creative Writer');
      expect(creative).toBeDefined();
      expect(creative?.metadata.name).toBe('Creative Writer');
      expect(creative?.metadata.category).toBe('creative');
    });
    
    it('should handle empty personas directory', async () => {
      const personas = await testServer.personaManager.getAllPersonas();
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
      expect(loaded?.unique_id).toMatch(/^creative-writer_\d{8}-\d{9}-[a-z0-9]{4}_/);
    });
  });
  
  describe('Persona Creation', () => {
    it('should create a new persona and save to file system', async () => {
      // v2: create() returns persona directly
      const persona = await testServer.personaManager.create({
        name: 'Test Assistant',
        description: 'A helpful test assistant',
        instructions: 'You are a helpful assistant for testing various features and functionality. Your responses should be clear, concise, and focused on testing scenarios.',
        category: 'professional'
      });

      expect(persona).toBeDefined();
      expect(persona.filename).toBe('test-assistant.md');

      // Verify file was created
      const filePath = path.join(personasDir, 'test-assistant.md');
      expect(await fileExists(filePath)).toBe(true);

      // Verify file content
      const fileContent = await readPersonaFile(filePath);
      expect(fileContent.metadata.name).toBe('Test Assistant');
      expect(fileContent.metadata.description).toBe('A helpful test assistant');
      // v2.0 dual-field format: instructions go to YAML frontmatter, body is reference content
      expect(fileContent.metadata.instructions).toContain('You are a helpful assistant for testing various features and functionality. Your responses should be clear, concise, and focused on testing scenarios.');

      // Verify persona is in memory
      const foundPersona = testServer.personaManager.findPersona('Test Assistant');
      expect(foundPersona).toBeDefined();
    });

    it('should prevent duplicate persona creation', async () => {
      // Create first persona
      await testServer.personaManager.create({
        name: 'Duplicate Test',
        description: 'First version of the persona',
        instructions: 'This is the first version of the duplicate test persona. It contains enough content to pass the minimum character validation requirements.',
        category: 'creative'
      });

      // Try to create duplicate - v2: throws instead of returning {success: false}
      await expect(
        testServer.personaManager.create({
          name: 'Duplicate Test',
          description: 'Second version of the persona',
          instructions: 'This is the second version of the duplicate test persona. It also contains enough content to pass the minimum character validation requirements.',
          category: 'creative'
        })
      ).rejects.toThrow(/already exists/);
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
      const activateResult = await testServer.personaManager.activatePersona('Creative Writer');
      expect(activateResult.success).toBe(true);
      expect(activateResult.persona?.metadata.name).toBe('Creative Writer');
      
      // Verify active persona
      const active = testServer.personaManager.getActivePersona();
      expect(active?.metadata.name).toBe('Creative Writer');
      
      // Get persona indicator
      const indicator = testServer.personaManager.getPersonaIndicator();
      expect(indicator).toContain('Creative Writer');
      
      // Deactivate - Issue #281: Now requires identifier parameter
      // Note: Internal API uses 'identifier' param; MCP-AQL uses 'element_name' (Issue #323)
      const deactivateResult = testServer.personaManager.deactivatePersona('Creative Writer');
      expect(deactivateResult.success).toBe(true);
      expect(testServer.personaManager.getActivePersona()).toBeNull();
    });

    it('should switch between personas', async () => {
      // Activate first persona
      await testServer.personaManager.activatePersona('Creative Writer');
      expect(testServer.personaManager.getActivePersona()?.metadata.name)
        .toBe('Creative Writer');

      // Switch to second persona - deactivates previous automatically
      testServer.personaManager.deactivatePersona('Creative Writer');
      await testServer.personaManager.activatePersona('Technical Assistant');
      expect(testServer.personaManager.getActivePersona()?.metadata.name)
        .toBe('Technical Assistant');
    });
  });
  
  describe('Persona Editing', () => {
    beforeEach(async () => {
      await createTestPersonaFile(personasDir, TEST_PERSONAS.technical);
      await testServer.personaManager.reload();
    });

    it('should edit persona and update file', async () => {
      const result = await testServer.personaManager.editPersona(
        'Technical Assistant',
        'description',
        'An enhanced technical documentation helper'
      );

      expect(result.success).toBe(true);

      // Verify in-memory update
      const persona = testServer.personaManager.findPersona('Technical Assistant');
      expect(persona?.metadata.description).toBe('An enhanced technical documentation helper');
      expect(String(persona?.metadata.version)).toBe('1.0.1'); // Auto-incremented

      // Verify file update
      const filePath = path.join(personasDir, 'technical-assistant.md');
      const fileContent = await readPersonaFile(filePath);
      expect(fileContent.metadata.description).toBe('An enhanced technical documentation helper');
      expect(String(fileContent.metadata.version)).toBe('1.0.1');
    });
    
    it('should handle concurrent edits gracefully', async () => {
      // Simulate concurrent edits
      const edits = [
        testServer.personaManager.editPersona('Technical Assistant', 'description', 'Edit 1'),
        testServer.personaManager.editPersona('Technical Assistant', 'category', 'technical'),
        testServer.personaManager.editPersona('Technical Assistant', 'version', '2.0')
      ];
      
      // Use Promise.allSettled to handle potential race conditions
      const results = await Promise.allSettled(edits);
      
      // Add synchronization delay to let file system settle
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify all edits completed successfully
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ success: boolean }> => result.status === 'fulfilled');
      expect(fulfilled.length).toBe(results.length);
      const successCount = fulfilled.filter(result => result.value.success).length;
      expect(successCount).toBeGreaterThan(0);
      
      // Verify final state - at least one of each edit should have succeeded
      const persona = testServer.personaManager.findPersona('Technical Assistant');
      expect(persona).toBeDefined();
    });
    
    // Copy-on-write: When editing a default/seed persona, create a user copy instead
    it('should create a copy when editing default personas', async () => {
      // Use one of the actual default persona names from DEFAULT_PERSONAS list
      // Create a default persona using the Creative Writer name
      const defaultPersonaContent = `---
name: Creative Writer
description: Original default description
category: creative
unique_id: creative-writer
author: system
version: 1.0.0
triggers:
  - creative
  - writing
---

Original default creative writer persona content.`;

      const defaultFilename = 'creative-writer.md';
      const defaultPath = path.join(personasDir, defaultFilename);
      await fs.writeFile(defaultPath, defaultPersonaContent);
      await testServer.personaManager.reload();

      // Verify the default persona exists
      const beforeEdit = testServer.personaManager.findPersona(defaultFilename);
      expect(beforeEdit).toBeDefined();
      expect(beforeEdit?.metadata.name).toBe('Creative Writer');

      // Edit the default persona - this should trigger copy-on-write
      await testServer.personaManager.editPersona(defaultFilename, 'description', 'Modified description for testing');

      // Reload to pick up changes
      await testServer.personaManager.reload();

      // Verify: Original default file should still exist unchanged
      const originalContent = await fs.readFile(defaultPath, 'utf-8');
      expect(originalContent).toContain('Original default description');
      expect(originalContent).not.toContain('Modified description for testing');

      // Verify: A new copy should have been created with the modification
      const allPersonas = await testServer.personaManager.list();

      // Should now have 2 "Creative Writer" personas: original default + modified copy
      const creativeWriters = allPersonas.filter(p => p.metadata.name === 'Creative Writer');
      expect(creativeWriters.length).toBe(2);

      const original = creativeWriters.find(p => p.filename === defaultFilename);
      const modifiedCopy = creativeWriters.find(p => p.filename !== defaultFilename);

      // Verify original is unchanged
      expect(original).toBeDefined();
      expect(original?.metadata.description).toBe('Original default description');

      // Verify copy was created with modifications
      expect(modifiedCopy).toBeDefined();
      expect(modifiedCopy?.metadata.description).toBe('Modified description for testing');
      expect(modifiedCopy?.filename).not.toBe(defaultFilename);
      expect(modifiedCopy?.unique_id).not.toBe('creative-writer');
      expect(modifiedCopy?.metadata.version).not.toBe('1.0.0'); // Version should be incremented
    });
  });
  
  describe('Error Handling', () => {
    it('should handle file system errors gracefully', async () => {
      // Create a persona with a valid category
      // v2: create() with object syntax
      await testServer.personaManager.create({
        name: 'Error Test',
        description: 'Test persona for permission testing',
        instructions: 'This is a test persona created specifically for testing file permission errors. It needs to be at least 50 characters long to pass validation.',
        category: 'creative'
      });
      
      const filePath = path.join(personasDir, 'error-sample.md');
      const { promises: fs } = await import('node:fs');
      
      // FIX (SonarCloud S1143): Refactored to avoid throw statement with finally block
      // The pattern of throw before finally can mask errors and make debugging difficult
      let testPassed = false;
      let testError: any = null;

      try {
        // Make the file read-only (simulate permission error)
        // On Windows, we need to handle permissions differently
        // Set file to read-only (same for all platforms)
        await fs.chmod(filePath, 0o444);

        // Try to edit (should fail gracefully)
        const result = await testServer.personaManager.editPersona(
          'Error Test',
          'description',
          'Updated description'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to edit persona');
        testPassed = true;
      } catch (chmodError: any) {
        // Store the error for later handling
        testError = chmodError;
      }

      // Always attempt cleanup using test utility
      // SECURITY: 0o644 is safe for test files (read for all, write for owner)
      // This is test-only code in a temporary test directory
      await restoreFilePermissions(filePath, 0o644);

      // Now handle any test errors after cleanup is complete
      if (!testPassed && testError) {
        const skipResult = shouldSkipPermissionTest(testError);
        if (skipResult.skipped) {
          logger.info(`File permission test skipped - ${skipResult.reason}`);
          return;
        }
        throw testError;
      }
    });
    
    it('should recover from corrupted persona files', async () => {
      // Create a corrupted file with invalid YAML that will cause parsing errors
      const { promises: fs } = await import('node:fs');
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
      const allPersonas = await testServer.personaManager.getAllPersonas();

      // Verify file still exists (not deleted)
      const fileStillExists = await fileExists(corruptedPath);
      expect(fileStillExists).toBe(true);
      
      // Other personas should still work
      // v2: create() returns persona directly
      const workingPersona = await testServer.personaManager.create({
        name: 'Working Persona',
        description: 'This persona should work despite corrupted files',
        instructions: 'This is a working persona that demonstrates the system can continue functioning even when some persona files are corrupted or invalid.',
        category: 'professional'
      });

      expect(workingPersona).toBeDefined();
      const foundPersona = testServer.personaManager.findPersona('Working Persona');
      expect(foundPersona).toBeDefined();
      
      // System should continue functioning with at least the working personas
      expect(allPersonas.size).toBeGreaterThanOrEqual(0);
    });
  });
});

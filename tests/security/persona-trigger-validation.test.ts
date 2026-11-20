/**
 * Security tests for PersonaManager trigger validation
 * Phase 4.7 - Trigger validation security testing
 *
 * Tests:
 * - Format validation (alphanumeric, hyphens, underscores only)
 * - Length limits (max 50 characters per trigger)
 * - Special character rejection
 * - Trigger count limits (max 10 triggers)
 */

import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import type { PersonaMetadata as _PersonaMetadata } from '../../src/types/persona.js';
import { createRealPersonaManager } from '../helpers/di-mocks.js';
import type { PersonaManager } from '../../src/persona/PersonaManager.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';

describe('PersonaManager - Trigger Validation Security', () => {
  let personaManager: PersonaManager;
  let portfolioManager: PortfolioManager;
  let testDir: string;

  beforeEach(async () => {
    // Disable element filtering so test personas aren't filtered out
    process.env.DISABLE_ELEMENT_FILTERING = 'true';

    testDir = mkdtempSync(join(tmpdir(), 'persona-trigger-test-'));
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    await portfolioManager.initialize();

    personaManager = createRealPersonaManager(testDir, {
      portfolioManager
    });

    await personaManager.initialize();
  });

  afterEach(async () => {
    await personaManager.dispose();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.DISABLE_ELEMENT_FILTERING;
  });

  describe('Format Validation', () => {
    it('should accept valid alphanumeric triggers', async () => {
      // v2: create() with object syntax including triggers
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['coding', 'debug', 'test']
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toEqual(['coding', 'debug', 'test']);
    });

    it('should accept triggers with hyphens', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['code-review', 'bug-fix', 'test-automation']
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toContain('code-review');
    });

    it('should accept triggers with underscores', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['code_review', 'bug_fix', 'unit_test']
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toContain('code_review');
    });

    it('should reject triggers with dangerous special characters', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        // Note: @ and . are now allowed (safe for emails/domains)
        // These contain shell metacharacters that MUST be rejected
        triggers: ['bad!trigger', 'evil;trigger', 'cmd$var']
      });

      // Persona should be created but dangerous triggers rejected
      expect(persona).toBeDefined();
      // All triggers should be rejected due to shell metacharacters
      expect(persona.metadata.triggers).toBeUndefined();
    });

    it('should accept triggers with @ and . (safe characters)', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['user@example', 'domain.com', 'email@test.org']
      });

      expect(persona).toBeDefined();
      // @ and . are safe - useful for mentions and domains
      expect(persona.metadata.triggers).toHaveLength(3);
      expect(persona.metadata.triggers).toContain('user@example');
      expect(persona.metadata.triggers).toContain('domain.com');
    });

    it('should reject triggers with spaces', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['code review', 'bug fix']
      });

      expect(persona).toBeDefined();
      // Triggers with spaces should be rejected
      expect(persona.metadata.triggers).toBeUndefined();
    });

    it('should reject triggers with injection patterns', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['$(evil)', '`malicious`', '${code}']
      });

      expect(persona).toBeDefined();
      // All malicious triggers should be rejected
      expect(persona.metadata.triggers).toBeUndefined();
    });
  });

  describe('Length Limits', () => {
    it('should accept triggers under 50 characters', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['a'.repeat(50)]
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toHaveLength(1);
      expect(persona.metadata.triggers?.[0]).toHaveLength(50);
    });

    it('should truncate triggers over 50 characters', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['a'.repeat(100)]
      });

      expect(persona).toBeDefined();
      if (persona.metadata.triggers) {
        expect(persona.metadata.triggers[0].length).toBeLessThanOrEqual(50);
      }
    });

    it('should reject empty triggers after sanitization', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['   ', '', '\t\n']
      });

      expect(persona).toBeDefined();
      // All empty triggers should be rejected
      expect(persona.metadata.triggers).toBeUndefined();
    });
  });

  describe('Trigger Count Limits', () => {
    it('should accept up to 10 triggers', async () => {
      const triggers = Array.from({ length: 10 }, (_, i) => `trigger${i}`);

      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toHaveLength(10);
    });

    it('should limit triggers to 20 maximum', async () => {
      const triggers = Array.from({ length: 30 }, (_, i) => `trigger${i}`);

      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers
      });

      expect(persona).toBeDefined();
      // Should be limited to 20 triggers (unified limit across all element types)
      expect(persona.metadata.triggers?.length).toBeLessThanOrEqual(20);
    });
  });

  describe('Mixed Valid and Invalid Triggers', () => {
    it('should accept valid triggers and reject invalid ones', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: [
          'valid-trigger',      // Valid
          'also_valid',         // Valid
          'bad!trigger',        // Invalid (shell metachar !)
          'another-good-one',   // Valid
          'user@domain.com',    // Valid (@ and . are now allowed)
          'evil;command',       // Invalid (shell metachar ;)
          'good_trigger'        // Valid
        ]
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toHaveLength(5); // Valid ones (including @.)
      expect(persona.metadata.triggers).toContain('valid-trigger');
      expect(persona.metadata.triggers).toContain('also_valid');
      expect(persona.metadata.triggers).toContain('another-good-one');
      expect(persona.metadata.triggers).toContain('user@domain.com');
      expect(persona.metadata.triggers).toContain('good_trigger');
      expect(persona.metadata.triggers).not.toContain('bad!trigger');
      expect(persona.metadata.triggers).not.toContain('evil;command');
    });
  });

  describe('Trigger Sanitization', () => {
    it('should sanitize triggers with dangerous content', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['<script>alert(1)</script>', 'normal-trigger']
      });

      expect(persona).toBeDefined();
      // Script tag should be sanitized/rejected
      const triggers = persona.metadata.triggers || [];
      expect(triggers.some(t => t.includes('<script>'))).toBe(false);
      expect(triggers).toContain('normal-trigger');
    });
  });

  describe('Case Sensitivity', () => {
    it('should preserve trigger case', async () => {
      const persona = await personaManager.create({
        name: 'Test Persona',
        description: 'A test persona',
        instructions: 'Test instructions',
        triggers: ['CodeReview', 'BugFix', 'TESTING']
      });

      expect(persona).toBeDefined();
      expect(persona.metadata.triggers).toContain('CodeReview');
      expect(persona.metadata.triggers).toContain('BugFix');
      expect(persona.metadata.triggers).toContain('TESTING');
    });
  });
});

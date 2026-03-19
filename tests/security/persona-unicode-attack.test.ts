/**
 * Security tests for PersonaManager Unicode attack prevention
 * Phase 4.7 - Unicode validation security testing
 *
 * Tests:
 * - Homograph attack prevention
 * - RTL override detection
 * - Zero-width character removal
 * - Mixed script detection
 */

import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { PersonaImporter } from '../../src/persona/export-import/PersonaImporter.js';
import { createRealPersonaManager } from '../helpers/di-mocks.js';
import type { PersonaManager } from '../../src/persona/PersonaManager.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';

describe('PersonaManager - Unicode Attack Prevention', () => {
  let personaManager: PersonaManager;
  let portfolioManager: PortfolioManager;
  let personaImporter: PersonaImporter;
  let testDir: string;

  beforeEach(async () => {
    // Disable element filtering so test personas aren't filtered out
    process.env.DISABLE_ELEMENT_FILTERING = 'true';

    testDir = mkdtempSync(join(tmpdir(), 'persona-unicode-test-'));
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    await portfolioManager.initialize();

    personaImporter = new PersonaImporter(portfolioManager);

    personaManager = createRealPersonaManager(testDir, {
      portfolioManager,
      personaImporter
    });

    await personaManager.initialize();
  });

  afterEach(async () => {
    personaManager.dispose();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.DISABLE_ELEMENT_FILTERING;
  });

  describe('Homograph Attack Prevention', () => {
    it('should reject Cyrillic lookalikes as mixed script attack', async () => {
      // Cyrillic 'а' (U+0430) looks like Latin 'a' (U+0061)
      const cyrillicName = 'Аdmin'; // First char is Cyrillic А (U+0410)

      // DMCP-SEC-004: Mixed script (Cyrillic + Latin) = high severity homograph attack
      // Input normalization at boundary properly detects and rejects this
      await expect(
        personaManager.create({
          name: cyrillicName,
          description: 'A test persona',
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Mixed script/);
    });

    it('should reject Greek lookalikes as mixed script attack', async () => {
      // Greek 'ο' (U+03BF) looks like Latin 'o' (U+006F)
      const greekName = 'Cοding'; // 'o' is Greek omicron

      // DMCP-SEC-004: Mixed script (Greek + Latin) = high severity homograph attack
      await expect(
        personaManager.create({
          name: greekName,
          description: 'A test persona',
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Mixed script/);
    });

    it('should normalize fullwidth characters', async () => {
      // Fullwidth 'Ｔ' (U+FF34) instead of 'T' (U+0054)
      const fullwidthName = 'Ｔｅｓｔ';

      const persona = await personaManager.create({
        name: fullwidthName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // Should be normalized to 'Test'
      expect(persona.metadata.name).toBe('Test');
    });
  });

  describe('Direction Override Detection', () => {
    it('should reject RTL override characters as high severity attack', async () => {
      // U+202E is Right-to-Left Override
      const rtlName = 'Admin\u202EMalicious';

      // DMCP-SEC-004: Direction override = high severity attack
      await expect(
        personaManager.create({
          name: rtlName,
          description: 'A test persona',
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });

    it('should reject LTR override characters as high severity attack', async () => {
      // U+202D is Left-to-Right Override
      const ltrName = 'Test\u202DOverride';

      // DMCP-SEC-004: Direction override = high severity attack
      await expect(
        personaManager.create({
          name: ltrName,
          description: 'A test persona',
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });

    it('should reject direction embedding characters as high severity attack', async () => {
      // U+202A is Left-to-Right Embedding
      const embedName = 'Test\u202AEmbedded';

      // DMCP-SEC-004: Direction override = high severity attack
      await expect(
        personaManager.create({
          name: embedName,
          description: 'A test persona',
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });
  });

  describe('Zero-Width Character Removal', () => {
    it('should remove zero-width spaces', async () => {
      // U+200B is Zero-Width Space
      const zwsName = 'Test\u200BPersona';

      const persona = await personaManager.create({
        name: zwsName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // Zero-width space should be removed
      expect(persona.metadata.name).not.toContain('\u200B');
      expect(persona.metadata.name).toBe('TestPersona');
    });

    it('should remove zero-width non-joiner', async () => {
      // U+200C is Zero-Width Non-Joiner
      const zwnjName = 'Test\u200CPersona';

      const persona = await personaManager.create({
        name: zwnjName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // ZWNJ should be removed
      expect(persona.metadata.name).not.toContain('\u200C');
    });

    it('should remove zero-width joiner', async () => {
      // U+200D is Zero-Width Joiner
      const zwjName = 'Test\u200DPersona';

      const persona = await personaManager.create({
        name: zwjName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // ZWJ should be removed
      expect(persona.metadata.name).not.toContain('\u200D');
    });

    it('should remove byte order mark (BOM)', async () => {
      // U+FEFF is Zero-Width No-Break Space (BOM)
      const bomName = '\uFEFFTestPersona';

      const persona = await personaManager.create({
        name: bomName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // BOM should be removed
      expect(persona.metadata.name).not.toContain('\uFEFF');
      expect(persona.metadata.name).toBe('TestPersona');
    });
  });

  describe('Non-Printable Character Removal', () => {
    it('should remove control characters', async () => {
      // U+0000 (NULL), U+0007 (BELL)
      const controlName = 'Test\u0000\u0007Persona';

      const persona = await personaManager.create({
        name: controlName,
        description: 'A test persona',
        instructions: 'Test instructions'
      });

      expect(persona).toBeDefined();
      // Control characters should be removed
      expect(persona.metadata.name).not.toContain('\u0000');
      expect(persona.metadata.name).not.toContain('\u0007');
    });
  });

  describe('Description Unicode Validation', () => {
    it('should reject mixed script Unicode in descriptions as security threat', async () => {
      const unicodeDesc = 'А helpful аssistаnt'; // Contains Cyrillic 'а'

      // DMCP-SEC-004: Mixed script (Cyrillic + Latin) = high severity attack
      await expect(
        personaManager.create({
          name: 'Test Persona',
          description: unicodeDesc,
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Mixed script/);
    });

    it('should reject dangerous Unicode from descriptions as security threat', async () => {
      const dangerousDesc = 'Test\u202EOverride description';

      // DMCP-SEC-004: Direction override = high severity attack
      await expect(
        personaManager.create({
          name: 'Test Persona Dangerous',
          description: dangerousDesc,
          instructions: 'Test instructions'
        })
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });
  });

  describe('Instructions Unicode Validation', () => {
    it('should reject mixed script Unicode in instructions as security threat', async () => {
      const unicodeInstructions = 'Yоu are а helpful аssistant'; // Contains Cyrillic lookalikes

      // DMCP-SEC-004: Input normalization at boundary now properly detects
      // mixed script (Latin + Cyrillic) as high-severity attack and fails validation
      // v2: create() throws on validation failure
      await expect(
        personaManager.create({
          name: 'Test Persona Mixed',
          description: 'A test persona',
          instructions: unicodeInstructions
        })
      ).rejects.toThrow(/Validation failed.*Mixed script/);
    });

    it('should reject dangerous Unicode in instructions as security threat', async () => {
      const dangerousInstructions = 'Test\u200Binstructions\u202Ewith attacks';

      // DMCP-SEC-004: Direction override = high severity, fails at boundary
      // v2: create() throws on validation failure
      await expect(
        personaManager.create({
          name: 'Test Persona Dangerous',
          description: 'A test persona',
          instructions: dangerousInstructions
        })
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });
  });

  describe('Edit Operations Unicode Validation', () => {
    let testPersonaFilename: string;

    beforeEach(async () => {
      const persona = await personaManager.create({
        name: 'Edit Test',
        description: 'A test persona',
        instructions: 'Original instructions'
      });
      testPersonaFilename = persona.filePath;
    });

    it('should reject Unicode mixed scripts in edit values as security threat', async () => {
      const unicodeValue = 'Updаted instructions'; // Contains Cyrillic 'а'

      // DMCP-SEC-004: Mixed script (Latin + Cyrillic) = high severity
      // Input normalization at boundary properly rejects this in validateEdit
      await expect(
        personaManager.editPersona(
          testPersonaFilename,
          'instructions',
          unicodeValue
        )
      ).rejects.toThrow(/Validation failed.*Mixed script/);
    });

    it('should reject critical Unicode attacks in edit values', async () => {
      const criticalUnicode = 'Test\u202EReverse';

      // DMCP-SEC-004: Direction override = high severity
      // Input normalization at boundary properly rejects this
      await expect(
        personaManager.editPersona(
          testPersonaFilename,
          'instructions',
          criticalUnicode
        )
      ).rejects.toThrow(/Validation failed.*Direction override/);
    });
  });

  describe('User Identity Unicode Validation', () => {
    it('should normalize Unicode in usernames', async () => {
      const unicodeUsername = 'аdmin'; // Cyrillic 'а'

      personaManager.setUserIdentity(unicodeUsername);

      const identity = personaManager.getUserIdentity();
      // Should be normalized
      expect(identity.username).not.toContain('а');
      expect(identity.username).toMatch(/admin/i);
    });

    it('should normalize Unicode in emails', async () => {
      const unicodeEmail = 'test@exаmple.com'; // Cyrillic 'а'

      personaManager.setUserIdentity('testuser', unicodeEmail);

      const identity = personaManager.getUserIdentity();
      // Email should be normalized
      expect(identity.email).not.toContain('а');
      expect(identity.email).toMatch(/example\.com/i);
    });

    it('should reject critical Unicode in usernames', async () => {
      const maliciousUsername = 'test\u202Euser';

      // Should either reject or normalize
      try {
        personaManager.setUserIdentity(maliciousUsername);
        const identity = personaManager.getUserIdentity();
        // If accepted, must be normalized
        expect(identity.username).not.toContain('\u202E');
      } catch (error) {
        // If rejected, that's also acceptable
        expect(error).toBeDefined();
      }
    });
  });
});

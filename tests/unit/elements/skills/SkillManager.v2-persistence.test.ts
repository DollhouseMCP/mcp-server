/**
 * Unit tests for SkillManager v2 markdown body serialization
 *
 * Tests that skills serialized without explicit content get a well-formed
 * markdown body (H1 + description) via buildDefaultBody(), matching the
 * pattern established for AgentManager in PR #711.
 *
 * @see Issue #713 - ensure create_element produces well-formatted markdown bodies
 * @see Issue #696 - element quality: YAML-only serialization gap
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Mock security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

import { SkillManager } from '../../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../../src/elements/skills/Skill.js';
import type { SkillMetadata } from '../../../../src/elements/skills/Skill.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

const metadataService: MetadataService = createTestMetadataService();

describe('SkillManager — element quality: markdown body (#713)', () => {
  let skillManager: InstanceType<typeof SkillManager>;
  let testDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();

    testDir = path.join(os.tmpdir(), 'skill-v2-test-' + Math.random().toString(36).substring(7));
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ElementType.SKILL), { recursive: true });

    const mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(testDir, type)),
      getBaseDir: jest.fn<() => string>(() => testDir)
    };

    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService();
    const serializationService = new SerializationService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    skillManager = new SkillManager({
      portfolioManager: mockPortfolioManager as any,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
    });
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('element quality — markdown body (#713)', () => {
    it('generated file contains a markdown body with name and description', async () => {
      const metadata: SkillMetadata = {
        name: 'My Test Skill',
        type: ElementType.SKILL,
        version: '1.0.0',
        author: 'test-user',
        description: 'Provides useful test capabilities'
      };
      const skill = new Skill(metadata, 'Some instructions', metadataService);
      // No content set — relies on buildDefaultBody()
      skill.content = '';

      const serialized = await (skillManager as any).serializeElement(skill);

      // Body section must exist after the closing ---
      const parts = serialized.split(/^---\s*$/m);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# My Test Skill');
      expect(body).toContain('Provides useful test capabilities');
    });

    it('generated file has H1 heading even with no description', async () => {
      const metadata: SkillMetadata = {
        name: 'Minimal Skill',
        type: ElementType.SKILL,
        version: '1.0.0',
        author: 'test-user'
        // no description
      };
      const skill = new Skill(metadata, 'Instructions', metadataService);
      skill.content = '';

      const serialized = await (skillManager as any).serializeElement(skill);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Minimal Skill');
    });

    it('generates a valid body even when name is empty (MetadataService normalizes to Untitled)', async () => {
      const metadata: SkillMetadata = {
        name: '',
        type: ElementType.SKILL,
        version: '1.0.0',
        author: 'test-user'
      };
      const skill = new Skill(metadata, 'Instructions', metadataService);
      skill.content = '';

      const serialized = await (skillManager as any).serializeElement(skill);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // MetadataService normalizes '' → 'Untitled Skill', so body still has a valid H1
      expect(body).toContain('# Untitled Skill');
      // No broken heading like '#   ' or '# '
      expect(body).not.toMatch(/^#\s*$/m);
    });

    it('preserves explicit content over the default body', async () => {
      const metadata: SkillMetadata = {
        name: 'Skill With Content',
        type: ElementType.SKILL,
        version: '1.0.0',
        author: 'test-user',
        description: 'Description text'
      };
      const skill = new Skill(metadata, 'Instructions', metadataService);
      skill.content = '# Custom Body\n\nThis is hand-written reference content.';

      const serialized = await (skillManager as any).serializeElement(skill);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Custom Body');
      expect(body).toContain('hand-written reference content');
      // Default body should NOT appear alongside the custom body
      expect(body).not.toContain('Description text');
    });

    it('whitespace-only name and description never produce a broken H1', async () => {
      const metadata: SkillMetadata = {
        name: '   ',
        type: ElementType.SKILL,
        version: '1.0.0',
        author: 'test-user',
        description: '   '
      };
      const skill = new Skill(metadata, 'Instructions', metadataService);
      skill.content = '';

      const serialized = await (skillManager as any).serializeElement(skill);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // Whitespace-only name: MetadataService normalizes to 'Untitled Skill'
      // buildDefaultBody() trims fields, so never produces a broken '#   '
      expect(body).not.toMatch(/^#\s*$/m);       // No empty heading
      expect(body).not.toMatch(/^#\s{2,}/m);     // No heading with only spaces
      expect(body).toContain('# Untitled Skill'); // Falls back to normalized name
    });
  });
});

import { promises as fs } from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { jest } from '@jest/globals';

import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('SkillManager (BaseElementManager integration)', () => {
  let manager: SkillManager;
  let env: PortfolioTestEnvironment;
  let skillsDir: string;
  let securitySpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    env = await createPortfolioTestEnvironment('skill-manager-test');

    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    manager = new SkillManager(
      env.portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      fileWatchService
    );

    skillsDir = env.portfolioManager.getElementDir(ElementType.SKILL);
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose manager to clean up file watchers
    if (manager) {
      manager.dispose();
    }

    await env.cleanup();
  });

  beforeEach(() => {
    securitySpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
  });

  afterEach(async () => {
    securitySpy?.mockRestore();

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        await fs.rm(path.join(skillsDir, entry.name), { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('saves and loads skills with trigger processing', async () => {
    const skill = new Skill(
      {
        name: 'Refactor Guru',
        description: 'Helps refactor code',
        triggers: ['refactor', 'improve', '']
      },
      'Do the thing',
      metadataService
    );

    await manager.save(skill, 'refactor-guru.md');

    const loaded = await manager.load('refactor-guru.md');

    expect(loaded.metadata.name).toBe('Refactor Guru');
    expect(loaded.instructions).toContain('Do the thing');
    expect(loaded.metadata.triggers).toEqual(['refactor', 'improve']);
  });

  it('persists metadata (including version and triggers) via serializeElement', async () => {
    const skill = new Skill(
      {
        name: 'Trigger Tester',
        description: 'Verifies serialization',
        triggers: ['alpha', 'beta']
      },
      'Testing serialization',
      metadataService
    );
    skill.version = '2.3.4';

    await manager.save(skill, 'trigger-tester.md');

    const filePath = path.join(skillsDir, 'trigger-tester.md');
    const contents = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(contents);

    expect(parsed.data.name).toBe('Trigger Tester');
    expect(parsed.data.version).toBe('2.3.4');
    expect(parsed.data.triggers).toEqual(['alpha', 'beta']);
    // v2.0 dual-field format: instructions go to YAML frontmatter, body is reference content
    expect(parsed.data.instructions).toBe('Testing serialization');
  });

  it('create() slugifies filenames and logs creation', async () => {
    const created = await manager.create({
      name: 'My Fancy Skill',
      description: 'Creates fancy outputs',
      content: 'return fancy();'
    });

    const expectedFile = path.join(skillsDir, 'my-fancy-skill.md');
    await expect(fs.access(expectedFile)).resolves.toBeUndefined();

    expect(created.metadata.name).toBe('My Fancy Skill');
    expect(securitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'SkillManager.create',
        type: 'ELEMENT_CREATED'
      })
    );
  });

  it('list() returns persisted skills', async () => {
    const skillA = new Skill({ name: 'Skill A' }, 'alpha', metadataService);
    const skillB = new Skill({ name: 'Skill B' }, 'beta', metadataService);

    await manager.save(skillA, 'skill-a.md');
    await manager.save(skillB, 'skill-b.md');

    const skills = await manager.list();
    const names = skills.map(s => s.metadata.name).sort();

    expect(names).toEqual(['Skill A', 'Skill B']);
  });
});

/**
 * Test suite for autoIncrementVersion function in editElement.ts
 * Verifies that version increment properly normalizes legacy 2-part versions
 * to 3-part semver format before incrementing
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { editElement } from '../../../../src/handlers/element-crud/editElement.js';
import { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';
import { SkillManager } from '../../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../../src/elements/skills/Skill.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';

// Mock dependencies
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('autoIncrementVersion in editElement', () => {
  let testDir: string;
  let skillsDir: string;
  let context: ElementCrudContext;
  let skillManager: SkillManager;
  let portfolioManager: PortfolioManager;
  let fileLockManager: FileLockManager;
  let fileOperationsService: FileOperationsService;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `version-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Initialize DI dependencies
    fileLockManager = new FileLockManager();
    fileOperationsService = new FileOperationsService(fileLockManager);

    // Initialize PortfolioManager with required FileOperationsService
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: testDir });
    await portfolioManager.initialize();

    // Get skills directory
    skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
    await fs.mkdir(skillsDir, { recursive: true });

    // Create service instances for DI
    const serializationService = new SerializationService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Initialize SkillManager
    skillManager = new SkillManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    });

    // Set up mocks
    jest.clearAllMocks();

    // Mock FileLockManager instance methods so FileOperationsService
    // actually writes/reads files (auto-mock makes them return undefined).
    (fileLockManager as any).atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    });
    (fileLockManager as any).atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    });

    // Create mock context
    context = {
      skillManager,
      ensureInitialized: async () => {},
      getPersonaIndicator: () => '🎭'
    } as any;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (_error) {
      // Ignore cleanup errors
    }
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  it('should normalize legacy 2-part version (1.0) to 3-part format and increment', async () => {
    // Create a skill with legacy 2-part version
    const skill = new Skill({
      name: 'Legacy Skill',
      description: 'Test skill with legacy version',
      version: '1.0'
    }, 'Test instructions', metadataService);

    const filename = 'legacy-skill.md';
    await skillManager.save(skill, filename);

    // Edit the skill (should trigger auto-increment)
    // Issue #290: Use input object format for edits
    const result = await editElement(context, {
      name: 'Legacy Skill',
      type: 'skills',
      input: { description: 'Updated description' }
    });

    // Verify success
    expect(result.content[0].text).toContain('✅');

    // Load the skill back and check version
    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill).toBeDefined();
    expect(updatedSkill!.version).toBe('1.0.1'); // Should be 1.0.1, not 1.1
  });

  it('should normalize legacy 2-part version (2.5) to 3-part format and increment', async () => {
    const skill = new Skill({
      name: 'Legacy Skill 2',
      description: 'Test skill',
      version: '2.5'
    }, 'Test instructions', metadataService);

    const filename = 'legacy-skill-2.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Legacy Skill 2',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('2.5.1'); // Should be 2.5.1, not 2.6
  });

  it('should handle standard 3-part version correctly', async () => {
    const skill = new Skill({
      name: 'Modern Skill',
      description: 'Test skill',
      version: '1.0.0'
    }, 'Test instructions', metadataService);

    const filename = 'modern-skill.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Modern Skill',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('1.0.1');
  });

  it('should increment patch version correctly', async () => {
    const skill = new Skill({
      name: 'Increment Test',
      description: 'Test skill',
      version: '1.2.3'
    }, 'Test instructions', metadataService);

    const filename = 'increment-test.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Increment Test',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('1.2.4');
  });

  it('should handle pre-release versions', async () => {
    const skill = new Skill({
      name: 'Prerelease Skill',
      description: 'Test skill',
      version: '1.0.0-beta.1'
    }, 'Test instructions', metadataService);

    const filename = 'prerelease-skill.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Prerelease Skill',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('1.0.0-beta.2');
  });

  it('should initialize version to 1.0.0 when missing', async () => {
    const skill = new Skill({
      name: 'No Version Skill',
      description: 'Test skill'
    }, 'Test instructions', metadataService);
    // Manually remove version
    delete (skill as any).version;
    delete skill.metadata.version;

    const filename = 'no-version-skill.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'No Version Skill',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    // When version is missing, autoIncrementVersion initializes to 1.0.0
    // (first version assignment). A subsequent edit would bump to 1.0.1.
    expect(updatedSkill!.version).toBe('1.0.0');
  });

  it('should NOT increment version when explicitly setting version field', async () => {
    const skill = new Skill({
      name: 'Explicit Version',
      description: 'Test skill',
      version: '1.0.0'
    }, 'Test instructions', metadataService);

    const filename = 'explicit-version.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Explicit Version',
      type: 'skills',
      input: { version: '2.0.0' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('2.0.0'); // Should be exactly what we set
  });

  it('should sync version to metadata', async () => {
    const skill = new Skill({
      name: 'Metadata Sync',
      description: 'Test skill',
      version: '1.0'
    }, 'Test instructions', metadataService);

    const filename = 'metadata-sync.md';
    await skillManager.save(skill, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Metadata Sync',
      type: 'skills',
      input: { description: 'Updated' }
    });

    const updatedSkill = await skillManager.load(filename);
    expect(updatedSkill!.version).toBe('1.0.1');
    expect(updatedSkill!.metadata.version).toBe('1.0.1');
  });
});

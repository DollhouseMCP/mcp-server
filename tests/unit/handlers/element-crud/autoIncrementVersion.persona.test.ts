/**
 * Test suite for autoIncrementVersion function with PersonaManager
 * Verifies that version increment properly normalizes legacy 2-part versions
 * to 3-part semver format before incrementing - specifically for personas
 * where the bug was originally discovered (TypeScript-Pro going 1.0 -> 1.2)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { editElement } from '../../../../src/handlers/element-crud/editElement.js';
import { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';
import { PersonaManager } from '../../../../src/persona/PersonaManager.js';
import { PersonaElement } from '../../../../src/persona/PersonaElement.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../../src/config/indicator-config.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

// Mock dependencies
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('autoIncrementVersion for PersonaManager', () => {
  let testDir: string;
  let personasDir: string;
  let context: ElementCrudContext;
  let personaManager: PersonaManager;
  let portfolioManager: PortfolioManager;
  let fileLockManager: FileLockManager;
  let fileOperationsService: FileOperationsService;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `persona-version-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Initialize FileLockManager and FileOperationsService for PortfolioManager
    fileLockManager = new FileLockManager();
    fileOperationsService = new FileOperationsService(fileLockManager);

    // Initialize PortfolioManager with required FileOperationsService
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: testDir });
    await portfolioManager.initialize();

    // Get personas directory
    personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
    await fs.mkdir(personasDir, { recursive: true });

    // Set up mocks
    jest.clearAllMocks();

    // Mock FileLockManager methods to actually perform file operations
    fileLockManager.atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    }) as any;
    fileLockManager.atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    }) as any;

    // Create service instances for DI
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Initialize PersonaManager
    personaManager = new PersonaManager({
      portfolioManager,
      indicatorConfig: DEFAULT_INDICATOR_CONFIG,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService: new SerializationService(),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
    });

    // Create mock context
    context = {
      personaManager,
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
    // Create a persona with legacy 2-part version (like TypeScript-Pro had)
    const persona = new PersonaElement({
      name: 'TypeScript-Pro',
      description: 'Test persona with legacy version',
      version: '1.0'
    }, 'This is the persona content', '', metadataService);

    const filename = 'typescript-pro.md';
    await personaManager.save(persona, filename);

    // Edit the persona (should trigger auto-increment)
    // Issue #290: Use input object format for edits
    const result = await editElement(context, {
      name: 'TypeScript-Pro',
      type: 'personas',
      input: { description: 'Updated description' }
    });

    // Verify success
    expect(result.content[0].text).toContain('✅');

    // Load the persona back and check version
    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona).toBeDefined();
    expect(updatedPersona!.version).toBe('1.0.1'); // Should be 1.0.1, not 1.1 or 1.2
  });

  it('should normalize legacy 2-part version (1.2) to 3-part format and increment', async () => {
    // This simulates the exact scenario where TypeScript-Pro went from 1.0 -> 1.1 -> 1.2
    const persona = new PersonaElement({
      name: 'Legacy Persona',
      description: 'Test persona',
      version: '1.2'
    }, 'Content', '', metadataService);

    const filename = 'legacy-persona.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Legacy Persona',
      type: 'personas',
      input: { description: 'Updated' }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('1.2.1'); // Should be 1.2.1, not 1.3
  });

  it('should handle standard 3-part version correctly', async () => {
    const persona = new PersonaElement({
      name: 'Modern Persona',
      description: 'Test persona',
      version: '1.0.0'
    }, 'Content', '', metadataService);

    const filename = 'modern-persona.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Modern Persona',
      type: 'personas',
      input: { description: 'Updated' }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('1.0.1');
  });

  it('should increment patch version correctly for personas', async () => {
    const persona = new PersonaElement({
      name: 'Increment Test',
      description: 'Test persona',
      version: '2.5.8'
    }, 'Content', '', metadataService);

    const filename = 'increment-test.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Increment Test',
      type: 'personas',
      input: { description: 'Updated' }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('2.5.9');
  });

  it('should sync version to metadata for personas', async () => {
    const persona = new PersonaElement({
      name: 'Metadata Sync',
      description: 'Test persona',
      version: '1.0'
    }, 'Content', '', metadataService);

    const filename = 'metadata-sync.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Metadata Sync',
      type: 'personas',
      input: { description: 'Updated' }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('1.0.1');
    expect(updatedPersona!.metadata.version).toBe('1.0.1');
  });

  it('should NOT increment version when explicitly setting version field on persona', async () => {
    const persona = new PersonaElement({
      name: 'Explicit Version',
      description: 'Test persona',
      version: '1.0.0'
    }, 'Content', '', metadataService);

    const filename = 'explicit-version.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Explicit Version',
      type: 'personas',
      input: { version: '3.0.0' }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('3.0.0'); // Should be exactly what we set
  });

  it('should handle editing persona triggers without version increment issues', async () => {
    // Test editing other fields to ensure version increment still works
    const persona = new PersonaElement({
      name: 'Trigger Test',
      description: 'Test persona',
      version: '1.0',
      triggers: ['test']
    }, 'Content', '', metadataService);

    const filename = 'trigger-test.md';
    await personaManager.save(persona, filename);

    // Issue #290: Use input object format
    await editElement(context, {
      name: 'Trigger Test',
      type: 'personas',
      input: { triggers: ['test', 'updated'] }
    });

    const updatedPersona = await personaManager.load(filename);
    expect(updatedPersona!.version).toBe('1.0.1');
    expect(updatedPersona!.metadata.triggers).toEqual(['test', 'updated']);
  });
});

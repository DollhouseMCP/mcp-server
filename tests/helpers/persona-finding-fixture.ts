import { jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import { PersonaManager } from '../../src/persona/PersonaManager.js';
import type { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import type { FileLockManager } from '../../src/security/fileLockManager.js';
import type { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { Persona } from '../../src/types/persona.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../src/config/indicator-config.js';
import { createMockPortfolioManager, createTestMetadataService } from './di-mocks.js';
import { ValidationRegistry } from '../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../src/services/validation/ValidationService.js';
import { ElementType } from '../../src/portfolio/types.js';
import { ElementEventDispatcher } from '../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../src/services/SerializationService.js';
import { createTestStorageFactory } from './createTestStorageFactory.js';

export function createPersonaFindingFixture() {
  const mockPersonasDir = path.join(os.tmpdir(), 'test-personas');

  // Test personas with various naming patterns
  const testPersonas: Persona[] = [
    {
      id: 'creative-writer-abc123',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Creative Writer',
        description: 'A creative writing assistant',
        unique_id: 'creative-writer-abc123',
        category: 'creative',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Creative-Writer.md',
      unique_id: 'creative-writer-abc123'
    } as Persona,
    {
      id: 'test-special-chars-def456',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Test & Test',
        description: 'Persona with special characters',
        unique_id: 'test-special-chars-def456',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-And-Test.md',
      unique_id: 'test-special-chars-def456'
    } as Persona,
    {
      id: 'test-unicode-ghi789',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Tëst Përsoñä',
        description: 'Persona with Unicode characters',
        unique_id: 'test-unicode-ghi789',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-Unicode.md',
      unique_id: 'test-unicode-ghi789'
    } as Persona,
    {
      id: 'test-emoji-jkl012',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Test 😀 Persona',
        description: 'Persona with emoji',
        unique_id: 'test-emoji-jkl012',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-Emoji.md',
      unique_id: 'test-emoji-jkl012'
    } as Persona
  ];

  const seedPersona = (persona: Persona): void => {
    (personaManager as any).cacheElement(persona, persona.filename);
  };

  const mockPortfolioManager = createMockPortfolioManager({
    getElementDir: jest.fn().mockReturnValue(mockPersonasDir)
  });

  const mockFileLockManager: jest.Mocked<FileLockManager> = {
    withLock: jest.fn().mockImplementation(async (_path, callback) => await callback()),
    acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
    release: jest.fn(),
    atomicWriteFile: jest.fn().mockResolvedValue(undefined),
    atomicReadFile: jest.fn().mockResolvedValue(''),
  } as any;

  // Mock FileOperationsService
  const mockFileOperationsService: jest.Mocked<FileOperationsService> = {
    readFile: jest.fn().mockResolvedValue(''),
    readElementFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    listDirectory: jest.fn().mockResolvedValue([]),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    resolvePath: jest.fn((p: string) => p),
    validatePath: jest.fn().mockReturnValue(true),
  } as any;

  // Create service instances for DI
  const metadataService = createTestMetadataService();
  const validationRegistry = new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  const personaManager = new PersonaManager({
    portfolioManager: mockPortfolioManager as unknown as PortfolioManager,
    indicatorConfig: DEFAULT_INDICATOR_CONFIG,
    fileLockManager: mockFileLockManager,
    fileOperationsService: mockFileOperationsService,
    validationRegistry,
    serializationService: new SerializationService(),
    metadataService,
    eventDispatcher: new ElementEventDispatcher(),
  storageLayerFactory: createTestStorageFactory(),
  });

  // Populate cache with test personas
  for (const persona of testPersonas) {
    seedPersona(persona);
  }
  return { personaManager, seedPersona, mockFileOperationsService };
}

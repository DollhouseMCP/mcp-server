/**
 * Unit tests for EnsembleManager implementation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs, realpathSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

// Import after mocking
import { EnsembleManager } from '../../../../src/elements/ensembles/EnsembleManager.js';
import { resolveElementTypes } from '../../../../src/utils/elementTypeResolver.js';
import { Ensemble } from '../../../../src/elements/ensembles/Ensemble.js';
import { EnsembleMetadata } from '../../../../src/elements/ensembles/types.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { logger } from '../../../../src/utils/logger.js';

describe('EnsembleManager', () => {
  let ensembleManager: EnsembleManager;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let fileLockManager: FileLockManager;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensemble-test-'));
    portfolioPath = testDir;

    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    const metadataService = createTestMetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );
    ensembleManager = new EnsembleManager(
      mockPortfolioManager as any,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService
    );

    // Set up mocks
    jest.clearAllMocks();

    // Set default mock implementations
    fileLockManager.atomicWriteFile = jest.fn(() => Promise.resolve(undefined)) as any;
    fileLockManager.atomicReadFile = jest.fn(() => Promise.resolve('')) as any;
    fileLockManager.withLock = jest.fn((resource: string, operation: () => Promise<any>) => operation()) as any;
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    // Create ensembles directory
    await fs.mkdir(path.join(portfolioPath, 'ensembles'), { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Create', () => {
    it('should create a new ensemble', async () => {
      const metadata: Partial<EnsembleMetadata> = {
        name: 'Test Ensemble',
        description: 'A test ensemble',
        activationStrategy: 'sequential',
        conflictResolution: 'last-write',
        elements: [
          {
            element_name: 'skill1',
            element_type: 'skills',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      const ensemble = await ensembleManager.create(metadata);

      expect(ensemble).toBeInstanceOf(Ensemble);
      expect(ensemble.metadata.name).toBe('Test Ensemble');
      expect(ensemble.metadata.activationStrategy).toBe('sequential');
      expect(ensemble.metadata.elements.length).toBe(1);

      // CRITICAL: Verify file was saved to disk
      expect(fileLockManager.atomicWriteFile).toHaveBeenCalled();
      const writeCall = (fileLockManager.atomicWriteFile as jest.Mock).mock.calls[0];
      const [actualPath, content] = writeCall as [string, string];

      // Verify the filename
      expect(actualPath).toMatch(/test-ensemble\.md$/);

      // Verify content
      expect(content).toContain('name: Test Ensemble');
    });

    it('should throw error when name is missing', async () => {
      await expect(ensembleManager.create({})).rejects.toThrow(/name/i);
    });

    it('should apply default values', async () => {
      const ensemble = await ensembleManager.create({ name: 'Minimal', description: 'A minimal test ensemble' });

      expect(ensemble.metadata.activationStrategy).toBe('sequential');
      expect(ensemble.metadata.conflictResolution).toBe('last-write');
      expect(ensemble.metadata.contextSharing).toBe('selective');
    });

    it('should migrate legacy name/type fields to element_name/element_type', async () => {
      // Test backwards compatibility: using legacy 'name' and 'type' fields
      const metadata: any = {
        name: 'Legacy Test Ensemble',
        description: 'Testing legacy field migration',
        elements: [
          {
            name: 'legacy-skill',  // Legacy field
            type: 'skill',         // Legacy field
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      const ensemble = await ensembleManager.create(metadata);

      expect(ensemble).toBeInstanceOf(Ensemble);
      expect(ensemble.metadata.elements.length).toBe(1);
      // Verify migration happened - element should have element_name/element_type
      expect(ensemble.metadata.elements[0].element_name).toBe('legacy-skill');
      expect(ensemble.metadata.elements[0].element_type).toBe('skill');
    });

    it('should warn once for repeated legacy field parsing on the same ensemble', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const legacyMetadata = {
        name: 'Legacy Parse Ensemble',
        elements: [
          {
            name: 'legacy-skill',
            type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      await (ensembleManager as any).parseMetadata(legacyMetadata);
      await (ensembleManager as any).parseMetadata(legacyMetadata);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenNthCalledWith(
        1,
        "Ensemble 'Legacy Parse Ensemble' element at index 0 uses deprecated 'name' field. Use 'element_name' instead."
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        2,
        "Ensemble 'Legacy Parse Ensemble' element at index 0 uses deprecated 'type' field. Use 'element_type' instead."
      );
      warnSpy.mockRestore();
    });

    it('should not re-warn for the same legacy fields across create and parse paths', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const metadata: any = {
        name: 'Legacy Shared Warning Ensemble',
        description: 'Testing bounded legacy warnings',
        elements: [
          {
            name: 'legacy-skill',
            type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      await ensembleManager.create(metadata);
      await (ensembleManager as any).parseMetadata(metadata);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    it('should allow warning history to be cleared for long-running managers', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const metadata: any = {
        name: 'Legacy Resettable Warning Ensemble',
        elements: [
          {
            name: 'legacy-skill',
            type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      await (ensembleManager as any).parseMetadata(metadata);
      ensembleManager.clearLegacyElementWarningHistory();
      await (ensembleManager as any).parseMetadata(metadata);

      expect(warnSpy).toHaveBeenCalledTimes(4);
      warnSpy.mockRestore();
    });

    it('should reject duplicate metadata name even with different filename (Issue #613)', async () => {
      // Create a mock ensemble that list() will return
      const mockEnsemble = {
        metadata: { name: 'My Ensemble', description: 'First ensemble' },
        id: 'my-ensemble',
        elements: []
      };
      jest.spyOn(ensembleManager, 'list').mockResolvedValue([mockEnsemble as any]);

      // Try to create another ensemble with the same metadata name
      await expect(
        ensembleManager.create({ name: 'My Ensemble', description: 'Duplicate ensemble' })
      ).rejects.toThrow(/already exists/);

      // Should NOT have attempted file write
      expect(fileLockManager.atomicWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('Import/Export', () => {
    it('should import ensemble from YAML', async () => {
      const yamlContent = `---
name: Imported Ensemble
description: Imported from YAML
activationStrategy: all
conflictResolution: priority
elements:
  - name: element1
    type: skill
    role: primary
    priority: 90
    activation: always
  - name: element2
    type: persona
    role: support
    priority: 50
    activation: on-demand
---

# Documentation
This is ensemble documentation.
`;

      const ensemble = await ensembleManager.importElement(yamlContent, 'yaml');

      expect(ensemble.metadata.name).toBe('Imported Ensemble');
      expect(ensemble.metadata.activationStrategy).toBe('all');
      expect(ensemble.metadata.elements.length).toBe(2);
      expect(ensemble.metadata.elements[0].element_name).toBe('element1');
    });

    it('should import ensemble from JSON', async () => {
      const jsonContent = JSON.stringify({
        name: 'JSON Ensemble',
        description: 'Imported from JSON',
        activationStrategy: 'priority',
        conflictResolution: 'merge',
        elements: [
          {
            name: 'json-element',
            element_type: 'template',
            role: 'support',
            priority: 60,
            activation: 'conditional',
            condition: 'test == true'
          }
        ]
      });

      const ensemble = await ensembleManager.importElement(jsonContent, 'json');

      expect(ensemble.metadata.name).toBe('JSON Ensemble');
      expect(ensemble.metadata.activationStrategy).toBe('priority');
      expect(ensemble.metadata.elements[0].condition).toBe('test == true');
    });

    it('should export ensemble to YAML', async () => {
      const ensemble = await ensembleManager.create({
        name: 'Export Test',
        description: 'A test ensemble for export',
        activationStrategy: 'sequential',
        elements: [
          {
            element_name: 'export-element',
            element_type: 'skills',
            role: 'primary',
            priority: 75,
            activation: 'always'
          }
        ]
      });

      const yaml = await ensembleManager.exportElement(ensemble, 'yaml');

      expect(yaml).toContain('name: Export Test');
      expect(yaml).toContain('activationStrategy: sequential');
      expect(yaml).toContain('export-element');
    });

    it('should export ensemble to JSON', async () => {
      const ensemble = await ensembleManager.create({
        name: 'JSON Export',
        description: 'A test ensemble for JSON export',
        elements: []
      });

      const json = await ensembleManager.exportElement(ensemble, 'json');
      const parsed = JSON.parse(json);

      expect(parsed.metadata.name).toBe('JSON Export');
      expect(parsed.type).toBe(ElementType.ENSEMBLE);
    });
  });

  describe('Save and Load', () => {
    it('should save ensemble to file', async () => {
      const ensemble = await ensembleManager.create({
        name: 'Save Test',
        description: 'A test ensemble for save operations',
        activationStrategy: 'all',
        elements: []
      });

      const filePath = 'save-test.md';
      const fullPath = path.join(portfolioPath, 'ensembles', filePath);

      // Mock successful save
      (fileLockManager.atomicWriteFile as jest.Mock).mockResolvedValueOnce(undefined);

      await ensembleManager.save(ensemble, filePath);

      const calls = (fileLockManager.atomicWriteFile as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [actualPath, content, options] = calls[calls.length - 1] as [string, string, { encoding: string }];

      // Normalize paths for cross-platform comparison (handles /var → /private/var on macOS)
      // Since the file hasn't been written yet (mocked), normalize parent directories
      const actualDir = path.dirname(actualPath);
      const expectedDir = path.dirname(fullPath);
      const actualFilename = path.basename(actualPath);
      const expectedFilename = path.basename(fullPath);

      expect(realpathSync(actualDir)).toBe(realpathSync(expectedDir));
      expect(actualFilename).toBe(expectedFilename);

      // Verify content and options
      expect(content).toContain('name: Save Test');
      expect(options).toEqual({ encoding: 'utf-8' });
    });

    it('should load ensemble from file', async () => {
      const fileContent = `---
name: Load Test
description: Test loading
activationStrategy: priority
conflictResolution: first-write
contextSharing: full
elements:
  - name: loaded-element
    type: skill
    role: primary
    priority: 85
    activation: always
---

# Ensemble Instructions
Test instructions.
`;

      const filePath = 'load-test.md';
      const fullPath = path.join(portfolioPath, 'ensembles', filePath);

      // Create the file
      await fs.writeFile(fullPath, fileContent, 'utf-8');

      // Mock file read
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValueOnce(fileContent);

      const ensemble = await ensembleManager.load(filePath);

      expect(ensemble.metadata.name).toBe('Load Test');
      expect(ensemble.metadata.activationStrategy).toBe('priority');
      expect(ensemble.metadata.elements.length).toBe(1);
      expect(ensemble.metadata.elements[0].element_name).toBe('loaded-element');
    });
  });

  describe('Naming Convention Support', () => {
    it('should support snake_case in YAML', async () => {
      const yamlContent = `---
name: Snake Case Test
activation_strategy: sequential
conflict_resolution: last-write
context_sharing: selective
resource_limits:
  max_active_elements: 20
  max_execution_time_ms: 15000
allow_nested: true
max_nesting_depth: 3
elements:
  - name: test-element
    type: skill
    role: primary
    priority: 80
    activation: always
---
`;

      const ensemble = await ensembleManager.importElement(yamlContent, 'yaml');

      expect(ensemble.metadata.activationStrategy).toBe('sequential');
      expect(ensemble.metadata.conflictResolution).toBe('last-write');
      expect(ensemble.metadata.contextSharing).toBe('selective');
      expect(ensemble.metadata.resourceLimits?.maxActiveElements).toBe(20);
      expect(ensemble.metadata.allowNested).toBe(true);
      expect(ensemble.metadata.maxNestingDepth).toBe(3);
    });

    it('should support camelCase in YAML', async () => {
      const yamlContent = `---
name: Camel Case Test
activationStrategy: all
conflictResolution: priority
contextSharing: full
resourceLimits:
  maxActiveElements: 30
  maxExecutionTimeMs: 20000
allowNested: false
maxNestingDepth: 2
elements: []
---
`;

      const ensemble = await ensembleManager.importElement(yamlContent, 'yaml');

      expect(ensemble.metadata.activationStrategy).toBe('all');
      expect(ensemble.metadata.conflictResolution).toBe('priority');
      expect(ensemble.metadata.contextSharing).toBe('full');
      expect(ensemble.metadata.resourceLimits?.maxActiveElements).toBe(30);
      expect(ensemble.metadata.allowNested).toBe(false);
      expect(ensemble.metadata.maxNestingDepth).toBe(2);
    });
  });

  describe('Validation', () => {
    it('should validate ensemble before saving', async () => {
      const invalidEnsemble = await ensembleManager.create({ name: 'Test', description: 'A test ensemble' });
      // Corrupt the ensemble
      (invalidEnsemble as any).metadata.name = '';

      const filePath = 'invalid.md';

      await expect(ensembleManager.save(invalidEnsemble, filePath)).rejects.toThrow();
    });

    it('should reject invalid activation strategy', async () => {
      const yamlContent = `---
name: Invalid Strategy
activationStrategy: invalid_strategy
elements: []
---
`;

      await expect(ensembleManager.importElement(yamlContent, 'yaml')).rejects.toThrow(/activation strategy/i);
    });

    it('should reject invalid conflict resolution', async () => {
      const yamlContent = `---
name: Invalid Conflict
conflictResolution: invalid_resolution
elements: []
---
`;

      await expect(ensembleManager.importElement(yamlContent, 'yaml')).rejects.toThrow(/conflict resolution/i);
    });

    it('should reject invalid element role', async () => {
      const yamlContent = `---
name: Invalid Role
elements:
  - name: bad-element
    type: skill
    role: invalid_role
    priority: 50
    activation: always
---
`;

      await expect(ensembleManager.importElement(yamlContent, 'yaml')).rejects.toThrow(/element role/i);
    });

    it('should reject too many elements', async () => {
      const tooManyElements = Array.from({ length: 51 }, (_, i) => ({
        name: `element-${i}`,
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      }));

      const yamlContent = `---
name: Too Many Elements
elements:
${tooManyElements.map(e => `  - name: ${e.element_name}
    type: ${e.element_type}
    role: ${e.role}
    priority: ${e.priority}
    activation: ${e.activation}`).join('\n')}
---
`;

      await expect(ensembleManager.importElement(yamlContent, 'yaml')).rejects.toThrow(/more than 50 elements/i);
    });
  });

  describe('Security', () => {
    it('should sanitize inputs during import', async () => {
      const maliciousYaml = `---
name: Safe Name Test
description: Test description without HTML
elements:
  - name: safe-element-name
    type: skill
    role: primary
    priority: 80
    activation: always
---
`;

      const ensemble = await ensembleManager.importElement(maliciousYaml, 'yaml');

      // Verify the ensemble was created successfully with sanitized inputs
      expect(ensemble.metadata.name).toBe('Safe Name Test');
      expect(ensemble.metadata.description).toBe('Test description without HTML');
      expect(ensemble.metadata.elements[0].element_name).toBe('safe-element-name');
    });

    it('should log security events', async () => {
      await ensembleManager.create({ name: 'Security Test', description: 'A test ensemble for security event logging' });

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.any(String),
          source: expect.stringContaining('EnsembleManager')
        })
      );
    });

    it('should validate path for security', () => {
      expect(ensembleManager.validatePath('../../../etc/passwd')).toBe(false);
      expect(ensembleManager.validatePath('/absolute/path.md')).toBe(false);
      expect(ensembleManager.validatePath('valid-ensemble.md')).toBe(true);
    });
  });

  describe('File Extension', () => {
    it('should return correct file extension', () => {
      expect(ensembleManager.getFileExtension()).toBe('.md');
    });
  });

  describe('Element Type', () => {
    it('should return correct element type', () => {
      expect(ensembleManager.getElementType()).toBe(ElementType.ENSEMBLE);
    });
  });

  describe('resolveElementTypes (#466)', () => {
    it('should pass through elements that already have element_type', async () => {
      const elements = [
        { element_name: 'my-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, {});
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].element_type).toBe('skill');
      expect(result.ambiguous).toHaveLength(0);
      expect(result.notFound).toHaveLength(0);
    });

    it('should pass through elements with legacy type field', async () => {
      const elements = [
        { element_name: 'my-skill', type: 'template', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, {});
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].type).toBe('template');
    });

    it('should resolve element_type when found in exactly one manager', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue({ metadata: { name: 'found-skill' } }) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
      };

      const elements = [
        { element_name: 'found-skill', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].element_type).toBe('skill');
      expect(result.resolved[0].element_name).toBe('found-skill');
    });

    it('should report ambiguous elements found in multiple types', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue({ metadata: { name: 'ambiguous' } }) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue({ metadata: { name: 'ambiguous' } }) },
      };

      const elements = [
        { element_name: 'ambiguous', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(0);
      expect(result.ambiguous).toHaveLength(1);
      expect(result.ambiguous[0].element_name).toBe('ambiguous');
      expect(result.ambiguous[0].found_in).toEqual(['skill', 'template']);
    });

    it('should report elements not found in any manager', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
      };

      const elements = [
        { element_name: 'ghost-element', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(0);
      expect(result.notFound).toEqual(['ghost-element']);
    });

    it('should resolve persona via findPersona method', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
        personaManager: { findPersona: jest.fn<(name: string) => any>().mockReturnValue({ metadata: { name: 'my-persona' } }) },
      };

      const elements = [
        { element_name: 'my-persona', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].element_type).toBe('persona');
    });

    it('should handle mixed elements: some with type, some needing resolution', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockImplementation(async (name: string) => {
          return name === 'found-template' ? { metadata: { name: 'found-template' } } : undefined;
        }) },
      };

      const elements = [
        { element_name: 'explicit-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
        { element_name: 'found-template', role: 'support', priority: 50, activation: 'always' },
        { element_name: 'not-found', role: 'support', priority: 30, activation: 'always' },
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(2);
      expect(result.resolved[0].element_name).toBe('explicit-skill');
      expect(result.resolved[0].element_type).toBe('skill');
      expect(result.resolved[1].element_name).toBe('found-template');
      expect(result.resolved[1].element_type).toBe('template');
      expect(result.notFound).toEqual(['not-found']);
    });

    it('should handle manager errors gracefully', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockRejectedValue(new Error('manager error')) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue({ metadata: { name: 'found' } }) },
      };

      const elements = [
        { element_name: 'found', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].element_type).toBe('template');
    });

    it('should validate resolved types against canonical element type map', async () => {
      const mockManagers = {
        skillManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue({ metadata: { name: 'valid-skill' } }) },
        templateManager: { findByName: jest.fn<(name: string) => Promise<any>>().mockResolvedValue(undefined) },
      };

      const elements = [
        { element_name: 'valid-skill', role: 'primary', priority: 80, activation: 'always' }
      ];

      const result = await resolveElementTypes(elements, mockManagers);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].element_type).toBe('skill');
    });
  });

  describe('Create with pre-resolved elements (#466)', () => {
    it('should accept elements with pre-resolved element_type', async () => {
      const metadata: any = {
        name: 'Pre-Resolved Ensemble',
        description: 'Tests that create accepts pre-resolved elements',
        elements: [
          {
            element_name: 'resolved-skill',
            element_type: 'skill',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      const ensemble = await ensembleManager.create(metadata);
      expect(ensemble.metadata.elements[0].element_type).toBe('skill');
    });

    it('should throw when element has no element_type', async () => {
      const metadata: any = {
        name: 'No Type',
        description: 'Should throw because no type provided',
        elements: [
          {
            element_name: 'typeless-element',
            role: 'primary',
            priority: 80,
            activation: 'always'
          }
        ]
      };

      await expect(ensembleManager.create(metadata)).rejects.toThrow(/missing required.*element_type/);
    });
  });

  describe('List', () => {
    it('should list all ensembles', async () => {
      const testFiles = ['ensemble1.md', 'ensemble2.md'];
      mockPortfolioManager.listElements.mockResolvedValue(testFiles);

      // Mock file reads
      const fileContent1 = `---
name: Ensemble 1
elements: []
---
`;
      const fileContent2 = `---
name: Ensemble 2
elements: []
---
`;

      // Use mockImplementation to return based on filename for deterministic ordering
      // BaseElementManager.list() uses Promise.all() which executes in parallel,
      // so mockResolvedValueOnce may return in unpredictable order
      (fileLockManager.atomicReadFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('ensemble1')) return Promise.resolve(fileContent1);
        if (filePath.includes('ensemble2')) return Promise.resolve(fileContent2);
        return Promise.reject(new Error('Unknown file'));
      });

      const ensembles = await ensembleManager.list();

      expect(ensembles.length).toBe(2);
      expect(ensembles[0].metadata.name).toBe('Ensemble 1');
      expect(ensembles[1].metadata.name).toBe('Ensemble 2');
    });

    it('should return empty array when directory does not exist', async () => {
      mockPortfolioManager.listElements.mockRejectedValue({ code: 'ENOENT' });

      const ensembles = await ensembleManager.list();

      expect(ensembles).toEqual([]);
    });
  });

  describe('Delete', () => {
    it('should delete ensemble file', async () => {
      const filePath = 'delete-test.md';
      const fullPath = path.join(portfolioPath, 'ensembles', filePath);

      // Create dummy file
      await fs.writeFile(fullPath, '# Test', 'utf-8');

      await ensembleManager.delete(filePath);

      const exists = await fs.access(fullPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should log deletion', async () => {
      const filePath = 'log-test.md';
      const fullPath = path.join(portfolioPath, 'ensembles', filePath);

      await fs.writeFile(fullPath, '# Test', 'utf-8');
      await ensembleManager.delete(filePath);

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.stringContaining('EnsembleManager.delete')
        })
      );
    });
  });

  describe('Activation — stale cache regression (#1895)', () => {
    it('should return fresh element count after external file edit', async () => {
      const ensemblesDir = path.join(portfolioPath, 'ensembles');
      const fileName = 'dqm-stack.md';
      const filePath = path.join(ensemblesDir, fileName);

      const originalContent = `---
name: DQM Stack
description: Test ensemble
elements:
  - element_name: skill1
    element_type: skills
    role: primary
    priority: 80
    activation: always
  - element_name: skill2
    element_type: skills
    role: support
    priority: 50
    activation: always
---
`;
      const updatedContent = `---
name: DQM Stack
description: Test ensemble
elements:
  - element_name: skill1
    element_type: skills
    role: primary
    priority: 80
    activation: always
  - element_name: skill2
    element_type: skills
    role: support
    priority: 50
    activation: always
  - element_name: new-skill
    element_type: skills
    role: support
    priority: 30
    activation: always
---
`;

      // Write initial file and warm the cache
      await fs.writeFile(filePath, originalContent, 'utf-8');
      mockPortfolioManager.listElements.mockResolvedValue([fileName]);
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(originalContent);

      // list() triggers a scan that stores the mtime and populates the LRU cache
      const initial = await ensembleManager.list();
      expect(initial[0].metadata.elements.length).toBe(2);

      // Simulate external edit: overwrite file on disk (changing mtime) and update mock
      await fs.writeFile(filePath, updatedContent, 'utf-8');
      // Advance mtime explicitly to guarantee the scan sees a change
      const futureTime = new Date(Date.now() + 5000);
      await fs.utimes(filePath, futureTime, futureTime);
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(updatedContent);

      // activateEnsemble must call scanAndEvict() so the LRU entry is flushed
      const result = await ensembleManager.activateEnsemble('DQM Stack');

      expect(result.success).toBe(true);
      // Without the fix, this returns 2 (stale cache). With the fix, it returns 3.
      expect(result.ensemble?.metadata.elements.length).toBe(3);
    });

    it('should not return stale data on repeated activate-deactivate-activate cycle', async () => {
      const ensemblesDir = path.join(portfolioPath, 'ensembles');
      const fileName = 'cycle-ensemble.md';
      const filePath = path.join(ensemblesDir, fileName);

      const v1 = `---\nname: Cycle Ensemble\nelements:\n  - element_name: a\n    element_type: skills\n    role: primary\n    priority: 80\n    activation: always\n---\n`;
      const v2 = `---\nname: Cycle Ensemble\nelements:\n  - element_name: a\n    element_type: skills\n    role: primary\n    priority: 80\n    activation: always\n  - element_name: b\n    element_type: skills\n    role: support\n    priority: 50\n    activation: always\n---\n`;

      await fs.writeFile(filePath, v1, 'utf-8');
      mockPortfolioManager.listElements.mockResolvedValue([fileName]);
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(v1);
      await ensembleManager.list();

      // First activation: should get v1 (1 element)
      const r1 = await ensembleManager.activateEnsemble('Cycle Ensemble');
      expect(r1.ensemble?.metadata.elements.length).toBe(1);

      await ensembleManager.deactivateEnsemble('Cycle Ensemble');

      // External edit between cycles
      await fs.writeFile(filePath, v2, 'utf-8');
      const futureTime = new Date(Date.now() + 5000);
      await fs.utimes(filePath, futureTime, futureTime);
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(v2);

      // Second activation: must NOT serve stale 1-element cache
      const r2 = await ensembleManager.activateEnsemble('Cycle Ensemble');
      expect(r2.ensemble?.metadata.elements.length).toBe(2);
    });
  });

  describe('element quality — markdown body (#696)', () => {
    it('generated file contains a markdown body section', async () => {
      const ensemble = await ensembleManager.create({
        name: 'Body Test',
        description: 'Tests that ensembles get a markdown body',
        elements: [
          { element_name: 'test-skill', element_type: 'skill', role: 'primary', priority: 50, activation: 'always' }
        ]
      });

      expect(ensemble.metadata.name).toBe('Body Test');

      // Verify the written content includes a markdown body
      const writeCall = (fileLockManager.atomicWriteFile as jest.Mock).mock.calls[
        (fileLockManager.atomicWriteFile as jest.Mock).mock.calls.length - 1
      ];
      const [, content] = writeCall as [string, string];

      // File should have content after the closing ---
      expect(content).toMatch(/---\s*\n[\s\S]+\n---\s*\n[\s\S]+/);
      expect(content).toContain('Body Test');
    });

    it('loads ensemble with legacy role "core" (#695)', async () => {
      const fileContent = `---
name: Legacy Ensemble
description: An older ensemble using the core role
version: 1.0.0
author: test
activationStrategy: sequential
conflictResolution: priority
contextSharing: none
allowNested: false
maxNestingDepth: 1
elements:
  - element_name: my-skill
    element_type: skill
    role: core
    priority: 50
    activation: always
---

# Legacy Ensemble
`;
      const ensemblesDir = path.join(portfolioPath, 'ensembles');
      await fs.writeFile(path.join(ensemblesDir, 'legacy-ensemble.md'), fileContent, 'utf-8');
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValueOnce(fileContent);

      // Should load without throwing
      const loaded = await ensembleManager.load('legacy-ensemble.md');
      expect(loaded.metadata.name).toBe('Legacy Ensemble');
      expect(loaded.metadata.elements[0].role).toBe('core');
    });

    it('loads ensemble with em-dash in description (#695)', async () => {
      const fileContent = `---
name: Em-Dash Test
description: "Business advisor — strategic planning"
version: 1.0.0
author: test
activationStrategy: sequential
conflictResolution: priority
contextSharing: none
allowNested: false
maxNestingDepth: 1
elements:
  - element_name: my-skill
    element_type: skill
    role: primary
    priority: 50
    activation: always
---
`;
      const ensemblesDir = path.join(portfolioPath, 'ensembles');
      await fs.writeFile(path.join(ensemblesDir, 'emdash-ensemble.md'), fileContent, 'utf-8');
      (fileLockManager.atomicReadFile as jest.Mock).mockResolvedValueOnce(fileContent);

      const loaded = await ensembleManager.load('emdash-ensemble.md');
      expect(loaded.metadata.description).toContain('—');
    });
  });
});

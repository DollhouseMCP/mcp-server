import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import type { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import type { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import type { TemplateRenderer } from '../../../src/utils/TemplateRenderer.js';
import type { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import type { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import type { PersonaHandler } from '../../../src/handlers/PersonaHandler.js';
import type { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';

describe('ElementCRUDHandler (DI)', () => {
  let handler: ElementCRUDHandler;
  let skillManager: jest.Mocked<SkillManager>;
  let templateManager: jest.Mocked<TemplateManager>;
  let templateRenderer: jest.Mocked<TemplateRenderer>;
  let agentManager: jest.Mocked<AgentManager>;
  let memoryManager: jest.Mocked<MemoryManager>;
  let ensembleManager: jest.Mocked<EnsembleManager>;
  let personaHandler: jest.Mocked<PersonaHandler>;
  let portfolioManager: jest.Mocked<PortfolioManager>;
  let initService: jest.Mocked<InitializationService>;
  let indicatorService: jest.Mocked<PersonaIndicatorService>;
  let fileOperations: jest.Mocked<IFileOperationsService>;

  beforeEach(() => {
    skillManager = {
      create: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    } as unknown as jest.Mocked<SkillManager>;

    templateManager = {
      create: jest.fn(),
    } as unknown as jest.Mocked<TemplateManager>;

    templateRenderer = {
      render: jest.fn(),
    } as unknown as jest.Mocked<TemplateRenderer>;

    agentManager = {
      create: jest.fn(),
    } as unknown as jest.Mocked<AgentManager>;

    memoryManager = {
      save: jest.fn(),
    } as unknown as jest.Mocked<MemoryManager>;

    ensembleManager = {
      list: jest.fn(),
    } as unknown as jest.Mocked<EnsembleManager>;

    personaHandler = {
      getActivePersona: jest.fn(),
    } as unknown as jest.Mocked<PersonaHandler>;

    portfolioManager = {
      getElementDir: jest.fn(),
      getFileExtension: jest.fn(),
    } as unknown as jest.Mocked<PortfolioManager>;

    initService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<InitializationService>;

    indicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>'),
    } as unknown as jest.Mocked<PersonaIndicatorService>;

    fileOperations = {
      readFile: jest.fn(),
      readElementFile: jest.fn(),
      writeFile: jest.fn(),
      deleteFile: jest.fn(),
      createDirectory: jest.fn(),
      listDirectory: jest.fn(),
      renameFile: jest.fn(),
      exists: jest.fn(),
      stat: jest.fn(),
      resolvePath: jest.fn(),
      validatePath: jest.fn(),
      createFileExclusive: jest.fn(),
    } as unknown as jest.Mocked<IFileOperationsService>;

    handler = new ElementCRUDHandler(
      skillManager,
      templateManager,
      templateRenderer,
      agentManager,
      memoryManager,
      ensembleManager,
      personaHandler,
      portfolioManager,
      initService,
      indicatorService,
      fileOperations
    );
  });

  it('ensures initialization and delegates to skill manager for create', async () => {
    skillManager.create.mockResolvedValue({ metadata: { name: 'created' } } as any);

    const result = await handler.createElement({
      name: 'my-skill',
      type: ElementType.SKILL,
      description: 'desc',
    });

    expect(initService.ensureInitialized).toHaveBeenCalled();
    expect(skillManager.create).toHaveBeenCalled();
    expect(result.content[0].text).toContain('✅');
  });

  it('prefixes persona indicator when creation fails', async () => {
    skillManager.create.mockRejectedValue(new Error('boom'));

    const result = await handler.createElement({
      name: 'my-skill',
      type: ElementType.SKILL,
      description: 'desc',
    });

    expect(result.content[0].text.startsWith('>>')).toBe(true);
    expect(result.content[0].text).toContain('Failed to create skill');
  });

  describe('getElementDetails', () => {
    it('should return details for ensemble element', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'Test Ensemble',
          description: 'Test description',
          version: '1.0.0',
          activationStrategy: 'sequential',
          conflictResolution: 'last-write',
          contextSharing: 'selective',
          allowNested: true,
          maxNestingDepth: 5,
          elements: [
            {
              element_name: 'skill1',
              element_type: 'skill',
              role: 'primary',
              priority: 80,
              activation: 'always'
            },
            {
              element_name: 'agent1',
              element_type: 'agent',
              role: 'support',
              priority: 50,
              activation: 'on-demand'
            }
          ]
        },
        getStatus: jest.fn().mockReturnValue('inactive')
      };

      ensembleManager.list = jest.fn().mockResolvedValue([mockEnsemble]);

      const result = await handler.getElementDetails('Test Ensemble', ElementType.ENSEMBLE);

      expect(ensembleManager.list).toHaveBeenCalled();
      expect(result.content[0].text).toContain('🎭');
      expect(result.content[0].text).toContain('Test Ensemble');
      expect(result.content[0].text).toContain('Test description');
      expect(result.content[0].text).toContain('sequential');
      expect(result.content[0].text).toContain('last-write');
      expect(result.content[0].text).toContain('**Elements** (2)'); // Markdown bold formatting
      expect(result.content[0].text).toContain('skill1');
      expect(result.content[0].text).toContain('agent1');
    });

    it('should throw ElementNotFoundError for missing ensemble', async () => {
      ensembleManager.list = jest.fn().mockResolvedValue([]);

      // Issue #275: Now throws error instead of returning error content
      await expect(handler.getElementDetails('NonExistent', ElementType.ENSEMBLE))
        .rejects.toThrow('Ensemble \'NonExistent\' not found');
    });

    it('should return error for unknown element type', async () => {
      const result = await handler.getElementDetails('test', 'invalid-type' as any);

      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Unknown element type');
    });

    it('should normalize ensemble type variations', async () => {
      const mockEnsemble = {
        metadata: {
          name: 'Test',
          description: 'Test',
          elements: []
        },
        getStatus: jest.fn().mockReturnValue('inactive')
      };

      ensembleManager.list = jest.fn().mockResolvedValue([mockEnsemble]);

      // Test with 'ensembles' (plural)
      const result1 = await handler.getElementDetails('Test', 'ensembles' as any);
      expect(result1.content[0].text).toContain('🎭');

      // Test with 'ensemble' (singular)
      const result2 = await handler.getElementDetails('Test', 'ensemble' as any);
      expect(result2.content[0].text).toContain('🎭');
    });
  });
});

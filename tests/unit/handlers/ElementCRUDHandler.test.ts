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
import type { ActivationStore } from '../../../src/services/ActivationStore.js';

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
      getActiveSkills: jest.fn().mockResolvedValue([]),
      refreshIndex: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(undefined),
      deactivateSkill: jest.fn().mockResolvedValue({ success: true, message: 'deactivated' }),
    } as unknown as jest.Mocked<SkillManager>;

    templateManager = {
      create: jest.fn(),
    } as unknown as jest.Mocked<TemplateManager>;

    templateRenderer = {
      render: jest.fn(),
    } as unknown as jest.Mocked<TemplateRenderer>;

    agentManager = {
      create: jest.fn(),
      getActiveAgents: jest.fn().mockResolvedValue([]),
      deactivateAgent: jest.fn().mockResolvedValue({ success: true, message: 'deactivated' }),
      list: jest.fn().mockResolvedValue([]),
      refreshIndex: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(undefined),
      getActivationIdentity: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<AgentManager>;

    memoryManager = {
      save: jest.fn(),
      getActiveMemories: jest.fn().mockResolvedValue([]),
      refreshIndex: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(undefined),
      deactivateMemory: jest.fn().mockResolvedValue({ success: true, message: 'deactivated' }),
    } as unknown as jest.Mocked<MemoryManager>;

    ensembleManager = {
      list: jest.fn(),
      getActiveEnsembles: jest.fn().mockResolvedValue([]),
      refreshIndex: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(undefined),
      deactivateEnsemble: jest.fn().mockResolvedValue({ success: true, message: 'deactivated' }),
    } as unknown as jest.Mocked<EnsembleManager>;

    personaHandler = {
      getActivePersona: jest.fn(),
      getActivePersonas: jest.fn().mockReturnValue([]),
      resolveActivePersonas: jest.fn().mockResolvedValue([]),
      refreshIndex: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(undefined),
      deactivatePersona: jest.fn().mockReturnValue({ success: true, message: 'deactivated' }),
      findPersona: jest.fn(),
      list: jest.fn().mockReturnValue([]),
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

  describe('policy reporting helpers', () => {
    it('includes active agents in getActiveElementsForPolicy()', async () => {
      agentManager.getActiveAgents.mockResolvedValue([
        {
          metadata: {
            name: 'autonomy-scout-demo',
            gatekeeper: {
              externalRestrictions: {
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        } as any,
      ]);

      const result = await handler.getActiveElementsForPolicy();

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'agent',
          name: 'autonomy-scout-demo',
        }),
      ]));
    });

    it('indexes each ensemble-member type once without full catalog loads', async () => {
      ensembleManager.getActiveEnsembles.mockResolvedValue([{
        metadata: {
          name: 'policy-team',
          elements: [
            { element_type: 'skill', element_name: 'policy-skill' },
            { element_type: 'skills', element_name: 'policy-skill' },
            { element_type: 'skill', element_name: 'ordinary-skill' },
            { element_type: 'memory', element_name: 'policy-memory' },
          ],
        },
      } as any]);
      skillManager.list = jest.fn();
      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      skillManager.findByName = jest.fn(async (name: string) => name === 'policy-skill'
        ? {
          metadata: {
            name,
            gatekeeper: { externalRestrictions: { denyPatterns: ['Bash:rm*'] } },
          },
        } as any
        : undefined);
      memoryManager.list = jest.fn();
      memoryManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      memoryManager.findByName = jest.fn().mockResolvedValue({
        metadata: {
          name: 'policy-memory',
          gatekeeper: { externalRestrictions: { confirmPatterns: ['Bash:git push*'] } },
        },
      } as any);

      const result = await handler.getActiveElementsForPolicy();

      expect(skillManager.refreshIndex).toHaveBeenCalledTimes(1);
      expect(memoryManager.refreshIndex).toHaveBeenCalledTimes(1);
      expect(skillManager.findByName).toHaveBeenCalledTimes(2);
      expect(memoryManager.findByName).toHaveBeenCalledTimes(1);
      expect(skillManager.list).not.toHaveBeenCalled();
      expect(memoryManager.list).not.toHaveBeenCalled();
      expect(result.filter((element) => element.name === 'policy-skill')).toHaveLength(1);
      expect(result.filter((element) => element.name === 'policy-memory')).toHaveLength(1);
      expect(result).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ordinary-skill' }),
      ]));
    });

    it('keeps large ensemble policy scans linear in unique member count', async () => {
      const members = Array.from({ length: 500 }, (_, index) => ({
        element_type: index % 2 === 0 ? 'skill' : 'skills',
        element_name: `member-${index % 250}`,
      }));
      ensembleManager.getActiveEnsembles.mockResolvedValue([{
        metadata: { name: 'large-ensemble', elements: members },
      } as any]);
      skillManager.list = jest.fn();
      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      skillManager.findByName = jest.fn().mockResolvedValue(undefined);

      await handler.getActiveElementsForPolicy();

      expect(skillManager.refreshIndex).toHaveBeenCalledTimes(1);
      expect(skillManager.findByName).toHaveBeenCalledTimes(250);
      expect(skillManager.list).not.toHaveBeenCalled();
    });

    it('bounds concurrent ensemble-member lookups at eight', async () => {
      const members = Array.from({ length: 20 }, (_, index) => ({
        element_type: 'skill',
        element_name: `member-${index}`,
      }));
      ensembleManager.getActiveEnsembles.mockResolvedValue([{
        metadata: { name: 'large-policy-team', elements: members },
      } as any]);
      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);

      let inFlight = 0;
      let maxInFlight = 0;
      let releaseLookups!: () => void;
      let markCeilingReached!: () => void;
      const lookupsBlocked = new Promise<void>((resolve) => {
        releaseLookups = resolve;
      });
      const ceilingReached = new Promise<void>((resolve) => {
        markCeilingReached = resolve;
      });
      skillManager.findByName = jest.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (maxInFlight === 8) markCeilingReached();
        await lookupsBlocked;
        inFlight -= 1;
        return undefined;
      });

      const snapshot = handler.getActiveElementsForPolicy();
      await ceilingReached;
      expect(skillManager.findByName).toHaveBeenCalledTimes(8);
      releaseLookups();
      await snapshot;

      expect(skillManager.findByName).toHaveBeenCalledTimes(20);
      expect(maxInFlight).toBe(8);
    });

    it('coalesces overlapping reporting snapshots in the same session', async () => {
      let releaseEnsembles!: () => void;
      const ensemblesBlocked = new Promise<void>((resolve) => {
        releaseEnsembles = resolve;
      });
      ensembleManager.getActiveEnsembles.mockImplementation(async () => {
        await ensemblesBlocked;
        return [];
      });

      const snapshots = [
        handler.getActiveElementsForPolicy(),
        handler.getActiveElementsForPolicy(),
        handler.getActiveElementsForPolicy(),
      ];
      releaseEnsembles();
      await Promise.all(snapshots);

      expect(ensembleManager.getActiveEnsembles).toHaveBeenCalledTimes(1);
    });

    it('does not share reporting snapshots across session scopes', async () => {
      let currentSession = 'session-a';
      const contextTracker = {
        getSessionContext: jest.fn(() => ({ sessionId: currentSession })),
      };
      const scopedHandler = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        undefined,
        undefined,
        undefined,
        undefined,
        contextTracker as any,
      );
      let releaseEnsembles!: () => void;
      const ensemblesBlocked = new Promise<void>((resolve) => {
        releaseEnsembles = resolve;
      });
      ensembleManager.getActiveEnsembles.mockImplementation(async () => {
        await ensemblesBlocked;
        return [];
      });

      const firstSessionSnapshot = scopedHandler.getActiveElementsForPolicy();
      currentSession = 'session-b';
      const secondSessionSnapshot = scopedHandler.getActiveElementsForPolicy();
      releaseEnsembles();
      await Promise.all([firstSessionSnapshot, secondSessionSnapshot]);

      expect(ensembleManager.getActiveEnsembles).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce enforcement onto an in-flight reporting snapshot', async () => {
      let markReportingStarted!: () => void;
      let releaseReporting!: () => void;
      const reportingStarted = new Promise<void>((resolve) => {
        markReportingStarted = resolve;
      });
      const reportingBlocked = new Promise<void>((resolve) => {
        releaseReporting = resolve;
      });
      ensembleManager.getActiveEnsembles
        .mockImplementationOnce(async () => {
          markReportingStarted();
          await reportingBlocked;
          return [];
        })
        .mockResolvedValueOnce([]);

      const reportingSnapshot = handler.getActiveElementsForPolicy();
      await reportingStarted;
      await handler.getActiveElementsForPolicy({ allowCoalescing: false });

      expect(ensembleManager.getActiveEnsembles).toHaveBeenCalledTimes(2);
      expect(personaHandler.refreshIndex).toHaveBeenCalledWith({ freshAfterInFlight: true });
      expect(skillManager.refreshIndex).toHaveBeenCalledWith({ freshAfterInFlight: true });
      expect(ensembleManager.refreshIndex).toHaveBeenCalledWith({ freshAfterInFlight: true });
      expect(personaHandler.resolveActivePersonas).toHaveBeenCalledTimes(1);
      expect(agentManager.getActiveAgents).toHaveBeenLastCalledWith({ freshAfterInFlight: true });
      releaseReporting();
      await reportingSnapshot;
    });

    it('merges persisted activation snapshots into reportable policy elements', async () => {
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([
          {
            sessionId: 'session-other',
            lastUpdated: new Date().toISOString(),
            activations: {
              skill: [{ name: 'audit-trace-demo', activatedAt: new Date().toISOString() }],
            },
          },
        ]),
      } as unknown as jest.Mocked<ActivationStore>;

      skillManager.getActiveSkills = jest.fn().mockResolvedValue([]);
      skillManager.list = jest.fn();
      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      skillManager.findByName = jest.fn().mockResolvedValue({
        metadata: {
          name: 'audit-trace-demo',
          gatekeeper: {
            externalRestrictions: {
              confirmPatterns: ['Bash:git push*'],
            },
          },
        },
      } as any);

      const reportHandler = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        activationStore,
      );

      const result = await reportHandler.getPolicyElementsForReport('session-other');

      expect(result).toEqual([
        expect.objectContaining({
          type: 'skill',
          name: 'audit-trace-demo',
          sessionIds: ['session-other'],
        }),
      ]);
      expect(activationStore.listPersistedActivationStates).toHaveBeenCalledWith('session-other');
      expect(skillManager.refreshIndex).toHaveBeenCalledTimes(1);
      expect(skillManager.findByName).toHaveBeenCalledWith('audit-trace-demo');
      expect(skillManager.list).not.toHaveBeenCalled();
    });

    it('deduplicates live and persisted agent policy by durable identity after rename', async () => {
      const identity = { kind: 'file' as const, value: 'stable-agent.md' };
      const policyAgent = {
        filePath: identity.value,
        metadata: {
          name: 'Renamed Agent',
          gatekeeper: { externalRestrictions: { denyPatterns: ['Bash:rm*'] } },
        },
      } as any;
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([{
          sessionId: 'session-other',
          lastUpdated: new Date().toISOString(),
          activations: {
            agent: [{ name: 'Original Agent', identity, activatedAt: new Date().toISOString() }],
          },
        }]),
      } as unknown as jest.Mocked<ActivationStore>;
      agentManager.getActiveAgents.mockResolvedValue([policyAgent]);
      agentManager.getActivationIdentity.mockReturnValue(identity);
      agentManager.refreshIndex.mockResolvedValue(undefined);
      agentManager.findByStorageIdentity = jest.fn().mockResolvedValue(policyAgent);

      const reportHandler = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        activationStore,
      );

      const result = await reportHandler.getPolicyElementsForReport();

      expect(result).toEqual([
        expect.objectContaining({
          type: 'agent',
          name: 'Renamed Agent',
          sessionIds: ['leader-session', 'session-other'],
        }),
      ]);
      expect(agentManager.findByStorageIdentity).toHaveBeenCalledWith(identity.value);
      expect(agentManager.findByName).not.toHaveBeenCalledWith('Original Agent');
    });

    it('reports a live-only persona by stable filename identity', async () => {
      personaHandler.getActivePersonas.mockReturnValue([{
        filename: 'policy-persona.md',
        metadata: {
          name: 'Policy Persona',
          gatekeeper: { externalRestrictions: { denyPatterns: ['Bash:rm*'] } },
        },
      } as any]);

      const result = await handler.getPolicyElementsForReport();

      expect(result).toEqual([
        expect.objectContaining({ type: 'persona', name: 'Policy Persona' }),
      ]);
    });

    it('reports a persisted-only persona through its stable filename', async () => {
      const persistedPersona = {
        filename: 'policy-persona.md',
        filePath: 'policy-persona.md',
        metadata: {
          name: 'Renamed Policy Persona',
          gatekeeper: { externalRestrictions: { denyPatterns: ['Bash:rm*'] } },
        },
      } as any;
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([{
          sessionId: 'session-other',
          lastUpdated: new Date().toISOString(),
          activations: {
            persona: [{
              name: 'Original Policy Persona',
              filename: 'policy-persona.md',
              activatedAt: new Date().toISOString(),
            }],
          },
        }]),
      } as unknown as jest.Mocked<ActivationStore>;
      personaHandler.findByName.mockImplementation(async (identifier: string) =>
        identifier === 'policy-persona.md' ? persistedPersona : undefined
      );

      const reportHandler = new ElementCRUDHandler(
        skillManager, templateManager, templateRenderer, agentManager, memoryManager,
        ensembleManager, personaHandler, portfolioManager, initService, indicatorService,
        fileOperations, undefined as any, undefined as any, activationStore,
      );

      const result = await reportHandler.getPolicyElementsForReport('session-other');

      expect(result).toEqual([
        expect.objectContaining({
          type: 'persona',
          name: 'Renamed Policy Persona',
          sessionIds: ['session-other'],
        }),
      ]);
      expect(personaHandler.findByName).toHaveBeenCalledWith('Original Policy Persona');
      expect(personaHandler.findByName).toHaveBeenCalledWith('policy-persona.md');
    });

    it('deduplicates combined live and persisted persona policy by stable filename', async () => {
      const policyPersona = {
        filename: 'policy-persona.md',
        filePath: 'policy-persona.md',
        metadata: {
          name: 'Renamed Policy Persona',
          gatekeeper: { externalRestrictions: { denyPatterns: ['Bash:rm*'] } },
        },
      } as any;
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([{
          sessionId: 'session-other',
          lastUpdated: new Date().toISOString(),
          activations: {
            persona: [{
              name: 'Original Policy Persona',
              filename: 'policy-persona.md',
              activatedAt: new Date().toISOString(),
            }],
          },
        }]),
      } as unknown as jest.Mocked<ActivationStore>;
      personaHandler.getActivePersonas.mockReturnValue([policyPersona]);
      personaHandler.findByName.mockImplementation(async (identifier: string) =>
        identifier === 'policy-persona.md' ? policyPersona : undefined
      );

      const reportHandler = new ElementCRUDHandler(
        skillManager, templateManager, templateRenderer, agentManager, memoryManager,
        ensembleManager, personaHandler, portfolioManager, initService, indicatorService,
        fileOperations, undefined as any, undefined as any, activationStore,
      );

      const result = await reportHandler.getPolicyElementsForReport();

      expect(result).toEqual([
        expect.objectContaining({
          type: 'persona',
          name: 'Renamed Policy Persona',
          sessionIds: ['leader-session', 'session-other'],
        }),
      ]);
    });

    it('bounds persisted policy lookups at eight and preserves activation order', async () => {
      const activations = Array.from({ length: 20 }, (_, index) => ({
        name: `persisted-skill-${index}`,
        activatedAt: new Date().toISOString(),
      }));
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([{
          sessionId: 'session-other',
          lastUpdated: new Date().toISOString(),
          activations: { skill: activations },
        }]),
      } as unknown as jest.Mocked<ActivationStore>;

      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      let inFlight = 0;
      let maxInFlight = 0;
      let releaseLookups!: () => void;
      let markCeilingReached!: () => void;
      const lookupsBlocked = new Promise<void>((resolve) => {
        releaseLookups = resolve;
      });
      const ceilingReached = new Promise<void>((resolve) => {
        markCeilingReached = resolve;
      });
      skillManager.findByName = jest.fn(async (name: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (maxInFlight === 8) markCeilingReached();
        await lookupsBlocked;
        inFlight -= 1;
        return {
          metadata: {
            name,
            gatekeeper: { externalRestrictions: { confirmPatterns: ['Bash:git push*'] } },
          },
        } as any;
      });

      const reportHandler = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        activationStore,
      );

      const report = reportHandler.getPolicyElementsForReport('session-other');
      await ceilingReached;
      expect(skillManager.findByName).toHaveBeenCalledTimes(8);
      releaseLookups();
      const result = await report;

      expect(skillManager.findByName).toHaveBeenCalledTimes(20);
      expect(maxInFlight).toBe(8);
      expect(result.map((element) => element.name)).toEqual(
        activations.map((activation) => activation.name),
      );
    });

    it('does not leak the current session in-memory policies into another session report', async () => {
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('leader-session'),
        listPersistedActivationStates: jest.fn().mockResolvedValue([
          {
            sessionId: 'session-other',
            lastUpdated: new Date().toISOString(),
            activations: {
              skill: [{ name: 'audit-trace-demo', activatedAt: new Date().toISOString() }],
            },
          },
        ]),
      } as unknown as jest.Mocked<ActivationStore>;

      skillManager.getActiveSkills = jest.fn().mockResolvedValue([
        {
          metadata: {
            name: 'leader-only-skill',
            gatekeeper: {
              externalRestrictions: {
                denyPatterns: ['Bash:rm*'],
              },
            },
          },
        } as any,
      ]);
      skillManager.list = jest.fn();
      skillManager.refreshIndex = jest.fn().mockResolvedValue(undefined);
      skillManager.findByName = jest.fn(async (name: string) => {
        const elements = [
          {
            metadata: {
              name: 'audit-trace-demo',
              gatekeeper: {
                externalRestrictions: {
                  confirmPatterns: ['Bash:git push*'],
                },
              },
            },
          },
          {
            metadata: {
              name: 'leader-only-skill',
              gatekeeper: {
                externalRestrictions: {
                  denyPatterns: ['Bash:rm*'],
                },
              },
            },
          },
        ];
        return elements.find((element) => element.metadata.name === name) as any;
      });

      const reportHandler = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        activationStore,
      );

      const result = await reportHandler.getPolicyElementsForReport('session-other');

      expect(result).toEqual([
        expect.objectContaining({
          name: 'audit-trace-demo',
          sessionIds: ['session-other'],
        }),
      ]);
      expect(skillManager.refreshIndex).toHaveBeenCalledTimes(1);
      expect(skillManager.findByName).toHaveBeenCalledTimes(1);
      expect(skillManager.list).not.toHaveBeenCalled();
    });
  });

  describe('releaseDeadlock', () => {
    it('should deactivate all active elements and clear persisted session state', async () => {
      const activationStore = {
        isEnabled: jest.fn().mockReturnValue(true),
        getSessionId: jest.fn().mockReturnValue('session-lock'),
        clearAll: jest.fn(),
      } as unknown as jest.Mocked<ActivationStore>;

      personaHandler.getActivePersonas.mockReturnValue([
        { metadata: { name: 'Locked Persona' } } as any,
      ]);
      personaHandler.findPersona.mockReturnValue({ metadata: { name: 'Locked Persona' } } as any);
      skillManager.getActiveSkills.mockResolvedValue([
        { metadata: { name: 'locked-skill' } } as any,
      ]);
      agentManager.getActiveAgents.mockResolvedValue([
        { metadata: { name: 'locked-agent' } } as any,
      ]);
      memoryManager.getActiveMemories.mockResolvedValue([
        { metadata: { name: 'locked-memory' } } as any,
      ]);
      ensembleManager.getActiveEnsembles.mockResolvedValue([
        { metadata: { name: 'locked-ensemble' } } as any,
      ]);

      const handlerWithPersistence = new ElementCRUDHandler(
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
        fileOperations,
        undefined as any,
        undefined as any,
        activationStore,
      );

      const result = await handlerWithPersistence.releaseDeadlock();

      expect(result.sessionId).toBe('session-lock');
      expect(result.failed).toEqual([]);
      expect(result.persistedStateCleared).toBe(true);
      expect(result.activeBeforeReset).toEqual(expect.arrayContaining([
        { type: ElementType.PERSONA, name: 'Locked Persona' },
        { type: ElementType.SKILL, name: 'locked-skill' },
        { type: ElementType.AGENT, name: 'locked-agent' },
        { type: ElementType.MEMORY, name: 'locked-memory' },
        { type: ElementType.ENSEMBLE, name: 'locked-ensemble' },
      ]));
      expect(result.deactivated).toEqual(expect.arrayContaining([
        { type: ElementType.PERSONA, name: 'Locked Persona' },
        { type: ElementType.SKILL, name: 'locked-skill' },
        { type: ElementType.AGENT, name: 'locked-agent' },
        { type: ElementType.MEMORY, name: 'locked-memory' },
        { type: ElementType.ENSEMBLE, name: 'locked-ensemble' },
      ]));
      expect(result.likelyDeadlockCause).toEqual({
        advisoryElements: [],
      });
      expect(result.snapshotFile).toMatch(/[\\/]\.dollhouse[\\/]state[\\/]deadlock-relief[\\/]/);
      expect(personaHandler.deactivatePersona).toHaveBeenCalledWith('Locked Persona');
      expect(skillManager.deactivateSkill).toHaveBeenCalledWith('locked-skill');
      expect(agentManager.deactivateAgent).toHaveBeenCalledWith('locked-agent');
      expect(memoryManager.deactivateMemory).toHaveBeenCalledWith('locked-memory');
      expect(ensembleManager.deactivateEnsemble).toHaveBeenCalledWith('locked-ensemble');
      expect(activationStore.clearAll).toHaveBeenCalled();
      expect(fileOperations.createDirectory).toHaveBeenCalled();
      expect(fileOperations.writeFile).toHaveBeenCalled();
    });

    it('deactivates colliding agent names by durable identity during deadlock relief', async () => {
      const firstAgent = { filePath: 'first.md', metadata: { name: 'Shared Agent' } } as any;
      const secondAgent = { filePath: 'second.md', metadata: { name: 'Shared Agent' } } as any;
      agentManager.getActiveAgents.mockResolvedValue([firstAgent, secondAgent]);
      agentManager.getActivationIdentity.mockImplementation((agent) => ({
        kind: 'file',
        value: agent.filePath,
      }));

      const result = await handler.releaseDeadlock();

      expect(agentManager.deactivateAgent).toHaveBeenCalledWith('first.md');
      expect(agentManager.deactivateAgent).toHaveBeenCalledWith('second.md');
      expect(result.deactivated).toEqual([
        { type: ElementType.AGENT, name: 'Shared Agent' },
        { type: ElementType.AGENT, name: 'Shared Agent' },
      ]);
    });
  });
});

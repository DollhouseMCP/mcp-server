/**
 * Unit tests for AgentManager.read() flexible fallback (#607)
 *
 * Validates that execute_agent can find agents whose filenames don't
 * exactly match {normalizeFilename(name)}.md — e.g., legacy agents
 * with a `-agent` suffix or other non-standard naming.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import { load as parseYaml } from 'js-yaml';

jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/services/FileOperationsService.js');

import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { canonicalElementName } from '../../../../src/storage/ElementNameKeys.js';
import { ValidationError } from '../../../../src/security/errors.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService, TestableAgentManager } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';
import { ElementIndeterminateError } from '../../../../src/elements/base/ElementReadError.js';

const metadataService: MetadataService = createTestMetadataService();

const AGENT_CONTENT_STANDARD = `---
name: my-agent
type: agent
version: 1.0.0
description: Standard agent
decisionFramework: rule_based
specializations:
  - testing
---

# My Agent

Agent instructions`;

const AGENT_CONTENT_LEGACY = `---
name: legacy-poster
type: agent
version: 1.0.0
description: Legacy agent with -agent suffix filename
decisionFramework: rule_based
specializations:
  - posting
---

# Legacy Poster

Post things`;

const AGENT_CONTENT_LEGACY_V2 = `---
name: legacy-poster
type: agent
version: 2.0.0
description: Legacy filename with v2 metadata
goal:
  template: "Handle {objective}"
  parameters:
    - name: objective
      type: string
      required: true
---

# Legacy Poster

Handle the objective`;

const AGENT_CONTENT_WRONG_DIRECT_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: different-agent',
);

const AGENT_CONTENT_REQUESTED_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: requested-agent',
);

const AGENT_CONTENT_STORAGE_FALLBACK_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: "---"',
);

const AGENT_CONTENT_SHARED_NAME = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: shared-agent',
);

const AGENT_CONTENT_CASED_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: Case_Sensitive-Agent',
);

const AGENT_CONTENT_LOWER_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: case-sensitive-agent',
);

const ACTIVE_REQUESTED_STATE = `---
goals:
  - id: goal_requested_active
    description: Requested identity goal
    priority: high
    status: in_progress
    importance: 8
    urgency: 7
    createdAt: 2026-08-04T12:00:00Z
    updatedAt: 2026-08-04T12:01:00Z
decisions: []
context: {}
lastActive: 2026-08-04T12:01:00Z
sessionCount: 1
stateVersion: 2
---`;

describe('AgentManager.read() flexible fallback (#607)', () => {
  let agentManager: TestableAgentManager;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let container: InstanceType<typeof DollhouseContainer>;
  let fileOperationsService: jest.Mocked<FileOperationsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    testDir = path.join(os.tmpdir(), 'agent-read-test-' + Math.random().toString(36).substring(7));
    portfolioPath = testDir;

    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    container = new DollhouseContainer();
    container.replace<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    container.replace<FileLockManager>('FileLockManager', () => new FileLockManager());

    const mockFileOperations: any = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      readFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      listDirectory: jest.fn().mockResolvedValue([]),
      stat: jest.fn().mockResolvedValue({ isDirectory: () => true }),
      resolvePath: jest.fn((p: string) => path.resolve(portfolioPath, p)),
      validatePath: jest.fn().mockReturnValue(true),
      createFileExclusive: jest.fn().mockResolvedValue(true)
    };
    // BaseElementManager.load uses readElementFile. Wire dynamically so tests
    // that reassign readFile propagate to the element-read path.
    mockFileOperations.readElementFile = jest.fn((...args: unknown[]) => mockFileOperations.readFile(...args));
    mockFileOperations.auditElementRead = jest.fn();
    container.replace<FileOperationsService>('FileOperationsService', () => mockFileOperations as any);

    container.replace('SerializationService', () => new SerializationService());
    container.replace('MetadataService', () => metadataService);
    container.replace('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

    container.replace('AgentManager', () => new TestableAgentManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      baseDir: portfolioPath,
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(container.resolve('FileOperationsService')),
    }));

    agentManager = container.resolve<AgentManager>('AgentManager');
    fileOperationsService = container.resolve<FileOperationsService>('FileOperationsService') as jest.Mocked<FileOperationsService>;

    await agentManager.initialize();
    const storage = (agentManager as any).storageLayer;
    // Build metadata fixtures independently of the loader's counted content reads; the warm index
    // offers the same candidates the collection snapshot lists.
    const buildSnapshot = async (enumerate = true) => {
      const entries: Array<{ filePath: string; name: string }> = [];
      const unindexed = new Map();
      // A warm index read is not an enumeration: it uses the fixture listing without counting a call.
      const files = enumerate ? await mockPortfolioManager.listElements(ElementType.AGENT)
        : await (mockPortfolioManager.listElements.getMockImplementation()?.(ElementType.AGENT) ?? Promise.resolve([]));
      for (const filePath of files) {
        try {
          const content = await fileOperationsService.readFile.getMockImplementation()!(filePath);
          const metadata = parseYaml(content.split('---')[1]) as { name: string };
          entries.push({ filePath, name: metadata.name });
        } catch {
          unindexed.set(filePath, { name: 'Error', reason: 'Unreadable fixture', candidateNames: [path.basename(filePath, '.md')], unattributed: true });
        }
      }
      return { entries, unindexed, authoritative: true, complete: unindexed.size === 0, includesPublic: false,
        diff: { added: [], modified: [], removed: [], unchanged: [] } };
    };
    jest.spyOn(storage, 'readIndexedPath').mockImplementation(async () => {
      // The real layer is warm only after a successful scan; while enumeration fails it stays cold
      // (non-authoritative) and the read goes to the collection snapshot, which then fails.
      let snapshot;
      try { snapshot = await buildSnapshot(false); }
      catch { return { path: undefined, authoritative: false, indexComplete: false, unindexed: [], failures: new Map(), candidates: [] }; }
      return { path: undefined, authoritative: true, indexComplete: true, unindexed: [...snapshot.unindexed.keys()],
        failures: snapshot.unindexed, candidates: snapshot.entries.map(entry => ({ reference: entry.filePath, name: entry.name })) };
    });
    jest.spyOn(storage, 'readCollection').mockImplementation(buildSnapshot);
  });

  afterEach(async () => {
    await container.dispose();
  });

  describe('direct lookup succeeds', () => {
    it.each(['name', 'file', 'database'] as const)('retains an indeterminate %s activation and prunes only proven absence', async kind => {
      const key = kind === 'name' ? 'policy' : kind === 'file' ? path.join('agents', 'policy.md') : 'c471af79-2d4f-41bd-a97e-57a3f5244289';
      const active = agentManager['getActivationSet']();
      const aliases = agentManager['getActivationNameMap']();
      active.add(key);
      if (kind !== 'name') aliases.set(key, 'policy');
      const read = jest.spyOn(agentManager, kind === 'name' ? 'findByName' : 'findByStorageIdentity');
      read.mockRejectedValue(new ElementIndeterminateError('Discovery incomplete'));
      await agentManager['cleanupStaleActiveAgents']();
      expect(active.has(key)).toBe(true);
      read.mockResolvedValue(undefined);
      await agentManager['cleanupStaleActiveAgents']();
      expect(active.has(key)).toBe(false);
      expect(aliases.has(key)).toBe(false);
      read.mockRestore();
    });

    it('refuses path syntax before the database agent read runs its transaction', async () => {
      const resolveContentIdentity = jest.fn<any>().mockResolvedValue(undefined);
      (agentManager as unknown as { storageLayer: unknown }).storageLayer = { writeContent: jest.fn(), cachedInstanceCurrency: 'unverifiable', isExactStorageReference: () => false,
        readCollection: jest.fn(), readIndexedPath: jest.fn<any>().mockResolvedValue({ path: undefined, authoritative: true, indexComplete: true,
          unindexed: [], failures: new Map(), candidates: [] }), resolveContentIdentity };
      await expect(agentManager.read('team/../secret')).rejects.toBeInstanceOf(ValidationError);
      expect(resolveContentIdentity).not.toHaveBeenCalled();
    });

    it('resolves a database agent in a transaction on every read: ambiguity names the competing rows, absence is null', async () => {
      const competitors = ['c471af79-2d4f-41bd-a97e-57a3f5244289', 'd582bf80-3e5f-42ce-b08a-68b4f6355390'];
      const readCollection = jest.fn();
      const readIndexedPath = jest.fn();
      const resolveContentIdentity = jest.fn<any>().mockRejectedValue(
        Object.assign(new Error('Ambiguous element identity: ambiguous-agent'), { code: 'EAMBIGUOUS', competitors }));
      (agentManager as unknown as { storageLayer: unknown }).storageLayer = { writeContent: jest.fn(), cachedInstanceCurrency: 'unverifiable', isExactStorageReference: () => false, readCollection, readIndexedPath, resolveContentIdentity };
      const ambiguity = { name: 'ElementIndeterminateError', failures: competitors.map(reference => ({ reference, reason: 'Competing definition name' })) };

      await expect(agentManager.resolveExecutionIdentity('ambiguous-agent')).rejects.toMatchObject(ambiguity);
      await expect(agentManager.read('ambiguous-agent')).rejects.toMatchObject(ambiguity);
      await expect(agentManager.getAgentStateForRecovery({ agentName: 'ambiguous-agent' })).rejects.toMatchObject(ambiguity);
      expect(resolveContentIdentity).toHaveBeenCalledWith(ElementType.AGENT, 'ambiguous-agent');
      // Freshness comes from the transaction, not the warm index or a collection read.
      expect(readIndexedPath).not.toHaveBeenCalled();
      expect(readCollection).not.toHaveBeenCalled();
      resolveContentIdentity.mockResolvedValue(undefined);
      await expect(agentManager.read('ambiguous-agent')).resolves.toBeNull();
    });

    it('refuses a path-shaped agent name on its syntax for reads and execution, as findByName does', async () => {
      mockPortfolioManager.listElements.mockResolvedValue(['outside.md']);
      fileOperationsService.readFile.mockResolvedValue(AGENT_CONTENT_STANDARD.replace('name: my-agent', 'name: outside'));
      const reference = path.join('..', 'outside');
      await expect(agentManager.resolveExecutionIdentity(reference)).rejects.toThrow(ValidationError);
      await expect(agentManager.read(reference)).rejects.toThrow(ValidationError);
      await expect(agentManager.findByName(reference)).rejects.toThrow(ValidationError);
    });

    it('tries the raw filename after the slug when the index has no candidate', async () => {
      mockPortfolioManager.listElements.mockResolvedValue([]);
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'My.Agent.md') return AGENT_CONTENT_STANDARD.replace('name: my-agent', 'name: My.Agent');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const loader = agentManager as unknown as { loadElementDefinition(reference: string): Promise<Agent> };
      const loadDefinition = jest.spyOn(loader, 'loadElementDefinition');
      const identity = await agentManager.resolveExecutionIdentity('My.Agent');
      expect(identity.value).toBe('My.Agent.md');
      expect(loadDefinition.mock.calls).toEqual([['my-agent.md'], ['My.Agent.md']]);

      // Both candidates are started together, so filesystem preparation can reorder the reads.
      const reads = fileOperationsService.readFile.mock.calls
        .map(([filePath]) => path.basename(filePath as string).toLowerCase())
        .sort();
      expect(reads).toEqual(['my-agent.md', 'my.agent.md']);
    });

    it('guards a database lifecycle save with the name the row is stored under, for names the sanitiser would change', () => {
      const agent = new Agent({ name: "Q&A Bob's (Strict)" }, createTestMetadataService());
      const options = AgentManager.prototype['getLifecycleSaveOptions'].call({}, agent,
        { kind: 'database', value: 'f2a1c0de-0000-4000-8000-000000000001' }) as { expectedIdentity: { name: string } };
      // DatabaseStorageLayer.writeContent stores canonicalElementName(name); the guard must compare that same name.
      expect(options.expectedIdentity.name).toBe(canonicalElementName("Q&A Bob's (Strict)"));
    });

    it('answers absent when a database agent row vanishes between its identity read and its load', async () => {
      const resolveContentIdentity = jest.fn<any>().mockResolvedValue({ id: 'e693c091-4f5a-4b6b-8c7d-79c5f6a7b8c9', name: 'vanishing-agent' });
      (agentManager as unknown as { storageLayer: unknown }).storageLayer = { writeContent: jest.fn(), cachedInstanceCurrency: 'unverifiable', isExactStorageReference: () => false, resolveContentIdentity };
      const missing = Object.assign(new Error('Element definition does not exist'), { code: 'ENOENT' });
      // The resolved row is read through the loader route (never back through load()).
      jest.spyOn(agentManager as any, 'loadStoredReference').mockRejectedValue(missing);
      jest.spyOn(agentManager as any, 'loadElementDefinition').mockRejectedValue(missing);
      await expect(agentManager.read('vanishing-agent')).resolves.toBeNull();
      await expect(agentManager.resolveExecutionIdentity('vanishing-agent')).rejects.toMatchObject({ name: 'ElementNotFoundError' });
    });

    it('resolves canonical-colliding file agents to their real distinct storage paths', async () => {
      mockPortfolioManager.listElements.mockResolvedValue([
        'Case_Sensitive-Agent.md',
        'case-sensitive-agent.md',
      ]);
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'Case_Sensitive-Agent.md') return AGENT_CONTENT_CASED_IDENTITY;
        if (filename === 'case-sensitive-agent.md') return AGENT_CONTENT_LOWER_IDENTITY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const first = await agentManager.resolveExecutionIdentity('Case_Sensitive-Agent');
      const second = await agentManager.resolveExecutionIdentity('case-sensitive-agent');

      expect(first).toEqual({ kind: 'file', value: 'Case_Sensitive-Agent.md' });
      expect(second).toEqual({ kind: 'file', value: 'case-sensitive-agent.md' });
      expect(first).not.toEqual(second);
    });

    it('should return the agent without fallback', async () => {
      fileOperationsService.readFile.mockResolvedValue(AGENT_CONTENT_STANDARD);

      const agent = await agentManager.read('my-agent');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('my-agent');
    });

    it('should accept metadata that resolves to the requested storage fallback identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'unnamed.md') {
          return AGENT_CONTENT_STORAGE_FALLBACK_IDENTITY;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const agent = await agentManager.read('unnamed');

      expect(agent?.metadata.name).toBe('---');
      expect(mockPortfolioManager.listElements).not.toHaveBeenCalled();
    });

    it('should fall back when the direct filename contains a different agent', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'requested-agent.md') return AGENT_CONTENT_WRONG_DIRECT_IDENTITY;
        if (filename === 'legacy-requested-agent.md') return AGENT_CONTENT_REQUESTED_IDENTITY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'requested-agent.md',
        'legacy-requested-agent.md',
      ]);

      const agent = await agentManager.read('requested-agent');

      // The warm index certifies the selection; the mismatched direct file is never served.
      expect(agent?.metadata.name).toBe('requested-agent');
      expect(mockPortfolioManager.listElements).not.toHaveBeenCalled();
    });

    it('serves one definition on ordinary and strict reads and locks it for execution', async () => {
      const content = (name: string) => AGENT_CONTENT_STANDARD.replace('name: my-agent', `name: ${name}`);
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'a.md') return content('my agent');
        if (filename === 'my-agent.md') return content('My_Agent');
        if (filename === 'a.state.yaml') return ACTIVE_REQUESTED_STATE;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['a.md', 'my-agent.md']);

      const ordinary = await agentManager.read('my agent');
      const strict = await agentManager['readWithStatePolicy']('my agent', true);
      expect(ordinary?.metadata.name).toBe('my agent');
      expect(strict?.metadata.name).toBe('my agent');
      await expect(agentManager.resolveExecutionIdentity('my agent')).resolves.toEqual({ kind: 'file', value: 'a.md' });
    });

    it('refuses Q&A beside QA as one canonical name, and refuses the reference Q&A.md on its syntax', async () => {
      const content = (name: string) => AGENT_CONTENT_STANDARD.replace('name: my-agent', `name: ${JSON.stringify(name)}`);
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'qa-agent.md') return content('Q&A');
        if (filename === 'qa.md') return content('QA');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['qa-agent.md', 'qa.md']);

      // Q&A and QA canonicalise to one name: two definitions holding it are ambiguous, never one of them.
      await expect(agentManager.read('Q&A')).rejects.toMatchObject({ name: 'ElementIndeterminateError',
        failures: expect.arrayContaining([expect.objectContaining({ reference: 'qa-agent.md' }), expect.objectContaining({ reference: 'qa.md' })]) });
      await expect(agentManager.load('Q&A.md')).rejects.toThrow(ValidationError);
    });

    it('recovers through the certified definition without reading the direct filename first', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'requested-agent.md') return AGENT_CONTENT_WRONG_DIRECT_IDENTITY;
        if (filename === 'legacy-requested-agent.md') return AGENT_CONTENT_REQUESTED_IDENTITY;
        if (filename === 'legacy-requested-agent.state.yaml') return ACTIVE_REQUESTED_STATE;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['requested-agent.md', 'legacy-requested-agent.md']);
      const recovered = await agentManager.getAgentStateForRecovery({ agentName: 'requested-agent' });
      expect(recovered.state).toBeDefined();
      // The selector names legacy-requested-agent.md; the mismatched direct file is never hydrated.
      expect(fileOperationsService.readFile.mock.calls.map(([filePath]) => path.basename(filePath as string))).not.toContain('requested-agent.md');
    });

    it('should not attach requested recovery state to a mismatched direct definition', async () => {
      const stateReads: string[] = [];
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'requested-agent.md') return AGENT_CONTENT_WRONG_DIRECT_IDENTITY;
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          return ACTIVE_REQUESTED_STATE;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['requested-agent.md']);

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'requested-agent' }))
        .rejects.toThrow("Agent 'requested-agent' not found");
      expect(stateReads).toEqual([]);
    });
  });

  describe('direct lookup ENOENT + flexible match finds agent', () => {
    it('should fall back to flexible matching and return the agent', async () => {
      // Direct lookup: ENOENT (filename mismatch)
      // Flexible fallback via list(): returns the legacy-named file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('legacy-poster.md')) {
          // Direct lookup for "legacy-poster" — file doesn't exist at this path
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        if (filePath.includes('legacy-poster-agent.md')) {
          // The actual file on disk has "-agent" suffix
          return AGENT_CONTENT_LEGACY;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      // list() uses portfolioManager.listElements which returns filenames
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const agent = await agentManager.read('legacy-poster');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('legacy-poster');
    });

    it('should match case-insensitively on metadata name', async () => {
      const upperCaseContent = AGENT_CONTENT_LEGACY.replace(
        'name: legacy-poster',
        'name: Legacy-Poster'
      );

      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('legacy-poster-agent.md')) {
          return upperCaseContent;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const agent = await agentManager.read('legacy-poster');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('Legacy-Poster');
    });

    it('should preserve candidate-file state for ordinary flexible reads', async () => {
      const stateReads: string[] = [];
      const candidateState = ACTIVE_REQUESTED_STATE.replace(
        'goal_requested_active',
        'goal_candidate_active',
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          if (filename === 'legacy-poster-agent.state.yaml') {
            return candidateState;
          }
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const result = await agentManager.getAgentState({ agentName: 'legacy-poster' });

      expect(result.state.goals).toEqual([
        expect.objectContaining({ id: 'goal_candidate_active', status: 'in_progress' })
      ]);
      expect(stateReads).toEqual(['legacy-poster-agent.state.yaml']);
    });

    it('should hydrate strict recovery from the matched storage identity', async () => {
      const stateReads: string[] = [];
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          if (filename === 'legacy-poster-agent.state.yaml') {
            return ACTIVE_REQUESTED_STATE;
          }
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const result = await agentManager.getAgentStateForRecovery({ agentName: 'legacy-poster' });

      expect(result.state.goals).toEqual([
        expect.objectContaining({ id: 'goal_requested_active', status: 'in_progress' })
      ]);
      expect(stateReads).toEqual(['legacy-poster-agent.state.yaml']);
    });

    it('should return empty state for an ordinary flexible read with no requested state identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md' || filename.endsWith('.state.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') return AGENT_CONTENT_LEGACY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      await expect(agentManager.getAgentState({ agentName: 'legacy-poster' }))
        .resolves.toEqual(expect.objectContaining({
          agentName: 'legacy-poster',
          state: expect.objectContaining({ goals: [] }),
        }));
    });

    it('should fail closed during recovery when a flexible match has no requested state identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md' || filename.endsWith('.state.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') return AGENT_CONTENT_LEGACY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'legacy-poster' }))
        .rejects.toThrow('Cannot verify durable state');
    });
  });

  describe('direct lookup ENOENT + no flexible match', () => {
    it('should return null', async () => {
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockResolvedValue([]);

      const agent = await agentManager.read('completely-missing');

      expect(agent).toBeNull();
    });

    it('should return null when list has agents but none match', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('other-agent.md')) {
          return AGENT_CONTENT_STANDARD;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      mockPortfolioManager.listElements.mockResolvedValue(['other-agent.md']);

      const agent = await agentManager.read('totally-different');

      expect(agent).toBeNull();
    });
  });

  describe('non-ENOENT errors', () => {
    it('should propagate non-ENOENT errors without fallback', async () => {
      fileOperationsService.readFile.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

      await expect(agentManager.read('some-agent')).rejects.toThrow('EACCES');
    });

    it('should propagate requested state failures through strict recovery reads', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        if (filename === 'my-agent.state.yaml') {
          throw Object.assign(new Error('State storage unavailable'), { code: 'EACCES' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'my-agent' }))
        .rejects.toThrow('State storage unavailable');
      expect(cacheSpy).not.toHaveBeenCalled();
    });

    it('should fail closed when the state directory is unavailable', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      fileOperationsService.stat.mockRejectedValueOnce(
        Object.assign(new Error('State mount unavailable'), { code: 'ENOENT' })
      );

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'my-agent' }))
        .rejects.toThrow('Agent state directory unavailable: State mount unavailable');
    });

    it('should bypass cached state without replacing shared caches during strict recovery reads', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      let requestedState = ACTIVE_REQUESTED_STATE.replace('in_progress', 'completed');
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        if (filename === 'my-agent.state.yaml') return requestedState;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const firstRead = await agentManager.read('my-agent');
      expect(firstRead?.getState().goals[0]?.status).toBe('completed');

      requestedState = ACTIVE_REQUESTED_STATE;
      cacheSpy.mockClear();
      const strictRead = await agentManager.getAgentStateForRecovery({ agentName: 'my-agent' });
      expect(strictRead.state.goals[0]?.status).toBe('in_progress');
      expect(cacheSpy).not.toHaveBeenCalled();

      const ordinaryRead = await agentManager.getAgentState({ agentName: 'my-agent' });
      expect(ordinaryRead.state.goals[0]?.status).toBe('completed');
    });
    it('should synchronize strict recovery into the cached instance for the requested file when display names collide', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-shared.md') return AGENT_CONTENT_SHARED_NAME.replace('Standard agent', 'Legacy duplicate');
        if (filename === 'shared-agent.md') return AGENT_CONTENT_SHARED_NAME;
        if (filename === 'shared-agent.state.yaml') return ACTIVE_REQUESTED_STATE;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Cache the intended file, then touch a same-named legacy file so it is the
      // most recently used entry; a name-keyed cache lookup would find it first.
      const intendedInstance = await agentManager.read('shared-agent');
      const legacyInstance = await agentManager.load('legacy-shared.md');
      expect(intendedInstance).not.toBeNull();
      expect(intendedInstance).not.toBe(legacyInstance);
      expect(intendedInstance?.metadata.name).toBe(legacyInstance.metadata.name);
      expect(intendedInstance?.getState().goals[0]?.status).toBe('in_progress');
      expect(legacyInstance.getState().goals).toEqual([]);

      const result = await agentManager.completeAgentGoalForRecovery({
        agentName: 'shared-agent',
        goalId: 'goal_requested_active',
        outcome: 'success',
        summary: 'Recovered after restart',
      });
      expect(result.goal.status).toBe('completed');

      // The recovered state belongs to shared-agent.md's live instance, never to a
      // different file that merely shares its display name.
      expect(legacyInstance.getState().goals).toEqual([]);
      expect(intendedInstance?.getState().goals).toEqual([
        expect.objectContaining({ id: 'goal_requested_active', status: 'completed' }),
      ]);
    });

    it('should synchronize a strict flexible recovery into the matched storage path', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-shared-agent.md') return AGENT_CONTENT_SHARED_NAME;
        if (filename === 'legacy-shared-agent.state.yaml') return ACTIVE_REQUESTED_STATE;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-shared-agent.md']);

      const matchedInstance = await agentManager.load('legacy-shared-agent.md');
      expect(matchedInstance.getState().goals).toEqual([
        expect.objectContaining({ id: 'goal_requested_active', status: 'in_progress' }),
      ]);
      fileOperationsService.writeFile.mockClear();

      const result = await agentManager.completeAgentGoalForRecovery({
        agentName: 'shared-agent',
        goalId: 'goal_requested_active',
        outcome: 'success',
        summary: 'Recovered through flexible identity',
      });

      expect(result.goal.status).toBe('completed');
      expect(matchedInstance.getState().goals).toEqual([
        expect.objectContaining({ id: 'goal_requested_active', status: 'completed' }),
      ]);
      const stateWrites = fileOperationsService.writeFile.mock.calls
        .map(([filePath]) => path.basename(filePath as string));
      expect(stateWrites).toContain('legacy-shared-agent.state.yaml');
      expect(stateWrites).not.toContain('shared-agent.state.yaml');
    });

    it.each([false, true])('certifies absence from metadata selection despite a filename match (unreadable sibling: %s)', async broken => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'wanted.md') return AGENT_CONTENT_STANDARD.replace('name: my-agent', 'name: Other');
        throw Object.assign(new Error('Unavailable'), { code: path.basename(filePath) === 'broken.md' ? 'EIO' : 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(broken ? ['wanted.md', 'broken.md'] : ['wanted.md']);
      if (broken) {
        const expected = { kind: 'indeterminate', failures: [expect.objectContaining({ reference: 'broken.md' })] };
        await expect(agentManager.read('wanted')).rejects.toMatchObject(expected);
        await expect(agentManager.getAgentStateForRecovery({ agentName: 'wanted' })).rejects.toMatchObject(expected);
      } else {
        await expect(agentManager.read('wanted')).resolves.toBeNull();
        await expect(agentManager.getAgentStateForRecovery({ agentName: 'wanted' })).rejects.toThrow("Agent 'wanted' not found");
      }
      await expect(agentManager.read('Other')).resolves.toMatchObject({ metadata: { name: 'Other' } });
      await expect(agentManager.read('wanted.md')).resolves.toMatchObject({ metadata: { name: 'Other' } });
    });

    it('should fail closed for strict flexible reads with colliding file identities', async () => {
      const stateReads: string[] = [];
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-shared-one.md' || filename === 'legacy-shared-two.md') {
          return AGENT_CONTENT_SHARED_NAME;
        }
        if (filename.endsWith('.state.yaml')) stateReads.push(filename);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'legacy-shared-one.md',
        'legacy-shared-two.md',
      ]);

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'shared-agent' }))
        .rejects.toMatchObject({ kind: 'indeterminate', failures: [
          expect.objectContaining({ reference: 'legacy-shared-one.md' }),
          expect.objectContaining({ reference: 'legacy-shared-two.md' }),
        ] });
      expect(stateReads).toEqual([]);
    });

    it('breaks a same-name tie by the name\'s own filename, as the shared selection rule does', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-shared.md') {
          return AGENT_CONTENT_SHARED_NAME.replace('Standard agent', 'Legacy duplicate');
        }
        if (filename === 'shared-agent.md') return AGENT_CONTENT_SHARED_NAME;
        if (filename.endsWith('.state.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'legacy-shared.md',
        'shared-agent.md',
      ]);

      const result = await agentManager.read('shared-agent');

      expect(result?.metadata.description).toBe('Standard agent');
    });

    it('fails closed on genuine ordinary-read ambiguity and names both paths', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-shared-one.md' || filename === 'legacy-shared-two.md') {
          return AGENT_CONTENT_SHARED_NAME;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'legacy-shared-one.md',
        'legacy-shared-two.md',
      ]);

      await expect(agentManager.read('shared-agent')).rejects.toMatchObject({ kind: 'indeterminate', failures: [
        expect.objectContaining({ reference: 'legacy-shared-one.md' }),
        expect.objectContaining({ reference: 'legacy-shared-two.md' }),
      ] });
    });
  });

  describe('flexible storage-identity save targets', () => {
    const originalDefinition = 'legacy-poster-agent.md';
    const requestedDefinition = 'legacy-poster.md';
    const originalState = 'legacy-poster-agent.state.yaml';
    const requestedState = 'legacy-poster.state.yaml';

    function arrangeFlexibleAgent(content: string, state?: string): void {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === originalDefinition) return content;
        if (filename === originalState && state !== undefined) return state;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([originalDefinition]);
    }

    function writtenBasenames(): string[] {
      return fileOperationsService.writeFile.mock.calls
        .map(([filePath]) => path.basename(filePath as string));
    }

    function expectOriginalDefinitionOnly(writes: string[]): void {
      expect(writes).toContain(originalDefinition);
      expect(writes).not.toContain(requestedDefinition);
      expect(writes).not.toContain(requestedState);
    }

    it('updates a flexibly resolved agent in its original file', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY_V2);

      await expect(agentManager.update('legacy-poster', { description: 'Updated' }))
        .resolves.toBe(true);

      expectOriginalDefinitionOnly(writtenBasenames());
    });

    it('converts a flexibly resolved v1 agent in its original file', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY);
      const agent = await agentManager.read('legacy-poster');
      expect(agent).not.toBeNull();
      fileOperationsService.writeFile.mockClear();

      await (agentManager as unknown as {
        convertLegacyAgentForExecution: (
          target: Agent,
          name: string,
          metadata: Agent['metadata'],
        ) => Promise<void>;
      }).convertLegacyAgentForExecution(agent!, 'legacy-poster', agent!.metadata);

      expectOriginalDefinitionOnly(writtenBasenames());
    });

    it('starts execution for a flexibly resolved agent in its original files', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY_V2);

      await expect(agentManager.executeAgent('legacy-poster', { objective: 'the objective' }))
        .resolves.toMatchObject({ agentName: 'legacy-poster' });

      const writes = writtenBasenames();
      expectOriginalDefinitionOnly(writes);
      expect(writes).toContain(originalState);
    });

    it('records a step for a flexibly resolved agent in its original files', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY_V2, ACTIVE_REQUESTED_STATE);

      await expect(agentManager.recordAgentStep({
        agentName: 'legacy-poster',
        goalId: 'goal_requested_active',
        stepDescription: 'Checked storage identity',
        outcome: 'success',
      })).resolves.toMatchObject({ success: true });

      const writes = writtenBasenames();
      expectOriginalDefinitionOnly(writes);
      expect(writes).toContain(originalState);
    });

    it('completes a goal for a flexibly resolved agent in its original files', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY_V2, ACTIVE_REQUESTED_STATE);

      await expect(agentManager.completeAgentGoal({
        agentName: 'legacy-poster',
        goalId: 'goal_requested_active',
        outcome: 'success',
        summary: 'Completed without forking storage',
      })).resolves.toMatchObject({ success: true });

      const writes = writtenBasenames();
      expectOriginalDefinitionOnly(writes);
      expect(writes).toContain(originalState);
    });

    it('persists explicitly requested state to the matched storage sidecar', async () => {
      arrangeFlexibleAgent(AGENT_CONTENT_LEGACY_V2, ACTIVE_REQUESTED_STATE);
      const agent = await agentManager.read('legacy-poster');
      expect(agent).not.toBeNull();
      agent?.addGoal({ description: 'Persist through the public state API' });
      jest.spyOn(agentManager, 'read').mockResolvedValue(agent);
      fileOperationsService.writeFile.mockClear();

      await expect(agentManager.persistState('legacy-poster')).resolves.toBe(true);

      const writes = writtenBasenames();
      expect(writes).toContain(originalState);
      expect(writes).not.toContain(requestedState);
    });
  });

  describe('flexible fallback resilience', () => {
    it('should preserve ordinary not-found behavior for an empty portfolio', async () => {
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockResolvedValue([]);

      await expect(agentManager.read('missing-agent')).resolves.toBeNull();
    });

    it('should propagate list failures through strict recovery reads', async () => {
      // Direct lookup: ENOENT
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      // list() itself throws
      mockPortfolioManager.listElements.mockRejectedValue(new Error('Storage unavailable'));

      // The shared resolution classifies the discovery failure; the storage error reaches the caller as its cause.
      await expect(agentManager.getAgentStateForRecovery({ agentName: 'failing-agent' }))
        .rejects.toMatchObject({ kind: 'unreadable', cause: expect.objectContaining({ message: 'Storage unavailable' }) });
      expect(mockPortfolioManager.listElements).toHaveBeenCalledWith(
        ElementType.AGENT
      );
    });

    it('should preserve a missing agents directory as a storage failure', async () => {
      fileOperationsService.createDirectory.mockClear();
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('Direct file missing'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockRejectedValue(
        Object.assign(new Error('Agents directory unavailable'), { code: 'ENOENT' })
      );

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'offline-agent' }))
        .rejects.toMatchObject({ cause: expect.objectContaining({ message: 'Agents directory unavailable' }) });
      expect(fileOperationsService.createDirectory).not.toHaveBeenCalled();
    });

    it('should propagate candidate load failures through getAgentState()', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'failing-agent.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw new Error('Candidate storage unavailable');
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-failing-agent.md']);

      await expect(agentManager.getAgentState({ agentName: 'failing-agent' }))
        .rejects.toMatchObject({ kind: 'indeterminate' });
    });

    it('should read one matching candidate despite an unrelated unreadable sibling', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        throw new Error('Unrelated candidate is malformed');
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'broken-agent.md',
        'legacy-poster-agent.md'
      ]);

      await expect(agentManager.read('legacy-poster')).resolves.toMatchObject({ metadata: { name: 'legacy-poster' } });
      expect(fileOperationsService.readFile.mock.calls.filter(([file]) => path.basename(file) === 'legacy-poster-agent.md')).toHaveLength(1);
      expect(fileOperationsService.readFile.mock.calls.some(([file]) => path.basename(file) === 'broken-agent.md')).toBe(false);
      expect(cacheSpy).not.toHaveBeenCalled();
    });
  });
});

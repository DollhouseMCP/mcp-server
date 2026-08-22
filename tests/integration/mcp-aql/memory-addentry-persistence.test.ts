/**
 * Integration tests for Issue #2329 — addEntry reported success while entries
 * were silently never persisted to disk.
 *
 * Two production failure modes are covered:
 * 1. Memories whose serialized YAML passed 64KB hit a hidden frontmatter-sized
 *    cap on the save path; every save threw, the deferred (debounced) save
 *    swallowed the error, and addEntry kept returning entry ids for data that
 *    only existed in process RAM.
 * 2. Any deferred save failure (e.g. disk error) was logged and forgotten; the
 *    next addEntry accepted more entries behind the same failure.
 *
 * Fixed behavior under test:
 * - addEntry on a >64KB memory succeeds AND the entries reach disk
 * - addEntry that would push a memory past MAX_YAML_SIZE errors and rolls back
 * - after a deferred save failure, the next addEntry retries the save and
 *   surfaces the error instead of silently accepting more entries
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { MEMORY_CONSTANTS } from '../../../src/elements/memories/constants.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Memory addEntry persistence (#2329)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let memoryManager: MemoryManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-memory-persistence');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    memoryManager = container.resolve<MemoryManager>('MemoryManager');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.dispose();
    await env.cleanup();
  });

  async function createMemory(name: string) {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: name,
        element_type: 'memories',
        description: `Test memory ${name}`,
      },
    });
    expect(result.success).toBe(true);
  }

  function addEntry(name: string, content: string) {
    return mcpAqlHandler.handleCreate({
      operation: 'addEntry',
      params: { element_name: name, content },
    });
  }

  /** Locate a memory's YAML file on disk (date-sharded folders). */
  async function findMemoryFile(name: string): Promise<string> {
    const memoriesDir = path.join(env.testDir, 'memories');
    const files = await fs.readdir(memoriesDir, { recursive: true });
    const match = files.find(f => String(f).includes(name) && String(f).endsWith('.yaml'));
    expect(match).toBeDefined();
    return path.join(memoriesDir, String(match));
  }

  // ~17KB of plain prose per entry — several of these push the serialized YAML
  // past the old hidden 64KB cap while staying under MAX_ENTRY_SIZE.
  const bigEntry = (marker: string) =>
    `${marker} ` + 'research finding lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(240);

  it('persists entries to disk after the memory grows past 64KB (#2329 repro)', async () => {
    await createMemory('forge-findings-2329');

    for (let i = 0; i < 6; i++) {
      const result = await addEntry('forge-findings-2329', bigEntry(`entry-${i}`));
      expect(result.success).toBe(true);
    }

    // Force the debounced save to run now (same code path as the timer).
    await mcpAqlHandler.flushPendingSaves();

    const filePath = await findMemoryFile('forge-findings-2329');
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(64 * 1024);

    const raw = await fs.readFile(filePath, 'utf-8');
    // First and last entries both present — nothing silently dropped.
    expect(raw).toContain('entry-0');
    expect(raw).toContain('entry-5');
  });

  it('stores blocked-pattern prose without echoing it in the mutation response', async () => {
    await createMemory('untrusted-receipt-2440');
    const untrustedProse = 'Historical example: exec("dangerous command")';

    const result = await addEntry('untrusted-receipt-2440', untrustedProse);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({
        id: expect.any(String),
        trustLevel: 'untrusted',
      }));
      expect(JSON.stringify(result.data)).not.toContain(untrustedProse);
      expect(result.data).not.toHaveProperty('content');
    }

    await mcpAqlHandler.flushPendingSaves();
    const raw = await fs.readFile(await findMemoryFile('untrusted-receipt-2440'), 'utf-8');
    expect(raw).toContain('exec');
  });

  it('returns an error and rolls back the entry when the memory cannot be persisted', async () => {
    await createMemory('overflow-2329');

    // Fill with entries below MAX_ENTRY_SIZE until aggregate YAML crosses the
    // independently larger MAX_YAML_SIZE ceiling.
    const hugeEntry = (marker: string) => `${marker} ${'x'.repeat(350 * 1024)}`;
    const accepted: string[] = [];
    let rejectedMarker = '';
    let overflowResult: Awaited<ReturnType<typeof addEntry>> | null = null;
    for (let index = 1; index <= 40; index += 1) {
      const marker = `huge-${index}`;
      const result = await addEntry('overflow-2329', hugeEntry(marker));
      if (!result.success) {
        rejectedMarker = marker;
        overflowResult = result;
        break;
      }
      accepted.push(marker);
    }

    expect(accepted.length).toBeGreaterThanOrEqual(2);
    expect(overflowResult).not.toBeNull();
    if (!overflowResult) throw new Error('expected aggregate memory size rejection');
    expect(overflowResult.success).toBe(false);
    if (!overflowResult.success) {
      expect(overflowResult.error).toContain('NOT saved');
      expect(overflowResult.error).toContain('maximum serialized size');
    }

    // The rejected entry must not linger in RAM: the memory still persists fine
    // and the file contains the accepted entries but not the rejected one.
    await mcpAqlHandler.flushPendingSaves();
    const filePath = await findMemoryFile('overflow-2329');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw.length).toBeLessThanOrEqual(MEMORY_CONSTANTS.MAX_YAML_SIZE);
    expect(raw).toContain(accepted[0]);
    expect(raw).toContain(accepted.at(-1));
    expect(raw).not.toContain(rejectedMarker);
  }, 30_000);

  it('does not acknowledge a failed file save and recovers on the next request', async () => {
    await createMemory('flaky-disk-2329');

    const saveSpy = jest.spyOn(memoryManager, 'save')
      .mockRejectedValueOnce(new Error('EIO: simulated disk failure'));
    const failed = await addEntry('flaky-disk-2329', 'entry rejected on disk failure');
    expect(failed.success).toBe(false);
    if (!failed.success) expect(failed.error).toContain('NOT saved');

    const result = await addEntry('flaky-disk-2329', 'entry after recovery');
    expect(result.success).toBe(true);

    const filePath = await findMemoryFile('flaky-disk-2329');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).not.toContain('entry rejected on disk failure');
    expect(raw).toContain('entry after recovery');
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a deleted memory after a rejected synchronous save', async () => {
    await createMemory('doomed-2329');
    jest.spyOn(memoryManager, 'save')
      .mockRejectedValueOnce(new Error('EIO: simulated disk failure'));
    expect((await addEntry('doomed-2329', 'entry that will fail to save')).success).toBe(false);
    jest.restoreAllMocks();

    // Delete the memory — must also drop the ledger entry.
    const deleteResult = await mcpAqlHandler.handleDelete({
      operation: 'delete_element',
      params: { element_name: 'doomed-2329', element_type: 'memories' },
    });
    expect(deleteResult.success).toBe(true);

    // A later flush must NOT re-save the retained instance and resurrect the file.
    await mcpAqlHandler.flushPendingSaves();
    const memoriesDir = path.join(env.testDir, 'memories');
    const files = await fs.readdir(memoriesDir, { recursive: true });
    expect(files.filter(f => String(f).includes('doomed-2329'))).toHaveLength(0);
  });

  it('reports an error immediately while a persistent disk failure remains', async () => {
    await createMemory('dead-disk-2329');
    jest.spyOn(memoryManager, 'save')
      .mockRejectedValue(new Error('EIO: simulated persistent disk failure'));

    const result = await addEntry('dead-disk-2329', 'entry that must be rejected');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('NOT saved');
      expect(result.error).toContain('simulated persistent disk failure');
    }
  });

  it('serializes concurrent manager instances without losing either entry', async () => {
    await createMemory('shared-file-race-2329');
    const secondContainer = new DollhouseContainer();
    const secondServer = new DollhouseMCPServer(secondContainer);
    await secondServer.listPersonas();
    preConfirmAllOperations(secondContainer);
    const secondHandler = secondContainer.resolve<MCPAQLHandler>('mcpAqlHandler');
    try {
      const [first, second] = await Promise.all([
        addEntry('shared-file-race-2329', 'entry from first manager'),
        secondHandler.handleCreate({
          operation: 'addEntry',
          params: {
            element_name: 'shared-file-race-2329',
            content: 'entry from second manager',
          },
        }),
      ]);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      const raw = await fs.readFile(await findMemoryFile('shared-file-race-2329'), 'utf8');
      expect(raw).toContain('entry from first manager');
      expect(raw).toContain('entry from second manager');
    } finally {
      await secondServer.dispose();
    }
  });

  it('orders a competing delete after an in-flight durable add without resurrection', async () => {
    await createMemory('shared-file-delete-race-2329');
    const secondContainer = new DollhouseContainer();
    const secondServer = new DollhouseMCPServer(secondContainer);
    await secondServer.listPersonas();
    preConfirmAllOperations(secondContainer);
    const secondHandler = secondContainer.resolve<MCPAQLHandler>('mcpAqlHandler');
    const originalSave = memoryManager.save.bind(memoryManager);
    let signalSaveStarted!: () => void;
    const saveStarted = new Promise<void>(resolve => { signalSaveStarted = resolve; });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    jest.spyOn(memoryManager, 'save').mockImplementation(async (...args) => {
      signalSaveStarted();
      await saveGate;
      return originalSave(...args);
    });
    try {
      const add = addEntry('shared-file-delete-race-2329', 'durable before delete');
      await saveStarted;
      const deletion = secondHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'shared-file-delete-race-2329',
          element_type: 'memories',
        },
      });
      releaseSave();
      expect((await add).success).toBe(true);
      expect((await deletion).success).toBe(true);
      await mcpAqlHandler.flushPendingSaves();
      const files = await fs.readdir(path.join(env.testDir, 'memories'), { recursive: true });
      expect(files.some(file => String(file).includes('shared-file-delete-race-2329'))).toBe(false);
    } finally {
      await secondServer.dispose();
    }
  });
});

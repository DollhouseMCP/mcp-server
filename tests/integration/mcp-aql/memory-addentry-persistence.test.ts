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
 * - the lifecycle path awaits known persistence before acknowledging an entry
 * - an unacknowledged pre-write failure leaves original RAM/disk unchanged
 * - persistent failure refuses additional entries instead of acknowledging RAM
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { MEMORY_CONSTANTS } from '../../../src/elements/memories/constants.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Memory addEntry persistence (#2329)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let memoryManager: MemoryManager;
  let lifecycle: MemoryUpgradeLifecycle;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-memory-persistence');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    memoryManager = container.resolve<MemoryManager>('MemoryManager');
    lifecycle = container.resolve<MemoryUpgradeLifecycle>('MemoryUpgradeLifecycle');
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
  // past the old hidden 64KB cap while staying under MAX_ENTRY_SIZE (100KB).
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

    // ~90KB per entry: two fit under MAX_YAML_SIZE (256KB), the third does not.
    const hugeEntry = (marker: string) =>
      `${marker} ` + 'oversized entry content padding words repeated for scale '.repeat(1550);

    expect((await addEntry('overflow-2329', hugeEntry('huge-1'))).success).toBe(true);
    expect((await addEntry('overflow-2329', hugeEntry('huge-2'))).success).toBe(true);

    const overflowResult = await addEntry('overflow-2329', hugeEntry('huge-3'));
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
    expect(raw).toContain('huge-1');
    expect(raw).toContain('huge-2');
    expect(raw).not.toContain('huge-3');
  });

  it('rejects an unacknowledged prewrite append without publication and persists its caller retry exactly once', async () => {
    await createMemory('flaky-disk-2329');
    const filePath = await findMemoryFile('flaky-disk-2329');
    const originalDisk = await fs.readFile(filePath, 'utf-8');
    const content = 'first entry before failure';

    // Interrupt the real known-save body before persistence starts, preserving
    // the manager's actual runWrite accounting and outcome classification.
    const known = memoryManager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const saveSpy = jest.spyOn(known, 'saveMemoryKnown')
      .mockRejectedValueOnce(new Error('EIO: simulated prewrite disk failure'));
    const attemptSpy = jest.spyOn(memoryManager, 'saveUnacknowledgedAppend');
    const failed = await addEntry('flaky-disk-2329', content);
    expect(failed).toMatchObject({ success: false, error: 'EIO: simulated prewrite disk failure' });
    expect(failed).not.toHaveProperty('data.id');
    await expect(attemptSpy.mock.results[0].value).rejects.toMatchObject({
      name: 'MemoryWriteOutcomeError', outcome: 'refused-before-write',
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(attemptSpy.mock.calls[0][1].getEntries().size).toBe(0);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(originalDisk);
    expect(lifecycle.getSummary()).toMatchObject({ admitted: 0, writes: 0, failedWrites: 0, retainedOwners: 0 });

    // A rejected request owns no published entry. An exact caller retry creates
    // a new quiet candidate and acknowledges only its one known persisted entry.
    const result = await addEntry('flaky-disk-2329', content);
    expect(result.success).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(attemptSpy.mock.calls[1][0]).not.toBe(attemptSpy.mock.calls[0][0]);
    await mcpAqlHandler.flushPendingSaves();
    expect(saveSpy).toHaveBeenCalledTimes(2); // No rejected candidate is replayed by flush.
    const persisted = new SerializationService().parsePureYaml(await fs.readFile(filePath, 'utf-8'));
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({ id: (result.data as { id: string }).id, content });
    expect(lifecycle.getSummary()).toMatchObject({ writes: 0, failedWrites: 0, retainedOwners: 0 });
  });

  it('does not resurrect a durably acknowledged memory after deletion', async () => {
    await createMemory('doomed-2329');
    expect((await addEntry('doomed-2329', 'entry that will fail to save')).success).toBe(true);

    // The acknowledged append already reached disk. Its later flush cannot
    // recreate the deleted head; legacy deferred-ledger deletion is covered
    // independently by MemorySaveHandler.ledger.test.ts.
    const deleteResult = await mcpAqlHandler.handleDelete({
      operation: 'delete_element',
      params: { element_name: 'doomed-2329', element_type: 'memories' },
    });
    expect(deleteResult.success).toBe(true);

    // A later flush must NOT resurrect the deleted file.
    await mcpAqlHandler.flushPendingSaves();
    const memoriesDir = path.join(env.testDir, 'memories');
    const files = await fs.readdir(memoriesDir, { recursive: true });
    expect(files.filter(f => String(f).includes('doomed-2329'))).toHaveLength(0);
  });

  it('repeated prewrite refusal leaves only acknowledged RAM/disk state and no accepted append obligation', async () => {
    await createMemory('dead-disk-2329');
    const acceptedContent = 'entry before persistent failure';
    expect((await addEntry('dead-disk-2329', acceptedContent)).success).toBe(true);
    const filePath = await findMemoryFile('dead-disk-2329');
    const originalDisk = await fs.readFile(filePath, 'utf-8');

    const known = memoryManager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const saveSpy = jest.spyOn(known, 'saveMemoryKnown')
      .mockRejectedValue(new Error('EIO: simulated persistent disk failure'));
    const attemptSpy = jest.spyOn(memoryManager, 'saveUnacknowledgedAppend');
    for (const content of ['candidate before persistent failure', 'entry that must be rejected']) {
      const result = await addEntry('dead-disk-2329', content);
      expect(result).toMatchObject({ success: false, error: 'EIO: simulated persistent disk failure' });
      expect(result).not.toHaveProperty('data.id');
      const attempt = attemptSpy.mock.results[attemptSpy.mock.results.length - 1];
      await expect(attempt.value).rejects.toMatchObject({
        name: 'MemoryWriteOutcomeError', outcome: 'refused-before-write',
      });
      const source = attemptSpy.mock.calls[attemptSpy.mock.calls.length - 1][1];
      expect([...source.getEntries().values()].map(entry => entry.content)).toEqual([acceptedContent]);
      expect(await fs.readFile(filePath, 'utf-8')).toBe(originalDisk);
      expect(lifecycle.getSummary()).toMatchObject({ admitted: 0, writes: 0, failedWrites: 0, retainedOwners: 0 });
    }
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(attemptSpy.mock.calls[1][0]).not.toBe(attemptSpy.mock.calls[0][0]);

    // Restoring storage and flushing cannot invent acceptance for either failed
    // request. Only the previously acknowledged entry remains durable.
    saveSpy.mockRestore();
    await mcpAqlHandler.flushPendingSaves();
    expect(attemptSpy).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(originalDisk);
    const persisted = new SerializationService().parsePureYaml(originalDisk);
    expect(persisted.entries.map((entry: { content: string }) => entry.content)).toEqual([acceptedContent]);
    expect(lifecycle.getSummary()).toMatchObject({ writes: 0, failedWrites: 0, retainedOwners: 0 });
  });
});

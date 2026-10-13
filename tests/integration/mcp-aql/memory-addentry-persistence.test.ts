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
 * - a definite pre-write failure retains its exact candidate for a known retry
 * - persistent failure refuses additional entries instead of acknowledging RAM
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

  it('refuses the failed save before ACK and recovers its exact retained candidate', async () => {
    await createMemory('flaky-disk-2329');

    // Interrupt the real known-save body before persistence starts, preserving
    // the manager's actual runWrite accounting and error classification.
    const known = memoryManager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const saveSpy = jest.spyOn(known, 'saveMemoryKnown')
      .mockRejectedValueOnce(new Error('EIO: simulated prewrite disk failure'));
    const failed = await addEntry('flaky-disk-2329', 'first entry before failure');
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('EIO: simulated prewrite disk failure');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const retained = saveSpy.mock.calls[0][0];
    const beforeRecovery = await fs.readFile(await findMemoryFile('flaky-disk-2329'), 'utf-8');
    expect(beforeRecovery).not.toContain('first entry before failure');

    // The next append first persists the exact retained object, then appends.
    const result = await addEntry('flaky-disk-2329', 'second entry after recovery');
    expect(result.success).toBe(true);
    expect(saveSpy.mock.calls[1][0]).toBe(retained);

    await mcpAqlHandler.flushPendingSaves();
    const filePath = await findMemoryFile('flaky-disk-2329');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toContain('first entry before failure');
    expect(raw).toContain('second entry after recovery');
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

  it('refuses ACK and further mutation while the definite prewrite save and retry fail', async () => {
    await createMemory('dead-disk-2329');

    expect((await addEntry('dead-disk-2329', 'entry before persistent failure')).success).toBe(true);

    const known = memoryManager as unknown as { saveMemoryKnown: (...args: unknown[]) => Promise<void> };
    const saveSpy = jest.spyOn(known, 'saveMemoryKnown')
      .mockRejectedValue(new Error('EIO: simulated persistent disk failure'));
    const failed = await addEntry('dead-disk-2329', 'retained candidate before persistent failure');
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('EIO: simulated persistent disk failure');
    const retained = saveSpy.mock.calls[0][0];

    const result = await addEntry('dead-disk-2329', 'entry that must be rejected');
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT saved');
    expect(result.error).toContain('save failure');
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy.mock.calls[1][0]).toBe(retained);
    const beforeRecovery = await fs.readFile(await findMemoryFile('dead-disk-2329'), 'utf-8');
    expect(beforeRecovery).toContain('entry before persistent failure');
    expect(beforeRecovery).not.toContain('retained candidate before persistent failure');
    expect(beforeRecovery).not.toContain('entry that must be rejected');

    // Restore known storage, reconcile only the retained candidate, and prove
    // the rejected later append never entered RAM or the persisted head.
    saveSpy.mockRestore();
    await mcpAqlHandler.flushPendingSaves();
    const recovered = await fs.readFile(await findMemoryFile('dead-disk-2329'), 'utf-8');
    expect(recovered).toContain('entry before persistent failure');
    expect(recovered).toContain('retained candidate before persistent failure');
    expect(recovered).not.toContain('entry that must be rejected');
  });
});

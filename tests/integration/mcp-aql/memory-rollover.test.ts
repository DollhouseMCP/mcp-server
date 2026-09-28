/**
 * Integration tests for Issue #2861 — rollover_memory through MCP-AQL.
 *
 * A full memory can be rolled over: older entries are sealed into read-only
 * archive volumes and the live memory keeps its name, so references to it
 * keep working and it accepts new entries again. Nothing is deleted.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('rollover_memory (#2861)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let memoriesDir: string;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-memory-rollover');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    memoriesDir = path.join(env.testDir, 'memories');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.dispose();
    await env.cleanup();
  });

  async function createMemory(name: string) {
    const result = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: { element_name: name, element_type: 'memories', description: `Test memory ${name}` },
    });
    expect(result.success).toBe(true);
  }

  function addEntry(name: string, content: string, tags?: string[]) {
    return mcpAqlHandler.handleCreate({
      operation: 'addEntry',
      params: { element_name: name, content, ...(tags ? { tags } : {}) },
    });
  }

  function rollover(name: string, params: Record<string, unknown> = {}) {
    return mcpAqlHandler.handleUpdate({
      operation: 'rollover_memory',
      params: { element_name: name, ...params },
    });
  }

  /** The live memory file (volumes live under memories/volumes/ and are excluded). */
  async function liveMemoryFile(name: string): Promise<string> {
    const files = (await fs.readdir(memoriesDir, { recursive: true })).map(String);
    const match = files.find(f => f.includes(name) && f.endsWith('.yaml') && !f.startsWith('volumes'));
    expect(match).toBeDefined();
    return path.join(memoriesDir, match!);
  }

  it('seals older entries into a volume and keeps the memory name, tagged entries and newest entries', async () => {
    await createMemory('project-log');
    await addEntry('project-log', 'schema: how to read this log', ['schema']);
    for (let i = 0; i < 5; i++) {
      expect((await addEntry('project-log', `log entry ${i}`)).success).toBe(true);
    }
    await mcpAqlHandler.flushPendingSaves();

    const result = await rollover('project-log', { keep_latest: 2, reason: 'integration test' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ memory: 'project-log', dryRun: false, sealedCount: 3, keptCount: 3 });
    const volumes = (result.data as { volumes: Array<{ file: string }> }).volumes;
    expect(volumes).toHaveLength(1);
    expect(volumes[0].file).toBe('volumes/project-log/v0001.yaml');

    const volume = await fs.readFile(path.join(memoriesDir, volumes[0].file), 'utf-8');
    expect(volume).toContain('log entry 0');
    expect(volume).toContain('log entry 2');
    expect(volume).not.toContain('log entry 4');

    const live = await fs.readFile(await liveMemoryFile('project-log'), 'utf-8');
    expect(live).toContain('schema: how to read this log');
    expect(live).toContain('log entry 3');
    expect(live).toContain('log entry 4');
    expect(live).not.toContain('log entry 0');
    expect(live).toContain('Rolled over 3 entries into archive volume 1');
    expect(live).toContain('Reason: integration test');
    expect(live).toContain('volumes/project-log/v0001.yaml');

    // Same name: references keep working, and the volume is never listed.
    const activated = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      element_type: 'memory',
      params: { element_name: 'project-log' },
    });
    expect(activated.success).toBe(true);
    const listed = await mcpAqlHandler.handleRead({
      operation: 'list_elements',
      element_type: 'memory',
      params: { pageSize: 100, fields: ['element_name'] },
    });
    expect(JSON.stringify(listed)).toContain('project-log');
    expect(JSON.stringify(listed)).not.toContain('project-log volume');
  });

  it('writes nothing on a dry run', async () => {
    await createMemory('dry-run-log');
    for (let i = 0; i < 3; i++) await addEntry('dry-run-log', `entry ${i}`);
    await mcpAqlHandler.flushPendingSaves();
    const before = await fs.readFile(await liveMemoryFile('dry-run-log'), 'utf-8');

    const result = await rollover('dry-run-log', { dry_run: true });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ dryRun: true, sealedCount: 3 });
    await expect(fs.access(path.join(memoriesDir, 'volumes', 'dry-run-log'))).rejects.toThrow();
    expect(await fs.readFile(await liveMemoryFile('dry-run-log'), 'utf-8')).toBe(before);
  });

  it('lets a memory that is full accept new entries again', async () => {
    await createMemory('full-log');
    // ~90KB per entry: two fit under MAX_YAML_SIZE (256KB), the third does not.
    const hugeEntry = (marker: string) =>
      `${marker} ` + 'oversized entry content padding words repeated for scale '.repeat(1550);
    expect((await addEntry('full-log', hugeEntry('huge-1'))).success).toBe(true);
    expect((await addEntry('full-log', hugeEntry('huge-2'))).success).toBe(true);
    expect((await addEntry('full-log', hugeEntry('huge-3'))).success).toBe(false);

    const rolled = await rollover('full-log', { keep_latest: 1 });
    expect(rolled.success).toBe(true);

    expect((await addEntry('full-log', hugeEntry('huge-3'))).success).toBe(true);
    await mcpAqlHandler.flushPendingSaves();
    const live = await fs.readFile(await liveMemoryFile('full-log'), 'utf-8');
    expect(live).toContain('huge-2');
    expect(live).toContain('huge-3');
    expect(live).not.toContain('huge-1');
    const volume = await fs.readFile(path.join(memoriesDir, 'volumes', 'full-log', 'v0001.yaml'), 'utf-8');
    expect(volume).toContain('huge-1');
  });

  it('rejects invalid parameters', async () => {
    await createMemory('invalid-params-log');

    const result = await rollover('invalid-params-log', { keep_latest: -1 });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('keep_latest must be an integer');
  });
});

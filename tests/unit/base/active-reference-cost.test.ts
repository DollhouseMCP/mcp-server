/**
 * Active-reference reports read only what is active: an empty active set reads no collection. An
 * enforcement read refreshes as beta's policy check did (invalidate and scan); an advisory read uses
 * the layer's cheaper collection refresh.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const skill = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\nFollow these detailed instructions.`;

describe('active-reference report cost', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'active-cost-'));
    suite = createRealManagerSuite(root);
    const dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'alpha.md'), skill('Alpha'));
    await writeFile(path.join(dir, 'beta.md'), skill('Beta'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([suite.skillManager.dispose(), suite.agentManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it('reads no collection when nothing of the type is active', async () => {
    const layer = (suite.skillManager as any).storageLayer;
    const readCollection = jest.spyOn(layer, 'readCollection');
    const scan = jest.spyOn(layer, 'scan');
    await expect(suite.skillManager.getActiveReferenceReport()).resolves.toEqual({ items: [], failures: [], complete: true });
    expect(readCollection).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it('refreshes an advisory read without invalidating the index, statting only the cached active member', async () => {
    const manager = suite.skillManager;
    await manager.listReport();
    expect((await manager.activateSkill('Alpha')).success).toBe(true);
    const layer = (manager as any).storageLayer;
    const invalidate = jest.spyOn(layer, 'invalidate');
    const statMany = jest.spyOn(layer.backend, 'statMany');
    const report = await manager.getActiveReferenceReport({ freshness: 'advisory' });
    expect(report.items.map(item => item.metadata.name)).toEqual(['Alpha']);
    expect(invalidate).not.toHaveBeenCalled();
    // Inside the cooldown the read compares membership and stats only the cached active member.
    expect(statMany.mock.calls).toEqual([[(manager as any)['elementDir'], ['alpha.md']]]);
  });

  it('refreshes an enforcement read as beta\'s policy check did: invalidate, then a full scan', async () => {
    const manager = suite.skillManager;
    await manager.listReport();
    expect((await manager.activateSkill('Alpha')).success).toBe(true);
    const layer = (manager as any).storageLayer;
    const invalidate = jest.spyOn(layer, 'invalidate');
    const scan = jest.spyOn(layer, 'scan');
    await manager.getActiveReferenceReport();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('sees a content-only edit of an active agent inside the scan cooldown (never weaker than beta)', async () => {
    const agents = suite.agentManager;
    await mkdir((agents as any)['elementDir'], { recursive: true });
    const created = await agents.create('gate-agent', 'Original description', 'Follow these detailed agent instructions.', {} as never);
    expect(created.success ? 'created' : created.message).toBe('created');
    // The real activation: the key is the storage identity, resolved through findByStorageIdentity.
    expect((await agents.activateAgent('gate-agent')).success).toBe(true);
    expect([...(agents as any).getActivationSet()]).toEqual(['gate-agent.md']);
    const before = await agents.getActiveReferenceReport();
    expect(before.items.map(item => item.metadata.description)).toEqual(['Original description']);
    const file = path.join((agents as any)['elementDir'], 'gate-agent.md');
    const text = await readFile(file, 'utf8');
    // Same name, new bytes and mtime: only the content changes, and no watcher event is delivered.
    await writeFile(file, text.replace('Original description', 'Edited description'));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    const after = await agents.getActiveReferenceReport();
    expect(after.complete).toBe(true);
    expect(after.items.map(item => item.metadata.description)).toEqual(['Edited description']);
    expect(after.items[0]).not.toBe(before.items[0]);
    // The enforcement read of the agent manager sees it too.
    expect((await agents.getActiveAgents({ freshAfterInFlight: true })).map(agent => agent.metadata.description)).toEqual(['Edited description']);
  });
});

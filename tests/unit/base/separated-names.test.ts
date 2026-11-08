/**
 * A stored name holding a separator ('CI/CD Helper') is listed, found, activated, enforced and
 * deleted by that name, like any other name. (Ensemble member names are limited to [A-Za-z0-9_-]
 * since beta, so a member never carries one.) Caller text with a separator selects only by exact or
 * case-folded name, never by slug and never as a filename, so 'team/notes' selects nothing beside a
 * stored 'Team Notes'.
 */
import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ActivePolicyCollector } from '../../../src/services/policy/ActivePolicyCollector.js';

const skill = (name: string) => `---\nname: ${name}\ndescription: Separated name fixture\n---\nFollow these detailed instructions.`;

describe('stored names holding a separator (file backend)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'separated-names-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'ci-cd-helper.md'), skill('CI/CD Helper'));
    await writeFile(path.join(dir, 'plain.md'), skill('Plain'));
  });
  afterEach(async () => {
    await Promise.all([suite.skillManager.dispose(), suite.ensembleManager.dispose(), suite.agentManager.dispose(),
      suite.personaManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  const collector = () => new ActivePolicyCollector({
    personaManager: suite.personaManager, skillManager: suite.skillManager, agentManager: suite.agentManager,
    ensembleManager: suite.ensembleManager, getManagerForType: () => undefined, ensureInitialized: async () => {},
  });

  it('lists, finds and loads the listed name, case-folded too', async () => {
    const manager = suite.skillManager;
    const report = await manager.listReport();
    expect(report.failures).toEqual([]);
    expect(report.items.map(item => item.metadata.name).sort()).toEqual(['CI/CD Helper', 'Plain']);
    expect((await manager.findByName('CI/CD Helper'))?.metadata.name).toBe('CI/CD Helper');
    expect((await manager.findByName('ci/cd helper'))?.metadata.name).toBe('CI/CD Helper');
    expect((await manager.load('CI/CD Helper')).metadata.name).toBe('CI/CD Helper');
    await expect(manager.exists('CI/CD Helper')).resolves.toBe(true);
  });

  it.each([['by name', 'CI/CD Helper'], ['by its file reference', 'ci-cd-helper.md']])(
    'activated %s, its active reference resolves and policy enforcement stays available', async (_route, identifier) => {
      const manager = suite.skillManager;
      const activated = await manager.activateSkill(identifier);
      expect(activated.success ? 'activated' : activated.message).toBe('activated');
      expect([...(manager as any).getActivationSet()]).toEqual(['CI/CD Helper']);
      const active = await manager.getActiveReferenceReport();
      expect(active).toMatchObject({ complete: true, failures: [] });
      expect(active.items.map(item => item.metadata.name)).toEqual(['CI/CD Helper']);
      // Enforcement for every other operation reads the same report: complete, so nothing is refused.
      await expect(collector().collectActiveElementsForReport()).resolves.toMatchObject({ complete: true, failures: [] });
      const deactivated = await manager.deactivateSkill('CI/CD Helper');
      expect(deactivated.success).toBe(true);
      expect([...(manager as any).getActivationSet()]).toEqual([]);
    });

  it('deletes the stored element by its separated name', async () => {
    await suite.skillManager.delete('CI/CD Helper');
    await expect(access(path.join(dir, 'ci-cd-helper.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(dir, 'plain.md'))).resolves.toBeUndefined();
  });
});

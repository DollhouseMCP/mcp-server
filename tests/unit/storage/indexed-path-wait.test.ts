/**
 * A name lookup on an authoritative table answers without waiting on a routine scan in flight; a
 * table that is invalidated (an enforcement scan, an observed change) waits for the scan. The scans
 * are held at a gate the test opens, so nothing depends on wall-clock timing.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Wait fixture\n---\nFollow these detailed instructions.`;
const gate = () => {
  let open: () => void = () => {};
  const closed = new Promise<void>(resolve => { open = resolve; });
  return { closed, open };
};
const turns = async (count: number) => { for (let turn = 0; turn < count; turn++) await new Promise(resolve => setImmediate(resolve)); };

describe('readIndexedPath during a scan', () => {
  it('answers from an authoritative table while a routine scan runs, and waits once the table is invalidated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'indexed-path-wait-'));
    const suite = createRealManagerSuite(root);
    const manager = suite.skillManager;
    const files = (suite as any).fileOperationsService;
    const routineGate = gate();
    const enforcementGate = gate();
    try {
      const dir = (manager as any)['elementDir'];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'alpha.md'), skill('Alpha'));
      await manager.list();
      const layer = (manager as any)['storageLayer'];
      const state = () => layer.getState(layer.directory);
      const stat = files.stat.bind(files);
      let current = routineGate;
      jest.spyOn(files, 'stat').mockImplementation(async (...args: unknown[]) => { await current.closed; return stat(...args); });

      // Past the cooldown a scan is due: a routine scan in flight over an authoritative table.
      layer.scanCooldownMs = 0;
      const routine = layer.scan();
      await Promise.resolve();
      expect([Boolean(state().scanInProgress), state().table.isAuthoritative()]).toEqual([true, true]);
      // Answered while the routine scan is still held at its gate.
      await expect(layer.readIndexedPath(['Alpha'])).resolves.toMatchObject({ authoritative: true });
      expect(Boolean(state().scanInProgress)).toBe(true);
      routineGate.open();
      await routine;

      current = enforcementGate;
      layer.invalidate();
      const enforcement = layer.scan();
      await Promise.resolve();
      expect(Boolean(state().scanInProgress)).toBe(true);
      let answered = false;
      const lookup = layer.readIndexedPath(['Alpha']).then((result: unknown) => { answered = true; return result; });
      await turns(20);
      expect(answered).toBe(false);
      enforcementGate.open();
      await Promise.all([enforcement, lookup]);
      expect(answered).toBe(true);
    } finally {
      routineGate.open();
      enforcementGate.open();
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

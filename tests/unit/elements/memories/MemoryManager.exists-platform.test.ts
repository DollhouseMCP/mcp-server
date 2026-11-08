import { describe, it, expect, jest } from '@jest/globals';
import path from 'node:path';

// Model Windows reference generation without depending on the host filesystem.
jest.unstable_mockModule('node:path', () => ({ default: path.win32, ...path.win32 }));
const { MemoryManager } = await import('../../../../src/elements/memories/MemoryManager.js');
const { BaseElementManager } = await import('../../../../src/elements/base/BaseElementManager.js');

describe('MemoryManager Windows existence references', () => {
  it.each(['system', '2026-01-01'])('passes the exact %s reference to the shared existence check', async folder => {
    const manager = Object.create(MemoryManager.prototype) as InstanceType<typeof MemoryManager>;
    Object.defineProperties(manager, {
      storageLayer: { value: {} },
      memoriesDir: { value: path.win32.resolve('C:/', 'portfolio', 'memories') },
      validateAndResolvePath: { value: async () => path.win32.resolve('C:/', 'portfolio', 'memories', folder, 'x.yaml') },
    });
    const exists = jest.spyOn(BaseElementManager.prototype, 'exists').mockResolvedValue(true);
    try {
      await expect(manager.exists(`${folder}/x.yaml`)).resolves.toBe(true);
      expect(exists).toHaveBeenCalledWith(`${folder}/x.yaml`);
    } finally { exists.mockRestore(); }
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { FileConfirmationStore } from '../../../src/state/FileConfirmationStore.js';
import { FileChallengeStore } from '../../../src/state/FileChallengeStore.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import { FilesystemSigningKeyStore } from '../../../src/storage/signingKeys/FilesystemSigningKeyStore.js';
import { logger } from '../../../src/utils/logger.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

afterEach(() => { jest.restoreAllMocks(); });
describe('file state diagnostics', () => {
  it.each(['confirmation', 'challenge', 'activation'])('reports unsupported and invalid %s snapshots', async kind => {
    for (const content of ['{"version":2}', 'null', '{"version":1,"confirmations":4,"challenges":4,"activations":4}']) {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const fileOps = { readFile: async () => content } as unknown as FileOperationsService;
      const directory = path.join(os.tmpdir(), 'state-diagnostics');
      const store = kind === 'confirmation' ? new FileConfirmationStore(fileOps, directory, 'session')
        : kind === 'challenge' ? new FileChallengeStore(fileOps, directory, 'session', 0)
        : new FileActivationStateStore(fileOps, directory, 'session');
      await store.initialize();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unsupportedVersion|invalid/), expect.anything());
      warn.mockRestore();
    }
  });
  it.each(['{', 'null', '{}', '[null]', '[{"kid":"key"}]'])('preserves rejected signing-key bytes: %s', async content => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'signing-state-'));
    const file = path.join(directory, 'signing-keys.json');
    try {
      await fs.writeFile(file, content);
      const store = new FilesystemSigningKeyStore({ rootDir: directory });
      await expect(store.getActive('cookie')).rejects.toThrow(/state/);
      await expect(store.rotate({ kid: 'new', kind: 'cookie', payload: {} })).rejects.toThrow(/state/);
      await expect(store.rotateAndRetirePrior({ kid: 'new', kind: 'cookie', payload: {} })).rejects.toThrow(/state/);
      await expect(store.retire('key')).rejects.toThrow(/state/);
      await expect(store.delete('key', { force: true })).rejects.toThrow(/state/);
      await expect(store.pruneRotatedBefore(Date.now())).rejects.toThrow(/state/);
      expect(await fs.readFile(file, 'utf8')).toBe(content);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

import { afterEach, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';

const directories: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exclusive-copy-')); directories.push(dir);
  const source = path.join(dir, 'source'), destination = path.join(dir, 'destination');
  await fs.writeFile(source, 'source'); await fs.writeFile(destination, 'destination');
  return { source, destination, service: new FileOperationsService(new FileLockManager()) };
}
it('preserves existing bytes for exclusive copies and retains default overwrite behavior', async () => {
  const { source, destination, service } = await fixture();
  await expect(service.copyFile(source, destination, { exclusive: true })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(destination, 'utf8')).toBe('destination');
  await service.copyFile(source, destination);
  expect(await fs.readFile(destination, 'utf8')).toBe('source');
});
it('validates the destination on the exclusive path before writing', async () => {
  const { source, destination, service } = await fixture();
  const enforceWritablePath = jest.fn(async () => { throw new Error('Destination not allowed'); });
  service.setSessionContainerRegistryProvider(() => ({ getActiveContainer: () => ({
    resolve: <T>() => ({ enforceWritablePath }) as T,
  }) }));
  await expect(service.copyFile(source, destination, { exclusive: true })).rejects.toThrow('Destination not allowed');
  expect(enforceWritablePath).toHaveBeenCalledWith(destination);
  expect(await fs.readFile(destination, 'utf8')).toBe('destination');
});

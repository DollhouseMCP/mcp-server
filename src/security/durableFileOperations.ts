import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM']);

export async function syncFilesystemDirectory(directoryPath: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function durableAtomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | null = null;
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  try {
    handle = await fs.open(temporaryPath, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await syncFilesystemDirectory(directoryPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

export async function durableAppendFile(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  let handle: fs.FileHandle | null = null;
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  try {
    handle = await fs.open(filePath, 'a', mode);
    await handle.chmod(mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncFilesystemDirectory(directoryPath);
}

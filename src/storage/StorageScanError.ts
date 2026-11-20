import * as path from 'node:path';
import { constants } from 'node:os';

/** Preserve content diagnostics; only filesystem failures need path redaction. */
export function sanitizeStorageError(error: unknown, root?: string, target?: string, role?: string): unknown {
  if (error instanceof StorageScanError) {
    return role === undefined ? error : new StorageScanError(error, root, target, role);
  }
  if (error === null || typeof error !== 'object') return error;
  const code = (error as NodeJS.ErrnoException).code;
  const filesystemError = (typeof code === 'string' && Object.hasOwn(constants.errno, code))
    || 'path' in error || 'dest' in error;
  return filesystemError ? new StorageScanError(error, root, target, role) : error;
}

/** A client-safe storage failure; the original diagnostic is retained only as cause. */
export class StorageScanError extends Error {
  readonly code: string;
  readonly relativePath: string;

  constructor(cause: unknown, root?: string, target?: string, role = 'storage path') {
    const original = cause as NodeJS.ErrnoException | undefined;
    const code = typeof original?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(original.code)
      ? original.code : 'UNKNOWN';
    const candidate = target ?? original?.path;
    const relative = root && typeof candidate === 'string' ? path.relative(root, candidate) : '';
    const insideRoot = relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    const relativePath = insideRoot ? relative : '.';
    const location = root ? ` ${JSON.stringify(relativePath)}` : '';
    super(`Cannot inspect ${role}${location} (${code})`, { cause });
    this.name = 'StorageScanError';
    this.code = code;
    this.relativePath = relativePath;
  }
}

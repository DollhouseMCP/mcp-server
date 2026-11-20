import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

/** Probe once at suite registration so unsupported file-link cases are reported skipped. */
export function supportsFileSymlinks(): boolean {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'file-symlink-probe-'));
  try {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

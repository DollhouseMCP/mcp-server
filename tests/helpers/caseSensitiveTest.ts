import { it } from '@jest/globals';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';

/** Register only case-distinct fixtures on a filesystem that can keep their files distinct. */
export async function caseSensitiveTest(directory: string): Promise<typeof it> {
  const probe = await mkdtemp(path.join(directory, 'case-probe-'));
  try {
    await writeFile(path.join(probe, 'Upper'), 'probe');
    try {
      await stat(path.join(probe, 'upper'));
      return it.skip;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return it;
      throw cause;
    }
  } finally { await rm(probe, { recursive: true, force: true }); }
}

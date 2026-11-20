import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { fileMetadataProof } from './fileProof.js';

describe('file metadata proof', () => {
  it('ignores access-time-only changes and retains mutation evidence', async () => {
    const stat = await fs.stat(new URL(import.meta.url), { bigint: true });
    const before = fileMetadataProof(stat);
    Object.assign(stat, { atime: new Date(0), atimeMs: stat.atimeMs + 1n, atimeNs: stat.atimeNs + 1n });
    expect(fileMetadataProof(stat)).toEqual(before);
    for (const field of ['dev', 'ino', 'size', 'mode', 'nlink', 'ctimeNs', 'mtimeNs'] as const) {
      const original = stat[field];
      stat[field] = original + 1n;
      expect(fileMetadataProof(stat)).not.toEqual(before);
      stat[field] = original;
    }
  });
});

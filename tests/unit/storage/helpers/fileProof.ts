import type { BigIntStats } from 'node:fs';

/** Identity and mutation evidence; reads may change access times without writing. */
export function fileMetadataProof(stat: BigIntStats) {
  return { device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode,
    links: stat.nlink, ctime: stat.ctimeNs, mtime: stat.mtimeNs };
}

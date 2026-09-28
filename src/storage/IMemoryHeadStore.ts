import type { ElementWriteMetadata } from './IStorageLayer.js';

/** Opaque, user-bound identity and revision captured with one head read. */
export interface MemoryHeadToken {
  readonly backend: 'database' | 'file';
  readonly userId: string;
  readonly ownerId: string;
  /** Backend locator: a row UUID in DB mode, a relative path in file mode. */
  readonly locator: string;
  readonly name: string;
  readonly revision: string;
}

export interface MemoryHeadSnapshot {
  readonly content: string;
  readonly token: MemoryHeadToken;
}

/** Conditional head persistence; implementations must compare and write atomically. */
export interface IMemoryHeadStore {
  readHeadSnapshot(storageLocator: string): Promise<MemoryHeadSnapshot>;
  writeHeadIfCurrent(
    expected: MemoryHeadToken,
    nextName: string,
    content: string,
    metadata: ElementWriteMetadata,
  ): Promise<MemoryHeadToken>;
}

import type { Dir, Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { MAX_MEMORY_VOLUME_LIST_SCAN } from './MemoryVolumeObservation.js';

/** Internal scan capability; implementations retain their own operation-specific bounds. */
export interface FileMemoryDirectoryScanner {
  readonly limit: number;
  readonly consumed: number;
  scan(directoryPath: string, inspect: (name: string) => void): Promise<void>;
}

/** Internal resource failure, never proof that a directory or artifact is absent. */
export class FileMemoryDirectoryScanLimitError extends Error {
  readonly code = 'EHEADRESOURCE';
  constructor() { super('Memory directory inspection budget exhausted'); }
}

/**
 * Invocation-owned read-attempt budget, not ownership or mutation authority.
 * Reserve before every Dir.read(): entries, EOF and failures each cost one unit.
 * Reservations are synchronous, shared across concurrent readers and never refunded.
 */
export class FileMemoryDirectoryScanBudget {
  readonly limit: number;
  #consumed = 0;

  constructor(limit = MAX_MEMORY_VOLUME_LIST_SCAN) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMORY_VOLUME_LIST_SCAN) {
      throw new RangeError('Memory directory inspection budget must be an integer from 1 through 1000');
    }
    this.limit = limit;
    Object.freeze(this);
  }

  get consumed(): number { return this.#consumed; }
  get remaining(): number { return this.limit - this.#consumed; }

  async read(directory: Dir): Promise<Dirent | null> {
    if (this.#consumed === this.limit) throw new FileMemoryDirectoryScanLimitError();
    this.#consumed += 1;
    return await directory.read();
  }

  private async inspectEntries(directory: Dir, inspect: (name: string) => void): Promise<void> {
    const entry = await this.read(directory);
    if (!entry) return;
    inspect(entry.name);
    // Ordered reads are required; the same hard budget bounds this recursion.
    return this.inspectEntries(directory, inspect);
  }

  async scan(directoryPath: string, inspect: (name: string) => void): Promise<void> {
    const directory = await fs.opendir(directoryPath);
    let failed = false;
    let failure: unknown;
    try {
      await this.inspectEntries(directory, inspect);
    } catch (cause) {
      failed = true;
      failure = cause;
    } finally {
      try { await directory.close(); }
      catch (cause) {
        // Keep both errors and the primary typed refusal when close also fails.
        failure = failed ? Object.assign(new AggregateError([failure, cause], 'Memory directory inspection and close failed', { cause: failure }), {
          code: (failure as NodeJS.ErrnoException | undefined)?.code,
        }) : cause;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
}

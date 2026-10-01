/** CREATE-private schedule budget; shared observation/listing limits are unchanged. */
import type { Dir } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeMemoryDirectoryInspection, FileMemoryDirectoryScanLimitError } from './FileMemoryDirectoryScanBudget.js';
export interface CreateScanSlot { locator: string; names: string[]; missing: boolean }
export class FileMemoryCreateScanBudget {
  #consumed = 0;
  #limit = 1000;
  #reserved = false;
  get consumed(): number { return this.#consumed; }
  get limit(): number { return this.#limit; }
  reserve(slots: CreateScanSlot[], headParent: string, phase?: string): void {
    if (this.#reserved || new Set(slots.map(slot => slot.locator)).size !== slots.length) throw new FileMemoryDirectoryScanLimitError();
    const weights = new Map(slots.map(slot => [slot.locator, new Set(slot.names).size + 1]));
    const weight = (locator: string) => {
      const value = weights.get(locator);
      if (value === undefined) throw new FileMemoryDirectoryScanLimitError();
      return value;
    };
    const proof = [...weights.values()].reduce((sum, value) => sum + value, 0);
    if (proof > 1000) throw new FileMemoryDirectoryScanLimitError();
    const transition = (locator: string) => weight(locator) + (path.posix.dirname(locator) !== locator ? (weights.get(path.posix.dirname(locator)) ?? 0) : 0);
    const head = transition(headParent), owners = transition('.memory-owners/owners');
    // Terminal suffix: published hook + both metadata writes + finalization =23P+3qH+2qOwners.
    // PREPARED adds link/publish (25P+8qH); LINKED adds publish (12P+4qH).
    // Recovery's initial proof is already charged to discovery; reserve only its remaining suffix.
    let remaining = phase ? 23 * proof + 3 * head + 2 * owners : 59 * proof + 15 * head + 2 * owners;
    if (phase === 'PREPARED_CREATE') remaining += 25 * proof + 8 * head;
    else if (phase === 'LINKED_CREATE') remaining += 12 * proof + 4 * head;
    for (const locator of ['.memory-owners', '.memory-owners/owners']) {
      const slot = slots.find(item => item.locator === locator)!;
      remaining += slot.missing ? 5 * proof + transition(path.posix.dirname(locator)) + weight(locator) : 3 * proof + weight(locator);
    }
    const limit = this.#consumed + remaining;
    if (!Number.isSafeInteger(limit) || limit > 110000) throw new FileMemoryDirectoryScanLimitError();
    this.#limit = limit; this.#reserved = true;
  }
  private async read(directory: Dir, localAttempts: number) {
    if (localAttempts >= 1000 || this.#consumed >= this.#limit) throw new FileMemoryDirectoryScanLimitError();
    this.#consumed += 1; // Synchronous reservation before the actual read, including EOF/errors.
    return await directory.read();
  }
  async scan(directoryPath: string, inspect: (name: string) => void): Promise<void> {
    const directory = await fs.opendir(directoryPath);
    let primary: { cause: unknown } | undefined;
    try {
      let attempts = 0;
      // Each entry/EOF consumes the same counter; no next read after either bound is exhausted.
      while (true) {
        const entry = await this.read(directory, attempts++);
        if (!entry) break;
        inspect(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    await closeMemoryDirectoryInspection(directory, primary, 'CREATE directory inspection and close failed');
  }
}

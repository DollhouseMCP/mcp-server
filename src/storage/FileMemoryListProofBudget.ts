/** Private listing namespace proof accounting; archive inspection remains separately bounded. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileMemoryDirectoryScanLimitError, type FileMemoryDirectoryScanner } from './FileMemoryDirectoryScanBudget.js';

interface Census {
  readonly identity: readonly string[];
  readonly names: readonly string[];
  readonly weight: number;
}
export class FileMemoryListProofBudget implements FileMemoryDirectoryScanner {
  #consumed = 0;
  #limit = 81920;
  #reserved = false;
  #identityChecks = 0;
  readonly #paths = new Map<string, string>();
  readonly #censuses = new Map<string, Census>();
  get consumed(): number { return this.#consumed; }
  get limit(): number { return this.#limit; }
  get identityChecks(): number { return this.#identityChecks; }
  private async identity(directoryPath: string): Promise<readonly string[]> {
    this.#identityChecks++;
    const stat = await fs.lstat(directoryPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Listing namespace is unsafe'), { code: 'EARCHIVEUNSAFE' });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].map(String);
  }
  private weight(directoryPath: string): number {
    const key = this.#paths.get(path.resolve(directoryPath));
    const census = key && this.#censuses.get(key);
    if (!census) throw new FileMemoryDirectoryScanLimitError();
    return census.weight;
  }
  reserve(headParent: string, registry: string, edgeParents: readonly string[], missingParent?: string): void {
    if (this.#reserved) throw new FileMemoryDirectoryScanLimitError();
    const proof = [...this.#censuses.values()].reduce((sum, census) => sum + census.weight, 0);
    if (proof > 8192) throw new FileMemoryDirectoryScanLimitError();
    // Two remaining owner observations, each at most three stable-read attempts;
    // four namespace reproofs, each with two extra scans of a missing edge parent.
    const remaining = 6 * (2 * this.weight(headParent) + this.weight(registry)) +
      4 * edgeParents.reduce((sum, parent) => sum + this.weight(parent), 0) +
      (missingParent ? 8 * this.weight(missingParent) : 0);
    const limit = this.#consumed + remaining;
    if (!Number.isSafeInteger(limit) || limit > 327680) throw new FileMemoryDirectoryScanLimitError();
    this.#limit = limit;
    this.#reserved = true;
  }
  async scan(directoryPath: string, inspect: (name: string) => void): Promise<void> {
    const named = path.resolve(directoryPath);
    const before = await this.identity(named);
    const key = `${before[0]}:${before[1]}`;
    const originalKey = this.#paths.get(named);
    const original = this.#censuses.get(key);
    if ((originalKey && originalKey !== key) || (original && !isDeepStrictEqual(original.identity, before)) ||
      (this.#reserved && !originalKey)) throw Object.assign(new Error('Listing namespace changed'), { code: 'EARCHIVECHANGED' });
    const directory = await fs.opendir(named);
    const names: string[] = [];
    let attempts = 0;
    let primary: { cause: unknown } | undefined;
    try {
      // Every entry, EOF and failed read is reserved synchronously; no free overflow read.
      while (true) {
        if (attempts === 4096 || this.#consumed >= this.#limit) throw new FileMemoryDirectoryScanLimitError();
        attempts++; this.#consumed++;
        const entry = await directory.read();
        if (!entry) break;
        names.push(entry.name);
        inspect(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    try { await directory.close(); }
    catch (cause) {
      if (!primary) throw cause;
      throw Object.assign(new AggregateError([primary.cause, cause], 'Listing namespace inspection and close failed', { cause: primary.cause }), {
        code: (primary.cause as NodeJS.ErrnoException | undefined)?.code,
      });
    }
    if (primary) throw primary.cause;
    const after = await this.identity(named);
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (!isDeepStrictEqual(before, after) || (original && !isDeepStrictEqual(original.names, names))) {
      throw Object.assign(new Error('Listing namespace changed'), { code: 'EARCHIVECHANGED' });
    }
    // Only complete EOF plus successful close establishes discovery evidence.
    if (!original) {
      const census = { identity: before, names, weight: attempts };
      const total = [...this.#censuses.values()].reduce((sum, value) => sum + value.weight, attempts);
      if (total > 8192) throw new FileMemoryDirectoryScanLimitError();
      this.#censuses.set(key, census);
    }
    this.#paths.set(named, key);
  }
}

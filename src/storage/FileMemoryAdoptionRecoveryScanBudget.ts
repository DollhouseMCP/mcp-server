/** Recovery-private resource accounting; existing recovery proofs alone grant authority. */
import type { Dir, BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { closeMemoryDirectoryInspection, FileMemoryDirectoryScanLimitError, type FileMemoryDirectoryScanner } from './FileMemoryDirectoryScanBudget.js';

interface Slot { names: Set<string>; paths: string[] }
const metadata = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink];
export class FileMemoryAdoptionRecoveryScanBudget implements FileMemoryDirectoryScanner {
  #consumed = 0;
  #limit = 4096;
  #reserved = false;
  readonly #weights = new Map<string, number>();
  readonly #slots = new Map<string, Slot>();
  readonly #roles = new Map<string, string>();
  readonly #bindings = new Map<string, string>();
  get consumed(): number { return this.#consumed; }
  get limit(): number { return this.#limit; }
  async discover(root: string, headParent: string, sidecarName: string, ownerId: string): Promise<void> {
    if (this.#reserved || this.#roles.size) throw new FileMemoryDirectoryScanLimitError();
    const parent = path.join(root, '.memory-owners'), registry = path.join(parent, 'owners');
    for (const [role, location, additions] of [
      ['T', root, ['.memory-owners']], ['H', headParent, [`${sidecarName}.adopt-${ownerId}.tmp`]],
      ['O', parent, ['owners']], ['R', registry, [`${ownerId}.json`, `${ownerId}.json.adopt-${ownerId}.tmp`]],
    ] as const) {
      // Parent slots precede children; all discovery attempts share one counter.
      await this.captureRole(role, path.resolve(location), additions);
    }
    // Projected virtual slots supply count ceilings only, never directory identity or permission.
    for (const slot of this.#slots.values()) for (const location of slot.paths) this.#weights.set(location, slot.names.size + 1);
  }
  private async captureRole(role: string, named: string, additions: readonly string[]): Promise<void> {
    let stat: BigIntStats;
    try { stat = await fs.lstat(named, { bigint: true }); }
    catch (cause) {
      if ((role !== 'O' && role !== 'R') || (cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause;
      const key = `missing:${named}`;
      this.#roles.set(role, key); this.#slots.set(key, { names: new Set(additions), paths: [named] });
      return;
    }
    await this.captureExistingRole(role, named, additions, stat);
  }
  private async captureExistingRole(role: string, named: string, additions: readonly string[], stat: BigIntStats): Promise<void> {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileMemoryDirectoryScanLimitError();
    const key = `${stat.dev}:${stat.ino}`, priorBinding = this.#bindings.get(named);
    if (priorBinding !== undefined && priorBinding !== key) throw new FileMemoryDirectoryScanLimitError();
    this.#bindings.set(named, key);
    if ((role === 'O' || role === 'R') && [...this.#roles.values()].includes(key)) throw new FileMemoryDirectoryScanLimitError();
    this.#roles.set(role, key);
    const existing = this.#slots.get(key);
    if (existing) { additions.forEach(name => existing.names.add(name)); existing.paths.push(named); return; }
    const names = new Set<string>();
    await this.inspect(named, 4096, name => names.add(name));
    if (!isDeepStrictEqual(metadata(stat), metadata(await fs.lstat(named, { bigint: true })))) throw new FileMemoryDirectoryScanLimitError();
    additions.forEach(name => names.add(name)); this.#slots.set(key, { names, paths: [named] });
  }
  reserve(): void {
    if (this.#reserved || this.#roles.size !== 4) throw new FileMemoryDirectoryScanLimitError();
    const P = [...this.#slots.values()].reduce((sum, slot) => sum + slot.names.size + 1, 0);
    if (P > 4096 || this.#consumed > P) throw new FileMemoryDirectoryScanLimitError();
    const w = (role: string) => this.#slots.get(this.#roles.get(role)!)!.names.size + 1;
    const T = w('T'), H = w('H'), O = w('O'), R = w('R');
    // Full both-missing path: 12A+3B+3M+2Q+T+O+R+2K+19C.
    // State/topology can change before the first original authority proof;
    // uniformly reserve this weighted suffix without selecting cached authority.
    const remaining = 51 * T + 47 * O + 40 * H + 69 * R;
    const limit = this.#consumed + remaining;
    if (!Number.isSafeInteger(limit) || limit > 376832) throw new FileMemoryDirectoryScanLimitError();
    this.#limit = limit; this.#reserved = true;
  }
  async read(directory: Dir, attempts: number, bound: number) {
    if (attempts >= bound || this.#consumed >= this.#limit) throw new FileMemoryDirectoryScanLimitError();
    this.#consumed++; return await directory.read();
  }
  private async inspect(location: string, bound: number, inspect: (name: string) => void): Promise<void> {
    const handle = await fs.opendir(location); let attempts = 0;
    let primary: { cause: unknown } | undefined;
    try {
      while (true) {
        const entry = await this.read(handle, attempts++, bound);
        if (!entry) break;
        inspect(entry.name);
      }
    } catch (cause) { primary = { cause }; }
    await closeMemoryDirectoryInspection(handle, primary, 'Adoption recovery directory inspection and close failed');
  }
  async scan(location: string, inspect: (name: string) => void): Promise<void> {
    const bound = this.#weights.get(path.resolve(location));
    if (!this.#reserved || bound === undefined) throw new FileMemoryDirectoryScanLimitError();
    await this.inspect(location, bound, inspect);
  }
}

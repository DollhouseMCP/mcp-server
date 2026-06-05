/**
 * FilesystemSigningKeyStore
 *
 * Durable JSON-on-disk backend. Single file at `<rootDir>/signing-keys.json`
 * holds the full set of keys (active + rotated). Atomic write-temp + rename
 * via `FileLockManager`; reads tolerate ENOENT (returns empty set) and
 * malformed JSON (logs and returns empty set).
 *
 * Single-file (rather than file-per-kid) because:
 *   - Rotation is a multi-row update (mark old inactive + insert new),
 *     which is naturally atomic when the whole set is one file.
 *   - Number of keys is small (one active per kind + a short rotation
 *     audit tail).
 *
 * @module storage/signingKeys/FilesystemSigningKeyStore
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { FileLockManager } from '../../security/fileLockManager.js';
import { logger } from '../../utils/logger.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyWrite,
} from './ISigningKeyStore.js';

export interface FilesystemSigningKeyStoreOptions {
  /** Directory holding `signing-keys.json`. */
  rootDir: string;
}

export class FilesystemSigningKeyStore implements ISigningKeyStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private readonly locks = new FileLockManager();

  constructor(options: FilesystemSigningKeyStoreOptions) {
    this.rootDir = options.rootDir;
    this.filePath = path.join(this.rootDir, 'signing-keys.json');
  }

  async getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    const all = await this.readAll();
    return all.find((k) => k.kind === kind && k.active) ?? null;
  }

  async getByKid(kid: string): Promise<SigningKey | null> {
    const all = await this.readAll();
    return all.find((k) => k.kid === kid) ?? null;
  }

  async listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    const all = await this.readAll();
    return all.filter((k) => k.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  }

  async rotate(write: SigningKeyWrite): Promise<SigningKey> {
    return this.locks.withLock(`signing-keys:${this.filePath}`, async () => {
      const all = await this.readAllRaw();
      if (all.some((k) => k.kid === write.kid)) {
        throw new Error(
          `SigningKeyStore: kid '${write.kid}' already exists; rotation requires a fresh kid.`,
        );
      }
      const now = Date.now();
      // Mark existing active of this kind as inactive
      for (const key of all) {
        if (key.kind === write.kind && key.active) {
          key.active = false;
          key.rotatedAt = now;
        }
      }
      const newKey: SigningKey = {
        kid: write.kid,
        kind: write.kind,
        payload: write.payload,
        active: true,
        createdAt: now,
      };
      all.push(newKey);
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.filePath, JSON.stringify(all, null, 2));
      return newKey;
    });
  }

  async pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    return this.locks.withLock(`signing-keys:${this.filePath}`, async () => {
      const all = await this.readAllRaw();
      const before = all.length;
      const kept = all.filter(
        (k) => k.active || k.rotatedAt === undefined || k.rotatedAt >= beforeEpochMs,
      );
      const removed = before - kept.length;
      if (removed > 0) {
        await this.ensureRoot();
        await this.locks.atomicWriteFile(this.filePath, JSON.stringify(kept, null, 2));
      }
      return removed;
    });
  }

  async retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    return this.locks.withLock(`signing-keys:${this.filePath}`, async () => {
      const all = await this.readAllRaw();
      const key = all.find(candidate => candidate.kid === kid);
      if (!key) return null;
      key.active = false;
      key.rotatedAt ??= retiredAt;
      key.retiredAt = retiredAt;
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.filePath, JSON.stringify(all, null, 2));
      return structuredClone(key);
    });
  }

  async delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    return this.locks.withLock(`signing-keys:${this.filePath}`, async () => {
      const all = await this.readAllRaw();
      const key = all.find(candidate => candidate.kid === kid);
      if (!key) return false;
      if (!options.force && (key.active || key.retiredAt === undefined)) return false;
      const kept = all.filter(candidate => candidate.kid !== kid);
      await this.ensureRoot();
      await this.locks.atomicWriteFile(this.filePath, JSON.stringify(kept, null, 2));
      return true;
    });
  }

  private async readAll(): Promise<SigningKey[]> {
    return this.readAllRaw();
  }

  private async readAllRaw(): Promise<SigningKey[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        logger.warn(
          '[SigningKeyStore:fs] signing-keys.json is not an array; treating as empty',
          { path: this.filePath },
        );
        return [];
      }
      return parsed as SigningKey[];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        logger.warn(
          '[SigningKeyStore:fs] signing-keys.json failed to parse; treating as empty',
          { path: this.filePath, error: err.message },
        );
        return [];
      }
      throw err;
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

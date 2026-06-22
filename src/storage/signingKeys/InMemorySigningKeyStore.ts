/**
 * InMemorySigningKeyStore
 *
 * Non-durable in-process backend. Map keyed by kid; tracks which kid is
 * active per kind. State lost on restart — tests + dev opt-in.
 *
 * @module storage/signingKeys/InMemorySigningKeyStore
 */

import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyWrite,
} from './ISigningKeyStore.js';

export class InMemorySigningKeyStore implements ISigningKeyStore {
  private readonly keys = new Map<string, SigningKey>();

  getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    for (const key of this.keys.values()) {
      if (key.kind === kind && key.active) return Promise.resolve(cloneKey(key));
    }
    return Promise.resolve(null);
  }

  getByKid(kid: string): Promise<SigningKey | null> {
    const key = this.keys.get(kid);
    return Promise.resolve(key ? cloneKey(key) : null);
  }

  listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    const matching = [...this.keys.values()]
      .filter((k) => k.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt);
    return Promise.resolve(matching.map(cloneKey));
  }

  rotate(write: SigningKeyWrite): Promise<SigningKey> {
    if (this.keys.has(write.kid)) {
      return Promise.reject(new Error(`SigningKeyStore: kid '${write.kid}' already exists; rotation requires a fresh kid.`));
    }
    const now = Date.now();
    // Mark any existing active key of this kind as inactive.
    for (const key of this.keys.values()) {
      if (key.kind === write.kind && key.active) {
        key.active = false;
        key.rotatedAt = now;
      }
    }
    const newKey: SigningKey = {
      kid: write.kid,
      kind: write.kind,
      payload: structuredClone(write.payload),
      active: true,
      createdAt: now,
    };
    this.keys.set(write.kid, newKey);
    return Promise.resolve(cloneKey(newKey));
  }

  pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    let removed = 0;
    for (const [kid, key] of this.keys) {
      if (!key.active && key.rotatedAt !== undefined && key.rotatedAt < beforeEpochMs) {
        this.keys.delete(kid);
        removed++;
      }
    }
    return Promise.resolve(removed);
  }

  retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    const key = this.keys.get(kid);
    if (!key) return Promise.resolve(null);
    key.active = false;
    key.rotatedAt ??= retiredAt;
    key.retiredAt = retiredAt;
    return Promise.resolve(cloneKey(key));
  }

  delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    const key = this.keys.get(kid);
    if (!key) return Promise.resolve(false);
    if (!options.force && (key.active || key.retiredAt === undefined)) return Promise.resolve(false);
    return Promise.resolve(this.keys.delete(kid));
  }
}

function cloneKey(k: SigningKey): SigningKey {
  return {
    kid: k.kid,
    kind: k.kind,
    payload: structuredClone(k.payload),
    active: k.active,
    createdAt: k.createdAt,
    rotatedAt: k.rotatedAt,
    retiredAt: k.retiredAt,
  };
}

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
  SigningKeyModeTransition,
  SigningKeyModeTransitionResult,
  SigningKeyWrite,
} from './ISigningKeyStore.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';
import {
  cloneSigningKey,
  inheritAuthorizationGeneration,
  SigningKeyLifecycleConflictError,
  stageSigningKeyModeTransition,
} from './signingKeyLifecycle.js';

export class InMemorySigningKeyStore implements ISigningKeyStore {
  private readonly keys = new Map<string, SigningKey>();
  private transactionGate: InMemoryTransactionGate | null = null;
  private readonly standaloneGate = new InMemoryTransactionGate();

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return [...this.keys.entries()].map(([kid, key]) => [kid, cloneKey(key)] as const);
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    this.keys.clear();
    for (const [kid, key] of snapshot as readonly (readonly [string, SigningKey])[]) {
      this.keys.set(kid, cloneKey(key));
    }
  }

  getActive(kind: SigningKeyKind): Promise<SigningKey | null> {
    return this.runRead(async () => {
      for (const key of this.keys.values()) {
        if (key.kind === kind && key.active) return cloneKey(key);
      }
      return null;
    });
  }

  getByKid(kid: string): Promise<SigningKey | null> {
    return this.runRead(async () => {
      const key = this.keys.get(kid);
      return key ? cloneKey(key) : null;
    });
  }

  listByKind(kind: SigningKeyKind): Promise<SigningKey[]> {
    return this.runRead(async () => {
      const matching = [...this.keys.values()]
        .filter((k) => k.kind === kind)
        .sort((a, b) => b.createdAt - a.createdAt);
      return matching.map(cloneKey);
    });
  }

  withActiveKey<T>(kind: SigningKeyKind, operation: (key: SigningKey) => Promise<T>): Promise<T> {
    return this.runRead(async () => {
      const key = [...this.keys.values()].find(candidate =>
        candidate.kind === kind && candidate.active && candidate.retiredAt === undefined);
      if (!key) throw new Error(`No active '${kind}' signing key is available`);
      return operation(cloneKey(key));
    });
  }

  rotate(write: SigningKeyWrite): Promise<SigningKey> {
    return this.runMutation(async () => this.rotateUnlocked(write));
  }

  assertActiveKey(kid: string, kind: SigningKeyKind): Promise<SigningKey> {
    return this.runRead(async () => {
      const key = this.keys.get(kid);
      if (!key || key.kind !== kind || !key.active || key.retiredAt !== undefined) {
        throw new SigningKeyLifecycleConflictError(
          `Signing key '${kid}' is no longer the active '${kind}' key`,
        );
      }
      return cloneKey(key);
    });
  }

  transitionAuthorizationMode(
    transition: SigningKeyModeTransition,
  ): Promise<SigningKeyModeTransitionResult> {
    return this.runMutation(async () => {
      const staged = stageSigningKeyModeTransition(
        [...this.keys.values()],
        transition,
        transition.transitionedAt,
      );
      this.keys.clear();
      for (const key of staged.keys) this.keys.set(key.kid, cloneSigningKey(key));
      return {
        transitionId: staged.transitionId,
        alreadyApplied: staged.alreadyApplied,
        retired: staged.retired.map(cloneSigningKey),
        installed: staged.installed.map(cloneSigningKey),
      };
    });
  }

  private rotateUnlocked(write: SigningKeyWrite): SigningKey {
    if (this.keys.has(write.kid)) {
      throw new Error(`SigningKeyStore: kid '${write.kid}' already exists; rotation requires a fresh kid.`);
    }
    const now = Date.now();
    const current = [...this.keys.values()].find(key => key.kind === write.kind && key.active);
    const effectiveWrite = inheritAuthorizationGeneration(current, write);
    // Mark any existing active key of this kind as inactive.
    for (const key of this.keys.values()) {
      if (key.kind === write.kind && key.active) {
        key.active = false;
        key.rotatedAt = now;
      }
    }
    const newKey: SigningKey = {
      kid: effectiveWrite.kid,
      kind: effectiveWrite.kind,
      payload: structuredClone(effectiveWrite.payload),
      active: true,
      createdAt: now,
    };
    this.keys.set(write.kid, newKey);
    return cloneKey(newKey);
  }

  pruneRotatedBefore(beforeEpochMs: number): Promise<number> {
    return this.runMutation(async () => {
      let removed = 0;
      for (const [kid, key] of this.keys) {
        if (!key.active && key.rotatedAt !== undefined && key.rotatedAt < beforeEpochMs) {
          this.keys.delete(kid);
          removed++;
        }
      }
      return removed;
    });
  }

  retire(kid: string, retiredAt: number = Date.now()): Promise<SigningKey | null> {
    return this.runMutation(async () => {
      const key = this.keys.get(kid);
      if (!key) return null;
      key.active = false;
      key.rotatedAt ??= retiredAt;
      key.retiredAt ??= retiredAt;
      return cloneKey(key);
    });
  }

  delete(kid: string, options: { readonly force?: boolean } = {}): Promise<boolean> {
    return this.runMutation(async () => {
      const key = this.keys.get(kid);
      if (!key) return false;
      if (!options.force && (key.active || key.retiredAt === undefined)) return false;
      return this.keys.delete(kid);
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return (this.transactionGate ?? this.standaloneGate).runMutation(operation);
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return (this.transactionGate ?? this.standaloneGate).runRead(operation);
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

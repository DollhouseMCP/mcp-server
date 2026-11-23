import type { PersistedStateRead } from './persistence-utils.js';

export interface PersistedBlock {
  eventId?: string;
  reason: string;
  triggeredPatterns?: string[];
  blockedAt: string;
  verificationId?: string;
  sessionId?: string;
  goalId?: string;
  requiresAdmin?: boolean;
}

export type BlockMutation =
  | { kind: 'put'; name: string; block: unknown }
  | { kind: 'remove'; name: string; eventId?: string }
  | { kind: 'clear' };

/** Durable block snapshots, scoped to one user by the composition root. */
export interface IDangerZoneBlockStore {
  readonly location: string;
  /**
   * True is a routine refresh that may return the live in-memory snapshot;
   * false or omitted forces a full read from storage.
   */
  load(refresh?: boolean): Promise<PersistedStateRead<Record<string, unknown>>>;
  /**
   * True means applied; false means declined by authoritative concurrent state.
   * A declined mutation must not be retried. Storage failures throw instead.
   */
  apply(mutation: BlockMutation, snapshot: Record<string, unknown>): Promise<boolean>;
  /** Preserve the snapshot before an administrative reset; empty string means no evidence existed. */
  reset(): Promise<string>;
}

export type DangerZoneBlockStoreFactory = (userId?: string, directory?: string) => IDangerZoneBlockStore;

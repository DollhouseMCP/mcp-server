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
  | { kind: 'put'; name: string; block: unknown; replay?: true }
  | { kind: 'remove'; name: string; eventId?: string }
  | { kind: 'clear' };

/** Durable block snapshots, scoped to one user by the composition root. */
export interface IDangerZoneBlockStore {
  readonly location: string;
  /** A routine refresh can reuse a snapshot if the backing file is unchanged. */
  load(refresh?: boolean): Promise<PersistedStateRead<Record<string, unknown>>>;
  /** Optional notification used to force a fresh read during file-backed recovery. */
  watchForRecovery?(retry: () => Promise<void>): () => void;
  /**
   * True means applied. A snapshot carries the authoritative state after applying or merging a mutation.
   * False means declined by authoritative concurrent state.
   * A declined mutation must not be retried. Storage failures throw instead.
   */
  apply(mutation: BlockMutation, snapshot: Record<string, unknown>): Promise<boolean | { snapshot: Record<string, unknown> }>;
  /** Preserve the snapshot before an administrative reset; empty string means no evidence existed. */
  reset(): Promise<string>;
}

export type DangerZoneBlockStoreFactory = (userId?: string, directory?: string) => IDangerZoneBlockStore;

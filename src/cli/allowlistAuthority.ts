/**
 * Where `dollhouse-allowlist` reads and writes.
 *
 * With the embedded authorization server on PostgreSQL, sign-in consults the
 * allowlist the console manages (`account_allowlist_entries`). The earlier
 * `auth_allowlist` table is not consulted there, and start-up refuses to run
 * while it holds an entry the console's allowlist does not carry. So on that
 * configuration the command works on the console's allowlist, and offers
 * `reconcile` to empty the earlier one. Everywhere else it works on the
 * storage layer's allowlist, as it always has.
 *
 * @module cli/allowlistAuthority
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { findAllowlistEntriesMissingFromAuthority } from '../auth/embedded-as/allowlistGate.js';
import type {
  AllowlistMatchValues,
  AuthAllowlistEntry,
  AuthAllowlistKind,
  IAuthStorageLayer,
} from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { authAllowlist, userAdminRoles, users } from '../database/schema/index.js';
import { authIdentityEvents } from '../database/schema/auth.js';
import { ConsoleStoreConflictError } from '../web-console/stores/ConsoleStoreValidation.js';
import type { ConsoleAccountAllowlistEntry } from '../web-console/stores/IConsoleAccountAllowlistStore.js';
import {
  accountAllowlistDeniesIdentityWithTx,
  addAccountAllowlistEntryWithTx,
  listActiveAccountAllowlistEntriesWithTx,
  removeAccountAllowlistEntryWithTx,
  updateAccountAllowlistEntryWithTx,
} from '../web-console/stores/PostgresConsoleAccountAllowlistStore.js';

/** A fault the operator can act on. The message is written for them. */
export class AllowlistCliError extends Error {}

export interface AllowlistCliAddInput {
  readonly kind: AuthAllowlistKind;
  readonly value: string;
  readonly note: string | null;
}

/** The allowlist the command works on, whichever one that is. */
export interface AllowlistCliTarget {
  /** Shown to the operator so it is clear which list was changed. */
  readonly description: string;
  list(): Promise<AuthAllowlistEntry[]>;
  add(input: AllowlistCliAddInput): Promise<AuthAllowlistEntry>;
  /** Null when no entry has that id. */
  updateNote(id: string, note: string | null): Promise<AuthAllowlistEntry | null>;
  /** False when no entry has that id. */
  remove(id: string): Promise<boolean>;
}

/** The storage layer's own allowlist: filesystem, memory, or PostgreSQL without the embedded server. */
export class StorageAllowlistCliTarget implements AllowlistCliTarget {
  readonly description = 'the sign-in allowlist';

  constructor(private readonly storage: IAuthStorageLayer) {}

  list(): Promise<AuthAllowlistEntry[]> {
    return this.storage.allowlistList();
  }

  add(input: AllowlistCliAddInput): Promise<AuthAllowlistEntry> {
    return this.storage.allowlistAdd({ kind: input.kind, value: input.value, note: input.note, createdBy: 'cli' });
  }

  updateNote(id: string, note: string | null): Promise<AuthAllowlistEntry | null> {
    return this.storage.allowlistUpdate(id, { note });
  }

  remove(id: string): Promise<boolean> {
    return this.storage.allowlistRemove(id);
  }
}

/** The console admin a command-line change is recorded as made by. */
export interface AllowlistCliActor {
  readonly userId: string;
  readonly username: string;
}

/** Console admins who can be named as the author of a change. */
export async function listConsoleAdmins(db: DatabaseInstance): Promise<AllowlistCliActor[]> {
  return withSystemContext(db, tx => tx
    .selectDistinct({ userId: users.id, username: users.username })
    .from(userAdminRoles)
    .innerJoin(users, eq(users.id, userAdminRoles.userId))
    .where(and(
      eq(userAdminRoles.role, 'admin'),
      isNull(userAdminRoles.revokedAt),
      isNull(users.deletedAt),
      isNull(users.disabledAt),
    ))
    .orderBy(users.username));
}

/**
 * The console's allowlist records who made each change, and the command has
 * no signed-in user. With one console admin, that admin is the author. With
 * several, the operator says which with `--as`; nobody is guessed.
 */
export function chooseActor(admins: readonly AllowlistCliActor[], asUsername: string | undefined): AllowlistCliActor {
  if (asUsername !== undefined) {
    const named = admins.find(admin => admin.username === asUsername);
    if (!named) {
      throw new AllowlistCliError(
        `--as '${asUsername}' is not an active console admin. ` +
        (admins.length > 0 ? `Active admins: ${admins.map(admin => admin.username).join(', ')}.` : 'There are no active console admins.'),
      );
    }
    return named;
  }
  if (admins.length === 1) return admins[0];
  if (admins.length === 0) {
    throw new AllowlistCliError(
      'This install records who makes each allowlist change, and it has no console admin to record. ' +
      'Designate the admin first with dollhouse-admin-bootstrap, then run this again.',
    );
  }
  throw new AllowlistCliError(
    'This install has more than one console admin, and allowlist changes record who made them. ' +
    `Say which admin you are with --as <username>. Active admins: ${admins.map(admin => admin.username).join(', ')}.`,
  );
}

function fromConsoleEntry(entry: ConsoleAccountAllowlistEntry): AuthAllowlistEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    value: entry.normalizedValue,
    note: entry.note,
    createdBy: entry.createdByUserId,
    createdAt: new Date(entry.createdAt),
  };
}

/** Recorded with each change, in the same transaction, so the console's sign-in audit shows it. */
async function recordChange(
  tx: DrizzleTx,
  actor: AllowlistCliActor,
  occurredAt: Date,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.insert(authIdentityEvents).values({
    type: 'auth.allowlist_changed',
    sub: actor.username,
    provider: null,
    externalSub: null,
    details: { source: 'dollhouse-allowlist', actorUserId: actor.userId, ...details },
    timestamp: occurredAt.getTime(),
  });
}

/** The allowlist the console manages, which is the one sign-in consults on a hosted install. */
export class ConsoleAllowlistCliTarget implements AllowlistCliTarget {
  readonly description = 'the allowlist sign-in uses (the one the console manages)';

  /**
   * `resolveActor` is asked only when something is about to be changed, so
   * listing works on an install that has no console admin yet.
   */
  constructor(
    private readonly db: DatabaseInstance,
    private readonly resolveActor: () => Promise<AllowlistCliActor>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<AuthAllowlistEntry[]> {
    const entries = await withSystemContext(this.db, tx => listActiveAccountAllowlistEntriesWithTx(tx));
    return entries.map(fromConsoleEntry);
  }

  async add(input: AllowlistCliAddInput): Promise<AuthAllowlistEntry> {
    const actor = await this.resolveActor();
    const occurredAt = this.now();
    try {
      return await withSystemContext(this.db, async tx => {
        const entry = await addAccountAllowlistEntryWithTx(tx, {
          kind: input.kind,
          value: input.value,
          note: input.note,
          createdByUserId: actor.userId,
          createdAt: occurredAt,
        });
        await recordChange(tx, actor, occurredAt, { operation: 'add', kind: entry.kind, entryId: entry.id });
        return fromConsoleEntry(entry);
      });
    } catch (error) {
      if (error instanceof ConsoleStoreConflictError) {
        // The same wording the storage layer uses, which the command matches on.
        throw new Error(`allowlist entry already exists for kind=${input.kind} value=${input.value}`);
      }
      throw error;
    }
  }

  async updateNote(id: string, note: string | null): Promise<AuthAllowlistEntry | null> {
    const actor = await this.resolveActor();
    const occurredAt = this.now();
    return withSystemContext(this.db, async tx => {
      const entry = await updateAccountAllowlistEntryWithTx(tx, { id, note });
      if (!entry) return null;
      await recordChange(tx, actor, occurredAt, { operation: 'update', kind: entry.kind, entryId: entry.id });
      return fromConsoleEntry(entry);
    });
  }

  /**
   * Removing an entry here revokes it, as removing it in the console does: the
   * entry stays as history and the identity is refused until it is added again.
   */
  async remove(id: string): Promise<boolean> {
    const actor = await this.resolveActor();
    const occurredAt = this.now();
    return withSystemContext(this.db, async tx => {
      const entry = await removeAccountAllowlistEntryWithTx(tx, {
        id,
        revokedByUserId: actor.userId,
        revokedAt: occurredAt,
      });
      if (!entry) return false;
      await recordChange(tx, actor, occurredAt, { operation: 'remove', kind: entry.kind, entryId: entry.id });
      return true;
    });
  }
}

export type ReconcileMode = 'report' | 'carry' | 'discard';

export interface ReconcilePlan {
  /** In the earlier allowlist and already in the one sign-in uses. Redundant. */
  readonly carried: readonly AuthAllowlistEntry[];
  /** In the earlier allowlist, and removed in the console since. The removal stands. */
  readonly removedInConsole: readonly AuthAllowlistEntry[];
  /** In the earlier allowlist only. These are what stop the server from starting. */
  readonly uncarried: readonly AuthAllowlistEntry[];
}

export interface ReconcileResult extends ReconcilePlan {
  readonly mode: ReconcileMode;
  /** Entries added to the allowlist sign-in uses. */
  readonly added: number;
  /** Entries deleted from the earlier allowlist. */
  readonly cleared: number;
}

function matchValues(entry: Pick<AuthAllowlistEntry, 'kind' | 'value'>): AllowlistMatchValues {
  if (entry.kind === 'email') return { email: entry.value };
  if (entry.kind === 'github_username') return { githubUsername: entry.value };
  return { githubId: entry.value };
}

async function planReconcileWithTx(tx: DrizzleTx, earlier: readonly AuthAllowlistEntry[]): Promise<ReconcilePlan> {
  const active = (await listActiveAccountAllowlistEntriesWithTx(tx)).map(fromConsoleEntry);
  const missing = new Set(findAllowlistEntriesMissingFromAuthority(earlier, active).map(entry => entry.id));
  const carried: AuthAllowlistEntry[] = [];
  const removedInConsole: AuthAllowlistEntry[] = [];
  const uncarried: AuthAllowlistEntry[] = [];
  for (const entry of earlier) {
    if (!missing.has(entry.id)) carried.push(entry);
    else if (await accountAllowlistDeniesIdentityWithTx(tx, matchValues(entry))) removedInConsole.push(entry);
    else uncarried.push(entry);
  }
  return { carried, removedInConsole, uncarried };
}

/**
 * Empties the earlier allowlist, so start-up no longer has anything to refuse.
 *
 * `report` changes nothing. `carry` adds every entry sign-in does not have to
 * the allowlist it uses, then clears the earlier list. `discard` clears it
 * without adding anything.
 *
 * An entry an admin has since removed in the console is never added back:
 * that removal is a later decision, and re-adding the entry would quietly
 * re-admit someone who was taken off. It is cleared from the earlier list in
 * both modes and reported.
 *
 * Everything happens in one transaction: either the earlier list is empty and
 * the carried entries are in place, or nothing changed.
 */
export async function reconcileEarlierAllowlist(options: {
  readonly db: DatabaseInstance;
  readonly storage: Pick<IAuthStorageLayer, 'allowlistList'>;
  /** Asked only when the mode changes something. */
  readonly resolveActor: () => Promise<AllowlistCliActor>;
  readonly mode: ReconcileMode;
  readonly now?: () => Date;
}): Promise<ReconcileResult> {
  const occurredAt = (options.now ?? (() => new Date()))();
  const earlier = await options.storage.allowlistList();
  const changes = options.mode !== 'report' && earlier.length > 0;
  const actor = changes ? await options.resolveActor() : null;
  return withSystemContext(options.db, async tx => {
    const plan = await planReconcileWithTx(tx, earlier);
    if (!actor) return { ...plan, mode: options.mode, added: 0, cleared: 0 };

    let added = 0;
    if (options.mode === 'carry') {
      for (const entry of plan.uncarried) {
        const created = await addAccountAllowlistEntryWithTx(tx, {
          kind: entry.kind,
          value: entry.value,
          note: entry.note,
          createdByUserId: actor.userId,
          createdAt: occurredAt,
        });
        await recordChange(tx, actor, occurredAt, {
          operation: 'carry_over', kind: created.kind, entryId: created.id,
        });
        added += 1;
      }
    }
    const cleared = await tx.delete(authAllowlist)
      .where(inArray(authAllowlist.id, earlier.map(entry => entry.id)))
      .returning({ id: authAllowlist.id });
    await recordChange(tx, actor, occurredAt, {
      operation: 'earlier_allowlist_cleared',
      mode: options.mode,
      cleared: cleared.length,
      carried: plan.carried.length,
      removedInConsole: plan.removedInConsole.length,
      [options.mode === 'carry' ? 'added' : 'discarded']: plan.uncarried.length,
    });
    return { ...plan, mode: options.mode, added, cleared: cleared.length };
  });
}

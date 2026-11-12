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

import type {
  AllowlistMatchValues,
  AuthAllowlistEntry,
  AuthAllowlistKind,
  IAuthStorageLayer,
} from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { authAllowlist, userAdminRoles, users } from '../database/schema/index.js';
import { authIdentityEvents } from '../database/schema/auth.js';
import { ConsoleStoreConflictError } from '../web-console/stores/ConsoleStoreValidation.js';
import {
  storedConsoleAllowlistValueMatches,
  type ConsoleAccountAllowlistEntry,
} from '../web-console/stores/IConsoleAccountAllowlistStore.js';
import {
  accountAllowlistDeniesIdentityWithTx,
  accountAllowlistMatchesIdentityWithTx,
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
  /**
   * The entry for an identity as the operator typed it, compared by this
   * allowlist's own rules. The two allowlists do not fold case the same way
   * outside ASCII, so the comparison cannot be done by the caller.
   */
  findByValue(kind: AuthAllowlistKind, value: string): Promise<AuthAllowlistEntry | null>;
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

  async findByValue(kind: AuthAllowlistKind, value: string): Promise<AuthAllowlistEntry | null> {
    const normalized = normalizeAuthAllowlistValue(kind, value);
    return (await this.storage.allowlistList()).find(entry => entry.kind === kind && entry.value === normalized) ?? null;
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

  async findByValue(kind: AuthAllowlistKind, value: string): Promise<AuthAllowlistEntry | null> {
    const entries = await withSystemContext(this.db, tx => listActiveAccountAllowlistEntriesWithTx(tx));
    // The rule sign-in itself matches a stored entry by.
    const found = entries.find(entry => entry.kind === kind && storedConsoleAllowlistValueMatches(kind, entry.displayValue, value));
    return found ? fromConsoleEntry(found) : null;
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
  /** In the earlier allowlist, and sign-in already admits the identity. Redundant. */
  readonly carried: readonly AuthAllowlistEntry[];
  /** In the earlier allowlist, and removed in the console since. The removal stands. */
  readonly removedInConsole: readonly AuthAllowlistEntry[];
  /** In the earlier allowlist only: sign-in does not admit the identity. */
  readonly uncarried: readonly AuthAllowlistEntry[];
}

export interface ReconcileResult extends ReconcilePlan {
  readonly mode: ReconcileMode;
  /** Entries added to the allowlist sign-in uses. */
  readonly added: number;
  /** Entries deleted from the earlier allowlist. */
  readonly cleared: number;
  /** Entries in the earlier allowlist afterwards. Zero unless something else added to it meanwhile. */
  readonly remaining: number;
}

function matchValues(entry: Pick<AuthAllowlistEntry, 'kind' | 'value'>): AllowlistMatchValues {
  if (entry.kind === 'email') return { email: entry.value };
  if (entry.kind === 'github_username') return { githubUsername: entry.value };
  return { githubId: entry.value };
}

/** One statement at a time, in order: a transaction has one connection, and the order of writes is recorded. */
function inOrder<Item>(items: readonly Item[], each: (item: Item) => Promise<void>): Promise<void> {
  return items.reduce((earlier, item) => earlier.then(() => each(item)), Promise.resolve());
}

/** The whole earlier allowlist, locked for the rest of the transaction. */
export async function readEarlierAllowlistWithTx(tx: DrizzleTx): Promise<AuthAllowlistEntry[]> {
  const rows = await tx.select().from(authAllowlist).orderBy(authAllowlist.createdAt, authAllowlist.id).for('update');
  return rows.map(row => ({
    id: row.id,
    kind: row.kind as AuthAllowlistKind,
    value: row.value,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}

/**
 * Sorts the earlier entries by what sign-in would do with each identity
 * today. The sign-in authority itself is asked, entry by entry, because that
 * is the only answer that matters: an entry is redundant only if the identity
 * it names is already admitted. Comparing stored values instead would get
 * identities with non-ASCII letters wrong, since the two allowlists do not
 * fold case the same way.
 */
async function planReconcileWithTx(tx: DrizzleTx, earlier: readonly AuthAllowlistEntry[]): Promise<ReconcilePlan> {
  const carried: AuthAllowlistEntry[] = [];
  const removedInConsole: AuthAllowlistEntry[] = [];
  const uncarried: AuthAllowlistEntry[] = [];
  await inOrder(earlier, async entry => {
    const values = matchValues(entry);
    if (await accountAllowlistMatchesIdentityWithTx(tx, values)) carried.push(entry);
    else if (await accountAllowlistDeniesIdentityWithTx(tx, values)) removedInConsole.push(entry);
    else uncarried.push(entry);
  });
  return { carried, removedInConsole, uncarried };
}

/**
 * Empties the earlier allowlist, so start-up no longer has anything to refuse.
 *
 * `report` changes nothing. `carry` adds every entry sign-in does not admit to
 * the allowlist it uses, then clears the earlier list. `discard` clears it
 * without adding anything.
 *
 * An entry an admin has since removed in the console is never added back:
 * that removal is a later decision, and re-adding the entry would quietly
 * re-admit someone who was taken off. It is cleared from the earlier list in
 * both modes and reported.
 *
 * Everything happens in one transaction, with the earlier list read and
 * locked inside it: either the entries that were read are gone and the
 * carried ones are in place, or nothing changed.
 */
export async function reconcileEarlierAllowlist(options: {
  readonly db: DatabaseInstance;
  /** Asked only when the mode changes something. */
  readonly resolveActor: () => Promise<AllowlistCliActor>;
  readonly mode: ReconcileMode;
  /** Which earlier entries to reconcile. Defaults to all of them. */
  readonly readEarlier?: (tx: DrizzleTx) => Promise<readonly AuthAllowlistEntry[]>;
  readonly now?: () => Date;
}): Promise<ReconcileResult> {
  const occurredAt = (options.now ?? (() => new Date()))();
  const readEarlier = options.readEarlier ?? readEarlierAllowlistWithTx;
  return withSystemContext(options.db, async tx => {
    const earlier = await readEarlier(tx);
    const plan = await planReconcileWithTx(tx, earlier);
    if (options.mode === 'report' || earlier.length === 0) {
      return { ...plan, mode: options.mode, added: 0, cleared: 0, remaining: earlier.length };
    }
    const actor = await options.resolveActor();

    let added = 0;
    if (options.mode === 'carry') {
      await inOrder(plan.uncarried, async entry => {
        const created = await addAccountAllowlistEntryWithTx(tx, {
          kind: entry.kind,
          value: entry.value,
          note: entry.note,
          createdByUserId: actor.userId,
          createdAt: occurredAt,
        });
        await recordChange(tx, actor, occurredAt, { operation: 'carry_over', kind: created.kind, entryId: created.id });
        added += 1;
      });
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
    const left = await tx.select({ id: authAllowlist.id }).from(authAllowlist);
    return { ...plan, mode: options.mode, added, cleared: cleared.length, remaining: left.length };
  });
}

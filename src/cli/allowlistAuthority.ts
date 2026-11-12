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
import { lockAuthAllowlistIdentitiesWithTx } from '../database/authPrincipalLock.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { authAllowlist, userAdminRoles, users } from '../database/schema/index.js';
import { authIdentityEvents } from '../database/schema/auth.js';
import { ConsoleStoreConflictError, ConsoleStoreValidationError } from '../web-console/stores/ConsoleStoreValidation.js';
import {
  MAX_ALLOWLIST_NOTE_LENGTH,
  normalizeAllowlistValue,
  storedConsoleAllowlistValueMatches,
  validateAllowlistValue,
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
  /**
   * In the earlier allowlist only, with a value the allowlist sign-in uses
   * does not accept. The earlier allowlist took any text. These are never
   * carried, and `carry` leaves them where they are.
   */
  readonly uncarriable: readonly UncarriableEntry[];
}

export interface UncarriableEntry {
  readonly entry: AuthAllowlistEntry;
  /** Why the allowlist sign-in uses will not take the value. */
  readonly reason: string;
}

export interface ReconcileResult extends ReconcilePlan {
  readonly mode: ReconcileMode;
  /** Entries added to the allowlist sign-in uses. */
  readonly added: number;
  /** Entries deleted from the earlier allowlist. */
  readonly cleared: number;
  /** Entries in the earlier allowlist afterwards: any that could not be carried, and any added meanwhile. */
  readonly remaining: number;
  /** Entries carried with a note longer than the allowlist sign-in uses allows. The note was cut to fit. */
  readonly notesShortened: readonly AuthAllowlistEntry[];
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

/** Whether a read of the earlier allowlist also locks its rows for the rest of the transaction. */
export type EarlierAllowlistLock = 'none' | 'rows';

/** The whole earlier allowlist, with its rows locked for the rest of the transaction when asked. */
export async function readEarlierAllowlistWithTx(tx: DrizzleTx, lock: EarlierAllowlistLock): Promise<AuthAllowlistEntry[]> {
  const query = tx.select().from(authAllowlist).orderBy(authAllowlist.createdAt, authAllowlist.id);
  const rows = await (lock === 'rows' ? query.for('update') : query);
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
  const uncarriable: UncarriableEntry[] = [];
  await inOrder(earlier, async entry => {
    const values = matchValues(entry);
    if (await accountAllowlistMatchesIdentityWithTx(tx, values)) {
      carried.push(entry);
      return;
    }
    if (await accountAllowlistDeniesIdentityWithTx(tx, values)) {
      removedInConsole.push(entry);
      return;
    }
    const reason = whyNotCarriable(entry);
    if (reason === null) uncarried.push(entry);
    else uncarriable.push({ entry, reason });
  });
  return { carried, removedInConsole, uncarried, uncarriable };
}

/** The earlier allowlist took any text as a value. The one sign-in uses checks the value's form. */
function whyNotCarriable(entry: AuthAllowlistEntry): string | null {
  try {
    validateAllowlistValue(entry.kind, entry.value, 'value');
    return null;
  } catch (error) {
    if (error instanceof ConsoleStoreValidationError) return error.message;
    throw error;
  }
}

/**
 * A note as the allowlist sign-in uses will take it. The earlier allowlist
 * put no limit on a note's length, so a long one is cut to fit and marked.
 */
export function noteForCarry(note: string | null): { readonly note: string | null; readonly shortened: boolean } {
  if (note === null || note.length <= MAX_ALLOWLIST_NOTE_LENGTH) return { note, shortened: false };
  let kept = note.slice(0, MAX_ALLOWLIST_NOTE_LENGTH - 1);
  // Never end on half of a character that takes two code units.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return { note: `${kept}\u2026`, shortened: true };
}

function lockIdentity(entry: AuthAllowlistEntry): { readonly kind: AuthAllowlistKind; readonly normalizedValue: string } {
  return { kind: entry.kind, normalizedValue: normalizeAllowlistValue(entry.kind, entry.value) };
}

/**
 * The earlier entries a changing run works on, with everything it needs held
 * to the end of the transaction.
 *
 * First the locks every writer of the allowlist sign-in uses takes, for the
 * identities the entries name. Nothing can then grant or revoke one of those
 * identities between the plan being made and its entries being carried, so a
 * carry can never land on top of a removal it did not see.
 *
 * Then the rows themselves. That order, identity locks before rows of the
 * earlier allowlist, is the order account deletion takes them in, so the two
 * cannot deadlock. It is why the entries are read twice: once to learn which
 * identities to lock, and again, locked, for the entries to act on.
 *
 * An entry that appeared between the two reads names an identity this run
 * holds no lock for. It is left alone and counted as remaining.
 */
async function readAndLockEarlierWithTx(
  tx: DrizzleTx,
  readEarlier: (tx: DrizzleTx, lock: EarlierAllowlistLock) => Promise<readonly AuthAllowlistEntry[]>,
  seen: readonly AuthAllowlistEntry[],
): Promise<readonly AuthAllowlistEntry[]> {
  const identities = seen.map(lockIdentity);
  await lockAuthAllowlistIdentitiesWithTx(tx, identities);
  const held = new Set(identities.map(identity => `${identity.kind}:${identity.normalizedValue}`));
  return (await readEarlier(tx, 'rows')).filter(entry => {
    const identity = lockIdentity(entry);
    return held.has(`${identity.kind}:${identity.normalizedValue}`);
  });
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
 * An entry whose value the allowlist sign-in uses does not accept cannot be
 * carried. `carry` leaves it in the earlier list and reports it with the
 * reason, so the rest still go across; `discard` clears it with the others.
 *
 * Everything happens in one transaction, with the earlier list read and
 * locked inside it, and the identities it names locked against other
 * allowlist changes: either the entries that were read are dealt with and the
 * carried ones are in place, or nothing changed.
 */
export async function reconcileEarlierAllowlist(options: {
  readonly db: DatabaseInstance;
  /** Asked only when the mode changes something. */
  readonly resolveActor: () => Promise<AllowlistCliActor>;
  readonly mode: ReconcileMode;
  /** Which earlier entries to reconcile. Defaults to all of them. */
  readonly readEarlier?: (tx: DrizzleTx, lock: EarlierAllowlistLock) => Promise<readonly AuthAllowlistEntry[]>;
  readonly now?: () => Date;
}): Promise<ReconcileResult> {
  const occurredAt = (options.now ?? (() => new Date()))();
  const readEarlier = options.readEarlier ?? readEarlierAllowlistWithTx;
  return withSystemContext(options.db, async tx => {
    // A report writes nothing, so it locks nothing.
    const seen = await readEarlier(tx, 'none');
    if (options.mode === 'report' || seen.length === 0) {
      const plan = await planReconcileWithTx(tx, seen);
      return { ...plan, mode: options.mode, added: 0, cleared: 0, remaining: seen.length, notesShortened: [] };
    }
    // Locked before the plan, not after: the plan is only good while nothing else can change what it read.
    const earlier = await readAndLockEarlierWithTx(tx, readEarlier, seen);
    const plan = await planReconcileWithTx(tx, earlier);
    if (earlier.length === 0) {
      // Everything that was seen went while this run waited for its locks. There is nothing to change or record.
      const left = await tx.select({ id: authAllowlist.id }).from(authAllowlist);
      return { ...plan, mode: options.mode, added: 0, cleared: 0, remaining: left.length, notesShortened: [] };
    }
    const actor = await options.resolveActor();

    const notesShortened: AuthAllowlistEntry[] = [];
    if (options.mode === 'carry') {
      await inOrder(plan.uncarried, async entry => {
        const { note, shortened } = noteForCarry(entry.note);
        const created = await addAccountAllowlistEntryWithTx(tx, {
          kind: entry.kind,
          value: entry.value,
          note,
          createdByUserId: actor.userId,
          createdAt: occurredAt,
        });
        await recordChange(tx, actor, occurredAt, {
          operation: 'carry_over', kind: created.kind, entryId: created.id, ...(shortened ? { noteShortened: true } : {}),
        });
        if (shortened) notesShortened.push(entry);
      });
    }
    const carrying = options.mode === 'carry';
    const kept = new Set(carrying ? plan.uncarriable.map(({ entry }) => entry.id) : []);
    const toClear = earlier.filter(entry => !kept.has(entry.id)).map(entry => entry.id);
    const cleared = toClear.length === 0
      ? []
      : await tx.delete(authAllowlist).where(inArray(authAllowlist.id, toClear)).returning({ id: authAllowlist.id });
    await recordChange(tx, actor, occurredAt, {
      operation: 'earlier_allowlist_cleared',
      mode: options.mode,
      cleared: cleared.length,
      carried: plan.carried.length,
      removedInConsole: plan.removedInConsole.length,
      [carrying ? 'added' : 'discarded']: plan.uncarried.length,
      [carrying ? 'notCarriable' : 'discardedNotCarriable']: plan.uncarriable.length,
    });
    const left = await tx.select({ id: authAllowlist.id }).from(authAllowlist);
    return {
      ...plan,
      mode: options.mode,
      added: carrying ? plan.uncarried.length : 0,
      cleared: cleared.length,
      remaining: left.length,
      notesShortened,
    };
  });
}

#!/usr/bin/env node

/**
 * dollhouse-allowlist — manage the sign-in allowlist from the operator's
 * machine.
 *
 * Mirrors `dollhouse-admin-bootstrap` and `dollhouse-create-user`:
 * commander-based, connects directly to the same storage the running AS
 * reads from, runs outside the MCP-AQL surface entirely.
 *
 * Which allowlist that is depends on the install. With the embedded
 * authorization server on PostgreSQL, sign-in consults the allowlist the
 * console manages, so the command works on that one and records each change
 * against a console admin. Everywhere else it works on the storage layer's
 * allowlist (filesystem JSON, or the `auth_allowlist` table). See
 * `allowlistAuthority.ts`.
 *
 * **Why CLI-only (no MCP-AQL exposure):** sign-in allowlist mutations are
 * security policy. Exposing them through MCP-AQL puts the admin's bearer
 * token in an AI's context window, where prompt-injection or a poisoned
 * tool result could trigger autonomous allowlist changes the admin didn't
 * intend. CLI invocation is inherent human-in-the-loop. See
 * `feedback_security_policy_outside_ai_surface.md` for the full rationale.
 *
 * Sub-commands:
 *   add    — add an entry (by email / github_username / github_id)
 *   list   — list entries, optionally filtered by kind
 *   remove — remove an entry by id or by (kind, value)
 *   update — change the note on an existing entry (kind/value are immutable)
 *   reconcile — where the console manages the allowlist: report, carry over or
 *               discard what is left in the earlier allowlist
 *
 * Examples:
 *   dollhouse-allowlist add --kind email --value todd@example.com --note "founder"
 *   dollhouse-allowlist add --kind github_username --value insomnolence
 *   dollhouse-allowlist list
 *   dollhouse-allowlist list --kind email
 *   dollhouse-allowlist remove --kind email --value mick@example.com
 *   dollhouse-allowlist remove --id 018e1a2b-3c4d-7e5f-8901-abcdef123456
 *   dollhouse-allowlist update --id 018e1a2b-... --note "renamed to mick"
 *   dollhouse-allowlist reconcile
 *   dollhouse-allowlist reconcile --carry
 *
 * @module cli/allowlist
 */

import { Command } from 'commander';
import { openCliAuthStorage, type CliAuthStorageHandle } from './cliAuthStorage.js';
import {
  AllowlistCliError,
  chooseActor,
  ConsoleAllowlistCliTarget,
  listConsoleAdmins,
  reconcileEarlierAllowlist,
  StorageAllowlistCliTarget,
  type AllowlistCliActor,
  type AllowlistCliTarget,
  type ReconcileMode,
  type ReconcileResult,
} from './allowlistAuthority.js';
import { consoleAllowlistIsSignInAuthority } from '../auth/embedded-as/allowlistGate.js';
import { env } from '../config/env.js';
import type { AuthAllowlistEntry, AuthAllowlistKind } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import {
  normalizeAuthAllowlistPrincipal,
  normalizeAuthAllowlistValue,
} from '../auth/embedded-as/allowlistIdentity.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

const VALID_KINDS: readonly AuthAllowlistKind[] = ['email', 'github_username', 'github_id'];

/** Present only where the console manages the allowlist and changes name an admin. */
interface ActorOptions {
  as?: string;
}

interface AddOptions extends ActorOptions {
  kind: string;
  value: string;
  note?: string;
}

interface ListOptions {
  kind?: string;
}

interface RemoveOptions extends ActorOptions {
  id?: string;
  kind?: string;
  value?: string;
}

interface UpdateOptions extends ActorOptions {
  id: string;
  note?: string;
}

interface ReconcileOptions extends ActorOptions {
  carry?: boolean;
  discard?: boolean;
}

/** What a sub-command is given: the allowlist to work on, and how to reach the earlier one. */
interface AllowlistCliSession {
  readonly target: AllowlistCliTarget;
  readonly handle: CliAuthStorageHandle;
  /** True where sign-in consults the console's allowlist. */
  readonly consoleIsAuthority: boolean;
  readonly resolveActor: () => Promise<AllowlistCliActor>;
}

function assertValidKind(kind: string): asserts kind is AuthAllowlistKind {
  if (!VALID_KINDS.includes(kind as AuthAllowlistKind)) {
    process.stderr.write(
      `Invalid --kind '${kind}'. Must be one of: ${VALID_KINDS.join(', ')}.\n`,
    );
    process.exit(1);
  }
}

function normalizeCliInput(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent;
}

function formatEntry(e: AuthAllowlistEntry): string {
  const note = e.note ? ` — ${e.note}` : '';
  const by = e.createdBy ? ` (added by ${e.createdBy})` : '';
  const when = e.createdAt.toISOString();
  return `${e.id}  [${e.kind}]  ${e.value}${note}${by}  ${when}`;
}

async function runAdd(session: AllowlistCliSession, opts: AddOptions): Promise<void> {
  const kind = normalizeCliInput(opts.kind).trim();
  const value = normalizeAuthAllowlistPrincipal(opts.value);
  const note = opts.note === undefined ? undefined : normalizeCliInput(opts.note);
  assertValidKind(kind);
  if (!value) {
    process.stderr.write('--value is required.\n');
    process.exit(1);
  }
  try {
    const entry = await session.target.add({ kind, value, note: note ?? null });
    // The line is unchanged where the command has always worked on its one allowlist.
    process.stdout.write(session.consoleIsAuthority
      ? `Added to ${session.target.description}: ${formatEntry(entry)}\n`
      : `Added: ${formatEntry(entry)}\n`);
    await warnAboutEarlierEntries(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      process.stderr.write(`Entry already exists for kind=${kind} value=${value.toLowerCase()}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runList(session: AllowlistCliSession, opts: ListOptions): Promise<void> {
  const kind = opts.kind === undefined ? undefined : normalizeCliInput(opts.kind).trim();
  if (kind !== undefined) {
    assertValidKind(kind);
  }
  const all = await session.target.list();
  const filtered = kind ? all.filter(e => e.kind === kind) : all;
  if (filtered.length === 0) {
    process.stdout.write(
      kind
        ? `No allowlist entries of kind '${kind}'.\n`
        : 'Allowlist is empty.\n',
    );
    await warnAboutEarlierEntries(session);
    return;
  }
  // Stable order: kind, then createdAt.
  filtered.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const ta = a.createdAt.getTime();
    const tb = b.createdAt.getTime();
    return ta - tb;
  });
  process.stdout.write(`${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}:\n`);
  for (const entry of filtered) {
    process.stdout.write(`  ${formatEntry(entry)}\n`);
  }
  await warnAboutEarlierEntries(session);
}

/**
 * Where the console manages the allowlist, anything still in the earlier one
 * is not honoured by sign-in and stops the server from starting. Say so every
 * time, since the operator may not know the earlier list exists.
 */
async function warnAboutEarlierEntries(session: AllowlistCliSession): Promise<void> {
  if (!session.consoleIsAuthority) return;
  const earlier = await session.handle.storage.allowlistList();
  if (earlier.length === 0) return;
  process.stderr.write(
    `Note: ${earlier.length} entr${earlier.length === 1 ? 'y is' : 'ies are'} still in the earlier allowlist, which sign-in no longer reads. ` +
    'Run `dollhouse-allowlist reconcile` to see and clear them.\n',
  );
}

async function runRemove(session: AllowlistCliSession, opts: RemoveOptions): Promise<void> {
  // Accept either --id OR --kind + --value (mutually exclusive).
  const byId = opts.id !== undefined;
  const byKindValue = opts.kind !== undefined || opts.value !== undefined;
  if (byId === byKindValue) {
    process.stderr.write(
      'Specify EITHER --id <uuid> OR (--kind <k> --value <v>), not both / not neither.\n',
    );
    process.exit(1);
  }

  let targetId: string;
  if (typeof opts.id === 'string') {
    targetId = normalizeCliInput(opts.id).trim();
  } else {
    if (opts.kind === undefined || opts.value === undefined) {
      process.stderr.write('--kind and --value are both required when removing by value.\n');
      process.exit(1);
    }
    const kind = normalizeCliInput(opts.kind).trim();
    assertValidKind(kind);
    // Matched by the rules of the allowlist being changed, not by the caller.
    const found = await session.target.findByValue(kind, normalizeAuthAllowlistPrincipal(opts.value));
    if (!found) {
      process.stderr.write(`No allowlist entry found for kind=${kind} value=${normalizeAuthAllowlistValue(kind, opts.value)}\n`);
      process.exit(1);
    }
    targetId = found.id;
  }

  const removed = await session.target.remove(targetId);
  if (!removed) {
    process.stderr.write(`No allowlist entry found with id '${targetId}'.\n`);
    process.exit(1);
  }
  process.stdout.write(`Removed allowlist entry ${targetId}.\n`);
}

async function runUpdate(session: AllowlistCliSession, opts: UpdateOptions): Promise<void> {
  const id = normalizeCliInput(opts.id).trim();
  if (!id) {
    process.stderr.write('--id is required.\n');
    process.exit(1);
  }
  if (opts.note === undefined) {
    process.stderr.write('Nothing to update. Pass --note <text> (or empty string to clear).\n');
    process.exit(1);
  }
  const note = normalizeCliInput(opts.note);
  const updated = await session.target.updateNote(id, note === '' ? null : note);
  if (!updated) {
    process.stderr.write(`No allowlist entry found with id '${id}'.\n`);
    process.exit(1);
  }
  process.stdout.write(`Updated: ${formatEntry(updated)}\n`);
}

function describeEntries(label: string, entries: readonly AuthAllowlistEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(entry => `  [${entry.kind}]  ${entry.value}`).join('\n');
  return `${label} (${entries.length}):\n${lines}\n`;
}

function reconcileReport(result: ReconcileResult): string {
  const total = result.carried.length + result.removedInConsole.length + result.uncarried.length;
  if (total === 0) return 'The earlier allowlist is empty. Nothing to reconcile.\n';
  const lines = [
    describeEntries('Sign-in does not admit these; they were only ever in the earlier allowlist', result.uncarried),
    describeEntries('Removed in the console since; the removal stands and they are not added back', result.removedInConsole),
    describeEntries('Sign-in already admits these; redundant here', result.carried),
  ].join('');
  if (result.mode === 'report') {
    return `${lines}Nothing was changed. To clear the earlier allowlist:\n` +
      '  dollhouse-allowlist reconcile --carry     add the first group to the allowlist sign-in uses, then clear\n' +
      '  dollhouse-allowlist reconcile --discard   clear without adding anything\n';
  }
  const after = result.remaining === 0
    ? 'which is now empty.'
    : `which still holds ${result.remaining} added while this ran. Run reconcile again.`;
  return `${lines}Added ${result.added} to the allowlist sign-in uses. Cleared ${result.cleared} from the earlier allowlist, ${after}\n`;
}

async function runReconcile(session: AllowlistCliSession, opts: ReconcileOptions): Promise<void> {
  if (opts.carry && opts.discard) {
    process.stderr.write('Use --carry or --discard, not both.\n');
    process.exit(1);
  }
  if (!session.consoleIsAuthority || !session.handle.db) {
    process.stdout.write('This install has one sign-in allowlist. There is nothing to reconcile.\n');
    return;
  }
  let mode: ReconcileMode = 'report';
  if (opts.carry) mode = 'carry';
  if (opts.discard) mode = 'discard';
  const result = await reconcileEarlierAllowlist({ db: session.handle.db, resolveActor: session.resolveActor, mode });
  process.stdout.write(reconcileReport(result));
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('dollhouse-allowlist')
    .description(
      'Manage the sign-in allowlist for the embedded authorization server.\n\n' +
      'The allowlist gates GitHub OAuth, magic-link, and local-password sign-ins\n' +
      'against an operator-curated set of allowed identities. The bootstrap admin\n' +
      'always passes regardless of allowlist contents — operators cannot lock\n' +
      'themselves out.\n\n' +
      'Set DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true to enforce the allowlist even\n' +
      'when the list is empty (secure-by-default mode — only the bootstrap admin\n' +
      'can sign in until you add entries).\n\n' +
      'With the embedded authorization server on PostgreSQL, sign-in uses the\n' +
      'allowlist the console manages. There, this command changes that allowlist\n' +
      'and records each change against a console admin: the only admin, or the\n' +
      'one named with --as when there are several.\n\n' +
      'Allowlist changes are deliberately NOT exposed via MCP-AQL, to avoid\n' +
      'prompt-injection risk on admin LLM sessions.',
    );
  const AS_OPTION = ['--as <username>', 'console admin to record the change against (needed only with several admins)'] as const;

  program
    .command('add')
    .description('Add a new allowlist entry')
    .requiredOption('--kind <kind>', `match key: ${VALID_KINDS.join(' | ')}`)
    .requiredOption('--value <value>', 'identity value (email, GitHub login, or numeric ID)')
    .option('--note <text>', 'free-form note (e.g. "added 2026-05-19 for Mick onboarding")')
    .option(...AS_OPTION)
    .action(async (opts: AddOptions) => {
      await withSession(opts, session => runAdd(session, opts));
    });

  program
    .command('list')
    .description('List allowlist entries')
    .option('--kind <kind>', `filter by kind: ${VALID_KINDS.join(' | ')}`)
    .action(async (opts: ListOptions) => {
      await withSession({}, session => runList(session, opts));
    });

  program
    .command('remove')
    .description('Remove an allowlist entry by --id or by --kind + --value')
    .option('--id <uuid>', 'entry id (UUID)')
    .option('--kind <kind>', `match key kind: ${VALID_KINDS.join(' | ')}`)
    .option('--value <value>', 'identity value to remove')
    .option(...AS_OPTION)
    .action(async (opts: RemoveOptions) => {
      await withSession(opts, session => runRemove(session, opts));
    });

  program
    .command('update')
    .description('Update the note on an existing entry. Kind/value are immutable — to change those, remove + add.')
    .requiredOption('--id <uuid>', 'entry id (UUID)')
    .option('--note <text>', 'new note text (pass empty string to clear)')
    .option(...AS_OPTION)
    .action(async (opts: UpdateOptions) => {
      await withSession(opts, session => runUpdate(session, opts));
    });

  program
    .command('reconcile')
    .description(
      'Where the console manages the allowlist: show what is left in the earlier allowlist, ' +
      'which sign-in no longer reads and which stops the server from starting. ' +
      'Changes nothing unless --carry or --discard is given.',
    )
    .option('--carry', 'add entries sign-in does not have to the allowlist it uses, then clear the earlier allowlist')
    .option('--discard', 'clear the earlier allowlist without adding anything')
    .option(...AS_OPTION)
    .action(async (opts: ReconcileOptions) => {
      await withSession(opts, session => runReconcile(session, opts));
    });

  await program.parseAsync(process.argv);
}

function openSession(handle: CliAuthStorageHandle, actorOptions: ActorOptions): AllowlistCliSession {
  const db = handle.db;
  const consoleIsAuthority = consoleAllowlistIsSignInAuthority({
    hasDatabase: db !== undefined,
    authProvider: env.DOLLHOUSE_AUTH_PROVIDER,
    authStorageBackend: env.DOLLHOUSE_AUTH_STORAGE_BACKEND,
  });
  if (!db || !consoleIsAuthority) {
    if (actorOptions.as !== undefined) {
      process.stderr.write('Note: --as is used only where the console manages the allowlist. It is ignored here.\n');
    }
    return {
      target: new StorageAllowlistCliTarget(handle.storage),
      handle,
      consoleIsAuthority: false,
      resolveActor: () => Promise.reject(new AllowlistCliError('This install does not record who changes the allowlist.')),
    };
  }
  const asUsername = actorOptions.as === undefined ? undefined : normalizeCliInput(actorOptions.as).trim();
  let actor: Promise<AllowlistCliActor> | null = null;
  const resolveActor = () => {
    actor ??= listConsoleAdmins(db).then(admins => chooseActor(admins, asUsername));
    return actor;
  };
  return { target: new ConsoleAllowlistCliTarget(db, resolveActor), handle, consoleIsAuthority: true, resolveActor };
}

async function withSession(
  actorOptions: ActorOptions,
  fn: (session: AllowlistCliSession) => Promise<void>,
): Promise<void> {
  let handle: CliAuthStorageHandle;
  try {
    // Pass methods=['github'] so the durable-storage guard in createAuthStorage
    // accepts whatever backend the AS is using. The exact method doesn't matter
    // here — we only touch the allowlist surface, not method-specific paths.
    handle = await openCliAuthStorage({ methods: ['github'] });
  } catch (err) {
    process.stderr.write(
      `Failed to initialize auth storage: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  try {
    await fn(openSession(handle, actorOptions));
  } catch (err) {
    if (!(err instanceof AllowlistCliError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((err) => { // NOSONAR — top-level await breaks the Jest CJS transform; .catch() is required here
  process.stderr.write(`allowlist failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

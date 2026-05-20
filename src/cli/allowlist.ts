/**
 * dollhouse-allowlist — manage the sign-in allowlist from the operator's
 * machine.
 *
 * Mirrors `dollhouse-admin-bootstrap` and `dollhouse-create-user`:
 * commander-based, connects directly to the same storage the running AS
 * reads from (filesystem JSON or Postgres `auth_allowlist` table), runs
 * outside the MCP-AQL surface entirely.
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
 *
 * Examples:
 *   dollhouse-allowlist add --kind email --value todd@example.com --note "founder"
 *   dollhouse-allowlist add --kind github_username --value insomnolence
 *   dollhouse-allowlist list
 *   dollhouse-allowlist list --kind email
 *   dollhouse-allowlist remove --kind email --value mick@example.com
 *   dollhouse-allowlist remove --id 018e1a2b-3c4d-7e5f-8901-abcdef123456
 *   dollhouse-allowlist update --id 018e1a2b-... --note "renamed to mick"
 *
 * @module cli/allowlist
 */

import { Command } from 'commander';
import { openCliAuthStorage, type CliAuthStorageHandle } from './cliAuthStorage.js';
import type { AuthAllowlistEntry, AuthAllowlistKind } from '../auth/embedded-as/storage/IAuthStorageLayer.js';

const VALID_KINDS: readonly AuthAllowlistKind[] = ['email', 'github_username', 'github_id'];

interface AddOptions {
  kind: string;
  value: string;
  note?: string;
}

interface ListOptions {
  kind?: string;
}

interface RemoveOptions {
  id?: string;
  kind?: string;
  value?: string;
}

interface UpdateOptions {
  id: string;
  note?: string;
}

function assertValidKind(kind: string): asserts kind is AuthAllowlistKind {
  if (!VALID_KINDS.includes(kind as AuthAllowlistKind)) {
    process.stderr.write(
      `Invalid --kind '${kind}'. Must be one of: ${VALID_KINDS.join(', ')}.\n`,
    );
    process.exit(1);
  }
}

function formatEntry(e: AuthAllowlistEntry): string {
  const note = e.note ? ` — ${e.note}` : '';
  const by = e.createdBy ? ` (added by ${e.createdBy})` : '';
  const when = e.createdAt.toISOString();
  return `${e.id}  [${e.kind}]  ${e.value}${note}${by}  ${when}`;
}

async function runAdd(handle: CliAuthStorageHandle, opts: AddOptions): Promise<void> {
  assertValidKind(opts.kind);
  if (!opts.value || opts.value.trim().length === 0) {
    process.stderr.write('--value is required.\n');
    process.exit(1);
  }
  try {
    const entry = await handle.storage.allowlistAdd({
      kind: opts.kind,
      value: opts.value,
      note: opts.note ?? null,
      createdBy: 'cli',
    });
    process.stdout.write(`Added: ${formatEntry(entry)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      process.stderr.write(`Entry already exists for kind=${opts.kind} value=${opts.value.toLowerCase()}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runList(handle: CliAuthStorageHandle, opts: ListOptions): Promise<void> {
  if (opts.kind !== undefined) {
    assertValidKind(opts.kind);
  }
  const all = await handle.storage.allowlistList();
  const filtered = opts.kind ? all.filter(e => e.kind === opts.kind) : all;
  if (filtered.length === 0) {
    process.stdout.write(
      opts.kind
        ? `No allowlist entries of kind '${opts.kind}'.\n`
        : 'Allowlist is empty.\n',
    );
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
}

async function runRemove(handle: CliAuthStorageHandle, opts: RemoveOptions): Promise<void> {
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
  if (byId) {
    targetId = opts.id!;
  } else {
    if (opts.kind === undefined || opts.value === undefined) {
      process.stderr.write('--kind and --value are both required when removing by value.\n');
      process.exit(1);
    }
    assertValidKind(opts.kind);
    const value = opts.value.toLowerCase();
    const all = await handle.storage.allowlistList();
    const found = all.find(e => e.kind === opts.kind && e.value === value);
    if (!found) {
      process.stderr.write(`No allowlist entry found for kind=${opts.kind} value=${value}\n`);
      process.exit(1);
    }
    targetId = found.id;
  }

  const removed = await handle.storage.allowlistRemove(targetId);
  if (!removed) {
    process.stderr.write(`No allowlist entry found with id '${targetId}'.\n`);
    process.exit(1);
  }
  process.stdout.write(`Removed allowlist entry ${targetId}.\n`);
}

async function runUpdate(handle: CliAuthStorageHandle, opts: UpdateOptions): Promise<void> {
  if (!opts.id || opts.id.trim().length === 0) {
    process.stderr.write('--id is required.\n');
    process.exit(1);
  }
  if (opts.note === undefined) {
    process.stderr.write('Nothing to update. Pass --note <text> (or empty string to clear).\n');
    process.exit(1);
  }
  const updated = await handle.storage.allowlistUpdate(opts.id, {
    note: opts.note === '' ? null : opts.note,
  });
  if (!updated) {
    process.stderr.write(`No allowlist entry found with id '${opts.id}'.\n`);
    process.exit(1);
  }
  process.stdout.write(`Updated: ${formatEntry(updated)}\n`);
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
      'This CLI is the ONLY supported admin write surface. Allowlist mutations\n' +
      'are deliberately NOT exposed via MCP-AQL to avoid prompt-injection risk\n' +
      'on admin LLM sessions.',
    );

  program
    .command('add')
    .description('Add a new allowlist entry')
    .requiredOption('--kind <kind>', `match key: ${VALID_KINDS.join(' | ')}`)
    .requiredOption('--value <value>', 'identity value (email, GitHub login, or numeric ID)')
    .option('--note <text>', 'free-form note (e.g. "added 2026-05-19 for Mick onboarding")')
    .action(async (opts: AddOptions) => {
      await withStorage(handle => runAdd(handle, opts));
    });

  program
    .command('list')
    .description('List allowlist entries')
    .option('--kind <kind>', `filter by kind: ${VALID_KINDS.join(' | ')}`)
    .action(async (opts: ListOptions) => {
      await withStorage(handle => runList(handle, opts));
    });

  program
    .command('remove')
    .description('Remove an allowlist entry by --id or by --kind + --value')
    .option('--id <uuid>', 'entry id (UUID)')
    .option('--kind <kind>', `match key kind: ${VALID_KINDS.join(' | ')}`)
    .option('--value <value>', 'identity value to remove')
    .action(async (opts: RemoveOptions) => {
      await withStorage(handle => runRemove(handle, opts));
    });

  program
    .command('update')
    .description('Update the note on an existing entry. Kind/value are immutable — to change those, remove + add.')
    .requiredOption('--id <uuid>', 'entry id (UUID)')
    .option('--note <text>', 'new note text (pass empty string to clear)')
    .action(async (opts: UpdateOptions) => {
      await withStorage(handle => runUpdate(handle, opts));
    });

  await program.parseAsync(process.argv);
}

async function withStorage(fn: (handle: CliAuthStorageHandle) => Promise<void>): Promise<void> {
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
    await fn(handle);
  } finally {
    await handle.close();
  }
}

main().catch((err) => { // NOSONAR — top-level await breaks the Jest CJS transform; .catch() is required here
  process.stderr.write(`allowlist failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});

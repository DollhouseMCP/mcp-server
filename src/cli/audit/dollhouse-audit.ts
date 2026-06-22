#!/usr/bin/env node

import path from 'node:path';

import { env } from '../../config/env.js';
import { createDatabaseConnection } from '../../database/connection.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import { AuditHmacKeyResolver } from '../../security/auditHmacKey.js';
import { DatabaseAuditSink, FileAuditSink, type AuditSink } from '../../security/auditSink.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { APPROVAL_SEARCH_ROW_LIMIT, DatabaseConfirmationStore } from '../../state/DatabaseConfirmationStore.js';
import { FileConfirmationStore } from '../../state/FileConfirmationStore.js';
import type { ApprovalSearchFilter, IConfirmationStore } from '../../state/IConfirmationStore.js';

const CLI_USER_ID = '00000000-0000-4000-8000-000000000000';
const CLI_SESSION_ID = 'audit-cli';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help') {
    printUsage();
    return;
  }

  const backend = args.backend ?? (env.DOLLHOUSE_STORAGE_BACKEND === 'database' ? 'database' : 'file');
  const resources = await createResources(backend);
  try {
    if (args.command === 'find') {
      const refs = await resources.store.findApprovals({
        userId: args.userId,
        sessionId: args.sessionId,
        approvalId: args.approvalId,
        after: args.after,
        before: args.before,
      });
      process.stdout.write(`${JSON.stringify(refs, null, 2)}\n`);
      // Both backends now enforce APPROVAL_SEARCH_ROW_LIMIT; warn on either
      // when the cap is reached so the operator knows the result may be
      // truncated regardless of which storage backend is in use.
      if (refs.length >= APPROVAL_SEARCH_ROW_LIMIT) {
        process.stderr.write(
          `[dollhouse-audit] result count is at the per-search cap (${APPROVAL_SEARCH_ROW_LIMIT} rows). ` +
          `Results may be truncated; narrow with --user, --session, or --after/--before to see more.\n`,
        );
      }
      return;
    }

    if (args.command === 'show') {
      const sessionId = args.sessionId;
      const approvalId = args.approvalId;
      if (!sessionId || !approvalId) {
        throw new Error('show requires <sessionId> <approvalId> or --session/--approval');
      }
      const actorId = args.actorId ?? process.env.USER ?? process.env.USERNAME;
      // Access intent — must be durable BEFORE the read so a crash between
      // intent and result still leaves the access on the audit log.
      await resources.sink.write({
        eventType: 'audit.raw_input_accessed',
        actorId,
        targetId: `${sessionId}:${approvalId}`,
        metadata: { sessionId, approvalId, backend },
      });
      const detail = await resources.store.getRawApprovalDetail(sessionId, approvalId);
      // Paired result event — lets forensic reconstruction see whether the
      // lookup actually returned data (matters when investigating after a
      // suspected key/data deletion).
      await resources.sink.write({
        eventType: 'audit.raw_input_access_result',
        actorId,
        targetId: `${sessionId}:${approvalId}`,
        metadata: { sessionId, approvalId, backend, found: detail !== null },
      });
      process.stdout.write(`${detail === null ? 'null' : JSON.stringify(detail, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown command: ${args.command}`);
  } finally {
    await resources.close?.();
  }
}

async function createResources(backend: 'file' | 'database'): Promise<{
  store: IConfirmationStore;
  sink: AuditSink;
  close?: () => Promise<void>;
}> {
  if (backend === 'file') {
    // CLI runs outside the container; resolve the state dir via
    // resolveDataDirectory directly (same backend PathService would use).
    // Sharing the same path resolution as the server guarantees the CLI
    // sees the same HMAC key and the same confirmation files the server
    // wrote.
    const stateDir = resolveDataDirectory('state');
    const resolver = new AuditHmacKeyResolver({
      rootDir: path.join(stateDir, 'secrets', 'audit-hmac-key'),
    });
    const store = new FileConfirmationStore(
      new FileOperationsService(new FileLockManager()),
      stateDir,
      undefined,
      resolver,
    );
    await store.initialize();
    return { store, sink: new FileAuditSink(path.join(stateDir, 'audit', 'security_events.jsonl')) };
  }

  if (!env.DOLLHOUSE_DATABASE_URL) {
    throw new Error('database backend requires DOLLHOUSE_DATABASE_URL');
  }
  const connection = createDatabaseConnection({
    connectionUrl: env.DOLLHOUSE_DATABASE_ADMIN_URL ?? env.DOLLHOUSE_DATABASE_URL,
    poolSize: Math.min(env.DOLLHOUSE_DATABASE_POOL_SIZE, 2),
    ssl: env.DOLLHOUSE_DATABASE_SSL,
  });
  const resolver = new AuditHmacKeyResolver({ database: connection.db });
  const store = new DatabaseConfirmationStore(connection.db, CLI_USER_ID, CLI_SESSION_ID, resolver);
  return {
    store,
    sink: new DatabaseAuditSink(connection.db),
    close: connection.close,
  };
}

interface AuditCliArgs extends ApprovalSearchFilter {
  command?: string;
  backend?: 'file' | 'database';
  actorId?: string;
}

function parseArgs(argv: string[]): AuditCliArgs {
  const args: AuditCliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--backend':
        args.backend = parseBackend(next());
        break;
      case '--user':
        args.userId = next();
        break;
      case '--session':
        args.sessionId = next();
        break;
      case '--approval':
        args.approvalId = next();
        break;
      case '--after':
        args.after = parseTime(next(), '--after');
        break;
      case '--before':
        args.before = parseTime(next(), '--before');
        break;
      case '--actor':
        args.actorId = parseActor(next());
        break;
      default:
        positional.push(arg);
    }
  }
  args.command = positional[0];
  if (!args.sessionId && positional[1]) args.sessionId = positional[1];
  if (!args.approvalId && positional[2]) args.approvalId = positional[2];
  return args;
}

function parseBackend(value: string): 'file' | 'database' {
  if (value === 'file' || value === 'database') return value;
  throw new Error('--backend must be file or database');
}

/**
 * Validate `--actor`. The CLI lets the operator set the attribution that
 * lands in `security_audit_events.actor_id`, so the value goes into a
 * forensic record. Reject control characters and oversize values that
 * could break log parsing or obscure the attribution. Trim whitespace.
 */
function parseActor(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('--actor must not be empty');
  }
  if (trimmed.length > 256) {
    throw new Error('--actor must be 256 characters or fewer');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('--actor must not contain control characters');
  }
  const envUser = process.env.USER ?? process.env.USERNAME;
  if (envUser && envUser !== trimmed) {
    // Operator is overriding default attribution. Warn so forgery is at
    // least visible in the terminal session; the audit row still records
    // whatever they passed because the CLI is operator-trusted.
    process.stderr.write(
      `[dollhouse-audit] --actor=${trimmed} differs from process user (${envUser}); ` +
      `the audit event will record ${trimmed}.\n`,
    );
  }
  return trimmed;
}

function parseTime(value: string, flag: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  // Echo the rejected value back so the operator doesn't have to re-read
  // their own command line to spot the typo.
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`${flag} must be a unix-ms timestamp or parseable date; got: ${JSON.stringify(value)}`);
}

function printUsage(): void {
  process.stdout.write(
    'Usage:\n' +
    '  dollhouse-audit find [--backend file|database] [--user <id>] [--session <id>] [--approval <id>] [--after <ms|date>] [--before <ms|date>]\n' +
    '  dollhouse-audit show <sessionId> <approvalId> [--backend file|database] [--actor <id>]\n',
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}

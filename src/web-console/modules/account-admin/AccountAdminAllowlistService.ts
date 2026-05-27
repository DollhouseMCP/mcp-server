import type { ConsoleAdminAuditResult } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import {
  assertUuid,
  ConsoleStoreConflictError,
  ConsoleStoreValidationError,
} from '../../stores/ConsoleStoreValidation.js';
import type {
  ConsoleAccountAllowlistKind,
  IConsoleAccountAllowlistStore,
} from '../../stores/IConsoleAccountAllowlistStore.js';
import { assertAllowlistKind } from '../../stores/IConsoleAccountAllowlistStore.js';
import { validateAllowlistValue } from '../../stores/IConsoleAccountAllowlistStore.js';
import type { IAccountAdminMutationTransactionRunner } from './AccountAdminMutationTransaction.js';
import {
  serializeAccountAllowlistEntry,
  serializeAccountAllowlistList,
} from './AccountAdminAllowlistDtos.js';

export interface AccountAdminAllowlistServiceOptions {
  readonly allowlistStore: IConsoleAccountAllowlistStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly now?: () => Date;
}

export class AccountAdminAllowlistService {
  constructor(private readonly options: AccountAdminAllowlistServiceOptions) {}

  async list(): Promise<ConsoleHandlerResult> {
    return {
      status: 200,
      body: serializeAccountAllowlistList(await this.options.allowlistStore.listActive()),
    };
  }

  async get(id: string): Promise<ConsoleHandlerResult> {
    assertUuid(id, 'id');
    const entry = await this.options.allowlistStore.findActive(id);
    return entry
      ? { status: 200, body: serializeAccountAllowlistEntry(entry) }
      : problem(404, 'not_found', 'Not found', 'Allowlist entry was not found.');
  }

  async add(req: ConsoleRequest, route: ConsoleRouteDefinition): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    const parsed = parseAddBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAudit(req, route, 'rejected', 'invalid_request', null, parsed.auditArgs);
      return problem(400, 'invalid_request', 'Invalid request', parsed.detail);
    }
    try {
      let body;
      await this.options.transactionRunner.run(async tx => {
        const entry = await tx.addAllowlistEntry({
          ...parsed.value,
          createdByUserId: actor.userId,
          createdAt: occurredAt,
        });
        body = serializeAccountAllowlistEntry(entry);
        await tx.writeAdminAuditEvent(buildAuditEvent(req, route, 'approved', null, occurredAt, entry.id, {
          operation: 'allowlist_add',
          kind: entry.kind,
        }));
      });
      return { status: 201, body };
    } catch (error) {
      if (error instanceof ConsoleStoreConflictError) {
        await this.writeAudit(req, route, 'conflict', 'conflict', null, {
          operation: 'allowlist_add',
          kind: parsed.value.kind,
        });
        return problem(409, 'conflict', 'Conflict', 'An active allowlist entry already exists.');
      }
      throw error;
    }
  }

  async update(req: ConsoleRequest, route: ConsoleRouteDefinition, id: string): Promise<ConsoleHandlerResult> {
    assertUuid(id, 'id');
    const occurredAt = this.now();
    const parsed = parseUpdateBody(req.body);
    if (parsed.kind === 'invalid') {
      await this.writeAudit(req, route, 'rejected', 'invalid_request', id, parsed.auditArgs);
      return problem(400, 'invalid_request', 'Invalid request', parsed.detail);
    }
    const body = await this.options.transactionRunner.run(async tx => {
      const entry = await tx.updateAllowlistEntry({ id, note: parsed.note });
      await tx.writeAdminAuditEvent(buildAuditEvent(req, route, entry ? 'approved' : 'failed', entry ? null : 'not_found', occurredAt, id, {
        operation: 'allowlist_update',
      }));
      return entry ? serializeAccountAllowlistEntry(entry) : null;
    });
    return body
      ? { status: 200, body }
      : problem(404, 'not_found', 'Not found', 'Allowlist entry was not found.');
  }

  async remove(req: ConsoleRequest, route: ConsoleRouteDefinition, id: string): Promise<ConsoleHandlerResult> {
    assertUuid(id, 'id');
    const actor = requireConsoleAuthentication(req);
    const occurredAt = this.now();
    const removed = await this.options.transactionRunner.run(async tx => {
      const entry = await tx.removeAllowlistEntry({
        id,
        revokedByUserId: actor.userId,
        revokedAt: occurredAt,
      });
      await tx.writeAdminAuditEvent(buildAuditEvent(req, route, entry ? 'approved' : 'failed', entry ? null : 'not_found', occurredAt, id, {
        operation: 'allowlist_remove',
      }));
      return !!entry;
    });
    return removed
      ? { status: 204, body: null }
      : problem(404, 'not_found', 'Not found', 'Allowlist entry was not found.');
  }

  private async writeAudit(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleAdminAuditResult,
    errorCode: string | null,
    resourceId: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.transactionRunner.run(tx => tx.writeAdminAuditEvent(buildAuditEvent(
      req,
      route,
      result,
      errorCode,
      this.now(),
      resourceId,
      argsRedacted,
    )));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function parseAddBody(body: unknown): { readonly kind: 'valid'; readonly value: {
  readonly kind: ConsoleAccountAllowlistKind;
  readonly value: string;
  readonly note?: string | null;
} } | { readonly kind: 'invalid'; readonly detail: string; readonly auditArgs: Readonly<Record<string, unknown>> } {
  try {
    if (!isRecord(body)) throw new ConsoleStoreValidationError('request body is required.');
    const record = body;
    if (typeof record.kind !== 'string') throw new ConsoleStoreValidationError('kind must be a string.');
    assertAllowlistKind(record.kind, 'kind');
    if (typeof record.value !== 'string') throw new ConsoleStoreValidationError('value must be a string.');
    validateAllowlistValue(record.kind, record.value, 'value');
    if (record.note !== undefined && record.note !== null && typeof record.note !== 'string') {
      throw new ConsoleStoreValidationError('note must be a string or null.');
    }
    if (typeof record.note === 'string' && record.note.length > 500) {
      throw new ConsoleStoreValidationError('note must be at most 500 characters');
    }
    return {
      kind: 'valid',
      value: { kind: record.kind, value: record.value, note: record.note },
    };
  } catch (error) {
    return {
      kind: 'invalid',
      detail: error instanceof Error ? error.message : 'Invalid allowlist request.',
      auditArgs: { operation: 'allowlist_add', invalid_body: true },
    };
  }
}

function parseUpdateBody(body: unknown): { readonly kind: 'valid'; readonly note?: string | null }
  | { readonly kind: 'invalid'; readonly detail: string; readonly auditArgs: Readonly<Record<string, unknown>> } {
  if (!isRecord(body)) {
    return {
      kind: 'invalid',
      detail: 'request body is required.',
      auditArgs: { operation: 'allowlist_update', invalid_body: true },
    };
  }
  const record = body;
  if (record.note !== undefined && record.note !== null && typeof record.note !== 'string') {
    return {
      kind: 'invalid',
      detail: 'note must be a string or null.',
      auditArgs: { operation: 'allowlist_update', invalid_body: true },
    };
  }
  return { kind: 'valid', note: record.note };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildAuditEvent(
  req: ConsoleRequest,
  route: ConsoleRouteDefinition,
  result: ConsoleAdminAuditResult,
  errorCode: string | null,
  occurredAt: Date,
  resourceId: string | null,
  argsRedacted: Readonly<Record<string, unknown>>,
) {
  return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, occurredAt, {
    resourceKind: 'account_allowlist_entry',
    resourceId,
    argsRedacted,
    resultDetailRedacted: null,
  });
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}

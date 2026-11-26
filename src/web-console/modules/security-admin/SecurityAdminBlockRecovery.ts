import { randomUUID } from 'node:crypto';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { IRateLimitStore } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import { reserveAdminTotpAttempt } from '../../../auth/embedded-as/totp/AdminTotpRateLimit.js';
import type { AdminTotpService } from '../../../auth/embedded-as/totp/AdminTotpService.js';
import { DatabaseDangerZoneBlockStore } from '../../../state/DatabaseDangerZoneBlockStore.js';
import type { ConsoleAdminAuditResult, IAdminAuditWriter } from '../../audit/IAdminAuditWriter.js';
import { appendConsoleAdminAuditEventWithTx, type AdminAuditHmacKeyResolver } from '../../audit/PostgresAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { isElevationValidForRoute, type ConsoleAuthenticatedContext, type ConsoleHandlerResult, type ConsoleRequest, type ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';

const PATH = '/api/v1/admin/security/users/:user_id/blocked-agents/reset';
const PREVIEW_OPERATION = 'security.users.blocked_agents.reset.preview';
const RESET_OPERATION = 'security.users.blocked_agents.reset';
const APPROVAL_TTL_MS = 60_000;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

interface RecoveryBinding {
  readonly digest: string;
  readonly expires_at: number;
}

export interface SecurityAdminBlockRecoveryOptions {
  readonly database: DatabaseInstance;
  readonly auditKeys: AdminAuditHmacKeyResolver;
  readonly auditWriter: IAdminAuditWriter;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly totp: Pick<AdminTotpService, 'prove'>;
  readonly rateLimitStore: IRateLimitStore;
  readonly now?: () => Date;
}

class BlockResetExpiredError extends Error {}

export function createSecurityAdminBlockRecoveryRoutes(options: SecurityAdminBlockRecoveryOptions): readonly ConsoleRouteDefinition[] {
  const recovery = new SecurityAdminBlockRecovery(options);
  const shared = {
    path: PATH, audience: 'admin', requiredCapability: 'console:admin:security', privacyClass: 'security_metadata',
  } as const;
  const resetRoute: ConsoleRouteDefinition = {
    ...shared,
    method: 'POST', elevation: 'admin_5m', idempotency: 'required', auditExecution: 'handler_transaction',
    auditOperation: RESET_OPERATION,
    idempotencyFingerprintBody: body => parseBinding(body),
    privacyProjector: () => undefined,
    handler: req => recovery.reset(req, resetRoute),
  };
  return [{
    ...shared,
    method: 'GET', elevation: 'admin_30m', idempotency: 'not_applicable', auditOperation: PREVIEW_OPERATION,
    privacyProjector: projectPreview,
    handler: req => recovery.preview(req),
  }, resetRoute];
}

class SecurityAdminBlockRecovery {
  constructor(private readonly options: SecurityAdminBlockRecoveryOptions) {}

  async preview(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const userId = targetUserId(req);
    if (!userId) return invalidTarget();
    const backing = new DatabaseDangerZoneBlockStore(this.options.database, userId);
    try {
      const digest = await backing.rejectedSnapshotDigest();
      const headers = { 'Cache-Control': 'no-store' } as const;
      if (!digest) return { status: 200, headers, body: { state: 'ready' } };
      const approvalId = randomUUID();
      const binding = { digest, expires_at: this.now().getTime() + APPROVAL_TTL_MS };
      const tag = this.options.opaqueValues.hashOpaqueValue(approvalInput(actor, userId, approvalId, binding));
      return { status: 200, headers, body: { state: 'unavailable', ...binding, approval_id: approvalId, approval_tag: tag.toString('hex') } };
    } catch {
      return unavailable();
    }
  }

  async reset(req: ConsoleRequest, route: ConsoleRouteDefinition): Promise<ConsoleHandlerResult> {
    const userId = targetUserId(req);
    const result = userId ? await this.applyReset(req, route, userId) : invalidTarget();
    if (result.status === 204) return result;
    let auditResult: ConsoleAdminAuditResult = result.status >= 500 ? 'failed' : 'rejected';
    if (result.status === 409) auditResult = 'conflict';
    const code = bodyRecord(result.body)?.code;
    try {
      const event = buildConsoleAdminAuditEvent(route, RESET_OPERATION, req, auditResult, typeof code === 'string' ? code : null, this.now(), {
        resourceKind: 'blocked_agent_state', resourceId: userId,
      });
      await this.options.auditWriter.write(event);
    } catch {
      return unavailable();
    }
    return result;
  }

  private async applyReset(req: ConsoleRequest, route: ConsoleRouteDefinition, userId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const binding = parseBinding(req.body);
    const proof = bodyRecord(req.body)?.proof;
    const approvalId = req.headers['idempotency-key'];
    if (!binding || typeof proof !== 'string' || proof.trim().length < 6 || proof.length > 64 ||
        typeof approvalId !== 'string' || !UUID.test(approvalId)) {
      return problem(422, 'validation_failed', 'A current reset approval and authenticator code are required.');
    }

    try {
      if (binding.expires_at <= this.now().getTime() || !this.options.opaqueValues.matchesHash(
        approvalInput(actor, userId, approvalId, binding), Buffer.from(binding.approval_tag, 'hex'),
      )) return changed();
      if (!await reserveAdminTotpAttempt(this.options.rateLimitStore, RESET_OPERATION, actor.userId)) {
        return problem(429, 'rate_limited', 'Too many reset proof attempts. Try again later.');
      }
      if (!(await this.options.totp.prove(actor.userId, proof)).ok) {
        return problem(403, 'forbidden', 'The authenticator proof could not be verified.');
      }

      const backing = new DatabaseDangerZoneBlockStore(this.options.database, userId);
      const reset = await backing.resetRejected(binding.digest, async (tx, evidence) => {
        const now = this.now();
        if (binding.expires_at <= now.getTime() || !isElevationValidForRoute(actor, route, now)) throw new BlockResetExpiredError();
        const event = buildConsoleAdminAuditEvent(route, RESET_OPERATION, req, 'approved', null, now, {
          targetUserId: userId, resourceKind: 'blocked_agent_state', resourceId: userId,
          resultDetailRedacted: { evidence },
        });
        await appendConsoleAdminAuditEventWithTx(tx, event, this.options.auditKeys);
      });
      return reset ? { status: 204 } : changed();
    } catch (error) {
      if (error instanceof BlockResetExpiredError) return changed();
      return unavailable();
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function targetUserId(req: ConsoleRequest): string | null {
  const id = req.params.user_id;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}

function bodyRecord(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

function parseBinding(body: unknown): (RecoveryBinding & { readonly approval_tag: string }) | null {
  const record = bodyRecord(body);
  if (!record) return null;
  const { digest, expires_at, approval_tag } = record;
  if (typeof digest !== 'string' || !HEX_DIGEST.test(digest) || typeof expires_at !== 'number' ||
      !Number.isSafeInteger(expires_at) || typeof approval_tag !== 'string' || !HEX_DIGEST.test(approval_tag)) return null;
  return { digest, expires_at, approval_tag };
}

function approvalInput(actor: ConsoleAuthenticatedContext, userId: string, approvalId: string, binding: RecoveryBinding): string {
  return JSON.stringify([RESET_OPERATION, actor.userId, actor.sessionIdHash.toString('hex'), userId, approvalId, binding.digest, binding.expires_at]);
}

function projectPreview(value: unknown) {
  const record = bodyRecord(value);
  if (record?.state === 'ready') return { state: 'ready' };
  const binding = parseBinding(record);
  if (record?.state !== 'unavailable' || !binding || typeof record.approval_id !== 'string' || !UUID.test(record.approval_id)) {
    throw new Error('Blocked-agent recovery preview is incomplete');
  }
  return { state: 'unavailable', ...binding, approval_id: record.approval_id };
}

function problem(status: number, code: string, detail: string): ConsoleHandlerResult {
  return { status, body: { status, code, detail, title: 'Blocked-agent recovery' } };
}

function changed(): ConsoleHandlerResult {
  return problem(409, 'conflict', 'The reset approval expired or the blocked-agent state changed. Review it again.');
}

function invalidTarget(): ConsoleHandlerResult {
  return problem(422, 'validation_failed', 'Select a valid account UUID.');
}

function unavailable(): ConsoleHandlerResult {
  return problem(503, 'service_unavailable', 'Blocked-agent recovery is temporarily unavailable.');
}

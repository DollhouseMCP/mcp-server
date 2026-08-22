import { randomBytes, randomUUID } from 'node:crypto';

import { generateNewKeypair } from '../../../auth/embedded-as/persistKeys.js';
import { env } from '../../../config/env.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyWrite,
} from '../../../storage/signingKeys/ISigningKeyStore.js';
import { signingKeyVerificationGraceMs } from '../../../storage/signingKeys/signingKeyLifecycle.js';
import {
  ConsoleAuthPolicyConflictError,
  type ConsoleAuthPolicy,
  type IConsoleAuthPolicyStore,
} from '../../stores/IConsoleAuthPolicyStore.js';
import type { ConsoleHandlerResult } from '../../platform/ConsolePlatformTypes.js';
import type { ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IAccountAdminMutationTransactionRunner } from '../account-admin/AccountAdminMutationTransaction.js';
import type {
  SecurityAuthPolicyDto,
  SecuritySigningKeyDto,
  SecuritySigningKeyJobDto,
  SecuritySigningKeyKindDto,
} from './SecurityAdminDtos.js';

const SIGNING_KEY_KINDS = ['jwks', 'cookie', 'invite'] as const satisfies readonly SigningKeyKind[];
const DEFAULT_AUTH_POLICY = Object.freeze({
  require_admin_totp: true,
  csrf_protection: true,
  bff_session_security: true,
  step_up_required: true,
  privacy_boundaries_enforced: true,
  max_admin_elevation_seconds: 300,
});

export class SecurityAdminService {
  constructor(
    private readonly signingKeyStore: ISigningKeyStore,
    private readonly authPolicyStore: IConsoleAuthPolicyStore,
    private readonly transactionRunner: IAccountAdminMutationTransactionRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly isOperatorManaged: (kind: SigningKeyKind) => boolean = operatorManagedByEnvironment,
  ) {}

  async listSigningKeys(): Promise<ConsoleHandlerResult> {
    return {
      status: 200,
      body: {
        kinds: await Promise.all(SIGNING_KEY_KINDS.map(kind => this.getSigningKeyKindBody(kind))),
      },
    };
  }

  async getSigningKeyKind(kind: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed) return notFound('Unknown signing key kind.');
    return { status: 200, body: await this.getSigningKeyKindBody(parsed) };
  }

  async rotateSigningKey(req: ConsoleRequest, route: ConsoleRouteDefinition, kind: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed) return this.auditOnly(req, route, notFound('Unknown signing key kind.'), 'not_found', { kind });
    if (this.isOperatorManaged(parsed)) {
      return this.auditOnly(req, route, conflict(operatorManagedMessage(parsed)), 'operator_managed', { kind: parsed });
    }
    const write = await createSigningKeyWrite(parsed);
    return this.transactionRunner.run(async tx => {
      const key = await tx.rotateSigningKey(write);
      const result = { status: 200, body: this.jobReceipt(parsed, 'rotate', null, key.kid, null) };
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'approved', null, { kind: parsed, result_kid: key.kid }));
      return result;
    }, requireConsoleAuthentication(req));
  }

  async retireSigningKey(req: ConsoleRequest, route: ConsoleRouteDefinition, kind: string, kid: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed || !isBoundedIdentifier(kid)) {
      return this.auditOnly(req, route, notFound('Signing key was not found.'), 'not_found', { kind, kid });
    }
    if (this.isOperatorManaged(parsed)) {
      return this.auditOnly(req, route, conflict(operatorManagedMessage(parsed)), 'operator_managed', { kind: parsed, kid });
    }
    return this.transactionRunner.run(async tx => {
      const key = await tx.getSigningKeyByKid(kid);
      if (key?.kind !== parsed) {
        const result = notFound('Signing key was not found.');
        await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'failed', 'not_found', { kind: parsed, kid }));
        return result;
      }
      if (key.active) {
        const result = conflict('Rotate this key kind before retiring its active signing key.');
        await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'conflict', 'conflict', { kind: parsed, kid }));
        return result;
      }
      await tx.retireSigningKey(kid, this.now().getTime());
      const result = { status: 200, body: this.jobReceipt(parsed, 'retire', kid, null, null) };
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'approved', null, { kind: parsed, kid }));
      return result;
    }, requireConsoleAuthentication(req));
  }

  async deleteSigningKey(req: ConsoleRequest, route: ConsoleRouteDefinition, kind: string, kid: string, body: unknown): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    const force = requestForceDelete(bodyRecordFromUnknown(body));
    if (!parsed || !isBoundedIdentifier(kid)) {
      return this.auditOnly(req, route, notFound('Signing key was not found.'), 'not_found', { kind, kid, force });
    }
    if (this.isOperatorManaged(parsed)) {
      return this.auditOnly(req, route, conflict(operatorManagedMessage(parsed)), 'operator_managed', { kind: parsed, kid, force });
    }
    return this.transactionRunner.run(async tx => {
      const key = await tx.getSigningKeyByKid(kid);
      let result: ConsoleHandlerResult | null = null;
      if (key?.kind !== parsed) result = notFound('Signing key was not found.');
      else if (key.active) result = conflict('Only retired inactive signing keys can be deleted.');
      else if (!key.retiredAt) result = conflict('Signing key must be retired before deletion.');
      else if (!force && this.now().getTime() - key.retiredAt < signingKeyVerificationGraceMs(parsed)) {
        result = conflict('Signing key is still within hard-delete grace.');
      }
      if (result) {
        await tx.writeAdminAuditEvent(this.auditEvent(req, route, result.status === 404 ? 'failed' : 'conflict',
          result.status === 404 ? 'not_found' : 'conflict', { kind: parsed, kid, force }));
        return result;
      }
      await tx.deleteSigningKey(kid, { force });
      const success = { status: 200, body: this.jobReceipt(parsed, 'delete', kid, null, null) };
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'approved', null, { kind: parsed, kid, force }));
      return success;
    }, requireConsoleAuthentication(req));
  }

  async getAuthPolicy(): Promise<ConsoleHandlerResult> {
    const body = this.authPolicyDto(await this.authPolicyStore.load());
    return { status: 200, body, headers: { ETag: body.etag } };
  }

  async putAuthPolicy(req: ConsoleRequest, route: ConsoleRouteDefinition, body: unknown, ifMatch?: string): Promise<ConsoleHandlerResult> {
    return this.transactionRunner.run(async tx => {
    const loaded = await tx.loadAuthPolicy();
    const current = this.authPolicyDto(loaded);
    if (!ifMatch) {
      const result = problem(428, 'precondition_required', 'Missing If-Match header.', 'Auth policy updates require If-Match.');
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'rejected', 'precondition_required', {}));
      return result;
    }
    if (ifMatch !== current.etag) {
      const result = problem(412, 'precondition_failed', 'Stale auth policy.', 'Auth policy changed before this request.');
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'conflict', 'precondition_failed', {}));
      return result;
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (record.require_admin_totp === false || record.csrf_protection === false ||
        record.bff_session_security === false || record.step_up_required === false ||
        record.privacy_boundaries_enforced === false) {
      const result = problem(422, 'validation_failed', 'Auth policy violates platform invariants.', 'Required security invariants cannot be disabled.');
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'rejected', 'validation_failed', {}));
      return result;
    }
    const max = record.max_admin_elevation_seconds;
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 60 || max > 300)) {
      const result = problem(422, 'validation_failed', 'Invalid auth policy.', 'max_admin_elevation_seconds must be an integer from 60 to 300.');
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'rejected', 'validation_failed', {}));
      return result;
    }
    let saved: ConsoleAuthPolicy;
    try {
      saved = await tx.saveAuthPolicy({
        maxAdminElevationSeconds: max ?? loaded.maxAdminElevationSeconds,
      }, { expectedUpdatedAt: loaded.updatedAt });
    } catch (error) {
      if (error instanceof ConsoleAuthPolicyConflictError) {
        const result = problem(412, 'precondition_failed', 'Stale auth policy.', 'Auth policy changed before this request.');
        await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'conflict', 'precondition_failed', {}));
        return result;
      }
      throw error;
    }
    const updated = this.authPolicyDto(saved);
    const result = { status: 200, body: updated, headers: { ETag: updated.etag } };
    await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'approved', null, {
      max_admin_elevation_seconds: updated.max_admin_elevation_seconds,
    }));
    return result;
    }, requireConsoleAuthentication(req));
  }

  async resetTotp(req: ConsoleRequest, route: ConsoleRouteDefinition, userId: string, actorUserId: string | null): Promise<ConsoleHandlerResult> {
    if (!isUuid(userId)) return this.auditOnly(req, route, notFound('User was not found.'), 'not_found', { user_id: userId });
    const resetAt = this.now();
    return this.transactionRunner.run(async tx => {
    const disabled = await tx.disableActiveTotp(userId, resetAt);
    let eventId: string | null = null;
    if (disabled) {
      const event = await tx.appendSecurityInvalidationEvent({
        kind: 'admin_factor_disabled',
        urgency: 'acknowledged',
        userId,
        reason: 'admin_totp_reset',
        payload: { clearedElevations: true, proofMethod: 'admin_reset' },
        createdAt: resetAt,
        createdByUserId: actorUserId,
      });
      eventId = event.eventId;
    }
    const result = {
      status: 200,
      body: {
        user_id: userId,
        factor_disabled: disabled,
        elevation_revocation: {
          event_id: eventId,
          status: disabled ? 'queued' : 'not_required',
        },
        reset_at: resetAt.toISOString(),
      },
    };
    await tx.writeAdminAuditEvent(this.auditEvent(req, route, 'approved', null, {
      user_id: userId,
      factor_disabled: disabled,
    }, userId));
    return result;
    }, requireConsoleAuthentication(req));
  }

  private async auditOnly(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: ConsoleHandlerResult,
    errorCode: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ConsoleHandlerResult> {
    return this.transactionRunner.run(async tx => {
      await tx.writeAdminAuditEvent(this.auditEvent(req, route, result.status === 409 ? 'conflict' : 'rejected', errorCode, args));
      return result;
    }, requireConsoleAuthentication(req));
  }

  private auditEvent(
    req: ConsoleRequest,
    route: ConsoleRouteDefinition,
    result: 'approved' | 'rejected' | 'failed' | 'conflict',
    errorCode: string | null,
    argsRedacted: Readonly<Record<string, unknown>>,
    targetUserId: string | null = null,
  ) {
    return buildConsoleAdminAuditEvent(route, route.auditOperation ?? '', req, result, errorCode, this.now(), {
      resourceKind: route.auditOperation?.includes('signing_keys') ? 'signing_key' : 'security_configuration',
      resourceId: targetUserId,
      targetUserId,
      argsRedacted,
      resultDetailRedacted: null,
    });
  }

  private async getSigningKeyKindBody(kind: SigningKeyKind): Promise<SecuritySigningKeyKindDto> {
    const keys = (await this.signingKeyStore.listByKind(kind))
      .map(key => this.toKeyDto(key));
    const active = keys.find(key => key.state === 'active')?.kid ?? null;
    return { kind, active_kid: active, keys };
  }

  private toKeyDto(key: SigningKey): SecuritySigningKeyDto {
    const retiredAt = key.retiredAt ?? null;
    const deletedAt: number | null = null;
    const graceEndsAt = key.rotatedAt
      ? key.rotatedAt + signingKeyVerificationGraceMs(key.kind)
      : null;
    return {
      kind: key.kind,
      kid: key.kid,
      state: key.active ? 'active' : signingKeyState(retiredAt, deletedAt, graceEndsAt, this.now().getTime()),
      created_at: new Date(key.createdAt).toISOString(),
      rotated_at: key.rotatedAt ? new Date(key.rotatedAt).toISOString() : null,
      retired_at: retiredAt ? new Date(retiredAt).toISOString() : null,
      deleted_at: null,
      verification_grace_ends_at: graceEndsAt ? new Date(graceEndsAt).toISOString() : null,
    };
  }

  /**
   * Build the final receipt for a synchronously completed signing-key
   * operation. The receipt is response-only — it is not retained, because the
   * durable outcome already lives in the signing-key store.
   */
  private jobReceipt(
    kind: SigningKeyKind,
    action: SecuritySigningKeyJobDto['action'],
    targetKid: string | null,
    resultKid: string | null,
    errorCode: string | null,
  ): SecuritySigningKeyJobDto {
    const at = this.now().toISOString();
    return {
      id: randomUUID(),
      kind,
      action,
      status: errorCode ? 'failed' : 'completed',
      created_at: at,
      completed_at: at,
      target_kid: targetKid,
      result_kid: resultKid,
      error_code: errorCode,
    };
  }

  private authPolicyDto(policy: ConsoleAuthPolicy): SecurityAuthPolicyDto {
    return {
      ...DEFAULT_AUTH_POLICY,
      max_admin_elevation_seconds: policy.maxAdminElevationSeconds,
      updated_at: policy.updatedAt.toISOString(),
      etag: `W/"security-auth-policy:${policy.updatedAt.getTime()}:${policy.maxAdminElevationSeconds}"`,
    };
  }
}

async function createSigningKeyWrite(kind: SigningKeyKind): Promise<SigningKeyWrite> {
  if (kind === 'jwks') {
    const stored = await generateNewKeypair();
    return { kind, kid: stored.kid, payload: stored as unknown as Record<string, unknown> };
  }
  const kid = `${kind}-${randomUUID()}`;
  return {
    kind,
    kid,
    payload: { secret: randomBytes(32).toString('base64'), length: 32 },
  };
}

function bodyRecordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestForceDelete(body: Record<string, unknown>): boolean {
  return body.force === true || body.emergency === true;
}

function parseSigningKeyKind(value: string): SigningKeyKind | null {
  return SIGNING_KEY_KINDS.find(kind => kind === value) ?? null;
}

function signingKeyState(
  retiredAt: number | null,
  deletedAt: number | null,
  graceEndsAt: number | null,
  now: number,
): SecuritySigningKeyDto['state'] {
  if (deletedAt) return 'deleted';
  if (retiredAt) return 'retired';
  return graceEndsAt && graceEndsAt > now ? 'verifying' : 'retired';
}

function isBoundedIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function operatorManagedByEnvironment(kind: SigningKeyKind): boolean {
  if (kind === 'cookie') return Boolean(env.DOLLHOUSE_COOKIE_SIGNING_SECRET);
  if (kind === 'invite') return Boolean(env.DOLLHOUSE_INVITE_TOKEN_SECRET);
  return false;
}

function operatorManagedMessage(kind: SigningKeyKind): string {
  const variable = kind === 'cookie'
    ? 'DOLLHOUSE_COOKIE_SIGNING_SECRET'
    : 'DOLLHOUSE_INVITE_TOKEN_SECRET';
  return `${kind} signing material is managed by ${variable}; change that secret and restart every replica.`;
}

function notFound(detail: string): ConsoleHandlerResult {
  return problem(404, 'not_found', 'Not found', detail);
}

function conflict(detail: string): ConsoleHandlerResult {
  return problem(409, 'conflict', 'Conflict', detail);
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: `https://dollhousemcp.com/errors/${code}`,
      title,
      status,
      code,
      detail,
    },
  };
}

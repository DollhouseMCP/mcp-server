import { randomBytes, randomUUID } from 'node:crypto';

import { generateNewKeypair } from '../../../auth/embedded-as/persistKeys.js';
import type {
  ISigningKeyStore,
  SigningKey,
  SigningKeyKind,
  SigningKeyWrite,
} from '../../../storage/signingKeys/ISigningKeyStore.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import {
  ConsoleAuthPolicyConflictError,
  type ConsoleAuthPolicy,
  type IConsoleAuthPolicyStore,
} from '../../stores/IConsoleAuthPolicyStore.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { ConsoleHandlerResult } from '../../platform/ConsolePlatformTypes.js';
import type {
  SecurityAuthPolicyDto,
  SecuritySigningKeyDto,
  SecuritySigningKeyJobDto,
  SecuritySigningKeyKindDto,
} from './SecurityAdminDtos.js';

const SIGNING_KEY_KINDS = ['jwks', 'cookie', 'invite'] as const satisfies readonly SigningKeyKind[];
const DEFAULT_VERIFICATION_GRACE_MS = 24 * 60 * 60 * 1000;
const HARD_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;
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
    private readonly factorStore: IConsoleFactorStore,
    private readonly invalidationStore: IConsoleSecurityInvalidationStore,
    private readonly authPolicyStore: IConsoleAuthPolicyStore,
    private readonly now: () => Date = () => new Date(),
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

  async rotateSigningKey(kind: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed) return notFound('Unknown signing key kind.');
    const write = await createSigningKeyWrite(parsed);
    const key = await this.signingKeyStore.rotate(write);
    // The store write above is the durable operation; respond with the final
    // receipt rather than a 202 + pollable job id (the work is synchronous).
    const job = this.jobReceipt(parsed, 'rotate', null, key.kid, null);
    return { status: 200, body: job };
  }

  async retireSigningKey(kind: string, kid: string): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed || !isBoundedIdentifier(kid)) return notFound('Signing key was not found.');
    const key = await this.signingKeyStore.getByKid(kid);
    if (key?.kind !== parsed) return notFound('Signing key was not found.');
    await this.signingKeyStore.retire(kid, this.now().getTime());
    const job = this.jobReceipt(parsed, 'retire', kid, null, null);
    return { status: 200, body: job };
  }

  async deleteSigningKey(kind: string, kid: string, body: unknown): Promise<ConsoleHandlerResult> {
    const parsed = parseSigningKeyKind(kind);
    if (!parsed || !isBoundedIdentifier(kid)) return notFound('Signing key was not found.');
    const key = await this.signingKeyStore.getByKid(kid);
    // Not-found and not-deletable are distinct: an unknown kid is a 404 (matching
    // retireSigningKey), an existing-but-active key is a 409 conflict.
    if (key?.kind !== parsed) return notFound('Signing key was not found.');
    if (key.active) return conflict('Only retired inactive signing keys can be deleted.');
    const retiredAt = key.retiredAt;
    if (!retiredAt) return conflict('Signing key must be retired before deletion.');
    const force = requestForceDelete(bodyRecordFromUnknown(body));
    if (!force && this.now().getTime() - retiredAt < HARD_DELETE_GRACE_MS) {
      return conflict('Signing key is still within hard-delete grace.');
    }
    await this.signingKeyStore.delete(kid, { force });
    const job = this.jobReceipt(parsed, 'delete', kid, null, null);
    return { status: 200, body: job };
  }

  async getAuthPolicy(): Promise<ConsoleHandlerResult> {
    const body = this.authPolicyDto(await this.authPolicyStore.load());
    return { status: 200, body, headers: { ETag: body.etag } };
  }

  async putAuthPolicy(body: unknown, ifMatch?: string): Promise<ConsoleHandlerResult> {
    const loaded = await this.authPolicyStore.load();
    const current = this.authPolicyDto(loaded);
    if (!ifMatch) {
      return problem(428, 'precondition_required', 'Missing If-Match header.', 'Auth policy updates require If-Match.');
    }
    if (ifMatch !== current.etag) {
      return problem(412, 'precondition_failed', 'Stale auth policy.', 'Auth policy changed before this request.');
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (record.require_admin_totp === false || record.csrf_protection === false ||
        record.bff_session_security === false || record.step_up_required === false ||
        record.privacy_boundaries_enforced === false) {
      return problem(422, 'validation_failed', 'Auth policy violates platform invariants.', 'Required security invariants cannot be disabled.');
    }
    const max = record.max_admin_elevation_seconds;
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 60 || max > 300)) {
      return problem(422, 'validation_failed', 'Invalid auth policy.', 'max_admin_elevation_seconds must be an integer from 60 to 300.');
    }
    let saved: ConsoleAuthPolicy;
    try {
      saved = await this.authPolicyStore.save({
        maxAdminElevationSeconds: max ?? loaded.maxAdminElevationSeconds,
      }, { expectedUpdatedAt: loaded.updatedAt });
    } catch (error) {
      if (error instanceof ConsoleAuthPolicyConflictError) {
        return problem(412, 'precondition_failed', 'Stale auth policy.', 'Auth policy changed before this request.');
      }
      throw error;
    }
    const updated = this.authPolicyDto(saved);
    return { status: 200, body: updated, headers: { ETag: updated.etag } };
  }

  async resetTotp(userId: string, actorUserId: string | null): Promise<ConsoleHandlerResult> {
    if (!isUuid(userId)) return notFound('User was not found.');
    const resetAt = this.now();
    const disabled = await this.factorStore.disableActiveTotp(userId, resetAt);
    let eventId: string | null = null;
    if (disabled) {
      const event = await this.invalidationStore.appendEvent({
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
    return {
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
    const graceEndsAt = key.rotatedAt ? key.rotatedAt + DEFAULT_VERIFICATION_GRACE_MS : null;
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

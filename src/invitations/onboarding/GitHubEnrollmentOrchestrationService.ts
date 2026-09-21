import { randomUUID } from 'node:crypto';
import {
  GitHubAuthenticatedUserError,
  type GitHubAuthenticatedUser,
  type GitHubAuthenticatedUserClient,
} from '../../auth/github/GitHubAuthenticatedUserClient.js';
import {
  GitHubOAuthTokenError,
  type GitHubOAuthTokenClient,
} from '../../auth/github/GitHubOAuthTokenClient.js';
import type { AuditSink, DurableAuditEvent } from '../../security/auditSink.js';
import type { InvitationManagementAudit } from '../IInvitationManagementStore.js';
import type {
  InvitationActivationInput,
  InvitationActivationResult,
  PostgresInvitationActivationStore,
} from '../PostgresInvitationActivationStore.js';
import { InvitationError } from '../InvitationTypes.js';
import {
  GITHUB_ENROLLMENT_PURPOSE,
  GitHubEnrollmentOAuthStateService,
  type GitHubEnrollmentStateContext,
} from './GitHubEnrollmentOAuthState.js';

export type GitHubEnrollmentCallback =
  | { readonly kind: 'code'; readonly state: string; readonly code: string }
  | { readonly kind: 'provider_error'; readonly state: string; readonly error: 'access_denied' | 'other' };

export type GitHubEnrollmentFlowErrorCode =
  | 'state_unavailable'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'activation_denied'
  | 'identity_conflict'
  | 'activation_unavailable'
  | 'audit_unavailable';

/** Sanitized orchestration failure. It never retains an upstream error or secret input. */
export class GitHubEnrollmentFlowError extends Error {
  constructor(readonly code: GitHubEnrollmentFlowErrorCode) {
    super('GitHub enrollment is unavailable');
    this.name = 'GitHubEnrollmentFlowError';
  }
}

export type GitHubEnrollmentCompletion = InvitationActivationResult | { readonly status: 'cancelled' };

export interface GitHubEnrollmentOrchestrationOptions {
  readonly state: Pick<GitHubEnrollmentOAuthStateService, 'begin' | 'consume'>;
  readonly tokens: Pick<GitHubOAuthTokenClient, 'exchangeCode'>;
  readonly users: Pick<GitHubAuthenticatedUserClient, 'fetchAuthenticatedUser'>;
  readonly activation: Pick<PostgresInvitationActivationStore, 'activate'>;
  readonly activationAudit: Extract<InvitationManagementAudit, { kind: 'system' }>;
  readonly audit: Pick<AuditSink, 'write'>;
}

/** Unregistered composition only. It creates no route, normal session, or persisted provider token. */
export class GitHubEnrollmentOrchestrationService {
  constructor(private readonly options: GitHubEnrollmentOrchestrationOptions) {
    if (!options?.state || !options.tokens || !options.users || !options.activation ||
        options.activationAudit?.kind !== 'system' || typeof options.activationAudit.appendSecurityEvent !== 'function' ||
        typeof options.audit?.write !== 'function') throw new Error('Invalid GitHub enrollment orchestration configuration');
  }

  async start(input: { readonly ownerHash: Buffer; readonly sessionHash: Buffer }): Promise<{
    readonly authorizationUrl: string;
    readonly expiresAt: Date;
  }> {
    const owned = copyBinding(input);
    try {
      let started: Awaited<ReturnType<GitHubEnrollmentOrchestrationOptions['state']['begin']>>;
      try {
        started = await this.options.state.begin(owned.ownerHash, owned.sessionHash, randomUUID());
      } catch {
        throw new GitHubEnrollmentFlowError('state_unavailable');
      }
      const context = contextFrom(started.context);
      const result = { authorizationUrl: started.authorizationUrl, expiresAt: new Date(started.expiresAt) };
      await this.writeAudit('invitation.github_enrollment_started', context);
      return result;
    } finally {
      owned.ownerHash.fill(0);
      owned.sessionHash.fill(0);
    }
  }

  async complete(input: {
    readonly ownerHash: Buffer;
    readonly sessionHash: Buffer;
    readonly callback: GitHubEnrollmentCallback;
  }): Promise<GitHubEnrollmentCompletion> {
    const callback = copyCallback(input.callback);
    const owned = { ...copyBinding(input), callback };
    try {
      let state: Awaited<ReturnType<GitHubEnrollmentOrchestrationOptions['state']['consume']>>;
      try {
        state = await this.options.state.consume(
          owned.callback.state,
          owned.ownerHash,
          owned.sessionHash,
        );
      } catch {
        throw new GitHubEnrollmentFlowError('state_unavailable');
      }
      const snapshot = stateSnapshot(state);
      const context = contextFrom(snapshot);
      if (owned.callback.kind === 'provider_error') {
        if (owned.callback.error === 'access_denied') {
          await this.writeAudit('invitation.github_enrollment_cancelled', context, 'callback', 'user_cancelled');
          return { status: 'cancelled' };
        }
        return this.fail(context, 'provider_rejected', 'callback', 'provider_error');
      }

      const identity = await this.exchangeIdentity(owned.callback.code, snapshot.codeVerifier, context);
      let result: InvitationActivationResult;
      try {
        const activation: InvitationActivationInput = {
          invitationId: snapshot.invitationId,
          generation: snapshot.generation,
          claimAssertionId: snapshot.claimAssertionId,
          claimOwnerHash: owned.ownerHash,
          sessionHash: owned.sessionHash,
          githubId: identity.externalSub,
          githubLogin: identity.login,
          providerEmail: identity.email,
          providerEmailVerified: false,
          correlationId: snapshot.correlationId,
        };
        result = await this.options.activation.activate(activation, this.options.activationAudit);
      } catch (error) {
        const mapped = activationFailure(error);
        return this.fail(context, mapped.code, 'activation', mapped.reason, mapped.event);
      }
      // Success audit is part of the activation transaction. Do not add a
      // non-atomic duplicate after the account and restricted-session commit.
      return { status: result.status, userId: result.userId, invitationId: result.invitationId };
    } finally {
      owned.ownerHash.fill(0);
      owned.sessionHash.fill(0);
    }
  }

  private async exchangeIdentity(
    code: string,
    codeVerifier: string,
    context: GitHubEnrollmentStateContext,
  ): Promise<GitHubAuthenticatedUser> {
    let token: string;
    try {
      token = await this.options.tokens.exchangeCode({ code, codeVerifier });
    } catch (error) {
      const rejected = error instanceof GitHubOAuthTokenError &&
        ['invalid_request', 'rejected', 'response_too_large', 'invalid_response'].includes(error.code);
      return this.fail(context, rejected ? 'provider_rejected' : 'provider_unavailable',
        'token_exchange', rejected ? 'provider_rejected' : 'upstream_unavailable');
    }
    try {
      return await this.options.users.fetchAuthenticatedUser(token);
    } catch (error) {
      const rejected = error instanceof GitHubAuthenticatedUserError &&
        ['unauthorized', 'response_too_large', 'invalid_response'].includes(error.code);
      return this.fail(context, rejected ? 'provider_rejected' : 'provider_unavailable',
        'identity_lookup', rejected ? 'provider_rejected' : 'upstream_unavailable');
    }
  }

  private async fail(
    context: GitHubEnrollmentStateContext,
    code: GitHubEnrollmentFlowErrorCode,
    stage: string,
    reason: string,
    event = 'invitation.github_enrollment_failed',
  ): Promise<never> {
    await this.writeAudit(event, context, stage, reason);
    throw new GitHubEnrollmentFlowError(code);
  }

  private async writeAudit(
    eventType: string,
    context: GitHubEnrollmentStateContext,
    stage?: string,
    reason?: string,
  ): Promise<void> {
    const event: DurableAuditEvent = {
      eventType,
      actorId: context.userId,
      targetId: context.invitationId,
      metadata: {
        invitationId: context.invitationId,
        userId: context.userId,
        generation: context.generation,
        claimAssertionId: context.claimAssertionId,
        correlationId: context.correlationId,
        purpose: GITHUB_ENROLLMENT_PURPOSE,
        ...(stage ? { stage } : {}),
        ...(reason ? { reason } : {}),
      },
    };
    try {
      await this.options.audit.write(event);
    } catch {
      throw new GitHubEnrollmentFlowError('audit_unavailable');
    }
  }
}

function copyBinding(input: { readonly ownerHash: Buffer; readonly sessionHash: Buffer }) {
  if (!Buffer.isBuffer(input?.ownerHash) || input.ownerHash.length !== 32 ||
      !Buffer.isBuffer(input?.sessionHash) || input.sessionHash.length !== 32) {
    throw new GitHubEnrollmentFlowError('state_unavailable');
  }
  return { ownerHash: Buffer.from(input.ownerHash), sessionHash: Buffer.from(input.sessionHash) };
}

function copyCallback(callback: GitHubEnrollmentCallback): GitHubEnrollmentCallback {
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) {
    throw new GitHubEnrollmentFlowError('state_unavailable');
  }
  if (callback.kind === 'code' && Object.keys(callback).length === 3 &&
      typeof callback.state === 'string' && typeof callback.code === 'string') return { ...callback };
  if (callback.kind === 'provider_error' && Object.keys(callback).length === 3 &&
      typeof callback.state === 'string' && ['access_denied', 'other'].includes(callback.error)) return { ...callback };
  throw new GitHubEnrollmentFlowError('state_unavailable');
}

function contextFrom(value: GitHubEnrollmentStateContext): GitHubEnrollmentStateContext {
  return {
    userId: value.userId,
    invitationId: value.invitationId,
    generation: value.generation,
    claimAssertionId: value.claimAssertionId,
    correlationId: value.correlationId,
  };
}

function stateSnapshot(value: Awaited<ReturnType<GitHubEnrollmentOrchestrationOptions['state']['consume']>>) {
  return {
    userId: value.userId,
    invitationId: value.invitationId,
    generation: value.generation,
    claimAssertionId: value.claimAssertionId,
    correlationId: value.correlationId,
    purpose: value.purpose,
    callbackUri: value.callbackUri,
    codeVerifier: value.codeVerifier,
  };
}

function activationFailure(error: unknown): {
  readonly code: GitHubEnrollmentFlowErrorCode;
  readonly reason: string;
  readonly event?: string;
} {
  if (!(error instanceof InvitationError)) return { code: 'activation_unavailable', reason: 'unavailable' };
  if (error.code === 'invitation_conflict') {
    return { code: 'identity_conflict', reason: 'identity_conflict', event: 'invitation.github_enrollment_conflict' };
  }
  if (['configuration_invalid', 'concurrent_update'].includes(error.code)) {
    return { code: 'activation_unavailable', reason: error.code };
  }
  return { code: 'activation_denied', reason: 'authority_rejected', event: 'invitation.github_enrollment_denied' };
}

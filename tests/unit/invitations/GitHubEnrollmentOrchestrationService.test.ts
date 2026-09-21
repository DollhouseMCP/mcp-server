import { jest } from '@jest/globals';
import type { DurableAuditEvent } from '../../../src/security/auditSink.js';
import type { InvitationManagementAudit } from '../../../src/invitations/IInvitationManagementStore.js';
import type { InvitationActivationInput } from '../../../src/invitations/PostgresInvitationActivationStore.js';
import { InvitationError, type InvitationErrorCode } from '../../../src/invitations/InvitationTypes.js';
import { GitHubAuthenticatedUserError } from '../../../src/auth/github/GitHubAuthenticatedUserClient.js';
import { GitHubOAuthTokenError } from '../../../src/auth/github/GitHubOAuthTokenClient.js';
import {
  GitHubEnrollmentFlowError,
  GitHubEnrollmentOrchestrationService,
} from '../../../src/invitations/onboarding/GitHubEnrollmentOrchestrationService.js';

const AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize?state=raw-state-secret';
const RAW_STATE = 'raw-state-secret';
const CODE = 'one-time-code-secret';
const TOKEN = 'gho_transient-token-secret';
const VERIFIER = 'v'.repeat(43);
const OWNER = Buffer.alloc(32, 1);
const SESSION = Buffer.alloc(32, 2);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

function fixture() {
  const context = { userId: USER_ID, invitationId: INVITATION_ID, generation: 3,
    claimAssertionId: CLAIM_ID, correlationId: CORRELATION_ID };
  const record = { ...context, stateHash: Buffer.alloc(32, 3), ownerHash: OWNER, sessionHash: SESSION,
    purpose: 'link_login_identity' as const, callbackUri: 'https://console.example.test/auth/onboarding/github/callback',
    createdAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    codeVerifier: VERIFIER };
  const state = {
    begin: jest.fn(async (_owner: Buffer, _session: Buffer, correlationId: string) => ({
      authorizationUrl: AUTHORIZATION_URL, expiresAt: record.expiresAt,
      context: { ...context, correlationId },
    })),
    consume: jest.fn(async () => record),
  };
  const tokens = { exchangeCode: jest.fn(async () => TOKEN) };
  const users = { fetchAuthenticatedUser: jest.fn(async () => ({
    id: 9007199254740991, externalSub: '9007199254740991', login: 'Renamed-User',
    displayName: 'Ignored Display', email: 'different-private-profile@example.test', avatarUrl: 'https://avatars.example.test/u',
  })) };
  let activationInput: InvitationActivationInput | undefined;
  const activation = { activate: jest.fn(async (input: InvitationActivationInput) => {
    activationInput = { ...input, claimOwnerHash: Buffer.from(input.claimOwnerHash), sessionHash: Buffer.from(input.sessionHash) };
    return { status: 'activated' as const, userId: USER_ID, invitationId: INVITATION_ID };
  }) };
  const activationAudit = { kind: 'system' as const,
    appendSecurityEvent: jest.fn(async () => {}) } satisfies Extract<InvitationManagementAudit, { kind: 'system' }>;
  const audit = { write: jest.fn(async (_event: DurableAuditEvent) => {}) };
  const service = new GitHubEnrollmentOrchestrationService({ state, tokens, users, activation, activationAudit, audit });
  return { service, state, tokens, users, activation, activationAudit, audit, context, record,
    activationInput: () => activationInput };
}

function codeCallback() {
  return { kind: 'code' as const, state: RAW_STATE, code: CODE };
}

describe('GitHubEnrollmentOrchestrationService', () => {
  it('starts with a server correlation, audits before projecting only URL and expiry, and clears owned hashes', async () => {
    const f = fixture();
    const result = await f.service.start({ ownerHash: OWNER, sessionHash: SESSION });
    expect(result).toEqual({ authorizationUrl: AUTHORIZATION_URL, expiresAt: f.record.expiresAt });
    expect(Object.keys(result).sort()).toEqual(['authorizationUrl', 'expiresAt']);
    expect(f.state.begin).toHaveBeenCalledTimes(1);
    expect(f.state.begin.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.state.begin.mock.calls[0][0]).toEqual(Buffer.alloc(32));
    expect(f.state.begin.mock.calls[0][1]).toEqual(Buffer.alloc(32));
    expect(f.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'invitation.github_enrollment_started', actorId: USER_ID, targetId: INVITATION_ID,
      metadata: expect.objectContaining({ invitationId: INVITATION_ID, userId: USER_ID,
        claimAssertionId: CLAIM_ID, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    }));
    const serializedAudit = JSON.stringify(f.audit.write.mock.calls);
    for (const forbidden of [AUTHORIZATION_URL, RAW_STATE, OWNER.toString('hex'), SESSION.toString('base64url')]) {
      expect(serializedAudit).not.toContain(forbidden);
    }
  });

  it('does not release the authorization URL when the start audit is unavailable', async () => {
    const f = fixture();
    f.audit.write.mockRejectedValueOnce(new Error(AUTHORIZATION_URL));
    await expect(f.service.start({ ownerHash: OWNER, sessionHash: SESSION }))
      .rejects.toEqual(expect.objectContaining({ code: 'audit_unavailable', message: 'GitHub enrollment is unavailable' }));
    expect(f.state.begin).toHaveBeenCalledTimes(1);
  });

  it('consumes state before one token/profile/activation call and treats email/login only as unverified metadata', async () => {
    const f = fixture();
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .resolves.toEqual({ status: 'activated', userId: USER_ID, invitationId: INVITATION_ID });
    expect(f.state.consume).toHaveBeenCalledTimes(1);
    expect(f.tokens.exchangeCode).toHaveBeenCalledTimes(1);
    expect(f.tokens.exchangeCode).toHaveBeenCalledWith({ code: CODE, codeVerifier: VERIFIER });
    expect(f.users.fetchAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(f.users.fetchAuthenticatedUser).toHaveBeenCalledWith(TOKEN);
    expect(f.activation.activate).toHaveBeenCalledTimes(1);
    expect(f.activation.activate.mock.calls[0][1]).toBe(f.activationAudit);
    expect(f.activationInput()).toEqual(expect.objectContaining({
      invitationId: INVITATION_ID, generation: 3, claimAssertionId: CLAIM_ID,
      githubId: '9007199254740991', githubLogin: 'Renamed-User',
      providerEmail: 'different-private-profile@example.test', providerEmailVerified: false,
      correlationId: CORRELATION_ID, claimOwnerHash: OWNER, sessionHash: SESSION,
    }));
    expect(f.state.consume.mock.invocationCallOrder[0]).toBeLessThan(f.tokens.exchangeCode.mock.invocationCallOrder[0]);
    expect(f.tokens.exchangeCode.mock.invocationCallOrder[0]).toBeLessThan(f.users.fetchAuthenticatedUser.mock.invocationCallOrder[0]);
    expect(f.users.fetchAuthenticatedUser.mock.invocationCallOrder[0]).toBeLessThan(f.activation.activate.mock.invocationCallOrder[0]);
    expect(f.audit.write).not.toHaveBeenCalled(); // Success audit belongs to activation's transaction.
  });

  it('accepts a private GitHub profile with no public email without inventing verification', async () => {
    const f = fixture();
    f.users.fetchAuthenticatedUser.mockResolvedValueOnce({
      id: 42, externalSub: '42', login: 'private-user', displayName: null, email: null, avatarUrl: null,
    });
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .resolves.toMatchObject({ status: 'activated' });
    expect(f.activationInput()).toEqual(expect.objectContaining({
      githubId: '42', githubLogin: 'private-user', providerEmail: null, providerEmailVerified: false,
    }));
  });

  it('owns consumed state scalars before provider code can mutate its result object', async () => {
    const f = fixture();
    const changed = {
      userId: '55555555-5555-4555-8555-555555555555',
      invitationId: '66666666-6666-4666-8666-666666666666',
      generation: 4,
      claimAssertionId: '77777777-7777-4777-8777-777777777777',
      correlationId: '88888888-8888-4888-8888-888888888888',
      codeVerifier: 'x'.repeat(43),
    };
    f.tokens.exchangeCode.mockImplementationOnce(async () => {
      Object.assign(f.record, changed);
      return TOKEN;
    });
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .resolves.toEqual({ status: 'activated', userId: USER_ID, invitationId: INVITATION_ID });
    expect(f.tokens.exchangeCode).toHaveBeenCalledWith({ code: CODE, codeVerifier: VERIFIER });
    expect(f.activationInput()).toEqual(expect.objectContaining({
      invitationId: INVITATION_ID,
      generation: 3,
      claimAssertionId: CLAIM_ID,
      correlationId: CORRELATION_ID,
    }));
  });

  it('consumes a bound cancellation, audits a fixed reason, and never contacts provider or activation', async () => {
    const f = fixture();
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION,
      callback: { kind: 'provider_error', state: RAW_STATE, error: 'access_denied' } }))
      .resolves.toEqual({ status: 'cancelled' });
    expect(f.state.consume).toHaveBeenCalledTimes(1);
    expect(f.tokens.exchangeCode).not.toHaveBeenCalled();
    expect(f.users.fetchAuthenticatedUser).not.toHaveBeenCalled();
    expect(f.activation.activate).not.toHaveBeenCalled();
    expect(f.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'invitation.github_enrollment_cancelled',
      metadata: expect.objectContaining({ stage: 'callback', reason: 'user_cancelled' }),
    }));
  });

  it('maps other provider callback errors without retaining provider text or contacting GitHub', async () => {
    const f = fixture();
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION,
      callback: { kind: 'provider_error', state: RAW_STATE, error: 'other' } }))
      .rejects.toMatchObject({ code: 'provider_rejected' });
    expect(f.tokens.exchangeCode).not.toHaveBeenCalled();
    expect(f.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'invitation.github_enrollment_failed',
      metadata: expect.objectContaining({ stage: 'callback', reason: 'provider_error' }),
    }));
  });

  it('does not contact or audit a provider when state/session binding is unavailable', async () => {
    const f = fixture();
    f.state.consume.mockRejectedValueOnce(new Error(CODE));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: 'state_unavailable', message: 'GitHub enrollment is unavailable' });
    expect(f.tokens.exchangeCode).not.toHaveBeenCalled();
    expect(f.audit.write).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_request', 'provider_rejected'], ['rejected', 'provider_rejected'],
    ['response_too_large', 'provider_rejected'], ['invalid_response', 'provider_rejected'],
    ['unavailable', 'provider_unavailable'], ['timeout', 'provider_unavailable'],
  ] as const)('maps token error %s once to %s and requires a fresh start', async (source, expected) => {
    const f = fixture();
    f.tokens.exchangeCode.mockRejectedValueOnce(new GitHubOAuthTokenError(source));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: expected });
    expect(f.tokens.exchangeCode).toHaveBeenCalledTimes(1);
    expect(f.users.fetchAuthenticatedUser).not.toHaveBeenCalled();
    expect(f.activation.activate).not.toHaveBeenCalled();
    expect(f.audit.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unauthorized', false, 'provider_rejected'], ['response_too_large', false, 'provider_rejected'],
    ['invalid_response', false, 'provider_rejected'], ['rate_limited', true, 'provider_unavailable'],
    ['upstream_unavailable', true, 'provider_unavailable'], ['timeout', true, 'provider_unavailable'],
  ] as const)('maps identity error %s (retryable=%s) once to %s without activation', async (source, retryable, expected) => {
    const f = fixture();
    f.users.fetchAuthenticatedUser.mockRejectedValueOnce(new GitHubAuthenticatedUserError(source, retryable));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: expected });
    expect(f.tokens.exchangeCode).toHaveBeenCalledTimes(1);
    expect(f.users.fetchAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(f.activation.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['invitation_conflict', 'identity_conflict', 'invitation.github_enrollment_conflict'],
    ['invitation_invalid', 'activation_denied', 'invitation.github_enrollment_denied'],
    ['invitation_expired', 'activation_denied', 'invitation.github_enrollment_denied'],
    ['claim_owner_mismatch', 'activation_denied', 'invitation.github_enrollment_denied'],
    ['concurrent_update', 'activation_unavailable', 'invitation.github_enrollment_failed'],
    ['configuration_invalid', 'activation_unavailable', 'invitation.github_enrollment_failed'],
  ] as const)('maps activation error %s to %s with a sanitized audit', async (source, expected, event) => {
    const f = fixture();
    f.activation.activate.mockRejectedValueOnce(new InvitationError(source as InvitationErrorCode, CODE));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: expected, message: 'GitHub enrollment is unavailable' });
    expect(f.activation.activate).toHaveBeenCalledTimes(1);
    expect(f.audit.write).toHaveBeenCalledWith(expect.objectContaining({ eventType: event }));
    const serialized = JSON.stringify(f.audit.write.mock.calls);
    for (const forbidden of [AUTHORIZATION_URL, RAW_STATE, CODE, TOKEN, 'Renamed-User', 'different-private-profile@example.test',
      OWNER.toString('hex'), SESSION.toString('base64url')]) expect(serialized).not.toContain(forbidden);
  });

  it('masks a failure-audit outage without retrying provider work', async () => {
    const f = fixture();
    f.tokens.exchangeCode.mockRejectedValueOnce(new GitHubOAuthTokenError('timeout'));
    f.audit.write.mockRejectedValueOnce(new Error(TOKEN));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: 'audit_unavailable', message: 'GitHub enrollment is unavailable' });
    expect(f.tokens.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('classifies unexpected client failures conservatively as provider unavailable', async () => {
    const f = fixture();
    f.tokens.exchangeCode.mockRejectedValueOnce(new Error(CODE));
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback: codeCallback() }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(f.audit.write).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'invitation.github_enrollment_failed',
      metadata: expect.objectContaining({ stage: 'token_exchange', reason: 'upstream_unavailable' }),
    }));
  });

  it('rejects malformed internal callback unions before state consumption', async () => {
    const f = fixture();
    const callback = { ...codeCallback(), injected: TOKEN };
    await expect(f.service.complete({ ownerHash: OWNER, sessionHash: SESSION, callback }))
      .rejects.toBeInstanceOf(GitHubEnrollmentFlowError);
    expect(f.state.consume).not.toHaveBeenCalled();
  });
});

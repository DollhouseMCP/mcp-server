import { createHash } from 'node:crypto';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import {
  GITHUB_ENROLLMENT_PURPOSE, GitHubEnrollmentOAuthStateService, GitHubEnrollmentStateError,
  type GitHubEnrollmentStateRecord, type GitHubEnrollmentStateStore,
} from '../../../src/invitations/onboarding/GitHubEnrollmentOAuthState.js';

const CALLBACK = 'https://console.example.test/auth/onboarding/github/callback';
const STATE = Buffer.alloc(32, 7).toString('base64url');
const ownerHash = Buffer.alloc(32, 1);
const sessionHash = Buffer.alloc(32, 2);
const CORRELATION = '44444444-4444-4444-8444-444444444444';

class FixedOpaqueValues extends HmacConsoleOpaqueValueService {
  override createOpaqueValue(): string { return STATE; }
}

class MemoryStore implements GitHubEnrollmentStateStore {
  record: GitHubEnrollmentStateRecord | null = null;
  async replace(input: Pick<GitHubEnrollmentStateRecord,
    'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri' | 'correlationId'>) {
    this.record = { ...input, userId: '11111111-1111-4111-8111-111111111111',
      invitationId: '22222222-2222-4222-8222-222222222222', generation: 3,
      claimAssertionId: '33333333-3333-4333-8333-333333333333', purpose: GITHUB_ENROLLMENT_PURPOSE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: new Date('2026-01-01T00:05:00.000Z') };
    return this.record;
  }
  async consume(input: Pick<GitHubEnrollmentStateRecord, 'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri'>) {
    if (!this.record || !input.stateHash.equals(this.record.stateHash)
        || !input.ownerHash.equals(this.record.ownerHash) || !input.sessionHash.equals(this.record.sessionHash)
        || input.callbackUri !== this.record.callbackUri) return null;
    const result = this.record;
    this.record = null;
    return result;
  }
}

function fixture(callbackUri = CALLBACK) {
  const store = new MemoryStore();
  const opaque = new FixedOpaqueValues(Buffer.alloc(32, 9));
  return { store, opaque, service: new GitHubEnrollmentOAuthStateService(store, opaque, { clientId: 'Iv1_client-123', callbackUri }) };
}

describe('GitHub enrollment OAuth state', () => {
  it('builds the dedicated minimum-scope authorization request with S256 PKCE', async () => {
    const { service, store, opaque } = fixture();
    const result = await service.begin(ownerHash, sessionHash, CORRELATION);
    const url = new URL(result.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1_client-123', redirect_uri: CALLBACK, scope: 'read:user', state: STATE,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: 'S256',
    });
    const stateHash = opaque.hashOpaqueValue(`dollhouse/onboarding/github-state/v1\0${STATE}`);
    const verifier = opaque.hashOpaqueValue(`dollhouse/onboarding/github-pkce/v1\0${STATE}`).toString('base64url');
    expect(store.record?.stateHash).toEqual(stateHash);
    expect(result.context).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      invitationId: '22222222-2222-4222-8222-222222222222',
      generation: 3,
      claimAssertionId: '33333333-3333-4333-8333-333333333333',
      correlationId: CORRELATION,
    });
    expect(stateHash.toString('base64url')).not.toBe(verifier);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  });

  it('consumes once and releases the server-derived verifier with fixed context', async () => {
    const { service } = fixture();
    await service.begin(ownerHash, sessionHash, CORRELATION);
    const result = await service.consume(STATE, ownerHash, sessionHash);
    expect(result).toMatchObject({ purpose: 'link_login_identity', generation: 3, correlationId: CORRELATION,
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    await expect(service.consume(STATE, ownerHash, sessionHash)).rejects.toBeInstanceOf(GitHubEnrollmentStateError);
  });

  it('does not consume a valid record for wrong state, owner, or session', async () => {
    const { service, store } = fixture();
    await service.begin(ownerHash, sessionHash, CORRELATION);
    for (const input of [
      [Buffer.alloc(32, 8).toString('base64url'), ownerHash, sessionHash] as const,
      [STATE, Buffer.alloc(32, 4), sessionHash] as const,
      [STATE, ownerHash, Buffer.alloc(32, 5)] as const,
    ]) await expect(service.consume(...input)).rejects.toBeInstanceOf(GitHubEnrollmentStateError);
    expect(store.record).not.toBeNull();
    await expect(service.consume(STATE, ownerHash, sessionHash)).resolves.toMatchObject({ purpose: 'link_login_identity' });
  });

  it.each(['', 'not-state', `${STATE}=`, STATE.slice(1), 42])('rejects malformed callback state %p before store access', async value => {
    const { service, store } = fixture();
    await service.begin(ownerHash, sessionHash, CORRELATION);
    await expect(service.consume(value as string, ownerHash, sessionHash)).rejects.toBeInstanceOf(GitHubEnrollmentStateError);
    expect(store.record).not.toBeNull();
  });

  it.each(['', 'not-a-uuid', 42])('rejects invalid server correlation %p before creating state', async value => {
    const { service, store } = fixture();
    await expect(service.begin(ownerHash, sessionHash, value as string)).rejects.toBeInstanceOf(GitHubEnrollmentStateError);
    expect(store.record).toBeNull();
  });

  it.each([
    'http://console.example.test/auth/onboarding/github/callback',
    'https://user@console.example.test/auth/onboarding/github/callback',
    'https://console.example.test/auth/onboarding/github/callback?next=x',
    'https://console.example.test/auth/onboarding/github/callback#fragment',
    'https://console.example.test/auth/social/github/callback',
    'https://CONSOLE.example.test/auth/onboarding/github/callback',
    'https://console.example.test/auth/onboarding/github/callback/',
  ])('rejects noncanonical or non-enrollment callback %s', callbackUri => {
    expect(() => fixture(callbackUri)).toThrow('Invalid GitHub enrollment callback URI');
  });

  it.each([' client', 'client id', '', 'x'.repeat(257)])('rejects invalid client ID %p', clientId => {
    expect(() => new GitHubEnrollmentOAuthStateService(new MemoryStore(), new FixedOpaqueValues(Buffer.alloc(32, 9)),
      { clientId, callbackUri: CALLBACK })).toThrow('Invalid GitHub OAuth client ID');
  });
});

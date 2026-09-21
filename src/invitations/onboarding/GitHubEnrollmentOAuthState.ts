import { createHash } from 'node:crypto';
import type { IConsoleOpaqueValueService } from '../../web-console/security/ConsoleOpaqueValues.js';

export const GITHUB_ENROLLMENT_CALLBACK_PATH = '/auth/onboarding/github/callback';
export const GITHUB_ENROLLMENT_PURPOSE = 'link_login_identity';
export const GITHUB_ENROLLMENT_STATE_TTL_SECONDS = 5 * 60;

export interface GitHubEnrollmentStateRecord {
  readonly stateHash: Buffer;
  readonly ownerHash: Buffer;
  readonly sessionHash: Buffer;
  readonly userId: string;
  readonly invitationId: string;
  readonly generation: number;
  readonly claimAssertionId: string;
  readonly correlationId: string;
  readonly purpose: typeof GITHUB_ENROLLMENT_PURPOSE;
  readonly callbackUri: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type GitHubEnrollmentStateContext = Pick<GitHubEnrollmentStateRecord,
  'userId' | 'invitationId' | 'generation' | 'claimAssertionId' | 'correlationId'>;

export type GitHubEnrollmentConsumedState = GitHubEnrollmentStateContext &
  Pick<GitHubEnrollmentStateRecord, 'purpose' | 'callbackUri'> & {
    readonly codeVerifier: string;
  };

export interface GitHubEnrollmentAuthorization {
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
  /** Server-only audit/activation context. Never serialize this into the browser response. */
  readonly context: GitHubEnrollmentStateContext;
}

export interface GitHubEnrollmentStateStore {
  replace(input: Pick<GitHubEnrollmentStateRecord,
    'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri' | 'correlationId'>): Promise<GitHubEnrollmentStateRecord>;
  consume(input: Pick<GitHubEnrollmentStateRecord, 'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri'>): Promise<GitHubEnrollmentStateRecord | null>;
}

export class GitHubEnrollmentStateError extends Error {
  constructor() {
    super('GitHub enrollment state is unavailable');
    this.name = 'GitHubEnrollmentStateError';
  }
}

export class GitHubEnrollmentOAuthStateService {
  private readonly callbackUri: string;
  private readonly clientId: string;

  constructor(
    private readonly store: GitHubEnrollmentStateStore,
    private readonly opaqueValues: IConsoleOpaqueValueService,
    options: { readonly clientId: string; readonly callbackUri: string },
  ) {
    this.clientId = validateClientId(options.clientId);
    this.callbackUri = validateCallbackUri(options.callbackUri);
  }

  async begin(ownerHash: Buffer, sessionHash: Buffer, correlationId: string): Promise<GitHubEnrollmentAuthorization> {
    if (!isUuid(correlationId)) throw new GitHubEnrollmentStateError();
    const state = this.opaqueValues.createOpaqueValue();
    if (!isOpaqueState(state)) throw new GitHubEnrollmentStateError();
    const stateHash = this.hashState(state);
    const verifier = this.codeVerifier(state);
    let record: GitHubEnrollmentStateRecord;
    try {
      record = await this.store.replace({ stateHash, ownerHash, sessionHash, callbackUri: this.callbackUri, correlationId });
    } catch { throw new GitHubEnrollmentStateError(); }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUri,
      scope: 'read:user',
      state,
      code_challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.toString(), expiresAt: record.expiresAt, context: context(record) };
  }

  async consume(state: string, ownerHash: Buffer, sessionHash: Buffer): Promise<GitHubEnrollmentConsumedState> {
    if (!isOpaqueState(state)) throw new GitHubEnrollmentStateError();
    let record: GitHubEnrollmentStateRecord | null;
    try {
      record = await this.store.consume({ stateHash: this.hashState(state), ownerHash, sessionHash, callbackUri: this.callbackUri });
    } catch { throw new GitHubEnrollmentStateError(); }
    if (!record) throw new GitHubEnrollmentStateError();
    return {
      ...context(record),
      purpose: record.purpose,
      callbackUri: record.callbackUri,
      codeVerifier: this.codeVerifier(state),
    };
  }

  private hashState(state: string): Buffer {
    return this.opaqueValues.hashOpaqueValue(`dollhouse/onboarding/github-state/v1\0${state}`);
  }

  private codeVerifier(state: string): string {
    return this.opaqueValues.hashOpaqueValue(`dollhouse/onboarding/github-pkce/v1\0${state}`).toString('base64url');
  }
}

function context(record: GitHubEnrollmentStateRecord): GitHubEnrollmentStateContext {
  return {
    userId: record.userId,
    invitationId: record.invitationId,
    generation: record.generation,
    claimAssertionId: record.claimAssertionId,
    correlationId: record.correlationId,
  };
}

export function validateGitHubEnrollmentCallbackUri(value: string): string {
  return validateCallbackUri(value);
}

function validateCallbackUri(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid GitHub enrollment callback URI');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid GitHub enrollment callback URI'); }
  const canonical = `${parsed.origin}${GITHUB_ENROLLMENT_CALLBACK_PATH}`;
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== GITHUB_ENROLLMENT_CALLBACK_PATH || value !== canonical) {
    throw new Error('Invalid GitHub enrollment callback URI');
  }
  return canonical;
}

function validateClientId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid GitHub OAuth client ID');
  }
  return value;
}

function isOpaqueState(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

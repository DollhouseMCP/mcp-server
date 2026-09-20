import {
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from '../../web-console/modules/integrations/BoundedResponseReader.js';

export const GITHUB_AUTHENTICATED_USER_URL = 'https://api.github.com/user';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_LOGIN_LENGTH = 255;
const MAX_DISPLAY_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 254;
const MAX_AVATAR_URL_LENGTH = 2_048;

export type GitHubAuthenticatedUserErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_response';

/** A sanitized client failure. It deliberately carries no token, URL, response body, or cause. */
export class GitHubAuthenticatedUserError extends Error {
  constructor(
    readonly code: GitHubAuthenticatedUserErrorCode,
    readonly retryable: boolean,
  ) {
    super(errorMessage(code));
    this.name = 'GitHubAuthenticatedUserError';
  }
}

export interface GitHubAuthenticatedUser {
  /** GitHub's immutable numeric user ID, validated before conversion. */
  readonly id: number;
  /** Canonical base-10 representation of `id`; use this as the provider link key. */
  readonly externalSub: string;
  /** Mutable profile metadata. Never use as an account link key. */
  readonly login: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null;
}

export interface GitHubAuthenticatedUserClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Reads the identity for a transient GitHub access token.
 *
 * This primitive does not exchange or persist tokens, choose OAuth scopes,
 * fetch `/user/emails`, or link an identity to an account. Callers must use
 * `externalSub` as the durable key; every other returned field is mutable
 * display metadata.
 */
export class GitHubAuthenticatedUserClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GitHubAuthenticatedUserClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveSafeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
  }

  async fetchAuthenticatedUser(accessToken: string): Promise<GitHubAuthenticatedUser> {
    if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
      throw new GitHubAuthenticatedUserError('unauthorized', false);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(GITHUB_AUTHENTICATED_USER_URL, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'DollhouseMCP',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = isAbortError(error) ? 'timeout' : 'upstream_unavailable';
      throw new GitHubAuthenticatedUserError(code, true);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) {
        throw new GitHubAuthenticatedUserError('unauthorized', false);
      }
      if (response.status === 403 || response.status === 429) {
        throw new GitHubAuthenticatedUserError('rate_limited', true);
      }
      throw new GitHubAuthenticatedUserError('upstream_unavailable', response.status >= 500);
    }

    let text: string;
    try {
      text = await readBoundedResponseText(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new GitHubAuthenticatedUserError('response_too_large', false);
      }
      throw new GitHubAuthenticatedUserError('upstream_unavailable', true);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new GitHubAuthenticatedUserError('invalid_response', false);
    }
    return parseAuthenticatedUser(value);
  }
}

function parseAuthenticatedUser(value: unknown): GitHubAuthenticatedUser {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
  const id = value.id as number;
  const login = requiredString(value.login, MAX_LOGIN_LENGTH);
  const displayName = optionalMetadataString(value.name, MAX_DISPLAY_NAME_LENGTH);
  const email = optionalMetadataString(value.email, MAX_EMAIL_LENGTH);
  const avatarUrl = optionalAvatarUrl(value.avatar_url);
  return {
    id,
    externalSub: String(id),
    login,
    displayName,
    email,
    avatarUrl,
  };
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
  return value;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
  return value;
}

function optionalMetadataString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
  return trimmed;
}

function optionalAvatarUrl(value: unknown): string | null {
  const raw = optionalString(value, MAX_AVATAR_URL_LENGTH);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new GitHubAuthenticatedUserError('invalid_response', false);
    }
    return url.href;
  } catch (error) {
    if (error instanceof GitHubAuthenticatedUserError) throw error;
    throw new GitHubAuthenticatedUserError('invalid_response', false);
  }
}

function positiveSafeInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorMessage(code: GitHubAuthenticatedUserErrorCode): string {
  switch (code) {
    case 'unauthorized': return 'GitHub authentication was rejected.';
    case 'rate_limited': return 'GitHub identity lookup is temporarily rate limited.';
    case 'upstream_unavailable': return 'GitHub identity lookup is temporarily unavailable.';
    case 'timeout': return 'GitHub identity lookup timed out.';
    case 'response_too_large': return 'GitHub identity response exceeded the allowed size.';
    case 'invalid_response': return 'GitHub returned an invalid identity response.';
  }
}

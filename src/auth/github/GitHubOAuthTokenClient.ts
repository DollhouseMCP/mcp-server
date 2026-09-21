import { readBoundedResponseText, ResponseBodyTooLargeError } from '../../web-console/modules/integrations/BoundedResponseReader.js';

export const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export type GitHubOAuthTokenErrorCode = 'invalid_request' | 'rejected' | 'unavailable' | 'timeout' | 'response_too_large' | 'invalid_response';

/** Never retains provider text, credentials, callback URL, or an upstream cause. */
export class GitHubOAuthTokenError extends Error {
  // An ambiguous exchange may have consumed the code. Restart authorization;
  // never automatically retry the same code, even for a transport failure.
  readonly retryable = false;
  constructor(readonly code: GitHubOAuthTokenErrorCode) {
    super(`GitHub token exchange failed (${code}).`);
    this.name = 'GitHubOAuthTokenError';
  }
}

export interface GitHubOAuthTokenClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Fixed-endpoint, transient authorization-code exchange, optionally with S256 PKCE. */
export class GitHubOAuthTokenClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly callbackUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GitHubOAuthTokenClientOptions) {
    this.clientId = boundedField(options.clientId, 4096);
    this.clientSecret = boundedField(options.clientSecret, 4096);
    this.callbackUrl = validateCallback(options.callbackUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = boundedLimit(options.timeoutMs ?? 15_000, 60_000);
    this.maxResponseBytes = boundedLimit(options.maxResponseBytes ?? 64 * 1024, 1024 * 1024);
  }

  async exchangeCode(input: { readonly code: string; readonly codeVerifier?: string }): Promise<string> {
    const code = boundedField(input.code, 2048);
    const verifier = input.codeVerifier;
    if (verifier !== undefined && (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))) {
      throw new GitHubOAuthTokenError('invalid_request');
    }
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
      code, redirect_uri: this.callbackUrl });
    if (verifier !== undefined) body.set('code_verifier', verifier);
    let response: Response;
    try {
      response = await this.fetchImpl(GITHUB_OAUTH_TOKEN_URL, {
        method: 'POST', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) { throw transportError(error); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitHubOAuthTokenError(response.status >= 500 || response.status === 429 ? 'unavailable' : 'rejected');
    }
    let text: string;
    try { text = await readBoundedResponseText(response, this.maxResponseBytes); }
    catch (error) {
      if (error instanceof ResponseBodyTooLargeError) throw new GitHubOAuthTokenError('response_too_large');
      throw transportError(error);
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new GitHubOAuthTokenError('invalid_response'); }
    return tokenFromResponse(value);
  }
}

function tokenFromResponse(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubOAuthTokenError('invalid_response');
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'error')) throw new GitHubOAuthTokenError('rejected');
  if (typeof record.access_token !== 'string' || record.access_token.length > 4096
      || !/^[A-Za-z0-9._~+/-]+=*$/.test(record.access_token)
      || (record.token_type !== undefined && (typeof record.token_type !== 'string' || record.token_type.toLowerCase() !== 'bearer'))) {
    throw new GitHubOAuthTokenError('invalid_response');
  }
  // Project only the transient access token; discard scope/refresh tokens and
  // arbitrary provider fields. The caller re-fetches the authenticated identity.
  return record.access_token;
}

function boundedField(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\s\p{Cc}\p{Cf}]/u.test(value)) {
    throw new GitHubOAuthTokenError('invalid_request');
  }
  return value;
}

function validateCallback(value: string): string {
  boundedField(value, 4096);
  try {
    const url = new URL(value);
    // HTTP supports existing local development. Enrollment separately requires
    // the exact trusted HTTPS callback at its state/route boundary.
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return value;
  } catch { throw new GitHubOAuthTokenError('invalid_request'); }
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new GitHubOAuthTokenError('invalid_request');
  return value;
}

function transportError(error: unknown): GitHubOAuthTokenError {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  return new GitHubOAuthTokenError(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'unavailable');
}

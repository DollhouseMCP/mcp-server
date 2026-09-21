import { describe, expect, it, jest } from '@jest/globals';
import { GitHubOAuthTokenClient, GitHubOAuthTokenError } from '../../../../src/auth/github/GitHubOAuthTokenClient.js';

const settings = { clientId: 'client-id', clientSecret: 'private-client-secret', callbackUrl: 'https://console.example.test/auth/onboarding/github/callback' };
const request = { code: 'private-authorization-code', codeVerifier: 'v'.repeat(43) };
const json = (value: unknown) => new Response(JSON.stringify(value));

async function failure(promise: Promise<unknown>, code: GitHubOAuthTokenError['code']): Promise<void> {
  const error = await promise.then(() => { throw new Error('Expected failure'); }, value => value);
  expect(error).toBeInstanceOf(GitHubOAuthTokenError);
  expect(error).toMatchObject({ code, retryable: false });
  expect(error).not.toHaveProperty('cause');
  const rendered = JSON.stringify(error) + String(error);
  for (const secret of [settings.clientSecret, request.code, request.codeVerifier, 'upstream-secret', settings.callbackUrl]) {
    expect(rendered).not.toContain(secret);
  }
}

describe('GitHubOAuthTokenClient', () => {
  it('posts exact configuration and PKCE once, rejects redirects and returns only the access token', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'gho_token', token_type: 'bearer', refresh_token: 'discard-me' }));
    const mutable = { ...settings, fetchImpl };
    const client = new GitHubOAuthTokenClient(mutable);
    mutable.clientSecret = 'changed-after-construction';
    await expect(client.exchangeCode(request)).resolves.toBe('gho_token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      client_id: settings.clientId, client_secret: settings.clientSecret,
      redirect_uri: settings.callbackUrl, code: request.code, code_verifier: request.codeVerifier,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves ordinary sign-in exchanges without PKCE and case-insensitive bearer type', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'legacy-token', token_type: 'Bearer' }));
    await expect(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode({ code: 'code' })).resolves.toBe('legacy-token');
    expect((fetchImpl.mock.calls[0][1]?.body as URLSearchParams).has('code_verifier')).toBe(false);
  });

  it.each(['', ' ', 'short', 'v'.repeat(129), '!'.repeat(43)])('rejects malformed PKCE before network access (%s)', async codeVerifier => {
    const fetchImpl = jest.fn<typeof fetch>();
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode({ ...request, codeVerifier }), 'invalid_request');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { access_token: '' }, { access_token: 42 }, { access_token: 'a\r\nb' },
    { access_token: 't'.repeat(4097) }, { access_token: 'token', token_type: 'mac' }])('rejects malformed successful responses', async value => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(json(value));
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode(request), 'invalid_response');
  });

  it('rejects OAuth errors even when HTTP succeeds and a token is also present', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(json({ error: 'upstream-secret', error_description: request.code, access_token: 'must-not-escape' }));
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode(request), 'rejected');
  });

  it.each([[400, 'rejected'], [401, 'rejected'], [403, 'rejected'], [429, 'unavailable'], [503, 'unavailable']] as const)(
    'sanitizes HTTP %s and never retries a possibly consumed code', async (status, code) => {
      const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(new Response('upstream-secret', { status }));
      await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode(request), code);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

  it('sanitizes fetch and malformed-JSON failures', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValueOnce(new Error(`upstream-secret ${request.code}`))
      .mockResolvedValueOnce(new Response('upstream-secret not JSON'));
    const client = new GitHubOAuthTokenClient({ ...settings, fetchImpl });
    await failure(client.exchangeCode(request), 'unavailable');
    await failure(client.exchangeCode(request), 'invalid_response');
  });

  it('bounds streamed bodies without relying on Content-Length', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'x'.repeat(200) }));
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl, maxResponseBytes: 64 }).exchangeCode(request), 'response_too_large');
  });

  it('covers timeout while reading a successful response body', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true }); },
    })));
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl, timeoutMs: 5 }).exchangeCode(request), 'timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies an abort before response headers without retrying', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(new DOMException('upstream-secret', 'AbortError'));
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode(request), 'timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['', ' ', 'code\n', 'c'.repeat(2049)])('rejects invalid authorization codes before I/O', async code => {
    const fetchImpl = jest.fn<typeof fetch>();
    await failure(new GitHubOAuthTokenClient({ ...settings, fetchImpl }).exchangeCode({ code }), 'invalid_request');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ timeoutMs: 0 }, { maxResponseBytes: 1024 * 1024 + 1 }, { callbackUrl: 'https://user:password@example.test/callback' },
    { callbackUrl: 'https://example.test/callback#fragment' }, { clientSecret: 'secret\n' }])('rejects unsafe configuration without echoing values', patch => {
    expect(() => new GitHubOAuthTokenClient({ ...settings, ...patch })).toThrow(GitHubOAuthTokenError);
  });
});

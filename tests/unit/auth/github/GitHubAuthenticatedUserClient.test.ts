import { describe, expect, it, jest } from '@jest/globals';
import {
  GitHubAuthenticatedUserClient,
  GitHubAuthenticatedUserError,
} from '../../../../src/auth/github/GitHubAuthenticatedUserClient.js';

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function expectClientError(
  promise: Promise<unknown>,
  code: GitHubAuthenticatedUserError['code'],
  retryable: boolean,
): Promise<GitHubAuthenticatedUserError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubAuthenticatedUserError);
    const clientError = error as GitHubAuthenticatedUserError;
    expect(clientError.code).toBe(code);
    expect(clientError.retryable).toBe(retryable);
    return clientError;
  }
  throw new Error('Expected GitHubAuthenticatedUserError');
}

describe('GitHubAuthenticatedUserClient', () => {
  it('fetches only /user and projects immutable subject plus optional display metadata', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      id: 42,
      login: 'octocat',
      name: 'The Octocat',
      email: 'octocat@example.com',
      avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4',
      bio: 'must not escape the projection',
      company: 'GitHub',
    }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expect(client.fetchAuthenticatedUser('temporary-token')).resolves.toEqual({
      id: 42,
      externalSub: '42',
      login: 'octocat',
      displayName: 'The Octocat',
      email: 'octocat@example.com',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer temporary-token');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/vnd.github+json');
    expect(new Headers(init?.headers).get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(init?.body).toBeUndefined();
  });

  it('keeps the canonical subject stable when mutable username and email metadata change', async () => {
    const fetchImpl = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 42, login: 'old-login', name: null, email: 'old@example.com', avatar_url: null }))
      .mockResolvedValueOnce(jsonResponse({ id: 42, login: 'new-login', name: 'New Name', email: 'new@example.com', avatar_url: null }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    const before = await client.fetchAuthenticatedUser('first-token');
    const after = await client.fetchAuthenticatedUser('second-token');

    expect(before.externalSub).toBe('42');
    expect(after.externalSub).toBe('42');
    expect(after.login).toBe('new-login');
    expect(after.email).toBe('new@example.com');
  });

  it('accepts absent optional email, display name, and avatar metadata', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 7, login: 'seven' }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expect(client.fetchAuthenticatedUser('token')).resolves.toEqual({
      id: 7,
      externalSub: '7',
      login: 'seven',
      displayName: null,
      email: null,
      avatarUrl: null,
    });
  });

  it('treats empty optional profile strings as absent and trims display metadata', async () => {
    const fetchImpl = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 7, login: 'seven', name: '', email: '', avatar_url: null }))
      .mockResolvedValueOnce(jsonResponse({
        id: 7,
        login: 'seven',
        name: '  Seven Example  ',
        email: '  seven@example.com  ',
        avatar_url: null,
      }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expect(client.fetchAuthenticatedUser('token')).resolves.toMatchObject({
      displayName: null,
      email: null,
    });
    await expect(client.fetchAuthenticatedUser('token')).resolves.toMatchObject({
      displayName: 'Seven Example',
      email: 'seven@example.com',
    });
  });

  it('rejects a whitespace-only access token before making a request', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expectClientError(client.fetchAuthenticatedUser('   '), 'unauthorized', false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '42'],
  ])('rejects a %s GitHub id', async (_label, id) => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id, login: 'octocat' }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'invalid_response', false);
  });

  it.each([
    ['empty login', { id: 42, login: '' }],
    ['non-string login', { id: 42, login: 123 }],
    ['credentialed avatar URL', { id: 42, login: 'octocat', avatar_url: 'https://user:secret@example.com/avatar' }],
    ['non-HTTPS avatar URL', { id: 42, login: 'octocat', avatar_url: 'http://example.com/avatar' }],
    ['oversized email', { id: 42, login: 'octocat', email: `${'a'.repeat(250)}@x.io` }],
  ])('rejects invalid metadata: %s', async (_label, body) => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'invalid_response', false);
  });

  it.each([
    [401, 'unauthorized', false],
    [403, 'rate_limited', true],
    [429, 'rate_limited', true],
    [500, 'upstream_unavailable', true],
    [404, 'upstream_unavailable', false],
  ] as const)('maps HTTP %i to a sanitized %s error', async (status, code, retryable) => {
    const secret = 'token-that-must-not-leak';
    const upstreamBody = 'upstream-body-that-must-not-leak';
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(new Response(upstreamBody, { status }));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    const error = await expectClientError(client.fetchAuthenticatedUser(secret), code, retryable);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(upstreamBody);
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects a declared oversized response before parsing it', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { id: 42, login: 'octocat' },
      200,
      { 'content-length': '1024' },
    ));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl, maxResponseBytes: 128 });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'response_too_large', false);
  });

  it('rejects a streamed response that exceeds the byte cap without content-length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":42,"login":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(128)));
        controller.close();
      },
    });
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl, maxResponseBytes: 32 });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'response_too_large', false);
  });

  it('maps timeout and network failures without retaining their causes', async () => {
    const timeoutFetch = jest.fn<typeof fetch>().mockRejectedValue(
      new DOMException('token-in-upstream-timeout', 'TimeoutError'),
    );
    const networkFetch = jest.fn<typeof fetch>().mockRejectedValue(
      new Error('request to secret-url with secret-token failed'),
    );

    const timeout = await expectClientError(
      new GitHubAuthenticatedUserClient({ fetchImpl: timeoutFetch }).fetchAuthenticatedUser('secret-token'),
      'timeout',
      true,
    );
    const network = await expectClientError(
      new GitHubAuthenticatedUserClient({ fetchImpl: networkFetch }).fetchAuthenticatedUser('secret-token'),
      'upstream_unavailable',
      true,
    );
    expect(timeout).not.toHaveProperty('cause');
    expect(network).not.toHaveProperty('cause');
    expect(`${timeout.message} ${network.message}`).not.toContain('secret');
  });

  it('classifies a timeout while reading a successful response body', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation((_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return Promise.resolve(new Response(body));
    });
    const client = new GitHubAuthenticatedUserClient({ fetchImpl, timeoutMs: 1 });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'timeout', true);
  });

  it('rejects malformed JSON with a fixed invalid-response error', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(new Response('<html>failure</html>'));
    const client = new GitHubAuthenticatedUserClient({ fetchImpl });

    await expectClientError(client.fetchAuthenticatedUser('token'), 'invalid_response', false);
  });
});

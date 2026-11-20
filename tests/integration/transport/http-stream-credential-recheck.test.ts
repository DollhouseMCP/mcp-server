/** An open standalone stream closes once its credential stops being active. */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import type { AuthClaims } from '../../../src/auth/IAuthProvider.js';
import { logger } from '../../../src/utils/logger.js';
import { assertSseResponse, readHttpResponse } from '../../helpers/httpResponseAssertions.js';
import { createHttpTestEnvironment, type HttpTestEnvironment } from '../../helpers/httpTransportHelper.js';

const RECHECK_MS = 25;
const CLAIMS: Record<string, AuthClaims> = {
  first: { sub: 'stream-user', exp: Math.floor(Date.now() / 1000) + 3600, credentialBinding: { grantId: 'grant-one' } },
  second: { sub: 'stream-user', exp: Math.floor(Date.now() / 1000) + 3600, credentialBinding: { grantId: 'grant-two' } },
};
const revokedGrants = new Set<string>();
const checkedGrants: string[] = [];
let failChecks = false;
let env: HttpTestEnvironment;
let startupWarnings: string[] = [];
const DISABLED_WARNING = 'Stream credential rechecks are disabled';
let requestId = 0;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const headers = (token: string, sessionId?: string) => ({
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
});

async function initialize(token: string): Promise<string> {
  const response = await fetch(env.runtime.url, { method: 'POST', headers: headers(token), body: JSON.stringify({
    jsonrpc: '2.0', id: ++requestId, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'recheck-raw', version: '1' } },
  }) });
  await readHttpResponse(response, 200, 'MCP initialize', true);
  return response.headers.get('mcp-session-id')!;
}

async function openStream(token: string, sessionId: string) {
  const abort = new AbortController();
  const response = await fetch(env.runtime.url, { headers: { ...headers(token, sessionId), Accept: 'text/event-stream' }, signal: abort.signal });
  await assertSseResponse(response);
  const reader = response.body!.getReader();
  let ended = false;
  const drained = (async () => {
    try { for (;;) { if ((await reader.read()).done) break; } }
    catch { /* aborted by the test */ }
    ended = true;
  })();
  return { abort, drained, hasEnded: () => ended };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle');
    await wait(10);
  }
}

beforeAll(async () => {
  const warn = jest.spyOn(logger, 'warn');
  env = await createHttpTestEnvironment({
    streamKeepaliveMs: 20,
    streamCredentialRecheckMs: RECHECK_MS,
    isStreamCredentialActive: claims => {
      const grantId = claims.credentialBinding?.grantId ?? '';
      checkedGrants.push(grantId);
      return failChecks ? Promise.reject(new Error('storage unavailable')) : Promise.resolve(!revokedGrants.has(grantId));
    },
    authMiddleware: createUnifiedAuthMiddleware({ provider: { name: 'recheck-fixture', validate: value => Promise.resolve(
      CLAIMS[value] ? { ok: true, claims: CLAIMS[value] } : { ok: false, reason: 'unknown token' },
    ) } }),
  });
  startupWarnings = warn.mock.calls.map(call => String(call[0]));
  warn.mockRestore();
}, 30_000);

afterAll(async () => { await env?.cleanup(); });

describe('standalone stream credential recheck', () => {
  it('closes only the stream whose grant was revoked, and survives a failed check', async () => {
    const first = await openStream('first', await initialize('first'));
    const second = await openStream('second', await initialize('second'));
    try {
      // Both streams stay open across several rechecks while their grants are active.
      await until(() => checkedGrants.filter(grant => grant === 'grant-one').length >= 3
        && checkedGrants.filter(grant => grant === 'grant-two').length >= 3);
      expect(first.hasEnded()).toBe(false);
      expect(second.hasEnded()).toBe(false);

      // A check that cannot complete is not a revocation.
      failChecks = true;
      const seen = checkedGrants.length;
      await until(() => checkedGrants.length >= seen + 4);
      expect(first.hasEnded()).toBe(false);
      expect(second.hasEnded()).toBe(false);
      failChecks = false;

      revokedGrants.add('grant-one');
      await until(() => first.hasEnded());
      await wait(RECHECK_MS * 4);
      expect(second.hasEnded()).toBe(false);
    } finally {
      first.abort.abort();
      second.abort.abort();
      await Promise.all([first.drained, second.drained]);
    }
  }, 30_000);
});

describe('standalone stream credential recheck configuration', () => {
  it('starts quietly when rechecks are on', () => {
    expect(startupWarnings.filter(message => message.includes(DISABLED_WARNING))).toEqual([]);
  });

  it.each([
    ['warns at startup when a provider can answer but rechecks are disabled', true, 1],
    ['stays quiet when there is no provider to ask', false, 0],
  ] as const)('%s', async (_label, withProvider, expected) => {
    const warn = jest.spyOn(logger, 'warn');
    const disabled = await createHttpTestEnvironment({
      streamCredentialRecheckMs: 0,
      isStreamCredentialActive: withProvider ? () => Promise.resolve(true) : undefined,
    });
    try {
      expect(warn.mock.calls.filter(call => String(call[0]).includes(DISABLED_WARNING))).toHaveLength(expected);
    } finally {
      warn.mockRestore();
      await disabled.cleanup();
    }
  }, 30_000);
});

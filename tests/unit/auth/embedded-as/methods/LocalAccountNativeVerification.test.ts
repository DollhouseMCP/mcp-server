import { describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { LocalAccountMethod } from '../../../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InviteTokenStore } from '../../../../../src/auth/embedded-as/inviteTokens.js';
import { LocalLoginRateLimiter } from '../../../../../src/auth/embedded-as/rateLimit.js';
import { InMemoryRateLimitStore } from '../../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { CLIENT_PRIMARY } from '../../../../fixtures/test-ips.js';

const CTX = { interactionId: 'i', clientId: 'c', requestedScopes: [], requestUrl: '/interaction/i' };
const DENIED = { kind: 'denied', reason: 'invalid credentials' };
const PASSWORD = 'a-very-long-password';
const WRONG_PASSWORD = 'incorrect-password';
const EXPECTED_PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const storage = new InMemoryAuthStorageLayer();
  const invites = new InviteTokenStore(randomBytes(32), storage);
  const rateLimiter = new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' });
  const method = new LocalAccountMethod({ storage, invites, rateLimiter });
  const invite = new URL(method.issueInvite('local_alice', 'alice@example.com', 'https://app/i/x'))
    .searchParams.get('invite')!;
  const setup = await method.completeInteraction(CTX, {
    formBody: { action: 'set-password', invite, password: PASSWORD },
  });
  expect(setup.kind).toBe('authenticated');
  const account = await storage.getAccount('local_alice');
  if (!account?.credentials?.passwordHash) throw new Error('Missing fixture credential');
  // Boolean assertions avoid printing hashes/salts in hosted failure output.
  expect(EXPECTED_PHC.test(account.credentials.passwordHash)).toBe(true);
  expect(await storage.getAccount('local_nobody')).toBeNull();
  return { storage, method, account };
}

// Separate file/module registry from the uninstrumented wall-time test. These
// controls inspect the real native verifier; they do not manufacture its result
// or claim that equal work factors establish end-to-end timing parity.
describe('LocalAccountMethod native password verification', () => {
  it.each(['alice', 'nobody'])('awaits exactly one native verify with the configured PHC cost for %s', async (username) => {
    const { method, account } = await fixture();
    const nativeVerify = argon2.verify;
    const nativeFinished = deferred();
    const release = deferred();
    let nativeOutcome: boolean | undefined;
    let loginFinished = false;
    const verify = jest.spyOn(argon2, 'verify').mockImplementation(async (...args) => {
      nativeOutcome = await nativeVerify(...args);
      nativeFinished.resolve();
      // Delay only delivery of the REAL native result. This makes a missing
      // await observable without adding sleeps or replacing the crypto work.
      await release.promise;
      return nativeOutcome;
    });
    const login = method.completeInteraction(CTX, {
      formBody: { action: 'login', username, password: WRONG_PASSWORD }, ip: CLIENT_PRIMARY,
    }).then((result) => { loginFinished = true; return result; });
    try {
      await Promise.race([
        nativeFinished.promise,
        login.then(() => { throw new Error('Login returned before native verification completed'); }),
      ]);
      expect(loginFinished).toBe(false);
      expect(verify).toHaveBeenCalledTimes(1);
      const [digest, password] = verify.mock.calls[0];
      expect(EXPECTED_PHC.test(digest)).toBe(true);
      expect(password).toBe(WRONG_PASSWORD);
      expect(digest === account.credentials!.passwordHash).toBe(username === 'alice');
      expect(nativeOutcome).toBe(false);
      release.resolve();
      expect(await login).toEqual(DENIED);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      try {
        await login;
        // Even a broken consumer that fails to await verify cannot leave our
        // admitted native work/result-delivery gate pending after this case.
        await Promise.allSettled(verify.mock.results.map((result) => result.value));
      } finally {
        verify.mockRestore();
      }
    }
  });

  it('denies malformed stored PHC after the real verifier rejects it', async () => {
    const { storage, method, account } = await fixture();
    await storage.upsertAccount({ ...account, credentials: { passwordHash: 'not-a-phc' } });
    const verify = jest.spyOn(argon2, 'verify'); // Default spy calls the real native API.
    try {
      const result = await method.completeInteraction(CTX, {
        formBody: { action: 'login', username: 'alice', password: WRONG_PASSWORD }, ip: CLIENT_PRIMARY,
      });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0][0]).toBe('not-a-phc');
      await expect(verify.mock.results[0].value).rejects.toThrow();
      expect(result).toEqual(DENIED);
    } finally {
      verify.mockRestore();
    }
  });
});

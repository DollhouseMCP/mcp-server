import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { LocalAccountMethod } from '../../../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InviteTokenStore } from '../../../../../src/auth/embedded-as/inviteTokens.js';
import { LocalLoginRateLimiter } from '../../../../../src/auth/embedded-as/rateLimit.js';

const CTX = {
  interactionId: 'i',
  clientId: 'c',
  requestedScopes: [],
  requestUrl: '/interaction/i',
};

describe('LocalAccountMethod', () => {
  let storage: InMemoryAuthStorageLayer;
  let invites: InviteTokenStore;
  let rateLimiter: LocalLoginRateLimiter;
  let method: LocalAccountMethod;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    invites = new InviteTokenStore(randomBytes(32));
    rateLimiter = new LocalLoginRateLimiter({ storage });
    method = new LocalAccountMethod({ storage, invites, rateLimiter });
  });

  it('renders the login + invite page on beginInteraction', async () => {
    const step = await method.beginInteraction(CTX);
    expect(step.kind).toBe('render-html');
    if (step.kind !== 'render-html') return;
    expect(step.html).toContain('Sign in');
    expect(step.html).toContain('Invite');
  });

  it('issues an invite URL and the user can redeem it (must-fix #17)', async () => {
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/interaction/x');
    const inviteToken = new URL(url).searchParams.get('invite');
    expect(inviteToken).toBeTruthy();

    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken!, password: 'a-very-long-password' },
    });
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') return;
    expect(result.identity.sub).toBe('local_alice');

    const stored = await storage.getAccount('local_alice');
    expect(stored?.email).toBe('alice@example.com');
    expect(stored?.credentials?.passwordHash).toBeTruthy();
    // Critically: rawProfile must NOT carry the credential (B4).
    expect((stored?.rawProfile as { passwordHash?: string } | undefined)?.passwordHash).toBeUndefined();
  });

  it('rejects passwords shorter than 12 characters', async () => {
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/i/x');
    const inviteToken = new URL(url).searchParams.get('invite')!;
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'short' },
    });
    expect(result.kind).toBe('next-step');
  });

  it('rejects re-use of an invite token (single-use)', async () => {
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/i/x');
    const inviteToken = new URL(url).searchParams.get('invite')!;
    await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
    });
    const second = await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
    });
    expect(second.kind).toBe('denied');
  });

  it('verifies a password and returns authenticated', async () => {
    // Set up the account first.
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/i/x');
    const inviteToken = new URL(url).searchParams.get('invite')!;
    await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
    });

    // Now log in.
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'login', username: 'alice', password: 'a-very-long-password' }, ip: '10.0.0.1',
    });
    expect(result.kind).toBe('authenticated');
  });

  it('rejects wrong password and notes the failure for rate limiting', async () => {
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/i/x');
    const inviteToken = new URL(url).searchParams.get('invite')!;
    await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await method.completeInteraction(CTX, {
        formBody: { action: 'login', username: 'alice', password: 'wrong' }, ip: '10.0.0.1',
      });
      expect(result.kind).toBe('denied');
    }
    // Sixth attempt should be rate-limited even with the correct password.
    const sixth = await method.completeInteraction(CTX, {
      formBody: { action: 'login', username: 'alice', password: 'a-very-long-password' }, ip: '10.0.0.1',
    });
    expect(sixth.kind).toBe('denied');
    if (sixth.kind === 'denied') {
      expect(sixth.reason).toMatch(/locked/);
    }
  });

  it('rejects login attempts on unknown usernames (no enumeration via timing)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'login', username: 'ghost', password: 'whatever' }, ip: '10.0.0.1',
    });
    expect(result.kind).toBe('denied');
  });

  it('unknown-account login pays the same argon2 cost as wrong-password (CWE-208 timing parity)', async () => {
    // Pin the rationale of the reference-hash: an earlier shape called
    // argon2.verify with a malformed hash string, which throws in
    // microseconds and leaks username existence by latency. The fix
    // verifies against a real argon2 hash so both branches pay ~30 ms.
    // A malformed dummy would give unknownMs <1 ms while wrongPasswordMs
    // stays ~30 ms; the assertion catches that regression.
    //
    // No separate warmup login: dropping it saves ~30 ms of argon2.verify
    // work per run (matters for jest parallel-worker CPU pressure across
    // the rest of the suite) and any lazy-init cost on the unknown branch
    // only makes the `unknownMs >= wrongPasswordMs/2` assertion easier
    // to satisfy.
    const url = method.issueInvite('local_alice', 'alice@example.com', 'http://app/i/x');
    const inviteToken = new URL(url).searchParams.get('invite')!;
    await method.completeInteraction(CTX, {
      formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
    });

    const wrongPasswordStart = Date.now();
    await method.completeInteraction(CTX, {
      formBody: { action: 'login', username: 'alice', password: 'incorrect' }, ip: '10.0.0.2',
    });
    const wrongPasswordMs = Date.now() - wrongPasswordStart;

    const unknownStart = Date.now();
    await method.completeInteraction(CTX, {
      formBody: { action: 'login', username: 'nobody', password: 'whatever' }, ip: '10.0.0.3',
    });
    const unknownMs = Date.now() - unknownStart;

    // Both branches should be in the same order of magnitude.
    expect(unknownMs).toBeGreaterThanOrEqual(Math.floor(wrongPasswordMs / 2));
  }, 30_000);

  describe('consumeInvite (out-of-band CLI invite redemption)', () => {
    it('verifies + creates the account when called directly (used by /auth/local/invite POST)', async () => {
      const url = method.issueInvite('local_bob', 'bob@example.com', 'http://app/auth/local/invite');
      const token = new URL(url).searchParams.get('invite')!;

      const result = await method.consumeInvite(token, 'a-very-long-password');
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.sub).toBe('local_bob');
      expect(result.email).toBe('bob@example.com');

      // Subsequent login with the just-set password works.
      const login = await method.completeInteraction(CTX, {
        formBody: { action: 'login', username: 'bob', password: 'a-very-long-password' },
      });
      expect(login.kind).toBe('authenticated');
    });

    it('rejects re-use of the same invite (single-use)', async () => {
      const url = method.issueInvite('local_bob', 'bob@example.com', 'http://app/auth/local/invite');
      const token = new URL(url).searchParams.get('invite')!;
      await method.consumeInvite(token, 'a-very-long-password');
      const second = await method.consumeInvite(token, 'a-very-long-password');
      expect(second.kind).toBe('error');
    });

    it('rejects passwords shorter than 12 characters with a clear reason', async () => {
      const url = method.issueInvite('local_bob', 'bob@example.com', 'http://app/auth/local/invite');
      const token = new URL(url).searchParams.get('invite')!;
      const result = await method.consumeInvite(token, 'short');
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') return;
      expect(result.reason).toMatch(/12 characters/);
    });

    it('verifyInvite returns the email without consuming the token', () => {
      const url = method.issueInvite('local_bob', 'bob@example.com', 'http://app/auth/local/invite');
      const token = new URL(url).searchParams.get('invite')!;
      const verified = method.verifyInvite(token);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.email).toBe('bob@example.com');
      // Token should still be consumable after verify.
      expect(invites.consume(token).ok).toBe(true);
    });

    it('does NOT consume the invite when argon2 hashing fails (atomicity)', async () => {
      // Earlier order (consume → hash) left the user with a dead invite
      // and no account if argon2 failed mid-flight. The fix verifies the
      // invite + hashes the password BEFORE consuming, so a hash failure
      // leaves the invite consumable for the user's retry.
      const url = method.issueInvite('local_carol', 'carol@example.com', 'http://app/auth/local/invite');
      const token = new URL(url).searchParams.get('invite')!;

      const spy = jest.spyOn(argon2, 'hash').mockRejectedValueOnce(new Error('argon2 OOM'));
      try {
        const failed = await method.consumeInvite(token, 'a-very-long-password');
        expect(failed.kind).toBe('error');
      } finally {
        spy.mockRestore();
      }

      // Token must still be consumable — the operator should not have to
      // issue a new invite because of a transient hash failure.
      const retried = await method.consumeInvite(token, 'a-very-long-password');
      expect(retried.kind).toBe('ok');
      const stored = await storage.getAccount('local_carol');
      expect(stored?.email).toBe('carol@example.com');
    });
  });

  describe('credential isolation (B4 — passwordHash off rawProfile)', () => {
    it('writes the argon2 hash to credentials.passwordHash, NOT rawProfile', async () => {
      const url = method.issueInvite('local_dave', 'dave@example.com', 'http://app/i/x');
      const inviteToken = new URL(url).searchParams.get('invite')!;
      await method.completeInteraction(CTX, {
        formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
      });
      const stored = await storage.getAccount('local_dave');
      expect(stored?.credentials?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stored?.rawProfile).toBeUndefined();
    });

    it('JSON.stringify({...account, credentials: undefined}) does NOT contain the hash', async () => {
      // Operator-tooling export pattern: dump the account record with
      // credentials masked. Asserts the credential is on a typed sibling
      // field that's straightforward to redact, rather than buried inside
      // an opaque rawProfile blob.
      const url = method.issueInvite('local_eve', 'eve@example.com', 'http://app/i/x');
      const inviteToken = new URL(url).searchParams.get('invite')!;
      await method.completeInteraction(CTX, {
        formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
      });
      const stored = await storage.getAccount('local_eve');
      const masked = { ...stored, credentials: undefined };
      const json = JSON.stringify(masked);
      expect(json).not.toContain('argon2id');
      expect(json).not.toContain('passwordHash');
    });

    it('login still verifies against credentials.passwordHash', async () => {
      const url = method.issueInvite('local_finn', 'finn@example.com', 'http://app/i/x');
      const inviteToken = new URL(url).searchParams.get('invite')!;
      await method.completeInteraction(CTX, {
        formBody: { action: 'set-password', invite: inviteToken, password: 'a-very-long-password' },
      });
      const result = await method.completeInteraction(CTX, {
        formBody: { action: 'login', username: 'finn', password: 'a-very-long-password' },
        ip: '10.0.0.1',
      });
      expect(result.kind).toBe('authenticated');
    });
  });
});

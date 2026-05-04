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
    expect((stored?.rawProfile as { passwordHash?: string } | undefined)?.passwordHash).toBeTruthy();
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
});

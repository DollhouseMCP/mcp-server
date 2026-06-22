/**
 * TrivialConsentMethod unit tests
 *
 * Cycle-16: closes the coverage gap flagged by the test reviewer. The
 * class was exercised only indirectly through integration harnesses;
 * these tests pin the behaviors that future refactors must preserve.
 */

import { describe, it, expect } from '@jest/globals';
import { TrivialConsentMethod } from '../../../../../src/auth/embedded-as/methods/TrivialConsentMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import type {
  InteractionContext,
  InteractionInput,
} from '../../../../../src/auth/embedded-as/IAuthMethod.js';

const STUB_CTX: InteractionContext = {
  interactionId: 'iid-1',
  clientId: 'dollhouse-claude-connector',
  redirectUri: 'http://127.0.0.1:65000/callback',
  state: 'state-1',
  scopes: ['mcp'],
};

const STUB_INPUT: InteractionInput = {
  formBody: {},
  query: {},
  headers: {},
};

describe('TrivialConsentMethod', () => {
  describe('sub format', () => {
    it('prefixes the OS-derived externalSub with the local provider', () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      expect(method.sub).toBe('local_alice');
    });

    it('falls back to defaultLocalSubject() when no defaultSubject is supplied', () => {
      const method = new TrivialConsentMethod();
      // Format invariant: starts with `local_` and is non-empty.
      expect(method.sub).toMatch(/^local_.+/);
    });
  });

  describe('beginInteraction', () => {
    it('returns the consent HTML render step', async () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      const step = await method.beginInteraction(STUB_CTX);
      expect(step.kind).toBe('render-html');
      if (step.kind === 'render-html') {
        expect(step.html).toContain('Approve Connector');
        expect(step.html).toContain('Operator: alice');
      }
    });

    it('escapes the clientId in rendered HTML (XSS guard)', async () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      const ctx = { ...STUB_CTX, clientId: '<script>alert(1)</script>' };
      const step = await method.beginInteraction(ctx);
      if (step.kind === 'render-html') {
        expect(step.html).not.toContain('<script>alert(1)</script>');
        expect(step.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      }
    });
  });

  describe('completeInteraction', () => {
    it('returns the authenticated identity without storage', async () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      const result = await method.completeInteraction(STUB_CTX, STUB_INPUT);
      expect(result.kind).toBe('authenticated');
      if (result.kind === 'authenticated') {
        expect(result.identity.sub).toBe('local_alice');
        expect(result.identity.emailVerified).toBe(false);
      }
    });

    it('with storage: upserts the account row so auth_time can be emitted', async () => {
      const storage = new InMemoryAuthStorageLayer();
      const method = new TrivialConsentMethod({ defaultSubject: 'alice', storage });
      await method.completeInteraction(STUB_CTX, STUB_INPUT);
      const account = await storage.getAccount('local_alice');
      expect(account).not.toBeNull();
      expect(account?.provider).toBe('local');
      expect(account?.externalSub).toBe('alice');
      expect(account?.emailVerified).toBe(false);
    });

    it('with storage: subsequent completions preserve createdAt', async () => {
      const storage = new InMemoryAuthStorageLayer();
      const method = new TrivialConsentMethod({ defaultSubject: 'alice', storage });
      await method.completeInteraction(STUB_CTX, STUB_INPUT);
      const first = await storage.getAccount('local_alice');
      // Wait a tick so updatedAt diverges from createdAt.
      await new Promise((r) => setTimeout(r, 5));
      await method.completeInteraction(STUB_CTX, STUB_INPUT);
      const second = await storage.getAccount('local_alice');
      expect(second?.createdAt).toBe(first?.createdAt);
    });
  });

  describe('findAccount', () => {
    it('returns the identity for the method-owned sub', async () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      const identity = await method.findAccount('local_alice');
      expect(identity).not.toBeNull();
      expect(identity?.sub).toBe('local_alice');
    });

    it('returns null for a foreign sub (does not pretend to know other users)', async () => {
      const method = new TrivialConsentMethod({ defaultSubject: 'alice' });
      expect(await method.findAccount('local_bob')).toBeNull();
      expect(await method.findAccount('github_42')).toBeNull();
    });
  });
});

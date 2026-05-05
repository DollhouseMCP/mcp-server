import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  MagicLinkMethod,
  hashEmail,
  type EmailSender,
  type SendMagicLinkInput,
} from '../../../../../src/auth/embedded-as/methods/MagicLinkMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InviteTokenStore } from '../../../../../src/auth/embedded-as/inviteTokens.js';

class CollectingEmailSender implements EmailSender {
  sent: SendMagicLinkInput[] = [];
  shouldThrow = false;
  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    if (this.shouldThrow) throw new Error('smtp down');
    this.sent.push(input);
  }
}

const CTX = {
  interactionId: 'i',
  clientId: 'c',
  requestedScopes: [],
  requestUrl: '/interaction/i',
};

describe('MagicLinkMethod', () => {
  let storage: InMemoryAuthStorageLayer;
  let invites: InviteTokenStore;
  let emailSender: CollectingEmailSender;
  let method: MagicLinkMethod;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
    invites = new InviteTokenStore(randomBytes(32));
    emailSender = new CollectingEmailSender();
    method = new MagicLinkMethod({
      storage,
      invites,
      emailSender,
      verifyUrl: 'http://app/auth/email/verify',
    });
  });

  it('renders the request page on beginInteraction', async () => {
    const step = await method.beginInteraction(CTX);
    expect(step.kind).toBe('render-html');
    if (step.kind !== 'render-html') return;
    expect(step.html).toContain('Sign in');
    expect(step.html).toContain('email');
  });

  it('sends a magic link on request and returns the generic check-email page', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'alice@example.com' }, ip: '1.1.1.1',
    });
    expect(result.kind).toBe('next-step');
    if (result.kind !== 'next-step') return;
    if (result.step.kind !== 'render-html') return;
    expect(result.step.html).toContain('Check your email');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe('alice@example.com');
    expect(emailSender.sent[0].url).toContain('http://app/auth/email/verify?token=');
  });

  it('returns the same generic page even when SMTP throws (must-fix #2 enumeration prevention)', async () => {
    emailSender.shouldThrow = true;
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'unknown@example.com' }, ip: '1.1.1.1',
    });
    expect(result.kind).toBe('next-step');
    if (result.kind !== 'next-step') return;
    if (result.step.kind !== 'render-html') return;
    expect(result.step.html).toContain('Check your email');
  });

  it('rejects invalid email shape with the same generic page (no error leak)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'not-an-email' }, ip: '1.1.1.1',
    });
    expect(result.kind).toBe('next-step');
    expect(emailSender.sent).toHaveLength(0);
  });

  it('rate-limits per email after 3 requests in a minute (must-fix #3 from existing list)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await method.completeInteraction(CTX, {
        formBody: { action: 'request-link', email: 'alice@example.com' }, ip: `1.1.1.${i}`,
      });
    }
    expect(emailSender.sent.length).toBeLessThanOrEqual(3);
  });

  it('consumes the link via consumeMagicLink and authenticates with a verified email', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'alice@example.com' }, ip: '1.1.1.1',
    });
    const url = new URL(emailSender.sent[0].url);
    const token = url.searchParams.get('token')!;

    const consumed = await method.consumeMagicLink(token);
    expect(consumed.kind).toBe('ok');
    if (consumed.kind !== 'ok') return;
    expect(consumed.identity.email).toBe('alice@example.com');
    expect(consumed.identity.emailVerified).toBe(true);
  });

  it('rejects re-use of a magic-link token via consumeMagicLink (single-use, must-fix #1)', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'alice@example.com' }, ip: '1.1.1.1',
    });
    const token = new URL(emailSender.sent[0].url).searchParams.get('token')!;
    await method.consumeMagicLink(token);
    const replay = await method.consumeMagicLink(token);
    expect(replay.kind).toBe('error');
  });

  it('rejects unknown form actions on completeInteraction (consume-link path was removed in C9)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'consume-link', token: 'whatever' }, ip: '1.1.1.1',
    });
    expect(result.kind).toBe('denied');
  });

  it('renderConfirmationPage emits a POST form with the token (anti-pre-fetch GET)', () => {
    const html = method.renderConfirmationPage('test-token');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="test-token"');
    // The 'action' hidden input was removed in C9 — /auth/email/verify POST
    // calls consumeMagicLink directly; no form action dispatch is needed.
    expect(html).not.toContain('value="consume-link"');
  });

  describe('verifyMagicLink / consumeMagicLink (used by /auth/email/verify)', () => {
    async function issueViaInteraction(): Promise<string> {
      await method.completeInteraction(
        { interactionId: 'INTERACT-42', clientId: 'c', requestedScopes: [], requestUrl: '/' },
        { formBody: { action: 'request-link', email: 'eve@example.com' }, ip: '1.1.1.1' },
      );
      return new URL(emailSender.sent[0].url).searchParams.get('token')!;
    }

    it('verifyMagicLink returns the interactionId from the token payload', async () => {
      const token = await issueViaInteraction();
      const verified = method.verifyMagicLink(token);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.interactionId).toBe('INTERACT-42');
    });

    it('verifyMagicLink does NOT consume — anti-pre-fetch (must-fix #1)', async () => {
      const token = await issueViaInteraction();
      method.verifyMagicLink(token);
      method.verifyMagicLink(token);
      // Still consumable.
      const consumed = await method.consumeMagicLink(token);
      expect(consumed.kind).toBe('ok');
    });

    it('consumeMagicLink returns the interactionId so the route can complete the OAuth flow', async () => {
      const token = await issueViaInteraction();
      const consumed = await method.consumeMagicLink(token);
      expect(consumed.kind).toBe('ok');
      if (consumed.kind !== 'ok') return;
      expect(consumed.interactionId).toBe('INTERACT-42');
      expect(consumed.identity.emailVerified).toBe(true);
    });

    it('consumeMagicLink rejects already-consumed tokens', async () => {
      const token = await issueViaInteraction();
      await method.consumeMagicLink(token);
      const replay = await method.consumeMagicLink(token);
      expect(replay.kind).toBe('error');
    });
  });

  describe('hashEmail (must-fix #18 — opaque, irreversible externalSub)', () => {
    it('produces a 43-char base64url string (32-byte SHA-256)', () => {
      const hash = hashEmail('alice@example.com');
      expect(hash).toHaveLength(43);
      expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is irreversible — base64url-decoding does not yield the email', () => {
      const email = 'alice@example.com';
      const hash = hashEmail(email);
      expect(Buffer.from(hash, 'base64url').toString('utf8')).not.toContain(email);
      expect(Buffer.from(hash, 'base64url').toString('utf8')).not.toContain('alice');
    });

    it('is deterministic — same email always hashes to the same value', () => {
      expect(hashEmail('alice@example.com')).toBe(hashEmail('alice@example.com'));
    });

    it('normalizes case — Alice@Example.com and alice@example.com share a sub', () => {
      expect(hashEmail('Alice@Example.com')).toBe(hashEmail('alice@example.com'));
    });

    it('normalizes whitespace — leading/trailing trim applied', () => {
      expect(hashEmail('  alice@example.com  ')).toBe(hashEmail('alice@example.com'));
    });

    it('emails with shared 24-byte prefixes do NOT collide', () => {
      // Earlier reversible-truncation implementation collapsed any two emails
      // sharing the first 24 bytes onto the same sub. SHA-256 doesn't.
      const a = hashEmail('alice.somebody.long-tag-1@biglongcorp.example.com');
      const b = hashEmail('alice.somebody.long-tag-2@biglongcorp.example.com');
      expect(a).not.toBe(b);
    });

    it('different emails produce different hashes', () => {
      expect(hashEmail('alice@example.com')).not.toBe(hashEmail('bob@example.com'));
    });
  });
});

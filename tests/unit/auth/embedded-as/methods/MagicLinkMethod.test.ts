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
import {
  CLIENT_PRIMARY,
  CLIENT_SECONDARY,
  CLIENT_TERTIARY,
  CLIENT_ATTACKER,
  CLIENT_GENERIC,
} from '../../../../fixtures/test-ips.js';

const ALICE_EMAIL = 'alice@example.com';
const REQUEST_LINK_ACTION = 'request-link';
const RENDER_HTML_STEP = 'render-html';

async function issueViaInteraction(
  method: MagicLinkMethod,
  emailSender: CollectingEmailSender,
): Promise<string> {
  await method.completeInteraction(
    { interactionId: 'INTERACT-42', clientId: 'c', requestedScopes: [], requestUrl: '/' },
    { formBody: { action: REQUEST_LINK_ACTION, email: 'eve@example.com' }, ip: CLIENT_GENERIC },
  );
  return new URL(emailSender.sent[0].url).searchParams.get('token')!;
}

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
    invites = new InviteTokenStore(randomBytes(32), storage);
    emailSender = new CollectingEmailSender();
    method = new MagicLinkMethod({
      storage,
      invites,
      emailSender,
      verifyUrl: 'http://app/auth/email/verify', // NOSONAR — opaque test base URL
      // Default suite uses 0ms floor for speed; the dedicated timing test
      // below builds its own MagicLinkMethod with the production default.
      requestResponseFloorMs: 0,
    });
  });

  it('renders the request page on beginInteraction', async () => {
    const step = await method.beginInteraction(CTX);
    expect(step.kind).toBe(RENDER_HTML_STEP);
    if (step.kind !== RENDER_HTML_STEP) return;
    expect(step.html).toContain('Sign in');
    expect(step.html).toContain('email');
  });

  it('sends a magic link on request and returns the generic check-email page', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: REQUEST_LINK_ACTION, email: ALICE_EMAIL }, ip: CLIENT_GENERIC,
    });
    expect(result.kind).toBe('next-step');
    if (result.kind !== 'next-step') return;
    if (result.step.kind !== RENDER_HTML_STEP) return;
    expect(result.step.html).toContain('Check your email');

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe(ALICE_EMAIL);
    expect(emailSender.sent[0].url).toContain('http://app/auth/email/verify?token='); // NOSONAR — assertion against opaque test fixture URL
  });

  it('returns the same generic page even when SMTP throws (must-fix #2 enumeration prevention)', async () => {
    emailSender.shouldThrow = true;
    const result = await method.completeInteraction(CTX, {
      formBody: { action: REQUEST_LINK_ACTION, email: 'unknown@example.com' }, ip: CLIENT_GENERIC,
    });
    expect(result.kind).toBe('next-step');
    if (result.kind !== 'next-step') return;
    if (result.step.kind !== RENDER_HTML_STEP) return;
    expect(result.step.html).toContain('Check your email');
  });

  it('rejects invalid email shape with the same generic page (no error leak)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: REQUEST_LINK_ACTION, email: 'not-an-email' }, ip: CLIENT_GENERIC,
    });
    expect(result.kind).toBe('next-step');
    expect(emailSender.sent).toHaveLength(0);
  });

  it('rate-limits per email after 3 requests in a minute (must-fix #3 from existing list)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await method.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: ALICE_EMAIL }, ip: `1.1.1.${i}`,
      });
    }
    expect(emailSender.sent.length).toBeLessThanOrEqual(3);
  });

  it('consumes the link via consumeMagicLink and authenticates with a verified email', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: REQUEST_LINK_ACTION, email: ALICE_EMAIL }, ip: CLIENT_GENERIC,
    });
    const url = new URL(emailSender.sent[0].url);
    const token = url.searchParams.get('token')!;

    const consumed = await method.consumeMagicLink(token);
    expect(consumed.kind).toBe('ok');
    if (consumed.kind !== 'ok') return;
    expect(consumed.identity.email).toBe(ALICE_EMAIL);
    expect(consumed.identity.emailVerified).toBe(true);
  });

  it('rejects re-use of a magic-link token via consumeMagicLink (single-use, must-fix #1)', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: REQUEST_LINK_ACTION, email: ALICE_EMAIL }, ip: CLIENT_GENERIC,
    });
    const token = new URL(emailSender.sent[0].url).searchParams.get('token')!;
    await method.consumeMagicLink(token);
    const replay = await method.consumeMagicLink(token);
    expect(replay.kind).toBe('error');
  });

  it('rejects unknown form actions on completeInteraction (consume-link path was removed in C9)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'consume-link', token: 'whatever' }, ip: CLIENT_GENERIC,
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
    it('verifyMagicLink returns the interactionId from the token payload', async () => {
      const token = await issueViaInteraction(method, emailSender);
      const verified = method.verifyMagicLink(token);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.interactionId).toBe('INTERACT-42');
    });

    it('verifyMagicLink does NOT consume — anti-pre-fetch (must-fix #1)', async () => {
      const token = await issueViaInteraction(method, emailSender);
      method.verifyMagicLink(token);
      method.verifyMagicLink(token);
      // Still consumable.
      const consumed = await method.consumeMagicLink(token);
      expect(consumed.kind).toBe('ok');
    });

    it('consumeMagicLink returns the interactionId so the route can complete the OAuth flow', async () => {
      const token = await issueViaInteraction(method, emailSender);
      const consumed = await method.consumeMagicLink(token);
      expect(consumed.kind).toBe('ok');
      if (consumed.kind !== 'ok') return;
      expect(consumed.interactionId).toBe('INTERACT-42');
      expect(consumed.identity.emailVerified).toBe(true);
    });

    it('consumeMagicLink rejects already-consumed tokens', async () => {
      const token = await issueViaInteraction(method, emailSender);
      await method.consumeMagicLink(token);
      const replay = await method.consumeMagicLink(token);
      expect(replay.kind).toBe('error');
    });
  });

  describe('handleRequestLink — must-fix #2 + #3', () => {
    it('always returns the same generic check-email page (no enumeration)', async () => {
      const known = await method.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: 'known@example.com' },
        ip: CLIENT_PRIMARY,
      });
      const unknown = await method.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: 'unknown@example.com' },
        ip: CLIENT_SECONDARY,
      });
      const malformed = await method.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: 'not-an-email' },
        ip: CLIENT_TERTIARY,
      });
      // All three must produce the identical generic check-email response.
      const responses = [known, unknown, malformed].map((r) =>
        r.kind === 'next-step' && r.step.kind === RENDER_HTML_STEP ? r.step.html : 'NOT-HTML',
      );
      expect(new Set(responses).size).toBe(1);
      expect(responses[0]).toContain('Check your email');
    });

    it('response time is padded to a floor regardless of state (must-fix #2)', async () => {
      // Build a dedicated method with a small but observable floor so
      // the assertion isn't sensitive to scheduler jitter. Production
      // floor is 250ms; 100ms here is plenty of signal for the test
      // without slowing CI.
      const timingMethod = new MagicLinkMethod({
        storage,
        invites,
        emailSender,
        verifyUrl: 'http://app/auth/email/verify', // NOSONAR — opaque test base URL
        requestResponseFloorMs: 100,
      });

      const t0 = Date.now();
      await timingMethod.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: 'malformed' },
        ip: CLIENT_PRIMARY,
      });
      const elapsedMalformed = Date.now() - t0;

      const t1 = Date.now();
      await timingMethod.completeInteraction(CTX, {
        formBody: { action: REQUEST_LINK_ACTION, email: 'real@example.com' },
        ip: CLIENT_PRIMARY,
      });
      const elapsedReal = Date.now() - t1;

      expect(elapsedMalformed).toBeGreaterThanOrEqual(80);
      expect(elapsedReal).toBeGreaterThanOrEqual(80);
    }, 5_000);

    it('emits auth.magic_link.flood_suspected audit on first per-email threshold cross', async () => {
      for (let i = 0; i < 3 + 1; i += 1) {
        await method.completeInteraction(CTX, {
          formBody: { action: REQUEST_LINK_ACTION, email: 'flood@example.com' },
          ip: `10.0.0.${i}`,
        });
      }
      const events = await storage.listIdentityEvents({ type: 'auth.magic_link.flood_suspected' });
      const emailEvents = events.filter(
        (e) => e.details?.dimension === 'email',
      );
      expect(emailEvents).toHaveLength(1);
    }, 30_000);

    it('emits at most ONE audit event per window despite continued flood', async () => {
      for (let i = 0; i < 3 + 5; i += 1) {
        await method.completeInteraction(CTX, {
          formBody: { action: REQUEST_LINK_ACTION, email: 'flood@example.com' },
          ip: `10.0.0.${i}`,
        });
      }
      const events = await storage.listIdentityEvents({ type: 'auth.magic_link.flood_suspected' });
      const emailEvents = events.filter(
        (e) => e.details?.dimension === 'email',
      );
      expect(emailEvents).toHaveLength(1);
    }, 30_000);

    it('emits per-IP audit independently of per-email audit', async () => {
      for (let i = 0; i < 5 + 1; i += 1) {
        await method.completeInteraction(CTX, {
          formBody: { action: REQUEST_LINK_ACTION, email: `user${i}@example.com` },
          ip: CLIENT_ATTACKER,
        });
      }
      const events = await storage.listIdentityEvents({ type: 'auth.magic_link.flood_suspected' });
      const ipEvents = events.filter(
        (e) => e.details?.dimension === 'ip',
      );
      expect(ipEvents).toHaveLength(1);
    }, 30_000);
  });

  describe('hashEmail (must-fix #18 — opaque, irreversible externalSub)', () => {
    it('produces a 43-char base64url string (32-byte SHA-256)', () => {
      const hash = hashEmail(ALICE_EMAIL);
      expect(hash).toHaveLength(43);
      expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is irreversible — base64url-decoding does not yield the email', () => {
      const email = ALICE_EMAIL;
      const hash = hashEmail(email);
      expect(Buffer.from(hash, 'base64url').toString('utf8')).not.toContain(email);
      expect(Buffer.from(hash, 'base64url').toString('utf8')).not.toContain('alice');
    });

    it('is deterministic — same email always hashes to the same value', () => {
      expect(hashEmail(ALICE_EMAIL)).toBe(hashEmail(ALICE_EMAIL));
    });

    it('normalizes case — Alice@Example.com and alice@example.com share a sub', () => {
      expect(hashEmail('Alice@Example.com')).toBe(hashEmail(ALICE_EMAIL));
    });

    it('normalizes whitespace — leading/trailing trim applied', () => {
      expect(hashEmail('  alice@example.com  ')).toBe(hashEmail(ALICE_EMAIL));
    });

    it('emails with shared 24-byte prefixes do NOT collide', () => {
      // Earlier reversible-truncation implementation collapsed any two emails
      // sharing the first 24 bytes onto the same sub. SHA-256 doesn't.
      const a = hashEmail('alice.somebody.long-tag-1@biglongcorp.example.com');
      const b = hashEmail('alice.somebody.long-tag-2@biglongcorp.example.com');
      expect(a).not.toBe(b);
    });

    it('different emails produce different hashes', () => {
      expect(hashEmail(ALICE_EMAIL)).not.toBe(hashEmail('bob@example.com'));
    });
  });
});

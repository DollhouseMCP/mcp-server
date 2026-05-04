import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  MagicLinkMethod,
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
      formBody: { action: 'request-link', email: 'alice@example.com', __ip: '1.1.1.1' },
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
      formBody: { action: 'request-link', email: 'unknown@example.com', __ip: '1.1.1.1' },
    });
    expect(result.kind).toBe('next-step');
    if (result.kind !== 'next-step') return;
    if (result.step.kind !== 'render-html') return;
    expect(result.step.html).toContain('Check your email');
  });

  it('rejects invalid email shape with the same generic page (no error leak)', async () => {
    const result = await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'not-an-email', __ip: '1.1.1.1' },
    });
    expect(result.kind).toBe('next-step');
    expect(emailSender.sent).toHaveLength(0);
  });

  it('rate-limits per email after 3 requests in a minute (must-fix #3 from existing list)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await method.completeInteraction(CTX, {
        formBody: { action: 'request-link', email: 'alice@example.com', __ip: `1.1.1.${i}` },
      });
    }
    expect(emailSender.sent.length).toBeLessThanOrEqual(3);
  });

  it('consumes the link on POST and authenticates with a verified email', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'alice@example.com', __ip: '1.1.1.1' },
    });
    const url = new URL(emailSender.sent[0].url);
    const token = url.searchParams.get('token')!;

    const consumed = await method.completeInteraction(CTX, {
      formBody: { action: 'consume-link', token },
    });
    expect(consumed.kind).toBe('authenticated');
    if (consumed.kind !== 'authenticated') return;
    expect(consumed.identity.email).toBe('alice@example.com');
    expect(consumed.identity.emailVerified).toBe(true);
  });

  it('rejects re-use of a magic-link token (single-use, must-fix #1)', async () => {
    await method.completeInteraction(CTX, {
      formBody: { action: 'request-link', email: 'alice@example.com', __ip: '1.1.1.1' },
    });
    const token = new URL(emailSender.sent[0].url).searchParams.get('token')!;
    await method.completeInteraction(CTX, { formBody: { action: 'consume-link', token } });
    const replay = await method.completeInteraction(CTX, { formBody: { action: 'consume-link', token } });
    expect(replay.kind).toBe('denied');
  });

  it('renderConfirmationPage emits a POST form with the token (anti-pre-fetch GET)', () => {
    const html = method.renderConfirmationPage('test-token');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="test-token"');
    expect(html).toContain('value="consume-link"');
  });
});

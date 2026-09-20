import { sanitizeDeliveryResult, validateDeliveryProvider } from '../../../src/invitations/InvitationDeliveryMetadata.js';

const result = { state: 'submitted' as const };

describe('invitation delivery metadata boundary', () => {
  it('copies only bounded numeric/boolean diagnostics and an opaque provider ID', () => {
    const detail = { durationMs: 43, smtpStatus: 250, providerAccepted: true };
    const clean = sanitizeDeliveryResult({ ...result, providerMessageId: '<abc@example.test>', sanitizedDetail: detail });
    detail.durationMs = 999;
    expect(clean).toEqual({ ...result, providerMessageId: '<abc@example.test>', failureClass: null,
      sanitizedDetail: { durationMs: 43, smtpStatus: 250, providerAccepted: true } });
  });

  it.each([
    { error: 'SMTP password=secret' },
    { url: 'https://example.test/invite?token=secret' },
    { nested: { credential: 'secret' } },
    { smtpStatus: '250 password=secret' },
    { smtpStatus: 600 },
    { durationMs: -1 },
    { durationMs: 86_400_001 },
    { durationMs: Number.NaN },
    { providerAccepted: 'true' },
  ])('rejects unapproved metadata %j', sanitizedDetail => {
    expect(() => sanitizeDeliveryResult({ ...result, sanitizedDetail })).toThrow('Invalid invitation delivery metadata');
  });

  it.each(['https://example.test/?token=secret', 'id\npassword=secret', 'x'.repeat(256)])('rejects unsafe provider message IDs', providerMessageId => {
    expect(() => sanitizeDeliveryResult({ ...result, providerMessageId })).toThrow();
  });

  it('does not classify ambiguous outcomes as confirmed failure or acceptance', () => {
    expect(() => sanitizeDeliveryResult({ state: 'failed', failureClass: 'timeout' })).toThrow();
    expect(() => sanitizeDeliveryResult({ state: 'submitted', failureClass: 'not_sent' })).toThrow();
    expect(() => sanitizeDeliveryResult({ state: 'unknown', failureClass: 'unknown', sanitizedDetail: { providerAccepted: false } })).toThrow();
    expect(sanitizeDeliveryResult({ state: 'unknown', failureClass: 'timeout' }).state).toBe('unknown');
    expect(sanitizeDeliveryResult({ state: 'failed', failureClass: 'not_sent' }).state).toBe('failed');
  });

  it.each(['smtp\nsecret', 'https://smtp.example.test', 'x'.repeat(33)])('rejects invalid provider identifiers', provider => {
    expect(() => validateDeliveryProvider(provider)).toThrow();
  });
});

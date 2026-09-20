import {
  buildInvitationClaimLink, invitationPublicOrigin, INVITATION_CLAIM_PATH,
} from '../../../src/invitations/InvitationClaimLink.js';
import { generateInvitationToken } from '../../../src/invitations/InvitationToken.js';
import {
  renderInvitationEmail, INVITATION_EMAIL_SUBJECT, type InvitationEmailTemplateInput,
} from '../../../src/invitations/InvitationEmailTemplate.js';

const credential = generateInvitationToken('74a7063c-2b2a-4b77-a16e-77b9bf49288b', 2, size => Buffer.alloc(size, 7)).token;
const fixture = (overrides: Partial<InvitationEmailTemplateInput> = {}): InvitationEmailTemplateInput => ({
  publicBaseUrl: 'https://beta.example.test', credential, recipientName: 'Morgan',
  intendedAccess: [{ name: 'Account administrator', description: 'Manage people and account settings.' }],
  issuedAt: new Date('2026-09-20T16:30:00Z'), expiresAt: new Date('2026-09-21T16:30:00Z'),
  supportEmail: 'help@example.test', ...overrides,
});

describe('trusted invitation claim links', () => {
  it('keeps the secret in a fragment outside the HTTP request target', () => {
    const link = new URL(buildInvitationClaimLink('https://beta.example.test/', credential));
    expect(link.origin).toBe('https://beta.example.test');
    expect(link.pathname).toBe(INVITATION_CLAIM_PATH);
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe(credential);
    expect(`${link.origin}${link.pathname}${link.search}`).not.toContain(credential);
  });

  it('canonicalizes an explicitly configured HTTPS origin without accepting a redirect path', () => {
    expect(invitationPublicOrigin('https://BETA.example.test:443/')).toBe('https://beta.example.test');
    expect(invitationPublicOrigin('https://beta.example.test:8443')).toBe('https://beta.example.test:8443');
  });

  it.each([
    'http://beta.example.test', '//beta.example.test', 'javascript:alert(1)',
    'https://user:password@beta.example.test', 'https://@beta.example.test',
    'https://beta.example.test/path', 'https://beta.example.test/../', 'https://beta.example.test/%2e',
    'https://beta.example.test?redirect=https://evil.test', 'https://beta.example.test/#secret',
    'https://beta.example.test/?', 'https://beta.example.test/#',
    'https://beta.example.test\\@evil.test', ' https://beta.example.test',
    'https://beta.example.test\n', 'https://%62eta.example.test',
    'https://beta.example.test:65536', '',
  ])('rejects unsafe configured base %j without echoing it', base => {
    expect(() => buildInvitationClaimLink(base, credential)).toThrow('Invitation public base URL must be a trusted HTTPS origin');
    try { buildInvitationClaimLink(base, credential); } catch (error) {
      expect((error as Error).message).not.toContain(credential);
      expect((error as Error).message).not.toContain('password@');
    }
  });

  it.each(['', 'token&redirect=https://evil.test', credential + '#x', credential.replace('dhi1.', 'other.')])('rejects malformed credentials', token => {
    expect(() => buildInvitationClaimLink('https://beta.example.test', token)).toThrow('invalid invitation credential');
  });
});

describe('private-beta invitation email', () => {
  it('renders multipart content with a fixed subject, one primary action and persisted expiration', () => {
    const email = renderInvitationEmail(fixture());
    expect(Object.keys(email).sort()).toEqual(['html', 'subject', 'text']);
    expect(email.subject).toBe(INVITATION_EMAIL_SUBJECT);
    expect(email.subject).not.toContain(credential);
    for (const body of [email.text, email.html]) {
      expect(body).toContain('DollhouseMCP private beta');
      expect(body).toContain('Hello Morgan,');
      expect(body).toContain('A GitHub account is required');
      expect(body).toContain('No Dollhouse password will be created');
      expect(body).toContain('Account administrator');
      expect(body).toContain('Manage people and account settings.');
      expect(body).toContain('24 hours from issue');
      expect(body).toContain('2026-09-21 16:30:00 UTC');
      expect(body).toContain('single-use');
      expect(body).toContain('Newer invitations invalidate older links');
      expect(body).toContain('If you did not expect this invitation');
      expect(body).toContain('help@example.test');
      expect(body).toContain(credential);
      expect(body).not.toContain('15 minutes');
      expect(body).not.toContain('console:admin:');
    }
    expect(email.html.match(/>Accept invitation<\/a>/g)).toHaveLength(1);
    expect(email.text).toContain(buildInvitationClaimLink(fixture().publicBaseUrl, credential));
    expect(email.html).not.toMatch(/<img|<script|<iframe|<link|\bsrc=|url\(/i);
  });

  it.each([
    ['help@example.test', 'mailto:help@example.test'],
    ['desk?case#tag&more@example.test', 'mailto:desk%3Fcase%23tag%26more@example.test'],
    ["desk'case@example.test", 'mailto:desk&#39;case@example.test'],
  ])('preserves mailto addr-spec without permitting header or fragment injection for %s', (supportEmail, expectedHref) => {
    const email = renderInvitationEmail(fixture({ supportEmail }));
    expect(email.html).toContain(`href="${expectedHref}"`);
    expect(expectedHref.match(/@/g)).toHaveLength(1);
    expect(expectedHref).not.toContain('?');
    expect(expectedHref).not.toContain('#tag');
  });

  it('escapes recipient and role strings in HTML without changing their plain-text meaning', () => {
    const name = 'Morgan <img src=x onerror="alert(1)"> & Co';
    const email = renderInvitationEmail(fixture({
      recipientName: name,
      intendedAccess: [{ name: '<script>Admin</script>', description: 'Read <b>all</b> & "settings".' }],
    }));
    expect(email.html).not.toContain('<img');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co');
    expect(email.html).toContain('&lt;script&gt;Admin&lt;/script&gt;');
    expect(email.html).toContain('Read &lt;b&gt;all&lt;/b&gt; &amp; &quot;settings&quot;.');
    expect(email.text).toContain(name);
    expect(email.subject).toBe(INVITATION_EMAIL_SUBJECT);
  });

  it.each([1, 168])('shows the persisted %s-hour duration without using a global default', hours => {
    const issuedAt = fixture().issuedAt;
    const email = renderInvitationEmail(fixture({ issuedAt, expiresAt: new Date(issuedAt.getTime() + hours * 3_600_000) }));
    expect(email.text).toContain(`${hours} ${hours === 1 ? 'hour' : 'hours'} from issue`);
  });

  it('supports absent names and no intended administrator roles', () => {
    const email = renderInvitationEmail(fixture({ recipientName: null, intendedAccess: [] }));
    expect(email.text).toContain('Hello,');
    expect(email.text).toContain('Your account access will be shown during onboarding.');
  });

  it.each([
    { recipientName: 'Morgan\r\nBcc: victim@example.test' },
    { recipientName: 'x'.repeat(256) },
    { supportEmail: 'help@example.test\r\nBcc:victim@example.test' },
    { issuedAt: new Date('invalid') },
    { expiresAt: new Date('2026-09-20T16:30:00Z') },
    { expiresAt: new Date('2026-09-20T16:45:00Z') },
    { expiresAt: new Date('2026-09-28T16:30:00Z') },
    { intendedAccess: [{ name: 'Admin', description: 'x'.repeat(501) }] },
  ])('rejects invalid template fields without echoing credential-bearing inputs', overrides => {
    expect(() => renderInvitationEmail(fixture(overrides))).toThrow('Invalid invitation email template input');
  });
});

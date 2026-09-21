import { onboardingOwnerCookieMaxAgeSeconds } from '../../../src/invitations/onboarding/OnboardingOwnerCookie.js';
import type { OnboardingOwnerRecord } from '../../../src/invitations/onboarding/OnboardingRecords.js';
import { serializeOnboardingCookie, ONBOARDING_OWNER_COOKIE } from '../../../src/invitations/onboarding/OnboardingBrowserPolicy.js';

const createdAt = new Date('2026-09-20T12:00:00Z');
const after = (seconds: number) => new Date(createdAt.getTime() + seconds * 1000);
const owner: OnboardingOwnerRecord = { ownerHash: Buffer.alloc(32), csrfTokenHash: Buffer.alloc(32, 1),
  createdAt, refreshedAt: createdAt, expiresAt: after(900), revokedAt: null };

describe('stable onboarding owner cookie horizon', () => {
  it('establishes the absolute horizon before exchange, surviving the15minute bootstrap record', () => {
    const maxAge = onboardingOwnerCookieMaxAgeSeconds(owner, createdAt);
    expect(maxAge).toBe(604800);
    expect(serializeOnboardingCookie(ONBOARDING_OWNER_COOKIE, Buffer.alloc(32).toString('base64url'), maxAge))
      .toContain('Max-Age=604800; Secure; HttpOnly; SameSite=Lax');
  });
  it('never slides the cookie horizon when the server owner is renewed', () => {
    expect(onboardingOwnerCookieMaxAgeSeconds({ ...owner, refreshedAt: after(3600), expiresAt: after(86400) }, after(3600)))
      .toBe(604800 - 3600);
    expect(onboardingOwnerCookieMaxAgeSeconds(owner, after(0.5))).toBe(604799);
  });
  it('does not authorize or renew an expired/revoked owner merely because the cookie survives', () => {
    expect(() => onboardingOwnerCookieMaxAgeSeconds(owner, after(900))).toThrow();
    expect(() => onboardingOwnerCookieMaxAgeSeconds({ ...owner, revokedAt: after(1) }, createdAt)).toThrow();
    expect(() => onboardingOwnerCookieMaxAgeSeconds(owner, after(-1))).toThrow();
    expect(() => onboardingOwnerCookieMaxAgeSeconds(owner, new Date(NaN))).toThrow();
  });
  it('rejects the exhausted absolute horizon even when a subsecond remains', () => {
    const renewed = { ...owner, refreshedAt: after(604799), expiresAt: after(604800) };
    expect(() => onboardingOwnerCookieMaxAgeSeconds(renewed, after(604799.5))).toThrow();
  });
});

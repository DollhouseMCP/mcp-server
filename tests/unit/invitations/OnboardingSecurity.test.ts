import { describe, expect, it } from '@jest/globals';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import {
  OnboardingCredentials, isOnboardingCredential, ONBOARDING_OWNER_COOKIE, ONBOARDING_SESSION_COOKIE,
  readOnboardingCookie, serializeOnboardingCookie, clearOnboardingCookie, onboardingMutationAllowed,
  ONBOARDING_SCOPE, ONBOARDING_OWNER_MAX_AGE_SECONDS, restrictedSessionExpiresAt,
  validateOnboardingOwnerRecord, validateOnboardingSessionRecord,
  type OnboardingCookieName, type OnboardingOwnerRecord, type OnboardingSessionRecord,
} from '../../../src/invitations/onboarding/index.js';

const opaque = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 42));
const credentials = new OnboardingCredentials(opaque);
const now = new Date('2026-09-20T12:00:00Z');
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const uuid = '00000000-0000-4000-8000-000000000001';
function owner(): OnboardingOwnerRecord {
  return { ownerHash: credentials.issue('owner').hash, csrfTokenHash: credentials.issue('csrf').hash,
    createdAt: now, refreshedAt: now, expiresAt: later(86400), revokedAt: null };
}
function session(): OnboardingSessionRecord {
  return { idHash: credentials.issue('session').hash, ownerHash: owner().ownerHash,
    csrfTokenHash: credentials.issue('csrf').hash, userId: uuid, invitationId: uuid,
    generation: 1, claimAssertionId: uuid, emailVerifiedAt: now, scope: ONBOARDING_SCOPE,
    createdAt: now, expiresAt: later(900), revokedAt: null };
}

describe('restricted onboarding credentials', () => {
  it('issues independent 256-bit values and isolates purposes from ordinary console hashes', () => {
    const issued = credentials.issue('owner');
    expect(Buffer.from(issued.value, 'base64url')).toHaveLength(32);
    expect(credentials.issue('owner').value).not.toBe(issued.value);
    expect(credentials.matches('owner', issued.value, issued.hash)).toBe(true);
    expect(credentials.matches('session', issued.value, issued.hash)).toBe(false);
    expect(credentials.matches('csrf', issued.value, issued.hash)).toBe(false);
    expect(opaque.matchesHash(issued.value, issued.hash)).toBe(false);
    expect(credentials.matches('owner', issued.value, opaque.hashOpaqueValue(issued.value))).toBe(false);
    expect(credentials.matches('owner', issued.value, Buffer.alloc(31))).toBe(false);
  });
  it.each(['', 'a'.repeat(42), 'a'.repeat(44), 'A'.repeat(42) + 'B', 'A'.repeat(43) + '=', 'x\r\nSet-Cookie:y'])('rejects malformed or noncanonical values (%s)', value => {
    expect(isOnboardingCredential(value)).toBe(false);
    expect(() => credentials.hash('session', value)).toThrow('Invalid onboarding credential');
    expect(credentials.matches('session', value, Buffer.alloc(32))).toBe(false);
  });
});

describe('restricted onboarding browser policy', () => {
  const value = credentials.issue('session').value;
  it('uses distinct host-only, secure, HttpOnly cookies with top-level OAuth callback support', () => {
    expect(serializeOnboardingCookie(ONBOARDING_SESSION_COOKIE, value, 900))
      .toBe(`${ONBOARDING_SESSION_COOKIE}=${value}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`);
    expect(serializeOnboardingCookie(ONBOARDING_OWNER_COOKIE, value, ONBOARDING_OWNER_MAX_AGE_SECONDS))
      .toContain('Max-Age=604800; Secure; HttpOnly; SameSite=Lax');
    expect(clearOnboardingCookie(ONBOARDING_SESSION_COOKIE))
      .toBe(`${ONBOARDING_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    expect(() => clearOnboardingCookie('dh_session' as OnboardingCookieName)).toThrow('Unknown onboarding cookie');
  });
  it.each([0, -1, 1.5, 901, Infinity, NaN])('rejects invalid restricted session cookie age %s', age => {
    expect(() => serializeOnboardingCookie(ONBOARDING_SESSION_COOKIE, value, age)).toThrow();
  });
  it('caps the owner lifetime independently from the restricted session', () => {
    expect(() => serializeOnboardingCookie(ONBOARDING_OWNER_COOKIE, value, 604801)).toThrow();
    expect(() => serializeOnboardingCookie(ONBOARDING_OWNER_COOKIE, 'injected; cookie=1', 60)).toThrow();
  });
  it('rejects ordinary cookies, duplicates, quoted values, and malformed encodings', () => {
    expect(readOnboardingCookie(`dh_session=${value}`, ONBOARDING_SESSION_COOKIE)).toBeUndefined();
    expect(readOnboardingCookie(`${ONBOARDING_SESSION_COOKIE}=${value}`, ONBOARDING_SESSION_COOKIE)).toBe(value);
    for (const header of [undefined, `${ONBOARDING_SESSION_COOKIE}="${value}"`,
      `${ONBOARDING_SESSION_COOKIE}=%zz`, `${ONBOARDING_SESSION_COOKIE}=short`,
      `${ONBOARDING_SESSION_COOKIE}=${value}; ${ONBOARDING_SESSION_COOKIE}=${value}`]) {
      expect(readOnboardingCookie(header, ONBOARDING_SESSION_COOKIE)).toBeUndefined();
    }
  });
  const csrf = credentials.issue('csrf');
  const request = { method: 'POST', origin: 'https://console.example', csrfToken: csrf.value };
  it('accepts only an explicit POST with exact configured origin and server-bound CSRF token', () => {
    expect(onboardingMutationAllowed(request, request.origin, csrf.hash, credentials)).toBe(true);
    expect(onboardingMutationAllowed(request, request.origin, credentials.issue('csrf').hash, credentials)).toBe(false);
    expect(onboardingMutationAllowed({ ...request, csrfToken: value }, request.origin, credentials.hash('session', value), credentials)).toBe(false);
  });
  it.each([
    { method: 'GET' }, { method: 'HEAD' }, { origin: undefined }, { origin: 'null' },
    { origin: 'https://console.example.attacker.test' }, { origin: 'http://console.example' },
    { origin: 'https://console.example:444' }, { origin: ['https://console.example'] },
    { csrfToken: undefined }, { csrfToken: [csrf.value] }, { csrfToken: 'bad' },
  ])('rejects missing/ambiguous/cross-origin mutation context %j', change => {
    expect(onboardingMutationAllowed({ ...request, ...change }, request.origin, csrf.hash, credentials)).toBe(false);
  });
  it.each(['http://console.example', 'https://console.example/', 'https://user@console.example',
    'https://console.example/path', 'https://console.example?x=1', 'https://console.example#x', 'invalid'])('rejects unsafe origin configuration %s', origin => {
    expect(() => onboardingMutationAllowed(request, origin, csrf.hash, credentials)).toThrow();
  });
});

describe('onboarding server record contracts', () => {
  it('accepts hash-only owner and restricted records without granting authorization', () => {
    expect(() => validateOnboardingOwnerRecord(owner())).not.toThrow();
    expect(() => validateOnboardingSessionRecord(session())).not.toThrow();
    expect(() => validateOnboardingOwnerRecord({ ...owner(), refreshedAt: later(60), expiresAt: later(604860) })).not.toThrow();
  });
  it.each([
    { scope: 'console' }, { scope: 'mcp' }, { scope: 'admin' }, { roles: ['admin'] },
    { email: 'private@example.test' }, { token: 'raw' }, { generation: 0 }, { generation: 1.5 },
    { idHash: Buffer.alloc(31) }, { invitationId: 'bad' }, { claimAssertionId: 'bad' },
    { expiresAt: later(901) }, { expiresAt: now }, { createdAt: new Date(NaN) },
    { emailVerifiedAt: later(1) }, { revokedAt: later(-1) },
  ])('rejects invalid session references or ordinary authorization data %j', change => {
    expect(() => validateOnboardingSessionRecord({ ...session(), ...change } as OnboardingSessionRecord)).toThrow();
  });
  it.each([
    { expiresAt: later(604801) }, { expiresAt: now }, { refreshedAt: later(-1) },
    { csrfTokenHash: Buffer.alloc(1) }, { revokedAt: new Date(NaN) }, { token: 'raw' },
  ])('rejects invalid owner records %j', change => {
    expect(() => validateOnboardingOwnerRecord({ ...owner(), ...change })).toThrow();
  });
  it('caps session expiry at the earliest independent authority deadline', () => {
    expect(restrictedSessionExpiresAt(now, later(86400), later(86400), later(86400))).toEqual(later(900));
    expect(restrictedSessionExpiresAt(now, later(100), later(200), later(300))).toEqual(later(100));
    expect(restrictedSessionExpiresAt(now, later(200), later(100), later(300))).toEqual(later(100));
    expect(restrictedSessionExpiresAt(now, later(300), later(200), later(100))).toEqual(later(100));
    expect(() => restrictedSessionExpiresAt(now, later(300), now, later(100))).toThrow();
    expect(() => restrictedSessionExpiresAt(now, later(300), later(200), later(-1))).toThrow();
    expect(() => restrictedSessionExpiresAt(now, new Date(NaN), later(200), later(100))).toThrow();
  });
});

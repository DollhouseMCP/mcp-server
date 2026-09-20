import { readCookie } from '../../web-console/middleware/ConsoleCookies.js';
import { isOnboardingCredential, type OnboardingCredentials } from './OnboardingCredentials.js';
import { ONBOARDING_OWNER_MAX_AGE_SECONDS, ONBOARDING_SESSION_TTL_SECONDS } from './OnboardingRecords.js';

export const ONBOARDING_OWNER_COOKIE = '__Host-dh_onboarding_owner';
export const ONBOARDING_SESSION_COOKIE = '__Host-dh_onboarding_session';
export type OnboardingCookieName = typeof ONBOARDING_OWNER_COOKIE | typeof ONBOARDING_SESSION_COOKIE;

/** Reading a well-formed cookie is not authentication: resolve its server record. */
export function readOnboardingCookie(header: string | undefined, name: OnboardingCookieName): string | undefined {
  maximumAge(name);
  const value = readCookie(header, name);
  return isOnboardingCredential(value) ? value : undefined;
}

/** Host-only cookie policy; SameSite=Lax permits the GitHub top-level callback. */
export function serializeOnboardingCookie(name: OnboardingCookieName, value: string, maxAgeSeconds: number): string {
  const maximum = maximumAge(name);
  if (!isOnboardingCredential(value) || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > maximum) {
    throw new Error('Invalid onboarding cookie');
  }
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearOnboardingCookie(name: OnboardingCookieName): string {
  maximumAge(name);
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Strict origin plus synchronizer-token guard for explicit browser POST actions.
 * expectedCsrfHash comes from an authenticated owner/session record. The raw
 * token is supplied to the page in a no-store same-origin response, held in
 * memory and echoed in a header; no script-readable credential cookie is used.
 */
export function onboardingMutationAllowed(
  request: { readonly method: string; readonly origin: string | readonly string[] | undefined; readonly csrfToken: string | readonly string[] | undefined },
  trustedOrigin: string,
  expectedCsrfHash: Buffer,
  credentials: OnboardingCredentials,
): boolean {
  assertTrustedOrigin(trustedOrigin);
  return request.method === 'POST' && typeof request.origin === 'string' && request.origin === trustedOrigin
    && typeof request.csrfToken === 'string' && credentials.matches('csrf', request.csrfToken, expectedCsrfHash);
}

function maximumAge(name: OnboardingCookieName): number {
  if (name === ONBOARDING_OWNER_COOKIE) return ONBOARDING_OWNER_MAX_AGE_SECONDS;
  if (name === ONBOARDING_SESSION_COOKIE) return ONBOARDING_SESSION_TTL_SECONDS;
  throw new Error('Unknown onboarding cookie');
}

function assertTrustedOrigin(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Onboarding origin must be a canonical HTTPS origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value) throw new Error('Onboarding origin must be a canonical HTTPS origin');
}

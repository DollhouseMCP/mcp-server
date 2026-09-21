import { parseInvitationToken } from './InvitationToken.js';

/** Shared with the future #2680 claim page; this helper does not mount a route. */
export const INVITATION_CLAIM_PATH = '/auth/onboarding/invitation';
export const INVITATION_CLAIM_FRAGMENT_KEY = 'token';

/**
 * Configuration-only HTTPS origin. Never pass request Host/Forwarded headers.
 * Subpath deployments must explicitly expose the fixed claim path at the origin.
 */
export function invitationPublicOrigin(configuredBaseUrl: string): string {
  // Inspect the raw shape too: URL() normalizes dot paths and whitespace away.
  if (typeof configuredBaseUrl !== 'string' || configuredBaseUrl.length > 2048 ||
    !/^https:\/\/[^/?#@%\\\s]+\/?$/u.test(configuredBaseUrl)) invalidOrigin();
  let parsed: URL;
  try { parsed = new URL(configuredBaseUrl); } catch { return invalidOrigin(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.pathname !== '/' || !parsed.hostname) invalidOrigin();
  return parsed.origin;
}

/**
 * The credential stays in the fragment, outside the initial HTTP request target.
 * #2680 must remove it from browser history, hold it only in memory, and exchange
 * it by POST after an explicit user action. GET/prefetch must never consume it.
 */
export function buildInvitationClaimLink(configuredBaseUrl: string, credential: string): string {
  const origin = invitationPublicOrigin(configuredBaseUrl);
  const parsed = parseInvitationToken(credential);
  parsed.secret.fill(0);
  const link = new URL(INVITATION_CLAIM_PATH, origin);
  link.hash = new URLSearchParams({ [INVITATION_CLAIM_FRAGMENT_KEY]: credential }).toString();
  return link.toString();
}

function invalidOrigin(): never {
  throw new Error('Invitation public base URL must be a trusted HTTPS origin without credentials, path, query, or fragment');
}

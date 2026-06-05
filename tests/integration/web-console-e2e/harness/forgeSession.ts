import { createHmac, randomBytes } from 'node:crypto';

import { getConfig } from './config.js';
import { db } from './pg.js';
import { ADMIN_ELEVATED, GRANTED_SELF } from './capabilities.js';

/**
 * A principal a session can be forged for. `sub` MUST match the principal's
 * `auth_accounts.sub`: the console authentication middleware re-resolves the
 * enabled principal by `auth_sub` on every request, so a synthetic sub yields a
 * 401 even with a valid cookie. The seed helper returns these.
 */
export interface SeededPrincipal {
  readonly id: string;
  readonly sub: string;
}

export interface ForgedSession {
  /** Raw value to send as the `dh_session` cookie. */
  readonly session: string;
  /** Raw value to send as the `dh_csrf` cookie + `X-CSRF-Token` header. */
  readonly csrf: string;
}

export interface ForgeOptions {
  /** Granted (un-elevated) capabilities. Defaults to user-tier `console:self`. */
  readonly granted?: readonly string[];
  /** Elevated capabilities. Empty/undefined => an un-elevated session. */
  readonly elevated?: readonly string[];
}

function hashOpaque(value: string): Buffer {
  return createHmac('sha256', getConfig().opaqueHmacKey).update(value, 'utf8').digest();
}

/**
 * Insert a `console_sessions` row exactly as the BFF login/step-up flow would
 * have produced it, and return the cookie values that resolve to it. This lets
 * the breadth suite exercise every endpoint at any privilege tier without
 * driving the browser login (the real flow is covered separately by Playwright).
 */
export async function forgeSession(principal: SeededPrincipal, options: ForgeOptions = {}): Promise<ForgedSession> {
  const session = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const granted = options.granted ?? GRANTED_SELF;
  const elevated = options.elevated ?? [];
  const isElevated = elevated.length > 0;
  const sql = db();
  const now = new Date();
  const plus = (ms: number) => new Date(now.getTime() + ms);

  await sql`DELETE FROM console_sessions WHERE id_hash = ${hashOpaque(session)}`;
  await sql`
    INSERT INTO console_sessions
      (id_hash, user_id, auth_sub, csrf_token_hash, granted_capabilities, elevated_capabilities,
       elevation_expires_at, elevation_acr, elevation_amr, elevation_auth_time,
       created_at, last_used_at, idle_expires_at, absolute_expires_at)
    VALUES
      (${hashOpaque(session)}, ${principal.id}, ${principal.sub}, ${hashOpaque(csrf)},
       ${sql.array(granted)}, ${sql.array(elevated)},
       ${isElevated ? plus(3600e3) : null}, ${isElevated ? 'urn:dollhouse:acr:admin-stepup' : null},
       ${isElevated ? sql.array(['otp']) : null}, ${isElevated ? now : null},
       ${now}, ${now}, ${plus(3600e3)}, ${plus(8 * 3600e3)})
  `;
  return { session, csrf };
}

/** A normal authenticated user session (`console:self`, no elevation). */
export function forgeUser(principal: SeededPrincipal): Promise<ForgedSession> {
  return forgeSession(principal, { granted: GRANTED_SELF });
}

/**
 * An admin principal whose session is authenticated but NOT stepped up. Shaped
 * identically to a user session — admin power only appears after step-up — so
 * this should be REJECTED by admin endpoints (the elevation negative test).
 */
export function forgeAdminUnelevated(principal: SeededPrincipal): Promise<ForgedSession> {
  return forgeSession(principal, { granted: GRANTED_SELF });
}

/**
 * A full admin session with all admin capabilities freshly elevated (stepped up).
 * The `console_sessions_capability_check` constraint requires elevated ⊆ granted,
 * so granted expands to include the admin caps while elevated holds the same set.
 */
export function forgeAdminElevated(principal: SeededPrincipal): Promise<ForgedSession> {
  return forgeSession(principal, { granted: [...GRANTED_SELF, ...ADMIN_ELEVATED], elevated: [...ADMIN_ELEVATED] });
}

/**
 * Console capability strings (mirror of src/web-console/platform/ConsolePlatformTypes.ts).
 *
 * The `console_sessions_elevation_check` constraint enforces the real model:
 * an un-elevated session may only GRANT `console:self`; admin capabilities exist
 * solely as ELEVATED capabilities after step-up. So every session is granted
 * `[console:self]`, and admin power is added via `elevated_capabilities`.
 */

export const SELF = 'console:self';
export const ACCOUNTS = 'console:admin:accounts';
export const OPERATE = 'console:admin:operate';
export const AUDIT = 'console:admin:audit';
export const SECURITY = 'console:admin:security';

/** The four admin capabilities a full step-up grants. */
export const ADMIN_ELEVATED = [ACCOUNTS, OPERATE, AUDIT, SECURITY] as const;

/** Granted capabilities for any authenticated session (constraint-enforced). */
export const GRANTED_SELF = [SELF] as const;

export type Tier = 'user' | 'admin';

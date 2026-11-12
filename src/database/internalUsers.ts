/**
 * Users the server creates for its own purposes. They are not people: nobody
 * signs in as one, and none holds a role. Each has a fixed, reserved ID so it
 * can be recognised everywhere without a schema change.
 *
 * Anything that lists, counts or administers accounts leaves these out.
 */

import { SYSTEM_USER_UUID } from '../collection/shared-pool/SharedPoolConfig.js';

/**
 * The canary: a test user the server uses to check that approvals and
 * executions can be read through the console, without reading a real user's
 * session (#3257).
 */
export const CANARY_USER_UUID = '00000000-0000-0000-0000-000000000002';

/**
 * Deliberately not shaped like a sign-in subject. Subjects are
 * `<provider>_<id>`, and a `users` row whose username equals a subject can be
 * matched by that sign-in. This name has no underscore, so it never can be.
 */
export const CANARY_USERNAME = 'dollhousemcp-canary';

export const CANARY_DISPLAY_NAME = 'DollhouseMCP canary (automated check, not a person)';

/** Every reserved internal user. The shared-pool system user owns shared elements; the canary is above. */
export const INTERNAL_USER_IDS: readonly string[] = Object.freeze([SYSTEM_USER_UUID, CANARY_USER_UUID]);

export function isInternalUserId(userId: string): boolean {
  return INTERNAL_USER_IDS.includes(userId.toLowerCase());
}

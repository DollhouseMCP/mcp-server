/**
 * assertHasRole — middleware factory for role-gated routes.
 *
 * Round 5 / H7: must-fix #22 wired admin-role pre-claim end-to-end
 * (CLI → bootstrap state → setAccountRoles → JWT `roles` claim → AuthClaims)
 * but no route ever read the claim. Dashboard prose implied enforcement
 * that didn't exist. This helper closes the loop without requiring a
 * web-console overhaul: any future admin-only route mounts
 * `assertHasRole('admin')` and gets a consistent 403 shape.
 *
 * Mount AFTER the unified auth middleware — the unified middleware sets
 * `res.locals.authClaims` from a validated JWT; this helper only
 * inspects that. If `res.locals.authClaims` is missing (no auth ran),
 * the helper 401s rather than 403ing, since the absence of claims means
 * the request is unauthenticated, not authenticated-but-unauthorized.
 *
 * @module auth/assertHasRole
 */

import type { RequestHandler } from 'express';

/**
 * Build a middleware that requires `role` to appear in the
 * authenticated user's `roles` claim. Returns 403 when the role is
 * missing; returns 401 when no auth claims are present at all.
 *
 * Usage:
 *   router.get('/auth/admin/me',
 *     createUnifiedAuthMiddleware({ provider }),
 *     assertHasRole('admin'),
 *     (req, res) => res.json({ ... }));
 *
 * The 403 body deliberately does NOT echo the granted-roles list —
 * leaks the requesting user's claims to the requester (already known)
 * but adds nothing useful for legitimate access. The required role
 * IS echoed so an integration test can pin which guard fired.
 */
export function assertHasRole(role: string): RequestHandler {
  return (req, res, next) => {
    const claims = res.locals.authClaims;
    if (!claims) {
      // Reached this without auth claims = the unified auth middleware
      // didn't run (mount-order bug) or the request was on a public
      // path that bypassed auth. Either way, 401 is the honest answer:
      // we can't authorize what we haven't authenticated.
      res.status(401).json({
        error: 'Authentication required',
        required_role: role,
      });
      return;
    }
    // Defense-in-depth: AuthClaims.roles is typed as string[] | undefined
    // and the canonical claimsFromPayload path filters to strings, but
    // assertHasRole is exported for any future IAuthProvider to use.
    // A provider that mis-populates res.locals.authClaims with a
    // non-array roles field would otherwise cause `.includes(role)` to
    // throw 500 instead of yielding a clean 403.
    const rawRoles: unknown = claims.roles;
    const roles = Array.isArray(rawRoles) ? rawRoles : [];
    if (!roles.includes(role)) {
      res.status(403).json({
        error: 'Forbidden: required role not present',
        required_role: role,
      });
      return;
    }
    next();
  };
}

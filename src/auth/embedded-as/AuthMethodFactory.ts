/**
 * AuthMethodFactory
 *
 * Method-ID allowlist for the embedded AS. Validates that
 * `DOLLHOUSE_AUTH_METHODS` (and the `methods` config option) only
 * references known method IDs before AuthProviderFactory dispatches to
 * concrete IAuthMethod constructors. The construction itself lives in
 * `AuthProviderFactory.buildAuthMethod` — this factory does not own
 * constructors today.
 *
 * Method IDs (all four ship in §8.1):
 *   - 'trivial-consent' — solo localhost auto-consent
 *   - 'github'          — Stage B social, reuses DOLLHOUSE_GITHUB_CLIENT_ID
 *   - 'local-password'  — argon2id + invite token (CLI-issued)
 *   - 'magic-link'      — SMTP-required, requires durable storage
 *
 * @module auth/embedded-as/AuthMethodFactory
 */

/**
 * Auth method identifiers recognized by the embedded AS.
 *
 * `oidc-bridge` is intentionally NOT in this union. The embedded-AS-bridges-
 * to-IdP implementation was scaffolded but the upstream OIDC discovery +
 * code-exchange + JWKS validation aren't wired. Operators with an existing
 * IdP should use the legacy `DOLLHOUSE_AUTH_PROVIDER=oidc` path
 * (OidcAuthProvider, direct upstream-token validation). When the bridge
 * implementation lands, add 'oidc-bridge' back to this union.
 */
export type AuthMethodId =
  | 'trivial-consent'
  | 'github'
  | 'local-password'
  | 'magic-link';

export const ALL_AUTH_METHOD_IDS: readonly AuthMethodId[] = [
  'trivial-consent',
  'github',
  'local-password',
  'magic-link',
];

/**
 * Tracks which method IDs the running AS accepts. Construction of the
 * concrete IAuthMethod instances lives in `AuthProviderFactory.buildAuthMethod`
 * because the constructor needs deps (storage, invites, SMTP config,
 * GitHub client creds) that this factory has no business knowing about.
 *
 * Functionally this is a typed `Set<AuthMethodId>` with a clearer error
 * message; promotion to a constructor-bearing factory is a future
 * refactor that would require pushing those construction-time deps
 * through this surface.
 */
export class AuthMethodFactory {
  private readonly registered = new Set<AuthMethodId>();

  /** Register a method ID as available. */
  register(id: AuthMethodId): void {
    this.registered.add(id);
  }

  has(id: AuthMethodId): boolean {
    return this.registered.has(id);
  }

  list(): AuthMethodId[] {
    return Array.from(this.registered);
  }

  /** Throw if any of the requested method IDs is not registered. */
  assertAllRegistered(ids: readonly AuthMethodId[]): void {
    const missing = ids.filter(id => !this.registered.has(id));
    if (missing.length > 0) {
      throw new Error(
        `AuthMethodFactory: requested methods are not registered: ${missing.join(', ')}. ` +
        `Available: ${this.list().join(', ') || '(none)'}.`,
      );
    }
  }
}

/**
 * Build the default factory with all methods that ship today.
 * Add new methods here when they land; AuthProviderFactory's
 * `buildAuthMethod` is the matching dispatch site.
 */
export function createDefaultAuthMethodFactory(): AuthMethodFactory {
  const factory = new AuthMethodFactory();
  factory.register('trivial-consent');
  factory.register('github');
  factory.register('local-password');
  factory.register('magic-link');
  return factory;
}

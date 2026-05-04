/**
 * AuthMethodFactory
 *
 * Inner factory for the two-level AuthProviderFactory structure (per
 * docs/PRODUCTION-AUTH-ARCHITECTURE.md §8.1). Registers the auth method
 * implementations that the embedded authorization server can drive its
 * /interaction/:uid handlers from.
 *
 * Method IDs:
 *   - 'trivial-consent' — solo localhost auto-consent; the only method
 *     registered until C4 (oidc-provider migration) lands the real
 *     IAuthMethod interface and TrivialConsentMethod implementation.
 *   - 'github'           — Stage B (C7), reuses DOLLHOUSE_GITHUB_CLIENT_ID
 *   - 'local-password'   — Stage C (C8), argon2 + invite token
 *   - 'magic-link'       — Stage C (C8), SMTP-required
 *   - 'oidc-bridge'      — Stage C (C8), wraps OidcAuthProvider
 *
 * At C2 this file establishes the registry shape only; method
 * implementations and the IAuthMethod interface land in subsequent
 * commits. The shape itself is validated by AuthProviderFactory so the
 * `methods` config option starts being honored from C2 forward.
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
 * Registry of auth methods available to EmbeddedAuthorizationServer.
 *
 * At C2 the registry tracks which method IDs are recognized; concrete
 * IAuthMethod constructors plug in starting at C4. This minimal surface
 * lets AuthProviderFactory validate `methods` config without depending
 * on the not-yet-existing IAuthMethod interface.
 */
export class AuthMethodFactory {
  private readonly registered = new Set<AuthMethodId>();

  /** Register a method ID as available. C4+ will widen this to also accept a constructor. */
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
 * Build the default factory with all methods that ship today: trivial-consent
 * (C2/C4), github (C7), local-password and magic-link (C8). When future
 * commits add new methods, register them here.
 */
export function createDefaultAuthMethodFactory(): AuthMethodFactory {
  const factory = new AuthMethodFactory();
  factory.register('trivial-consent');
  factory.register('github');
  factory.register('local-password');
  factory.register('magic-link');
  return factory;
}

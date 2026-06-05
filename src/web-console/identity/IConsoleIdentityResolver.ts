export interface ConsolePrincipalSecurityState {
  readonly sub: string;
  readonly userId: string;
  readonly disabledAt: Date | null;
  readonly authzVersion: number;
  /**
   * Active admin role names for this user, from the per-user `user_admin_roles`
   * table (the authoritative role store). Absent/empty means no admin roles.
   * Used to grant the full role-entitled admin capability set on step-up.
   */
  readonly roles?: readonly string[];
}

/**
 * Resolves an authentication subject to its canonical authorization owner.
 * Consumers must treat `null` as authentication failure.
 */
export interface IConsoleIdentityResolver {
  resolveEnabledPrincipal(sub: string): Promise<ConsolePrincipalSecurityState | null>;
  /**
   * Ensure the auth account for `sub` is linked to a `users` row (creating the
   * row if absent), so this identity resolves to ONE user across console + MCP.
   * Called once at console login before resolving the principal; idempotent /
   * no-op when already linked. This is what lets a CLI-provisioned admin (whose
   * `users` row + role exist before any login) be recognized on first sign-in.
   */
  linkAccount(sub: string, displayName?: string): Promise<void>;
}

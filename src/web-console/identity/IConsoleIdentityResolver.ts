export interface ConsolePrincipalSecurityState {
  readonly sub: string;
  readonly userId: string;
  readonly disabledAt: Date | null;
  readonly authzVersion: number;
  /**
   * Admin role names attached to the account (auth_accounts.roles). Optional so
   * existing constructors are unaffected; absent/empty means no admin roles.
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
}

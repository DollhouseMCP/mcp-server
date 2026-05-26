export interface ConsolePrincipalSecurityState {
  readonly sub: string;
  readonly userId: string;
  readonly disabledAt: Date | null;
  readonly authzVersion: number;
}

/**
 * Resolves an authentication subject to its canonical authorization owner.
 * Consumers must treat `null` as authentication failure.
 */
export interface IConsoleIdentityResolver {
  resolveEnabledPrincipal(sub: string): Promise<ConsolePrincipalSecurityState | null>;
}

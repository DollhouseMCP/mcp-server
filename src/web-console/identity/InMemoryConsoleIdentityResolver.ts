import type {
  ConsolePrincipalSecurityState,
  IConsoleIdentityResolver,
} from './IConsoleIdentityResolver.js';

export class InMemoryConsoleIdentityResolver implements IConsoleIdentityResolver {
  private readonly principals = new Map<string, ConsolePrincipalSecurityState>();

  constructor(principals: readonly ConsolePrincipalSecurityState[] = []) {
    principals.forEach(principal => this.set(principal));
  }

  set(principal: ConsolePrincipalSecurityState): void {
    this.principals.set(principal.sub, clonePrincipal(principal));
  }

  async resolveEnabledPrincipal(sub: string): Promise<ConsolePrincipalSecurityState | null> {
    await Promise.resolve();
    const principal = this.principals.get(sub);
    if (!principal || principal.disabledAt) return null;
    return clonePrincipal(principal);
  }
}

function clonePrincipal(principal: ConsolePrincipalSecurityState): ConsolePrincipalSecurityState {
  return {
    ...principal,
    disabledAt: principal.disabledAt ? new Date(principal.disabledAt.getTime()) : null,
  };
}

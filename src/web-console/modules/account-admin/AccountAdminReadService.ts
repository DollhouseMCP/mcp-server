import type {
  ConsoleAdminRole,
  IConsoleAccountAdminStore,
} from '../../stores/IConsoleAccountAdminStore.js';
import {
  serializeAccountPrincipal,
  serializeAccountPrincipalList,
  serializeAccountRoleList,
  type AccountPrincipalDto,
  type AccountPrincipalListDto,
  type AccountRoleListDto,
} from './AccountAdminDtos.js';

export interface AccountPrincipalListQuery {
  readonly sub?: string;
  readonly limit?: number;
}

export class AccountAdminReadService {
  constructor(private readonly store: IConsoleAccountAdminStore) {}

  async listUsers(query: AccountPrincipalListQuery = {}): Promise<AccountPrincipalListDto> {
    return serializeAccountPrincipalList(await this.store.listPrincipals(query));
  }

  async getUser(userId: string): Promise<AccountPrincipalDto | null> {
    const principal = await this.store.findPrincipal(userId);
    return principal ? serializeAccountPrincipal(principal) : null;
  }

  async resolveCorrelation(accountCorrelationId: string): Promise<AccountPrincipalDto | null> {
    const principal = await this.store.findPrincipalByAccountCorrelationId(accountCorrelationId);
    return principal ? serializeAccountPrincipal(principal) : null;
  }

  async listRoles(userId: string): Promise<AccountRoleListDto> {
    const roles: readonly ConsoleAdminRole[] = await this.store.listActiveRoles(userId);
    return serializeAccountRoleList(userId, roles);
  }
}

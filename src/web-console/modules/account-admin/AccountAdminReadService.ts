import { decodeConsoleCursor, encodeConsoleCursor } from '../../platform/ConsoleCursor.js';
import type {
  ConsoleAdminRole,
  IConsoleAccountAdminStore,
  PrincipalDirectoryCursor,
  UnlinkedIdentityCursor,
} from '../../stores/IConsoleAccountAdminStore.js';
import {
  serializeAccountPrincipal,
  serializeAccountPrincipalList,
  serializeAccountRoleList,
  type AccountPrincipalDto,
  type AccountPrincipalListDto,
  type AccountRoleListDto,
} from './AccountAdminDtos.js';
import {
  serializeAccountUnlinkedIdentityList,
  type AccountUnlinkedIdentityListDto,
} from './AccountAdminIdentityDtos.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountPrincipalListQuery {
  readonly sub?: string;
  readonly search?: string;
  readonly role?: ConsoleAdminRole;
  readonly enabled?: boolean;
  readonly limit?: number;
  /** Opaque Family-B cursor from a prior page's `next_cursor`. Foreign/garbage tokens page from the start. */
  readonly cursor?: string | null;
}

export interface AccountUnlinkedIdentityListQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export class AccountAdminReadService {
  constructor(private readonly store: IConsoleAccountAdminStore) {}

  async listUsers(query: AccountPrincipalListQuery = {}): Promise<AccountPrincipalListDto> {
    const limit = query.limit ?? 100;
    const after = decodePrincipalCursor(query.cursor ?? null);
    const page = await this.store.listPrincipals({
      sub: query.sub,
      search: query.search,
      role: query.role,
      enabled: query.enabled,
      limit,
      after: after ?? undefined,
    });
    return serializeAccountPrincipalList(page.items, {
      limit,
      cursor: query.cursor ?? null,
      next_cursor: page.nextCursor ? encodePrincipalCursor(page.nextCursor) : null,
    });
  }

  async listUnlinkedIdentities(
    query: AccountUnlinkedIdentityListQuery = {},
  ): Promise<AccountUnlinkedIdentityListDto> {
    const limit = query.limit ?? 100;
    const after = decodeIdentityCursor(query.cursor ?? null);
    const page = await this.store.listUnlinkedIdentities({ limit, after: after ?? undefined });
    return serializeAccountUnlinkedIdentityList(page.items, {
      limit,
      cursor: query.cursor ?? null,
      next_cursor: page.nextCursor ? encodeIdentityCursor(page.nextCursor) : null,
    });
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

function encodePrincipalCursor(cursor: PrincipalDirectoryCursor): string {
  return encodeConsoleCursor({ c: cursor.createdAt.toISOString(), i: cursor.userId });
}

/** Foreign/garbage/non-UUID tokens decode to null so traversal restarts from the first page (§5.3). */
function decodePrincipalCursor(token: string | null): PrincipalDirectoryCursor | null {
  if (!token) return null;
  const payload = decodeConsoleCursor(token);
  const createdAtRaw = payload?.c;
  const userId = payload?.i;
  if (typeof createdAtRaw !== 'string' || typeof userId !== 'string' || !UUID_PATTERN.test(userId)) return null;
  const createdAt = new Date(createdAtRaw);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, userId };
}

function encodeIdentityCursor(cursor: UnlinkedIdentityCursor): string {
  return encodeConsoleCursor({ c: cursor.createdAt.toISOString(), s: cursor.sub });
}

function decodeIdentityCursor(token: string | null): UnlinkedIdentityCursor | null {
  if (!token) return null;
  const payload = decodeConsoleCursor(token);
  const createdAtRaw = payload?.c;
  const sub = payload?.s;
  if (typeof createdAtRaw !== 'string' || typeof sub !== 'string' || sub.length === 0 || sub.length > 320) return null;
  const createdAt = new Date(createdAtRaw);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, sub };
}

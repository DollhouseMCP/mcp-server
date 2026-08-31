import type {
  IRuntimeSessionControlStore,
  RuntimeOperationalCursor,
  RuntimeSessionPresence,
  RuntimeTerminationAck,
  RuntimeTerminationReason,
} from '../../services/runtime/IRuntimeSessionControlStore.js';
import { decodeConsoleCursor, encodeConsoleCursor } from '../../platform/ConsoleCursor.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import type {
  RuntimeSessionAccountDto,
  RuntimeSessionOperationalDto,
  RuntimeSessionOperationalListDto,
  RuntimeSessionRevokeAllDto,
  RuntimeSessionSelfDto,
  RuntimeTerminationAcceptedDto,
  RuntimeTerminationCommandStatusDto,
} from './RuntimeSessionDtos.js';
import type { RuntimeSessionStatus } from '../../../database/schema/index.js';

export interface OperationalSessionListQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly userId?: string;
  readonly status?: RuntimeSessionStatus;
}

export class RuntimeSessionService {
  constructor(private readonly options: {
    readonly runtimeStore: IRuntimeSessionControlStore;
    readonly accountAdminStore: IConsoleAccountAdminStore;
    readonly now?: () => Date;
  }) {}

  async listSelfSessions(userId: string): Promise<RuntimeSessionSelfDto[]> {
    const sessions = await this.options.runtimeStore.listPresenceByUser(userId, { now: this.now() });
    return sessions.map(toSelfDto);
  }

  async getSelfSession(userId: string, sessionId: string): Promise<RuntimeSessionSelfDto | null> {
    const session = await this.findOwnedPresence(userId, sessionId);
    return session ? toSelfDto(session) : null;
  }

  async terminateSelfSession(userId: string, sessionId: string): Promise<RuntimeTerminationAcceptedDto | null> {
    const session = await this.findOwnedPresence(userId, sessionId);
    if (!session) return null;
    return this.createTermination(session, 'user_requested', { kind: 'self', userId });
  }

  async revokeAllSelfSessions(userId: string): Promise<RuntimeSessionRevokeAllDto> {
    return this.revokeAllOwnedSessions(userId, 'user_requested', { kind: 'self', userId });
  }

  async listAccountSessions(userId: string): Promise<RuntimeSessionAccountDto[] | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    const sessions = await this.options.runtimeStore.listPresenceByUser(userId, { now: this.now() });
    return sessions.map(toAccountDto);
  }

  async terminateAccountSession(
    userId: string,
    sessionId: string,
    administratorUserId: string,
  ): Promise<RuntimeTerminationAcceptedDto | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    const session = await this.findOwnedPresence(userId, sessionId);
    if (!session) return null;
    return this.createTermination(session, 'admin_terminated', {
      kind: 'admin',
      userId: administratorUserId,
    });
  }

  async revokeAllAccountSessions(
    userId: string,
    administratorUserId: string,
  ): Promise<RuntimeSessionRevokeAllDto | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    return this.revokeAllOwnedSessions(userId, 'admin_terminated', {
      kind: 'admin',
      userId: administratorUserId,
    });
  }

  private async revokeAllOwnedSessions(
    userId: string,
    reason: RuntimeTerminationReason,
    requestedBy: { readonly kind: 'self' | 'admin'; readonly userId: string },
  ): Promise<RuntimeSessionRevokeAllDto> {
    const sessions = await this.options.runtimeStore.listPresenceByUser(userId, { now: this.now(), limit: 500 });
    const commands = [];
    for (const session of sessions) {
      commands.push(await this.createTermination(session, reason, requestedBy));
    }
    return {
      user_id: userId,
      requested: commands.length,
      commands,
    };
  }

  async listOperationalSessions(
    query: OperationalSessionListQuery = {},
  ): Promise<RuntimeSessionOperationalListDto> {
    const limit = query.limit ?? 100;
    const after = decodeOperationalCursor(query.cursor ?? null);
    const page = await this.options.runtimeStore.listOperationalPresence({
      now: this.now(),
      limit,
      after: after ?? undefined,
      userId: query.userId,
      status: query.status,
    });
    return {
      items: page.items.map(toOperationalDto),
      page: {
        limit,
        cursor: query.cursor ?? null,
        next_cursor: page.nextCursor ? encodeOperationalCursor(page.nextCursor) : null,
      },
    };
  }

  async getOperationalSession(sessionId: string): Promise<RuntimeSessionOperationalDto | null> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session ? toOperationalDto(session) : null;
  }

  /** Operator-facing termination command status (any command). Null when the command id is unknown. */
  async getCommandStatus(commandId: string): Promise<RuntimeTerminationCommandStatusDto | null> {
    const command = await this.options.runtimeStore.getCommand(commandId);
    if (!command) return null;
    return toCommandStatusDto(commandId, await this.options.runtimeStore.getCommandAck(commandId));
  }

  /** Self-facing command status: only the caller's own termination commands are visible. */
  async getSelfCommandStatus(
    userId: string,
    commandId: string,
  ): Promise<RuntimeTerminationCommandStatusDto | null> {
    const command = await this.options.runtimeStore.getCommand(commandId);
    if (command?.requestedBy.userId !== userId) return null;
    return toCommandStatusDto(commandId, await this.options.runtimeStore.getCommandAck(commandId));
  }

  async terminateOperationalSession(sessionId: string, operatorUserId: string): Promise<RuntimeTerminationAcceptedDto | null> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    if (!session) return null;
    return this.createTermination(session, 'operator_terminated', { kind: 'operator', userId: operatorUserId });
  }

  private async findOwnedPresence(userId: string, sessionId: string): Promise<RuntimeSessionPresence | null> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session?.userId === userId ? session : null;
  }

  private async createTermination(
    session: RuntimeSessionPresence,
    reason: RuntimeTerminationReason,
    requestedBy: { readonly kind: 'self' | 'admin' | 'operator'; readonly userId: string },
  ): Promise<RuntimeTerminationAcceptedDto> {
    const command = await this.options.runtimeStore.createTerminationCommand({
      sessionId: session.sessionId,
      targetReplicaId: session.replicaId,
      reason,
      requestedAt: this.now(),
      requestedBy,
    });
    return {
      session_id: command.sessionId,
      command_id: command.commandId,
      target_replica_id: command.targetReplicaId,
      reason: command.reason,
      status: 'accepted',
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function toSelfDto(session: RuntimeSessionPresence): RuntimeSessionSelfDto {
  return {
    session_id: session.sessionId,
    transport: session.transport,
    client_info: session.clientInfo ? { ...session.clientInfo } : null,
    created_at: session.startedAt.toISOString(),
    last_active_at: session.lastActiveAt.toISOString(),
    request_count: session.requestCount,
    error_count: session.errorCount,
    status: 'active',
  };
}

function toAccountDto(session: RuntimeSessionPresence): RuntimeSessionAccountDto {
  return {
    session_id: session.sessionId,
    transport: session.transport,
    created_at: session.startedAt.toISOString(),
    last_active_at: session.lastActiveAt.toISOString(),
    status: 'active',
  };
}

function toOperationalDto(session: RuntimeSessionPresence): RuntimeSessionOperationalDto {
  return {
    ...toAccountDto(session),
    account_correlation_id: session.accountCorrelationId,
    replica_id: session.replicaId,
    request_count: session.requestCount,
    error_count: session.errorCount,
    lease_until: session.leaseUntil.toISOString(),
    client_info: session.clientInfo ? { ...session.clientInfo } : null,
  };
}

function toCommandStatusDto(
  commandId: string,
  ack: RuntimeTerminationAck | null,
): RuntimeTerminationCommandStatusDto {
  if (!ack) {
    return { command_id: commandId, status: 'pending', acknowledged_at: null, replica_id: null, error_code: null };
  }
  return {
    command_id: commandId,
    status: ack.result,
    acknowledged_at: ack.acknowledgedAt.toISOString(),
    replica_id: ack.replicaId,
    error_code: ack.errorCode,
  };
}

function encodeOperationalCursor(cursor: RuntimeOperationalCursor): string {
  return encodeConsoleCursor({ t: cursor.lastActiveAt.toISOString(), s: cursor.sessionId });
}

/** Foreign/garbage tokens decode to null so traversal restarts from the first page (§5.3). */
function decodeOperationalCursor(token: string | null): RuntimeOperationalCursor | null {
  if (!token) return null;
  const payload = decodeConsoleCursor(token);
  const lastActiveRaw = payload?.t;
  const sessionId = payload?.s;
  if (typeof lastActiveRaw !== 'string' || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    return null;
  }
  const lastActiveAt = new Date(lastActiveRaw);
  return Number.isNaN(lastActiveAt.getTime()) ? null : { lastActiveAt, sessionId };
}

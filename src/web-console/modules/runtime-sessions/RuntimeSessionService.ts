import type {
  RuntimeSessionPresence,
  RuntimeTerminationReason,
} from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import type {
  RuntimeSessionAccountDto,
  RuntimeSessionOperationalDto,
  RuntimeSessionRevokeAllDto,
  RuntimeSessionSelfDto,
  RuntimeTerminationAcceptedDto,
} from './RuntimeSessionDtos.js';

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

  async listAccountSessions(userId: string): Promise<RuntimeSessionAccountDto[] | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    const sessions = await this.options.runtimeStore.listPresenceByUser(userId, { now: this.now() });
    return sessions.map(toAccountDto);
  }

  async terminateAccountSession(userId: string, sessionId: string): Promise<RuntimeTerminationAcceptedDto | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    const session = await this.findOwnedPresence(userId, sessionId);
    if (!session) return null;
    return this.createTermination(session, 'admin_terminated', { kind: 'admin', userId });
  }

  async revokeAllAccountSessions(userId: string): Promise<RuntimeSessionRevokeAllDto | null> {
    const principal = await this.options.accountAdminStore.findPrincipal(userId);
    if (!principal) return null;
    const sessions = await this.options.runtimeStore.listPresenceByUser(userId, { now: this.now(), limit: 500 });
    const commands = [];
    for (const session of sessions) {
      commands.push(await this.createTermination(session, 'admin_terminated', { kind: 'admin', userId }));
    }
    return {
      user_id: userId,
      requested: commands.length,
      commands,
    };
  }

  async listOperationalSessions(): Promise<RuntimeSessionOperationalDto[]> {
    const sessions = await this.options.runtimeStore.listOperationalPresence({ now: this.now() });
    return sessions.map(toOperationalDto);
  }

  async getOperationalSession(sessionId: string): Promise<RuntimeSessionOperationalDto | null> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session ? toOperationalDto(session) : null;
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

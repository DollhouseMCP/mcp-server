import type {
  IRuntimeSessionControlStore,
  RuntimeSessionPresence,
  RuntimeTerminationAck,
  RuntimeTerminationCommand,
  RuntimeTerminationReason,
} from '../../services/runtime/IRuntimeSessionControlStore.js';

export interface AccountRuntimeTerminationSummary {
  readonly requested: number;
  readonly acknowledged: number;
  readonly terminated: number;
  readonly alreadyAbsent: number;
  readonly failed: number;
  readonly timedOut: number;
}

export interface AccountAdminRuntimeTerminationServiceOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly acknowledgementTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
}

export class AccountAdminRuntimeTerminationService {
  constructor(private readonly options: AccountAdminRuntimeTerminationServiceOptions) {}

  async terminatePrincipalSessions(input: {
    readonly userId: string;
    readonly requestedByUserId: string;
    readonly reason: Extract<RuntimeTerminationReason, 'admin_disabled' | 'credential_revoked'>;
  }): Promise<AccountRuntimeTerminationSummary> {
    const sessions = await this.snapshotPrincipalSessions(input.userId);
    return this.terminateSessions({ ...input, sessions });
  }

  async snapshotPrincipalSessions(userId: string): Promise<readonly RuntimeTerminationTarget[]> {
    const sessions = await this.options.runtimeStore.listAllPresenceByUser(userId, this.runtimeStoreNow());
    return sessions.map(toTerminationTarget);
  }

  async terminateSessions(input: {
    readonly sessions: readonly RuntimeTerminationTarget[];
    readonly requestedByUserId: string;
    readonly reason: Extract<RuntimeTerminationReason, 'admin_disabled' | 'credential_revoked'>;
  }): Promise<AccountRuntimeTerminationSummary> {
    const commands = await Promise.all(input.sessions.map(session =>
      this.options.runtimeStore.createTerminationCommand({
        sessionId: session.sessionId,
        targetReplicaId: session.replicaId,
        reason: input.reason,
        requestedAt: this.now(),
        requestedBy: { kind: 'admin', userId: input.requestedByUserId },
      })));
    return this.awaitTerminationCommands(commands);
  }

  async awaitTerminationCommands(
    commands: readonly Pick<RuntimeTerminationCommand, 'commandId'>[],
  ): Promise<AccountRuntimeTerminationSummary> {
    const acks = await Promise.all(commands.map(command => this.waitForAck(command.commandId)));
    return summarizeAcks(acks);
  }

  private async waitForAck(commandId: string): Promise<RuntimeTerminationAck | null> {
    const timeoutMs = this.options.acknowledgementTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let ack = await this.options.runtimeStore.getCommandAck(commandId);
    while (!ack && Date.now() < deadline) {
      await sleep(Math.min(this.options.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now())));
      ack = await this.options.runtimeStore.getCommandAck(commandId);
    }
    return ack;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private runtimeStoreNow(): Date | undefined {
    return this.options.now?.();
  }
}

export type RuntimeTerminationTarget = Pick<RuntimeSessionPresence, 'sessionId' | 'replicaId'>;

function toTerminationTarget(session: RuntimeSessionPresence): RuntimeTerminationTarget {
  return { sessionId: session.sessionId, replicaId: session.replicaId };
}

export function emptyRuntimeTerminationSummary(): AccountRuntimeTerminationSummary {
  return {
    requested: 0,
    acknowledged: 0,
    terminated: 0,
    alreadyAbsent: 0,
    failed: 0,
    timedOut: 0,
  };
}

export function runtimeTerminationErrorCode(summary: AccountRuntimeTerminationSummary): string | null {
  if (summary.timedOut > 0) return 'runtime_termination_ack_timeout';
  if (summary.failed > 0) return 'runtime_termination_failed';
  return null;
}

function summarizeAcks(acks: readonly (RuntimeTerminationAck | null)[]): AccountRuntimeTerminationSummary {
  const summary = {
    ...emptyRuntimeTerminationSummary(),
    requested: acks.length,
  };
  for (const ack of acks) {
    if (!ack) {
      summary.timedOut += 1;
    } else if (ack.result === 'terminated') {
      summary.acknowledged += 1;
      summary.terminated += 1;
    } else if (ack.result === 'already_absent') {
      summary.acknowledged += 1;
      summary.alreadyAbsent += 1;
    } else {
      summary.acknowledged += 1;
      summary.failed += 1;
    }
  }
  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

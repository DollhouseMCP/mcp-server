import type { IConsoleSecurityInvalidationStore } from './IConsoleSecurityInvalidationStore.js';

export type ConsoleSecurityInvalidationReadinessStatus = 'ok' | 'not_ready' | 'unavailable';

export type ConsoleSecurityInvalidationReadinessFailureCode =
  | 'security_invalidation_processor_not_ready'
  | 'security_invalidation_replica_lease_not_live'
  | 'security_invalidation_events_pending'
  | 'security_invalidation_check_failed';

export interface ConsoleSecurityInvalidationReadinessSnapshot {
  readonly ready: boolean;
  readonly status: ConsoleSecurityInvalidationReadinessStatus;
  readonly checkedAt: Date;
  readonly failureCodes: readonly ConsoleSecurityInvalidationReadinessFailureCode[];
}

export interface IConsoleSecurityInvalidationReadiness {
  getReadiness(): Promise<ConsoleSecurityInvalidationReadinessSnapshot>;
}

export type ConsoleSecurityInvalidationProcessorCheck = () => boolean | Promise<boolean>;

export interface StoreBackedConsoleSecurityInvalidationReadinessOptions {
  readonly store: IConsoleSecurityInvalidationStore;
  readonly replicaId: string;
  readonly processorReady?: ConsoleSecurityInvalidationProcessorCheck;
  readonly now?: () => Date;
}

export class StaticConsoleSecurityInvalidationReadiness implements IConsoleSecurityInvalidationReadiness {
  constructor(
    private readonly ready: boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly failureCodes: readonly ConsoleSecurityInvalidationReadinessFailureCode[] =
      ['security_invalidation_processor_not_ready'],
  ) {}

  getReadiness(): Promise<ConsoleSecurityInvalidationReadinessSnapshot> {
    return Promise.resolve({
      ready: this.ready,
      status: this.ready ? 'ok' : 'not_ready',
      checkedAt: this.now(),
      failureCodes: this.ready ? [] : this.failureCodes,
    });
  }
}

export class StoreBackedConsoleSecurityInvalidationReadiness implements IConsoleSecurityInvalidationReadiness {
  private readonly now: () => Date;
  private readonly processorReady: ConsoleSecurityInvalidationProcessorCheck;

  constructor(private readonly options: StoreBackedConsoleSecurityInvalidationReadinessOptions) {
    this.now = options.now ?? (() => new Date());
    this.processorReady = options.processorReady ?? (() => true);
  }

  async getReadiness(): Promise<ConsoleSecurityInvalidationReadinessSnapshot> {
    const checkedAt = this.now();
    try {
      const failureCodes: ConsoleSecurityInvalidationReadinessFailureCode[] = [];
      if (!await this.processorReady()) {
        failureCodes.push('security_invalidation_processor_not_ready');
      }
      const liveReplicaIds = await this.options.store.listLiveReplicaIds(checkedAt);
      if (!liveReplicaIds.includes(this.options.replicaId)) {
        failureCodes.push('security_invalidation_replica_lease_not_live');
      }
      const cursor = await this.options.store.getReplicaCursor(this.options.replicaId);
      const pending = await this.options.store.listEventsAfter(cursor, 1);
      if (pending.length > 0) {
        failureCodes.push('security_invalidation_events_pending');
      }
      return {
        ready: failureCodes.length === 0,
        status: failureCodes.length === 0 ? 'ok' : 'not_ready',
        checkedAt,
        failureCodes,
      };
    } catch {
      return {
        ready: false,
        status: 'unavailable',
        checkedAt,
        failureCodes: ['security_invalidation_check_failed'],
      };
    }
  }
}

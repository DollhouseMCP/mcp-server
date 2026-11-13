import type { DatabaseInstance } from '../../database/connection.js';
import { DatabaseConfirmationStore } from '../../state/DatabaseConfirmationStore.js';
import { CanaryMonitor, type CanaryMonitorLog } from './CanaryMonitor.js';
import { runCanary, sweepCanaryLeftovers, type CanaryRunDependencies } from './CanaryRun.js';

export interface DatabaseCanaryMonitorOptions
  extends Pick<CanaryRunDependencies, 'runtimeStore' | 'approvalStore' | 'executionReader' | 'gatekeeperReader' | 'replicaId'> {
  readonly database: DatabaseInstance;
  /** The audit key resolver the server's sessions use. An approval request cannot be made without it. */
  readonly auditHmacResolver: ConstructorParameters<typeof DatabaseConfirmationStore>[3] & CanaryRunDependencies['auditHmacResolver'];
  readonly log: CanaryMonitorLog;
  readonly now?: () => Date;
}

/**
 * The canary over a database: it reads through the stores it is given, which
 * are the console's own, and writes through the confirmation store a live
 * session writes through. Building it runs nothing.
 */
export function createDatabaseCanaryMonitor(options: DatabaseCanaryMonitorOptions): CanaryMonitor {
  const { database, auditHmacResolver, log, now, ...stores } = options;
  return new CanaryMonitor({
    run: () => runCanary({
      ...stores,
      db: database,
      createConfirmationStore: (userId, sessionId) => new DatabaseConfirmationStore(database, userId, sessionId, auditHmacResolver),
      auditHmacResolver,
      now,
    }),
    sweep: at => sweepCanaryLeftovers(database, at),
    log,
    now,
  });
}

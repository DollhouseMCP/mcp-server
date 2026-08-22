import { describe, expect, it } from '@jest/globals';

import { AccountAdminRuntimeTerminationService } from '../../../../src/web-console/modules/account-admin/AccountAdminRuntimeTerminationService.js';
import { InMemoryRuntimeSessionControlStore } from '../../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const NOW = new Date('2026-08-21T12:00:00.000Z');

class AutoAckRuntimeStore extends InMemoryRuntimeSessionControlStore {
  override async createTerminationCommand(
    input: Parameters<InMemoryRuntimeSessionControlStore['createTerminationCommand']>[0],
  ): ReturnType<InMemoryRuntimeSessionControlStore['createTerminationCommand']> {
    const command = await super.createTerminationCommand(input);
    await this.acknowledgeCommand({
      commandId: command.commandId,
      replicaId: command.targetReplicaId,
      acknowledgedAt: NOW,
      result: 'terminated',
    });
    return command;
  }
}

describe('AccountAdminRuntimeTerminationService', () => {
  it('terminates transaction-captured targets after their presence rows have been purged', async () => {
    const runtimeStore = new AutoAckRuntimeStore();
    const service = new AccountAdminRuntimeTerminationService({
      runtimeStore,
      acknowledgementTimeoutMs: 1,
      now: () => NOW,
    });

    await expect(service.terminateSessions({
      sessions: [{ sessionId: 'purged-session', replicaId: 'replica-a' }],
      requestedByUserId: USER_ID,
      reason: 'credential_revoked',
    })).resolves.toEqual({
      requested: 1,
      acknowledged: 1,
      terminated: 1,
      alreadyAbsent: 0,
      failed: 0,
      timedOut: 0,
    });
  });
});

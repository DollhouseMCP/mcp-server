import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import {
  serializeGitHubIntegrationStatus,
  serializeIntegrationList,
} from './IntegrationDtos.js';

export class IntegrationService {
  constructor(private readonly store: IUserIntegrationStore) {}

  async list(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = req.consoleAuthentication;
    if (!auth) throw new Error('authentication middleware did not populate console context');
    const records = await this.store.listByUser(auth.userId);
    return {
      status: 200,
      body: serializeIntegrationList(records),
    };
  }

  async getGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = req.consoleAuthentication;
    if (!auth) throw new Error('authentication middleware did not populate console context');
    const record = await this.store.findByProvider(auth.userId, 'github');
    return {
      status: 200,
      body: serializeGitHubIntegrationStatus(record),
    };
  }
}

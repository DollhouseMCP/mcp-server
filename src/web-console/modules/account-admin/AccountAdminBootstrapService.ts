import type { IAuthStorageLayer } from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { ConsoleHandlerResult } from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import { serializeAccountBootstrapStatus } from './AccountAdminOnboardingDtos.js';

export interface AccountAdminBootstrapServiceOptions {
  readonly authStorage?: IAuthStorageLayer | null;
  readonly accountAdminStore: IConsoleAccountAdminStore;
}

export class AccountAdminBootstrapService {
  constructor(private readonly options: AccountAdminBootstrapServiceOptions) {}

  async getStatus(): Promise<ConsoleHandlerResult> {
    if (!this.options.authStorage) {
      return problem(503, 'service_unavailable', 'Service unavailable', 'Bootstrap status storage is unavailable.');
    }
    const state = await this.options.authStorage.getBootstrapState();
    let adminUserId: string | null = null;
    if (state.completed && state.adminSub) {
      // Keep bootstrap storage authority-blind: resolve the stable AS subject
      // at read time instead of caching account-admin user IDs in AS state.
      const matches = await this.options.accountAdminStore.listPrincipals({
        sub: state.adminSub,
        limit: 1,
      });
      adminUserId = matches[0]?.userId ?? null;
    }
    return {
      status: 200,
      body: serializeAccountBootstrapStatus({
        completed: state.completed,
        completedAt: state.completedAt ? new Date(state.completedAt) : null,
        adminUserId,
      }),
    };
  }
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}

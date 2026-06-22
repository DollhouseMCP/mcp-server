import {
  cloneConsoleAuthPolicy,
  ConsoleAuthPolicyConflictError,
  DEFAULT_CONSOLE_AUTH_POLICY,
  type ConsoleAuthPolicy,
  type IConsoleAuthPolicyStore,
} from './IConsoleAuthPolicyStore.js';

export class InMemoryConsoleAuthPolicyStore implements IConsoleAuthPolicyStore {
  private current: ConsoleAuthPolicy | null = null;

  load(): Promise<ConsoleAuthPolicy> {
    return Promise.resolve(cloneConsoleAuthPolicy(this.current ?? DEFAULT_CONSOLE_AUTH_POLICY));
  }

  save(
    policy: Pick<ConsoleAuthPolicy, 'maxAdminElevationSeconds'>,
    options: { readonly expectedUpdatedAt?: Date } = {},
  ): Promise<ConsoleAuthPolicy> {
    const current = this.current ?? DEFAULT_CONSOLE_AUTH_POLICY;
    if (options.expectedUpdatedAt && current.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
      return Promise.reject(new ConsoleAuthPolicyConflictError());
    }
    const updated: ConsoleAuthPolicy = {
      maxAdminElevationSeconds: policy.maxAdminElevationSeconds,
      updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
    };
    this.current = updated;
    return Promise.resolve(cloneConsoleAuthPolicy(updated));
  }
}

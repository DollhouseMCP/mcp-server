export interface ConsoleAuthPolicy {
  readonly maxAdminElevationSeconds: number;
  readonly updatedAt: Date;
}

export class ConsoleAuthPolicyConflictError extends Error {
  constructor(message = 'console auth policy update conflict') {
    super(message);
    this.name = 'ConsoleAuthPolicyConflictError';
  }
}

export interface IConsoleAuthPolicyStore {
  load(): Promise<ConsoleAuthPolicy>;
  save(
    policy: Pick<ConsoleAuthPolicy, 'maxAdminElevationSeconds'>,
    options?: { readonly expectedUpdatedAt?: Date },
  ): Promise<ConsoleAuthPolicy>;
}

export const DEFAULT_CONSOLE_AUTH_POLICY: ConsoleAuthPolicy = Object.freeze({
  maxAdminElevationSeconds: 300,
  updatedAt: new Date(0),
});

export function cloneConsoleAuthPolicy(policy: ConsoleAuthPolicy): ConsoleAuthPolicy {
  return {
    maxAdminElevationSeconds: policy.maxAdminElevationSeconds,
    updatedAt: new Date(policy.updatedAt),
  };
}

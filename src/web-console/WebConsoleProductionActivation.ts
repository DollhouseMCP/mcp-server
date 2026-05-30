export type WebConsoleActivationProfile = 'development' | 'shared-hosted';

/*
 * M7 slice-1 activation guard.
 *
 * This intentionally catches the currently observable production hazards at
 * registrar composition time: absent required services, adapters with known
 * in-memory/empty class-name conventions, and adapters whose constructor cannot
 * be identified. It is not a complete cutover proof.
 * Before /api/v1 is mounted, the checker still needs to be driven from the
 * authoritative hosted-deployment signal and replaced with explicit adapter
 * capability metadata so process-local substrates such as live Gatekeeper
 * readers cannot pass merely because their class name is not InMemory*.
 */

export interface WebConsoleProductionReadinessOptions {
  readonly securityInvalidationProcessorReady?: boolean;
  readonly portfolioSyncWorkerReady?: boolean;
  readonly accountAllowlistAuthorityCutoverComplete?: boolean;
}

export interface WebConsoleProductionActivationFailure {
  readonly code: string;
  readonly detail: string;
}

export class WebConsoleProductionActivationError extends Error {
  readonly failures: readonly WebConsoleProductionActivationFailure[];

  constructor(failures: readonly WebConsoleProductionActivationFailure[]) {
    super(`Web console production activation failed: ${failures.map(failure => failure.code).join(', ')}`);
    this.name = 'WebConsoleProductionActivationError';
    this.failures = failures;
  }
}

export interface WebConsoleProductionActivationInputs {
  readonly activationProfile: WebConsoleActivationProfile;
  readonly storageBackend: 'memory' | 'postgres';
  readonly enableAccountAllowlistRoutes: boolean;
  readonly readiness?: WebConsoleProductionReadinessOptions;
  readonly stores: Readonly<Record<string, unknown>>;
  readonly services: Readonly<Record<string, unknown>>;
}

export function assertWebConsoleProductionActivation(
  inputs: WebConsoleProductionActivationInputs,
): void {
  if (inputs.activationProfile === 'development') return;

  const failures: WebConsoleProductionActivationFailure[] = [];

  requireCondition(
    failures,
    inputs.storageBackend === 'postgres',
    'database_required',
    'Hosted/shared web-console activation requires shared PostgreSQL persistence.',
  );
  requireCondition(
    failures,
    inputs.readiness?.securityInvalidationProcessorReady === true,
    'security_invalidation_processor_not_ready',
    'Hosted/shared web-console activation requires durable invalidation processor readiness.',
  );
  requireCondition(
    failures,
    inputs.readiness?.portfolioSyncWorkerReady === true,
    'portfolio_sync_worker_not_ready',
    'Hosted/shared web-console activation requires a portfolio sync worker for exposed sync routes.',
  );

  if (inputs.enableAccountAllowlistRoutes) {
    requireCondition(
      failures,
      inputs.readiness?.accountAllowlistAuthorityCutoverComplete === true,
      'account_allowlist_authority_not_cut_over',
      'Hosted/shared web-console activation cannot expose account allowlist CRUD before the sign-in authority cutover is complete.',
    );
  }

  for (const [name, value] of Object.entries(inputs.stores)) {
    requireProductionAdapter(failures, name, value);
  }
  for (const [name, value] of Object.entries(inputs.services)) {
    requireProductionAdapter(failures, name, value);
  }

  requirePresent(failures, 'authStorage', inputs.services.authStorage);
  requirePresent(failures, 'secretEncryption', inputs.services.secretEncryption);
  requirePresent(failures, 'protectedCorrelationRateLimiter', inputs.services.protectedCorrelationRateLimiter);
  requirePresent(failures, 'oauthGrantRevocationService', inputs.services.oauthGrantRevocationService);
  requirePresent(failures, 'accountInviteIssuer', inputs.services.accountInviteIssuer);
  requirePresent(failures, 'githubIntegrationProvider', inputs.services.githubIntegrationProvider);
  requirePresent(failures, 'integrationPublicBaseUrl', inputs.services.integrationPublicBaseUrl);

  if (failures.length > 0) throw new WebConsoleProductionActivationError(failures);
}

function requireProductionAdapter(
  failures: WebConsoleProductionActivationFailure[],
  name: string,
  value: unknown,
): void {
  requirePresent(failures, name, value);
  if (!value) return;
  const adapter = adapterName(value);
  if (isKnownUnsafeAdapter(adapter)) {
    failures.push({
      code: `${name}_not_production_ready`,
      detail: `${name} uses ${adapter}; hosted/shared activation requires a durable or externally managed production adapter.`,
    });
  }
}

function requirePresent(
  failures: WebConsoleProductionActivationFailure[],
  name: string,
  value: unknown,
): void {
  if (value !== null && value !== undefined && value !== '') return;
  const code = `${name}_missing`;
  if (failures.some(failure => failure.code === code)) return;
  failures.push({
    code,
    detail: `${name} is required for hosted/shared web-console activation.`,
  });
}

function requireCondition(
  failures: WebConsoleProductionActivationFailure[],
  condition: boolean,
  code: string,
  detail: string,
): void {
  if (condition) return;
  failures.push({ code, detail });
}

function adapterName(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object' && typeof value !== 'function') return typeof value;
  const prototype = Object.getPrototypeOf(value) as { readonly constructor?: { readonly name?: unknown } } | null;
  const constructorName = prototype?.constructor?.name;
  return typeof constructorName === 'string' && constructorName.length > 0
    ? constructorName
    : 'unknown';
}

function isKnownUnsafeAdapter(adapter: string): boolean {
  return adapter === 'unknown' || adapter.startsWith('InMemory') || adapter.startsWith('Empty');
}

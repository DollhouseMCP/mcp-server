export type WebConsoleActivationProfile = 'development' | 'shared-hosted';

/*
 * M7 slice-1 activation guard.
 *
 * This intentionally catches the currently observable production hazards at
 * registrar composition time. Required dependencies must be present first. If
 * an adapter was explicitly marked with production metadata, that metadata is
 * authoritative: productionReady=true bypasses constructor-name heuristics, and
 * productionReady=false fails closed with typed detail. Unmarked adapters fall
 * back to the current constructor-name heuristic for unknown, InMemory*, Empty*,
 * and known process-local Gatekeeper classes.
 *
 * This is not a complete cutover proof. The metadata mechanism is an additive,
 * in-trust opt-in path; undeclared adapters do not yet fail closed solely
 * because they lack metadata. Before /api/v1 is mounted, the checker still
 * needs to be driven from the authoritative hosted-deployment signal and
 * production-critical adapters need broad metadata adoption.
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

export interface WebConsoleProductionAdapterMetadata {
  readonly productionReady: boolean;
  readonly adapterName?: string;
  readonly detail?: string;
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

const KNOWN_PROCESS_LOCAL_ADAPTERS = new Set<string>([
  'GatekeeperSessionApprovalStore',
  'GatekeeperSessionStateReader',
]);

const ADAPTER_METADATA = new WeakMap<object | ((...args: never[]) => unknown), WebConsoleProductionAdapterMetadata>();

export function markWebConsoleProductionAdapter<T extends object | ((...args: never[]) => unknown)>(
  adapter: T,
  metadata: WebConsoleProductionAdapterMetadata,
): T {
  ADAPTER_METADATA.set(adapter, metadata);
  return adapter;
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
  requirePresent(failures, 'consoleOAuthClient', inputs.services.consoleOAuthClient);
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
  const metadata = productionAdapterMetadata(value);
  if (metadata) {
    requireMetadataProductionAdapter(failures, name, metadata);
    return;
  }
  const adapter = adapterName(value);
  if (isKnownUnsafeAdapter(adapter)) {
    failures.push({
      code: `${name}_not_production_ready`,
      detail: `${name} uses ${adapter}; hosted/shared activation requires a durable or externally managed production adapter.`,
    });
  }
}

function requireMetadataProductionAdapter(
  failures: WebConsoleProductionActivationFailure[],
  name: string,
  metadata: WebConsoleProductionAdapterMetadata,
): void {
  if (metadata.productionReady) return;
  const adapter = metadata.adapterName ?? 'explicitly-marked-adapter';
  failures.push({
    code: `${name}_not_production_ready`,
    detail: metadata.detail ??
      `${name} uses ${adapter}; hosted/shared activation requires a durable or externally managed production adapter.`,
  });
}

function productionAdapterMetadata(value: unknown): WebConsoleProductionAdapterMetadata | null {
  if (typeof value !== 'object' && typeof value !== 'function') return null;
  if (value === null) return null;
  return ADAPTER_METADATA.get(value) ?? null;
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
  return adapter === 'unknown' ||
    adapter.startsWith('InMemory') ||
    adapter.startsWith('Empty') ||
    KNOWN_PROCESS_LOCAL_ADAPTERS.has(adapter);
}

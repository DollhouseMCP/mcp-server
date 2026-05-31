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
  readonly databaseVerificationReady?: boolean;
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

export interface WebConsoleProductionRouteDependency {
  readonly moduleId: string;
  readonly dependencyName: string;
  readonly value: unknown;
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
  readonly registeredRouteModuleIds?: readonly string[];
  readonly routeDependencies?: readonly WebConsoleProductionRouteDependency[];
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
    inputs.readiness?.databaseVerificationReady === true,
    'database_verification_not_ready',
    'Hosted/shared web-console activation requires verification of the intended PostgreSQL database and current migration state.',
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
  requireRegisteredRouteDependencies(failures, inputs);

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
  const failure = productionAdapterFailure(name, value);
  if (failure) failures.push(failure);
}

function requireRegisteredRouteDependencies(
  failures: WebConsoleProductionActivationFailure[],
  inputs: WebConsoleProductionActivationInputs,
): void {
  const registeredRouteModuleIds = new Set(inputs.registeredRouteModuleIds ?? []);
  for (const dependency of inputs.routeDependencies ?? []) {
    if (!registeredRouteModuleIds.has(dependency.moduleId)) continue;
    const failure = productionAdapterFailure(
      `${dependency.moduleId}_${dependency.dependencyName}`,
      dependency.value,
      dependency.detail,
    );
    if (failure) failures.push(failure);
  }
}

function productionAdapterFailure(
  name: string,
  value: unknown,
  detail?: string,
): WebConsoleProductionActivationFailure | null {
  const missing = missingFailure(name, value);
  if (missing) return missing;
  const metadata = productionAdapterMetadata(value);
  if (metadata) {
    return metadataProductionAdapterFailure(name, metadata, detail);
  }
  const adapter = adapterName(value);
  if (isKnownUnsafeAdapter(adapter)) {
    return {
      code: `${name}_not_production_ready`,
      detail: detail ??
        `${name} uses ${adapter}; hosted/shared activation requires a durable or externally managed production adapter.`,
    };
  }
  return null;
}

function metadataProductionAdapterFailure(
  name: string,
  metadata: WebConsoleProductionAdapterMetadata,
  detail?: string,
): WebConsoleProductionActivationFailure | null {
  if (metadata.productionReady) return null;
  const adapter = metadata.adapterName ?? 'explicitly-marked-adapter';
  return {
    code: `${name}_not_production_ready`,
    detail: detail ?? metadata.detail ??
      `${name} uses ${adapter}; hosted/shared activation requires a durable or externally managed production adapter.`,
  };
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
  const failure = missingFailure(name, value);
  if (!failure) return;
  if (failures.some(existing => existing.code === failure.code)) return;
  failures.push(failure);
}

function missingFailure(
  name: string,
  value: unknown,
): WebConsoleProductionActivationFailure | null {
  if (value !== null && value !== undefined && value !== '') return null;
  const code = `${name}_missing`;
  return {
    code,
    detail: `${name} is required for hosted/shared web-console activation.`,
  };
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

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
 * The metadata mechanism is an additive, in-trust opt-in path by default. The
 * final hosted/shared mount path can require explicit metadata and fail closed
 * for unmarked adapters, which removes constructor-name heuristics from the
 * production proof.
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
  /*
   * Optional capabilities (e.g. the GitHub integration provider) may be absent
   * in a valid production deployment: the owning module degrades gracefully and
   * the operator can configure them later. Absence is not a mount blocker, but
   * a value that IS present is still held to the production-adapter check.
   */
  readonly optional?: boolean;
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
  readonly requireExplicitProductionAdapterMetadata?: boolean;
}

const KNOWN_PROCESS_LOCAL_ADAPTERS = new Set<string>([
  'GatekeeperSessionApprovalStore',
  'GatekeeperSessionStateReader',
]);
const ROUTE_MODULES_WITH_GLOBAL_PRODUCTION_DEPENDENCIES = new Set<string>([
  'auth',
  'health',
  // me-logs reads the in-memory log sink (a backend-agnostic source), not a
  // production storage adapter — so it has no per-module readiness evidence.
  'me-logs',
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
    requireProductionAdapter(failures, name, value, inputs.requireExplicitProductionAdapterMetadata === true);
  }
  for (const [name, value] of Object.entries(inputs.services)) {
    requireProductionAdapter(failures, name, value, inputs.requireExplicitProductionAdapterMetadata === true);
  }
  requireRegisteredRouteDependencies(failures, inputs);

  requirePresent(failures, 'authStorage', inputs.services.authStorage);
  requirePresent(failures, 'secretEncryption', inputs.services.secretEncryption);
  requirePresent(failures, 'consoleOAuthClient', inputs.services.consoleOAuthClient);
  requirePresent(failures, 'integrationPublicBaseUrl', inputs.services.integrationPublicBaseUrl);

  if (failures.length > 0) throw new WebConsoleProductionActivationError(failures);
}

function requireProductionAdapter(
  failures: WebConsoleProductionActivationFailure[],
  name: string,
  value: unknown,
  requireExplicitMetadata: boolean,
): void {
  const failure = productionAdapterFailure(name, value, undefined, requireExplicitMetadata);
  if (failure) failures.push(failure);
}

function requireRegisteredRouteDependencies(
  failures: WebConsoleProductionActivationFailure[],
  inputs: WebConsoleProductionActivationInputs,
): void {
  const registeredRouteModuleIds = new Set(inputs.registeredRouteModuleIds ?? []);
  const dependencyModuleIds = new Set((inputs.routeDependencies ?? []).map(dependency => dependency.moduleId));
  for (const moduleId of registeredRouteModuleIds) {
    if (ROUTE_MODULES_WITH_GLOBAL_PRODUCTION_DEPENDENCIES.has(moduleId)) continue;
    if (dependencyModuleIds.has(moduleId)) continue;
    failures.push({
      code: `${moduleId}_production_dependencies_undeclared`,
      detail: `${moduleId} routes are registered without a production dependency declaration; omit the module or declare its production dependencies before hosted/shared activation.`,
    });
  }
  for (const dependency of inputs.routeDependencies ?? []) {
    if (!registeredRouteModuleIds.has(dependency.moduleId)) continue;
    if (dependency.optional && isAbsentDependencyValue(dependency.value)) continue;
    const failure = productionAdapterFailure(
      `${dependency.moduleId}_${dependency.dependencyName}`,
      dependency.value,
      dependency.detail,
      inputs.requireExplicitProductionAdapterMetadata === true,
    );
    if (failure) failures.push(failure);
  }
}

function productionAdapterFailure(
  name: string,
  value: unknown,
  detail?: string,
  requireExplicitMetadata = false,
): WebConsoleProductionActivationFailure | null {
  const missing = missingFailure(name, value);
  if (missing) return missing;
  const metadata = productionAdapterMetadata(value);
  if (metadata) {
    return metadataProductionAdapterFailure(name, metadata, detail);
  }
  if (requireExplicitMetadata && isAdapterValue(value)) {
    return {
      code: `${name}_metadata_missing`,
      detail: detail ??
        `${name} does not declare web-console production adapter metadata; hosted/shared mount requires explicit production readiness metadata.`,
    };
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
  if (!isAdapterValue(value)) return null;
  return ADAPTER_METADATA.get(value) ?? null;
}

function isAdapterValue(value: unknown): value is object | ((...args: never[]) => unknown) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isAbsentDependencyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
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

import {
  CONSOLE_CAPABILITIES,
  CONSOLE_ELEVATION_POLICIES,
  CONSOLE_HTTP_METHODS,
  CONSOLE_PRIVACY_CLASSES,
  type ConsoleElevationPolicy,
  type ConsoleHttpMethod,
  type ConsoleIdempotencyPolicy,
  type ConsoleModuleDescriptor,
  type ConsolePrivacyClass,
  type ConsoleRouteDefinition,
  type ConsoleRouteManifest,
  type ConsoleRouteManifestEntry,
} from './ConsolePlatformTypes.js';

const CAPABILITIES = new Set<string>(CONSOLE_CAPABILITIES);
const PRIVACY_CLASSES = new Set<string>(CONSOLE_PRIVACY_CLASSES);
const ELEVATION_POLICIES = new Set<string>(CONSOLE_ELEVATION_POLICIES);
const HTTP_METHODS = new Set<string>(CONSOLE_HTTP_METHODS);
const IDEMPOTENCY_POLICIES = new Set<string>(['not_applicable', 'required']);
const OWNERSHIP_POLICIES = new Set<string>(['none', 'authenticated_user', 'owned_session']);
const MUTATING_METHODS = new Set<ConsoleHttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);
const SELF_PRIVACY_CLASSES = new Set<ConsolePrivacyClass>(['self_private', 'self_security']);
const SELF_PATH_PATTERN = /^\/api\/v1\/(me|auth)(\/|$)/;

type ValidatedConsoleRouteDefinition = ConsoleRouteDefinition & {
  readonly elevation: ConsoleElevationPolicy;
  readonly privacyClass: ConsolePrivacyClass;
  readonly idempotency: ConsoleIdempotencyPolicy;
};

type RegisteredConsoleModuleDescriptor = Omit<ConsoleModuleDescriptor, 'routes'> & {
  readonly routes: readonly ValidatedConsoleRouteDefinition[];
};

export class ConsoleModuleRegistrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConsoleModuleRegistrationError';
  }
}

function routeKey(route: Pick<ConsoleRouteDefinition, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function isAdminCapability(capability: string): boolean {
  return capability.startsWith('console:admin:');
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-zA-Z0-9._-]*$/.test(value)) {
    throw new ConsoleModuleRegistrationError(`${label} has invalid identifier "${value}"`);
  }
}

function manifestEntry(
  moduleId: string,
  route: ValidatedConsoleRouteDefinition,
): ConsoleRouteManifestEntry {
  return {
    moduleId,
    method: route.method,
    path: route.path,
    audience: route.audience,
    requiredCapability: route.requiredCapability,
    ownership: route.ownership ?? 'none',
    elevation: route.elevation,
    privacyClass: route.privacyClass,
    idempotency: route.idempotency,
    ...(route.auditOperation ? { auditOperation: route.auditOperation } : {}),
  };
}

function freezeDescriptor(
  module: ConsoleModuleDescriptor,
  routes: readonly ValidatedConsoleRouteDefinition[],
): RegisteredConsoleModuleDescriptor {
  return Object.freeze({
    ...module,
    capabilities: Object.freeze([...module.capabilities]),
    routes: Object.freeze(routes.map(route => Object.freeze({ ...route }))),
    auditOperations: module.auditOperations
      ? Object.freeze(module.auditOperations.map(operation => Object.freeze({ ...operation })))
      : undefined,
    events: module.events
      ? Object.freeze(module.events.map(event => Object.freeze({ ...event })))
      : undefined,
    schemas: module.schemas
      ? Object.freeze(module.schemas.map(schema => Object.freeze({ ...schema })))
      : undefined,
    migrations: module.migrations ? Object.freeze({ ...module.migrations }) : undefined,
  });
}

export class ConsoleModuleRegistry {
  private readonly modules = new Map<string, RegisteredConsoleModuleDescriptor>();
  private readonly routeOwners = new Map<string, string>();
  private readonly eventOwners = new Map<string, string>();
  private readonly schemaOwners = new Map<string, string>();

  public register(module: ConsoleModuleDescriptor): void {
    if (this.modules.has(module.id)) {
      throw new ConsoleModuleRegistrationError(`Duplicate console module id "${module.id}"`);
    }

    const routes = this.validateModule(module);
    this.assertNoRegisteredCollisions(module);
    const registeredModule = freezeDescriptor(module, routes);

    this.modules.set(registeredModule.id, registeredModule);
    for (const route of registeredModule.routes) {
      this.routeOwners.set(routeKey(route), registeredModule.id);
    }
    for (const event of registeredModule.events ?? []) {
      this.eventOwners.set(event.type, registeredModule.id);
      this.schemaOwners.set(event.schemaId, registeredModule.id);
    }
    for (const schema of registeredModule.schemas ?? []) {
      this.schemaOwners.set(schema.id, registeredModule.id);
    }
  }

  public getModules(): readonly ConsoleModuleDescriptor[] {
    return [...this.modules.values()];
  }

  public createRouteManifest(): ConsoleRouteManifest {
    return {
      apiVersion: 'v1',
      routes: [...this.modules.values()].flatMap(module =>
        module.routes.map(route => manifestEntry(module.id, route))),
    };
  }

  private validateModule(module: ConsoleModuleDescriptor): readonly ValidatedConsoleRouteDefinition[] {
    assertIdentifier(module.id, 'Module');
    const apiVersion: string = module.apiVersion;
    // Runtime guard: descriptors may enter from untyped JavaScript or future plugin loading.
    if (apiVersion !== 'v1') {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" has unsupported API version`);
    }

    const capabilities = this.validateCapabilities(module);
    const auditOperations = this.validateAuditOperations(module);
    const routes = this.validateRoutes(module, capabilities, auditOperations);
    this.validateEventAndSchemaIdentifiers(module);
    return routes;
  }

  private validateCapabilities(module: ConsoleModuleDescriptor): ReadonlySet<string> {
    const declaredCapabilities = new Set<string>();
    for (const capability of module.capabilities as readonly string[]) {
      if (!CAPABILITIES.has(capability)) {
        throw new ConsoleModuleRegistrationError(`Module "${module.id}" declares unknown capability "${capability}"`);
      }
      declaredCapabilities.add(capability);
    }
    return declaredCapabilities;
  }

  private validateAuditOperations(module: ConsoleModuleDescriptor): ReadonlySet<string> {
    const auditOperations = new Set<string>();
    for (const auditOperation of module.auditOperations ?? []) {
      assertIdentifier(auditOperation.id, `Audit operation in module "${module.id}"`);
      if (auditOperations.has(auditOperation.id)) {
        throw new ConsoleModuleRegistrationError(`Module "${module.id}" duplicates audit operation "${auditOperation.id}"`);
      }
      auditOperations.add(auditOperation.id);
    }
    return auditOperations;
  }

  private validateRoutes(
    module: ConsoleModuleDescriptor,
    declaredCapabilities: ReadonlySet<string>,
    auditOperations: ReadonlySet<string>,
  ): readonly ValidatedConsoleRouteDefinition[] {
    const localRoutes = new Set<string>();
    const routes: ValidatedConsoleRouteDefinition[] = [];
    for (const route of module.routes) {
      const validatedRoute = this.validateRoute(module, route, declaredCapabilities, auditOperations);
      const key = routeKey(validatedRoute);
      if (localRoutes.has(key)) {
        throw new ConsoleModuleRegistrationError(`Module "${module.id}" duplicates route ${key}`);
      }
      localRoutes.add(key);
      routes.push(validatedRoute);
    }
    return routes;
  }

  private validateEventAndSchemaIdentifiers(module: ConsoleModuleDescriptor): void {
    const localEvents = new Set<string>();
    const localSchemas = new Set<string>();
    for (const event of module.events ?? []) {
      assertIdentifier(event.type, `Event in module "${module.id}"`);
      assertIdentifier(event.schemaId, `Event schema in module "${module.id}"`);
      if (localEvents.has(event.type)) {
        throw new ConsoleModuleRegistrationError(`Module "${module.id}" duplicates event "${event.type}"`);
      }
      this.assertUniqueLocalSchema(module, localSchemas, event.schemaId);
      localEvents.add(event.type);
    }
    for (const schema of module.schemas ?? []) {
      assertIdentifier(schema.id, `Schema in module "${module.id}"`);
      this.assertUniqueLocalSchema(module, localSchemas, schema.id);
    }
  }

  private assertUniqueLocalSchema(
    module: ConsoleModuleDescriptor,
    localSchemas: Set<string>,
    schemaId: string,
  ): void {
    if (localSchemas.has(schemaId)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" duplicates schema "${schemaId}"`);
    }
    localSchemas.add(schemaId);
  }

  private validateRoute(
    module: ConsoleModuleDescriptor,
    route: ConsoleRouteDefinition,
    declaredCapabilities: ReadonlySet<string>,
    auditOperations: ReadonlySet<string>,
  ): ValidatedConsoleRouteDefinition {
    this.validateCommonRoutePolicy(module, route, declaredCapabilities);
    if (this.isAdministrativeRoute(route)) {
      this.validateAdminRoutePolicy(module, route, auditOperations);
    } else {
      this.validateSelfRoutePolicy(module, route);
    }

    return this.normalizeValidatedRoute(module, route);
  }

  private normalizeValidatedRoute(
    module: ConsoleModuleDescriptor,
    route: ConsoleRouteDefinition,
  ): ValidatedConsoleRouteDefinition {
    const { elevation, privacyClass } = route;
    if (!elevation || !privacyClass) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} was not fully validated`);
    }
    return {
      ...route,
      elevation,
      privacyClass,
      idempotency: route.idempotency ?? 'not_applicable',
    };
  }

  private validateCommonRoutePolicy(
    module: ConsoleModuleDescriptor,
    route: ConsoleRouteDefinition,
    declaredCapabilities: ReadonlySet<string>,
  ): void {
    if (!HTTP_METHODS.has(route.method)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route declares invalid method "${String(route.method)}"`);
    }
    if (!route.path.startsWith('/api/v1/')) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} must be under /api/v1`);
    }
    if (!CAPABILITIES.has(route.requiredCapability)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} requires unknown capability "${route.requiredCapability}"`);
    }
    if (!declaredCapabilities.has(route.requiredCapability)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} uses undeclared capability "${route.requiredCapability}"`);
    }
    if (!route.privacyClass || !PRIVACY_CLASSES.has(route.privacyClass)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} is missing a valid privacy class`);
    }
    if (!route.elevation || !ELEVATION_POLICIES.has(route.elevation)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} is missing a valid elevation policy`);
    }
    if (route.idempotency && !IDEMPOTENCY_POLICIES.has(route.idempotency)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} has an invalid idempotency decision`);
    }
    if (MUTATING_METHODS.has(route.method) && !route.idempotency) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" mutating route ${routeKey(route)} is missing an idempotency decision`);
    }
    if (route.ownership && !OWNERSHIP_POLICIES.has(route.ownership)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} has an invalid ownership policy`);
    }
  }

  private isAdministrativeRoute(route: ConsoleRouteDefinition): boolean {
    return route.audience === 'admin' || route.path.startsWith('/api/v1/admin/') ||
      isAdminCapability(route.requiredCapability);
  }

  private validateAdminRoutePolicy(
    module: ConsoleModuleDescriptor,
    route: ConsoleRouteDefinition,
    auditOperations: ReadonlySet<string>,
  ): void {
    if (route.audience !== 'admin' || !route.path.startsWith('/api/v1/admin/') ||
        !isAdminCapability(route.requiredCapability)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} has inconsistent admin policy`);
    }
    if (route.elevation === 'none') {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" admin route ${routeKey(route)} requires administrative elevation`);
    }
    if (!route.auditOperation || !auditOperations.has(route.auditOperation)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" admin route ${routeKey(route)} is missing a declared audit operation`);
    }
    if (!route.privacyProjector) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" admin route ${routeKey(route)} is missing a privacy projector`);
    }
  }

  private validateSelfRoutePolicy(
    module: ConsoleModuleDescriptor,
    route: ConsoleRouteDefinition,
  ): void {
    const audience: string = route.audience;
    // Runtime guard: descriptors may enter from untyped JavaScript or future plugin loading.
    if (audience !== 'self' || route.requiredCapability !== 'console:self' ||
        !SELF_PATH_PATTERN.test(route.path)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" route ${routeKey(route)} has inconsistent self-service policy`);
    }
    if (route.elevation !== 'none') {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" self-service route ${routeKey(route)} cannot require admin elevation`);
    }
    if (!route.privacyClass || !SELF_PRIVACY_CLASSES.has(route.privacyClass)) {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" self-service route ${routeKey(route)} has invalid privacy class`);
    }
    if (!route.ownership || route.ownership === 'none') {
      throw new ConsoleModuleRegistrationError(`Module "${module.id}" self-service route ${routeKey(route)} is missing an ownership policy`);
    }
  }

  private assertNoRegisteredCollisions(module: ConsoleModuleDescriptor): void {
    for (const route of module.routes) {
      const owner = this.routeOwners.get(routeKey(route));
      if (owner) {
        throw new ConsoleModuleRegistrationError(`Route ${routeKey(route)} collides between modules "${owner}" and "${module.id}"`);
      }
    }
    for (const event of module.events ?? []) {
      const eventOwner = this.eventOwners.get(event.type);
      if (eventOwner) {
        throw new ConsoleModuleRegistrationError(`Event "${event.type}" collides between modules "${eventOwner}" and "${module.id}"`);
      }
      const schemaOwner = this.schemaOwners.get(event.schemaId);
      if (schemaOwner) {
        throw new ConsoleModuleRegistrationError(`Schema "${event.schemaId}" collides between modules "${schemaOwner}" and "${module.id}"`);
      }
    }
    for (const schema of module.schemas ?? []) {
      const owner = this.schemaOwners.get(schema.id);
      if (owner) {
        throw new ConsoleModuleRegistrationError(`Schema "${schema.id}" collides between modules "${owner}" and "${module.id}"`);
      }
    }
  }
}

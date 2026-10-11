/** Private server composition. No request-selected kind, automatic admission or eviction. */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { UserIdResolver } from '../database/UserContext.js';
import { withUserRead } from '../database/rls.js';
import { validateUserId } from '../state/db-persistence-utils.js';
import { MemoryManager } from '../elements/memories/MemoryManager.js';
import type { ElementManagerDeps } from '../elements/base/BaseElementManager.js';
import { DatabaseMemoryModeEnforcingStorageLayerFactory } from './DatabaseMemoryModeEnforcingStorageLayerFactory.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from './DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from './DatabaseMemoryLegacyMutationGuard.js';
import type { DormantDurableMemoryComposition } from './DatabaseStorageLayerFactory.js';
import type { MemoryBootIdentity } from './DatabaseMemoryBootQualification.js';
import type { MemoryHandoffAttribution } from './DatabaseMemoryCandidateHandoff.js';

export interface TenantMemoryCapture { readonly protocolVersion: 1 }
interface Entry {
  readonly manager: MemoryManager;
  readonly durable?: DormantDurableMemoryComposition;
}
interface Slot {
  readonly tenant: string;
  readonly initialization: Promise<Entry>;
  qualification?: Promise<void>;
  qualificationAttempted?: boolean;
  entry?: Entry;
}
interface Dependencies {
  readonly db: DatabaseInstance;
  readonly getEffectiveTenant: UserIdResolver;
  readonly createManagerDeps: (factory: DatabaseMemoryModeEnforcingStorageLayerFactory,
    resolver: UserIdResolver) => ElementManagerDeps;
  readonly getAttribution: () => MemoryHandoffAttribution;
}

export class DatabaseTenantMemoryRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly captures = new WeakMap<TenantMemoryCapture, Slot>();
  private stopped = false;
  constructor(private readonly deps: Dependencies) {}

  matchesDatabase(db: DatabaseInstance): boolean { return db === this.deps.db; }

  /** Recheck an existing trusted slot without a new selection or asynchronous work. */
  assertCurrent(capture: TenantMemoryCapture): void { this.requireCapture(capture); }

  /** Existing authentic selection only; this grants no new selection or boot authority. */
  getCapturedTenant(capture: TenantMemoryCapture): string { return this.requireCapture(capture).tenant; }

  /** Capture trusted effective context synchronously; the opaque slot is not a tenant selector. */
  capture(expectedTenant?: string): TenantMemoryCapture {
    try { return this.captureBound(expectedTenant); }
    catch (cause) { this.observeFailure('capture'); throw cause; }
  }

  private captureBound(expectedTenant?: string): TenantMemoryCapture {
    const tenant = this.deps.getEffectiveTenant();
    validateUserId(tenant);
    if (expectedTenant !== undefined && tenant !== expectedTenant) {
      throw new Error('Effective memory tenant differs from the trusted construction identity');
    }
    this.requireTenant(tenant);
    let slot = this.slots.get(tenant);
    if (!slot) {
      // Install the one flight before it can perform asynchronous work.
      const initialization = Promise.resolve().then(() => this.initialize(tenant));
      slot = { tenant, initialization };
      this.slots.set(tenant, slot);
      // Retain failed slots and contain only this observer branch, not the caller's rejection.
      void initialization.then(entry => { slot!.entry = entry; if (this.stopped) entry.durable?.close(); }, () => {});
    }
    const capture = Object.freeze({ protocolVersion: 1 as const });
    this.captures.set(capture, slot);
    return capture;
  }

  async resolve(capture: TenantMemoryCapture): Promise<MemoryManager> {
    try {
      const slot = this.requireCapture(capture);
      const entry = await slot.initialization;
      this.requireCapture(capture);
      return entry.manager;
    } catch (cause) { this.observeFailure('resolve'); throw cause; }
  }

  /** Trusted boot owner only. Request handlers receive resolve, not this admission method. */
  async qualify(capture: TenantMemoryCapture, inspect: (identity: MemoryBootIdentity) => Promise<void>): Promise<void> {
    try { await this.qualifyBound(capture, inspect); }
    catch (cause) { this.observeFailure('qualify'); throw cause; }
  }

  private async qualifyBound(capture: TenantMemoryCapture, inspect: (identity: MemoryBootIdentity) => Promise<void>): Promise<void> {
    const slot = this.requireCapture(capture);
    const entry = await slot.initialization;
    this.requireCapture(capture);
    if (!entry.durable) throw new Error('Legacy memory entry cannot receive guarded qualification');
    if (!slot.qualification) {
      if (slot.qualificationAttempted) throw new Error('Tenant boot qualification attempt already completed');
      slot.qualificationAttempted = true;
      slot.qualification = entry.durable.qualify(inspect);
      void slot.qualification.then(() => { slot.qualification = undefined; }, () => { slot.qualification = undefined; });
    }
    await slot.qualification;
    this.requireCapture(capture);
  }

  /** Stop future access; not cancellation, completed drain, disposal or candidate deletion. */
  close(): void {
    this.stopped = true;
    for (const slot of this.slots.values()) slot.entry?.durable?.close();
  }

  private observeFailure(stage: 'capture' | 'resolve' | 'qualify'): void {
    try {
      SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'HIGH',
        source: 'DatabaseTenantMemoryRegistry',
        details: `Tenant memory boundary failed; stage=${stage}; outcome=unclassified; invocation=${randomUUID()}` });
    } catch {
      try { logger.warn('Tenant memory observer failed'); } catch { /* Preserve original refusal. */ }
    }
  }

  private requireCapture(capture: TenantMemoryCapture): Slot {
    const slot = this.captures.get(capture);
    if (!slot) throw new Error('Authentic tenant memory capture required');
    this.requireTenant(slot.tenant);
    return slot;
  }

  private requireTenant(tenant: string): void {
    if (this.stopped || this.deps.getEffectiveTenant() !== tenant) throw new Error('Tenant memory binding changed or closed');
  }

  private async initialize(tenant: string): Promise<Entry> {
    this.requireTenant(tenant);
    const rows = await withUserRead(this.deps.db, tenant, async tx => {
      const roles = await tx.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`);
      if (roles.length !== 1 || roles[0].rolsuper !== false || roles[0].rolbypassrls !== false) {
        throw new Error('Ordinary database memory role required');
      }
      this.requireTenant(tenant);
      return tx.execute(sql`SELECT protocol_version, profile, mode, generation::text AS generation
        FROM public.memory_backend_modes WHERE user_id=${tenant}::uuid AND backend='database'`);
    });
    this.requireTenant(tenant);
    if (rows.length !== 1 || rows[0].protocol_version !== 1 || typeof rows[0].generation !== 'string' ||
      !/^[1-9]\d*$/u.test(rows[0].generation) || BigInt(rows[0].generation) > 9223372036854775807n) {
      throw new Error('Explicit known tenant memory mode required');
    }
    const row = rows[0];
    const legacy = row.mode === 'legacy' && row.profile === DATABASE_MEMORY_LEGACY_PROFILE;
    const guarded = (row.mode === 'guarded' || row.mode === 'read_only') && row.profile === DATABASE_MEMORY_ADMISSION_PROFILE;
    if (!legacy && !guarded) throw new Error('Unsupported tenant memory mode');
    const resolver = () => { this.requireTenant(tenant); return tenant; };
    const factory = new DatabaseMemoryModeEnforcingStorageLayerFactory(this.deps.db, resolver);
    const deps = this.deps.createManagerDeps(factory, resolver);
    if (deps.storageLayerFactory !== factory || deps.getCurrentUserId !== resolver) {
      throw new Error('Tenant memory dependencies must preserve actual factory and resolver');
    }
    // Captures can start this flight before operation authorization. DB-only
    // construction must never register file watchers or auto-reload callbacks.
    if (deps.fileWatchService !== undefined) throw new Error('Tenant DB memory construction excludes filesystem watchers');
    this.requireTenant(tenant);
    if (legacy) return { manager: new MemoryManager(deps) };
    const durable = factory.createDurableAdmittedMemoryManager(deps, this.deps.getAttribution);
    return { manager: durable.manager, durable };
  }
}

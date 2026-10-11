/** Trusted caller plumbing only; this module registers no production provider. */
import { randomUUID } from 'node:crypto';
import type { ContextTracker, ExecutionContext } from '../security/encryption/ContextTracker.js';
import type { MemoryManager } from '../elements/memories/MemoryManager.js';
import type { SessionContext } from '../context/SessionContext.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { logger } from '../utils/logger.js';
import type { DatabaseTenantMemoryRegistry, TenantMemoryCapture } from './DatabaseTenantMemoryRegistry.js';

export interface MemoryOperationCapture { readonly protocolVersion: 1 }
export interface BoundMemoryOperation {
  readonly manager: MemoryManager;
  /** Revalidate the original invocation without reselecting a tenant or manager. */
  readonly assertCurrent: () => void;
}
interface CapturedInvocation {
  readonly slot: TenantMemoryCapture;
  readonly context: ExecutionContext;
  readonly session: SessionContext;
  readonly requestId: string;
  readonly type: ExecutionContext['type'];
  readonly timestamp: number;
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string | null;
  readonly transport: SessionContext['transport'];
  readonly createdAt: number;
}

export class TenantMemoryOperationProvider {
  private readonly captures = new WeakMap<MemoryOperationCapture, CapturedInvocation>();
  private readonly operations = new WeakMap<BoundMemoryOperation, CapturedInvocation>();
  constructor(private readonly registry: DatabaseTenantMemoryRegistry,
    private readonly tracker: ContextTracker) {}

  /** Trusted composition must not validate one invocation while a caller reads another tracker. */
  assertContextTracker(tracker: ContextTracker | undefined): void {
    if (tracker !== this.tracker) throw new Error('Memory caller context tracker binding mismatch');
  }

  /** Must run at caller entry, before its first awaited step. */
  capture(): MemoryOperationCapture {
    try {
      const context = this.tracker.getContext();
      const session = context?.session;
      if (!context || !session || !context.requestId || !session.sessionId || !session.userId) {
        throw new Error('Attributed memory invocation required');
      }
      const invocation: CapturedInvocation = Object.freeze({
        slot: this.registry.capture(), context, session, requestId: context.requestId,
        type: context.type, timestamp: context.timestamp, userId: session.userId,
        sessionId: session.sessionId, tenantId: session.tenantId, transport: session.transport,
        createdAt: session.createdAt,
      });
      const capture = Object.freeze({ protocolVersion: 1 as const });
      this.captures.set(capture, invocation);
      this.requireCurrent(invocation);
      return capture;
    } catch (cause) { this.observeFailure('capture'); throw cause; }
  }

  async resolve(capture: MemoryOperationCapture): Promise<BoundMemoryOperation> {
    try {
      const invocation = this.captures.get(capture);
      if (!invocation) throw new Error('Authentic memory invocation capture required');
      this.requireCurrent(invocation);
      const manager = await this.registry.resolve(invocation.slot);
      this.requireCurrent(invocation);
      const operation = Object.freeze({ manager, assertCurrent: () => this.requireCurrent(invocation) });
      this.operations.set(operation, invocation);
      return operation;
    } catch (cause) { this.observeFailure('resolve'); throw cause; }
  }

  /** A nested caller may use only this provider's resolved operation, without recapture. */
  assertOperation(operation: BoundMemoryOperation): void {
    if (!this.operations.has(operation)) throw new Error('Authentic bound memory operation required');
    operation.assertCurrent();
  }

  /** Bind derived namespace paths to this operation's actual selected DB tenant. */
  getOperationTenant(operation: BoundMemoryOperation): string {
    this.assertOperation(operation);
    return this.registry.getCapturedTenant(this.operations.get(operation)!.slot);
  }

  private requireCurrent(invocation: CapturedInvocation): void {
    const context = this.tracker.getContext();
    const session = context?.session;
    if (context !== invocation.context || session !== invocation.session ||
      context.requestId !== invocation.requestId || context.type !== invocation.type ||
      context.timestamp !== invocation.timestamp || session.userId !== invocation.userId ||
      session.sessionId !== invocation.sessionId || session.tenantId !== invocation.tenantId ||
      session.transport !== invocation.transport || session.createdAt !== invocation.createdAt) {
      throw new Error('Memory invocation context changed');
    }
    this.registry.assertCurrent(invocation.slot);
  }

  private observeFailure(stage: 'capture' | 'resolve'): void {
    try {
      SecurityMonitor.logSecurityEvent({ type: 'OPERATION_FAILED', severity: 'HIGH',
        source: 'TenantMemoryOperationProvider',
        details: `Memory invocation boundary failed; stage=${stage}; outcome=unclassified; invocation=${randomUUID()}` });
    } catch {
      try { logger.warn('Memory invocation observer failed'); } catch { /* Retain original cause. */ }
    }
  }
}

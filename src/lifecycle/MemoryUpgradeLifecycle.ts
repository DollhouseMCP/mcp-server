import { AsyncLocalStorage } from 'node:async_hooks';

/** Internal process ownership only. This is not a persisted queue or a recovery authority. */
export interface MemoryDrainOwner {
  flushPendingSaves(): Promise<void>;
  hasRetainedMemoryWork(): boolean;
}

export type MemoryWriteOutcome = 'refused-before-write' | 'unknown' | 'known-committed';

export class MemoryWriteOutcomeError extends Error {
  constructor(readonly outcome: MemoryWriteOutcome, cause: unknown) {
    super(outcome === 'refused-before-write' && cause instanceof Error ? cause.message :
      'Memory persistence outcome requires reconciliation; retain the process and candidate', { cause });
    this.name = 'MemoryWriteOutcomeError';
  }
}

export interface MemoryWriteIdentity {
  readonly owner: object;
  readonly target: string;
  readonly scope?: string;
  readonly candidateDigest: string;
  /** Private original snapshot; never included in the operational summary. */
  readonly candidate: string;
}

export class MemoryDrainRefusedError extends Error {
  readonly code = 'EMEMORYDRAIN';
  constructor(message = 'Memory drain refused; retain the process and pending work') {
    super(message);
    this.name = 'MemoryDrainRefusedError';
  }
}

/** One root instance is shared by root, child and selected-tenant handlers. */
export class MemoryUpgradeLifecycle {
  private state: 'running' | 'quiescing' | 'refused' | 'drained' = 'running';
  private readonly context = new AsyncLocalStorage<{ kind: 'admitted' | 'drain'; active: boolean }>();
  private readonly admitted = new Set<Promise<unknown>>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly writeOwners = new Map<Promise<unknown>, object>();
  private readonly owners = new Set<MemoryDrainOwner>();
  private readonly stopSources = new Set<() => void>();
  private readonly failedWrites = new Map<symbol, { identity?: MemoryWriteIdentity; order: number; error: unknown; outcome: MemoryWriteOutcome }>();
  private writeOrder = 0;
  private readonly targetTails = new Map<string, Promise<void>>();
  private readonly targetContext = new AsyncLocalStorage<{ target: string; active: boolean }>();
  private drainPromise?: Promise<void>;
  private drainWork?: Promise<void>;
  private hold?: NodeJS.Timeout;

  registerOwner(owner: MemoryDrainOwner): void { this.owners.add(owner); }

  releaseOwner(owner: MemoryDrainOwner): void {
    if (owner.hasRetainedMemoryWork()) throw new MemoryDrainRefusedError();
    this.owners.delete(owner);
  }

  /** Restore a retained owner's user context without reviving an expired
   * request admission lease captured by AsyncLocalStorage.snapshot(). */
  runRetainedOwnerContext<T>(owner: MemoryDrainOwner, restore: (body: () => Promise<T>) => Promise<T>,
    body: () => Promise<T>): Promise<T> {
    const lease = this.context.getStore();
    if (!this.owners.has(owner) || (this.state !== 'running' && !(lease?.active && lease.kind === 'drain'))) {
      return Promise.reject(new MemoryDrainRefusedError());
    }
    return restore(() => this.context.run(lease ?? { kind: 'admitted', active: false }, body));
  }

  registerStopSource(stop: () => void): () => void {
    this.stopSources.add(stop);
    return () => this.stopSources.delete(stop);
  }

  /** Register synchronously, before invoking any request code or awaiting setup. */
  runRequest<T>(body: () => Promise<T>): Promise<T> {
    if (this.state !== 'running') return Promise.reject(new MemoryDrainRefusedError('Server is quiescing; request was not admitted'));
    const lease = { kind: 'admitted' as const, active: true };
    return this.track(this.admitted, () => this.context.run(lease, async () => {
      try { return await body(); }
      finally { lease.active = false; }
    }));
  }

  /** Tracks every original promise, rather than one token per memory name. */
  runWrite<T>(body: () => Promise<T>, identity?: MemoryWriteIdentity,
    classifyFailure?: (error: unknown) => MemoryWriteOutcome | undefined): Promise<T> {
    if (this.state !== 'running' && !this.context.getStore()?.active) return Promise.reject(new MemoryDrainRefusedError());
    if (identity && [...this.failedWrites.values()].some(failure =>
      failure.identity && ((failure.outcome !== 'refused-before-write' &&
        (failure.identity.scope ?? failure.identity.target) === (identity.scope ?? identity.target)) ||
        (failure.identity.owner === identity.owner && failure.identity.target === identity.target &&
          failure.identity.candidateDigest !== identity.candidateDigest)))) {
      return Promise.reject(new MemoryDrainRefusedError('Unreconciled memory candidate must be retained without replay'));
    }
    const order = ++this.writeOrder;
    const operation = this.track(this.writes, body);
    if (identity) this.writeOwners.set(operation, identity.owner);
    const attempt = Symbol('original-memory-write');
    void operation.then(() => {
      this.writeOwners.delete(operation);
      // An exact later known save may reconcile a settled failure. A different
      // generation, target, owner or payload never clears it; older promises
      // still belong to `writes` until their own settlement.
      if (!identity) return;
      for (const [key, failure] of this.failedWrites) {
        const prior = failure.identity;
        if (failure.outcome === 'refused-before-write' && failure.order < order && prior?.owner === identity.owner && prior.target === identity.target &&
          prior.candidateDigest === identity.candidateDigest) this.failedWrites.delete(key);
      }
    }, error => {
      this.writeOwners.delete(operation);
      const outcome = this.classifyFailedWrite(error, classifyFailure);
      // A guarded preacceptance refusal has no accepted publication to replay.
      // Its original public error and adapter state remain with the caller.
      if (outcome !== undefined) this.failedWrites.set(attempt, { identity, order, error, outcome });
    });
    return operation;
  }

  private classifyFailedWrite(error: unknown,
    classifyFailure?: (error: unknown) => MemoryWriteOutcome | undefined): MemoryWriteOutcome | undefined {
    if (classifyFailure) {
      try { return classifyFailure(error); }
      catch { return 'unknown'; }
    }
    if (error instanceof MemoryWriteOutcomeError) return error.outcome;
    return 'unknown';
  }

  hasRetainedWrites(owner: object): boolean {
    return [...this.writeOwners.values()].includes(owner) ||
      [...this.failedWrites.values()].some(failure => failure.identity?.owner === owner);
  }

  /** In-process FIFO only; never grants file/database ownership or guard admission. */
  async runTarget<T>(target: string, body: () => Promise<T>): Promise<T> {
    const held = this.targetContext.getStore();
    if (held?.active && held.target === target) return body();
    const prior = this.targetTails.get(target) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => gate);
    this.targetTails.set(target, tail);
    await prior;
    const lease = { target, active: true };
    try { return await this.targetContext.run(lease, body); }
    finally {
      lease.active = false;
      release();
      if (this.targetTails.get(target) === tail) this.targetTails.delete(target);
    }
  }

  getSummary(): Readonly<{ state: string; admitted: number; writes: number; owners: number; failedWrites: number; retainedOwners: number }> {
    return { state: this.state, admitted: this.admitted.size, writes: this.writes.size,
      owners: this.owners.size, failedWrites: this.failedWrites.size,
      retainedOwners: [...this.owners].filter(owner => owner.hasRetainedMemoryWork()).length };
  }

  /** No timeout cancellation, forced process exit, service close or candidate replay. */
  quiesceAndDrain(timeoutMs = 30_000): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.state === 'drained') return Promise.resolve();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('Invalid memory drain deadline'));
    this.state = 'quiescing';
    // Refusal must keep the process alive even when its remaining timers are unref'ed.
    this.hold ??= setInterval(() => {}, 60_000);
    this.drainPromise = this.drain(timeoutMs);
    return this.drainPromise;
  }

  private async drain(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      for (const stop of this.stopSources) stop();
      const lease = { kind: 'drain' as const, active: true };
      const previous = this.drainWork;
      const complete = this.context.run(lease, async () => {
        try {
        // A deadline never cancels the original drain. A later signal must not
        // start duplicate flushes while that original work is still unsettled.
        if (previous) await previous.catch(() => {});
        await this.settle(this.admitted);
        await this.settle(this.writes);
        // One refusing owner must not prevent another retained owner from
        // settling its original work. Final state remains the safety oracle.
        const flushed = await Promise.allSettled([...this.owners].map(owner => owner.flushPendingSaves()));
        await this.settle(this.writes);
        if (this.failedWrites.size || [...this.owners].some(owner => owner.hasRetainedMemoryWork())) {
          const failure = flushed.find(result => result.status === 'rejected');
          throw failure?.status === 'rejected' ? failure.reason : new MemoryDrainRefusedError();
        }
        } finally { lease.active = false; }
      });
      this.drainWork = complete;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MemoryDrainRefusedError('Memory drain deadline reached; original work remains retained')), timeoutMs);
      });
      await Promise.race([complete, deadline]);
      this.state = 'drained';
      if (this.hold) clearInterval(this.hold);
      this.hold = undefined;
    } catch (error) {
      this.state = 'refused';
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // An explicitly requested later drain may settle an exact retained
      // candidate after its infrastructure fault is resolved. Admission stays
      // closed; the failed attempt is not cleared merely by requesting retry.
      this.drainPromise = undefined;
    }
  }

  private async settle(operations: Set<Promise<unknown>>): Promise<void> {
    while (operations.size) await Promise.allSettled(operations);
  }

  private track<T>(set: Set<Promise<unknown>>, body: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(body);
    set.add(operation);
    void operation.then(() => set.delete(operation), () => set.delete(operation));
    return operation;
  }
}

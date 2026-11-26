import type { BlockMutation, IDangerZoneBlockStore } from '../state/IDangerZoneBlockStore.js';

interface Entry {
  mutation: BlockMutation;
  receipt: Promise<boolean>;
  settle: (saved: boolean) => void;
}

/** Ordered mutations and their durability receipts, independent of owner readiness. */
export class BlockPersistenceQueue {
  private readonly entries: Entry[] = [];
  private state: Record<string, unknown> = Object.create(null);
  private paused = true;
  private recovering = false;
  private draining?: Promise<void>;
  private active?: Entry;

  constructor(
    private readonly store: IDangerZoneBlockStore,
    private readonly ready: () => boolean,
    private readonly failed: (error: unknown) => void,
    private readonly reconcile: () => Promise<boolean>,
  ) {}

  /** Admit every mutation and return its durability receipt, regardless of readiness. */
  admit(mutation: BlockMutation): Promise<boolean> {
    let settle!: Entry['settle'];
    const receipt = new Promise<boolean>(resolve => { settle = resolve; });
    this.entries.push({ mutation, receipt, settle });
    if (!this.ready() && !this.paused) this.unavailable();
    this.drain();
    return receipt;
  }

  /** Stop admission from starting writes; let the in-flight write finish. */
  async pause(): Promise<void> {
    this.paused = true;
    await this.draining;
  }

  /** Rebase the durable snapshot after an authoritative read or reset. */
  replace(snapshot: Record<string, unknown>): void {
    this.state = Object.assign(Object.create(null), snapshot);
  }

  /** Overlay queued mutations on the durable snapshot for local enforcement. */
  projected(): Record<string, unknown> {
    const snapshot = Object.assign(Object.create(null), this.state);
    for (const entry of this.entries) this.applyTo(snapshot, entry.mutation);
    return snapshot;
  }

  /** Blocks admitted during unavailability belong in the new durable snapshot. */
  pendingBlocks(): Record<string, unknown> {
    const blocks: Record<string, unknown> = Object.create(null);
    for (const { mutation } of this.entries) {
      if (mutation.kind === 'put') this.applyTo(blocks, mutation);
    }
    return blocks;
  }

  /** Capture the reset boundary before later blocks are admitted. */
  resetBoundary(): () => void {
    const preceding = new Set(this.entries);
    return () => {
      for (let index = this.entries.length - 1; index >= 0; index--) {
        const entry = this.entries[index];
        if (preceding.has(entry)) {
          entry.settle(false);
          this.entries.splice(index, 1);
        }
      }
      this.replace({});
    };
  }

  /** Allow the ready owner to drain admitted mutations in order. */
  async resume(): Promise<boolean> {
    if (this.recovering) {
      // Include blocks admitted while the repair was being read with writes paused.
      for (const entry of this.entries) {
        if (entry.mutation.kind === 'put') entry.mutation = { ...entry.mutation, replay: true };
      }
      this.recovering = false;
    }
    this.paused = false;
    this.drain();
    const draining = this.draining;
    await draining;
    return draining !== undefined;
  }

  /** Retain blocks for recovery, but require a fresh request for failed releases. */
  unavailable(): void {
    this.recovering = true;
    this.paused = false;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      entry.settle(false);
      if (entry.mutation.kind !== 'put') this.entries.splice(index, 1);
    }
  }

  /** Fence the entries present at invocation, including already failed retries. */
  fence(): Promise<boolean> {
    const receipts = this.entries.map(entry => entry.receipt);
    if (this.active) receipts.push(this.active.receipt);
    return Promise.all(receipts).then(results => results.every(Boolean));
  }

  private drain(): void {
    if (this.draining || this.paused || !this.ready()) return;
    const operation = this.writeEntries().finally(() => {
      this.draining = undefined;
      if (this.entries.length && !this.paused && this.ready()) this.drain();
    });
    this.draining = operation;
  }

  private async writeEntries(): Promise<void> {
    while (this.entries.length && !this.paused && this.ready()) {
      const entry = this.entries[0];
      this.active = entry;
      const snapshot = Object.assign(Object.create(null), this.state);
      this.applyTo(snapshot, entry.mutation);
      try {
        const applied = await this.store.apply(entry.mutation, snapshot);
        this.entries.shift();
        if (applied) this.state = typeof applied === 'object' ? applied.snapshot : snapshot;
        else await this.reconcile();
        entry.settle(Boolean(applied) && this.ready());
      } catch (error) {
        entry.settle(false);
        this.failed(error);
        this.unavailable();
        return;
      } finally {
        this.active = undefined;
      }
    }
  }

  private applyTo(snapshot: Record<string, unknown>, mutation: BlockMutation): void {
    if (mutation.kind === 'put') snapshot[mutation.name] = mutation.block;
    else if (mutation.kind === 'remove') delete snapshot[mutation.name];
    else for (const name of Object.keys(snapshot)) delete snapshot[name];
  }
}

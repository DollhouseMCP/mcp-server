import { performance } from 'node:perf_hooks';
import type { ErasurePublication } from '../../../../src/storage/FileMemoryOwnerSnapshots.js';

const categories = {
  'head-prepared-durable': 'head', 'ready-durable': 'head',
  'segment-durable': 'inventory', 'inventory-durable': 'inventory',
  'action-prepared-durable': 'actions', 'before-owner-action': 'actions',
  'after-owner-action': 'actions', 'action-durable': 'actions', 'owner-root-removed-durable': 'actions',
  'evidence-retiring-durable': 'retirement', 'retire-action-prepared-durable': 'retirement',
  'before-evidence-retirement': 'retirement', 'after-evidence-retirement': 'retirement',
  'evidence-retired-durable': 'retirement', 'after-audit': 'retirement', 'before-return': 'retirement',
} as const satisfies Record<ErasurePublication, string>;
interface Observation { count: number; firstMs: number; lastMs: number }

/** Fixed-size test evidence only: no I/O, promises, authority changes or per-entry clocks.
 * Times are hook ENTRY offsets, including surrounding proofs/publications. They
 * neither measure syscalls nor identify the exact head.run/executor.run boundary.
 */
export class ErasurePublicationDiagnostics {
  private started: number | undefined;
  private readonly labels: Partial<Record<ErasurePublication, Observation>> = {};
  private workReportMs: number | undefined;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  start(): void { this.started = this.clock(); }
  readonly publication = (label: ErasurePublication): void => {
    if (this.started === undefined || !Object.hasOwn(categories, label)) return;
    const elapsed = this.clock() - this.started;
    const prior = this.labels[label];
    if (prior) { prior.count++; prior.lastMs = elapsed; }
    else this.labels[label] = { count: 1, firstMs: elapsed, lastMs: elapsed };
  };
  readonly afterWork = (): void => {
    if (this.started !== undefined) this.workReportMs = this.clock() - this.started;
  };

  summary() {
    const groups: Record<string, Observation> = {};
    const labels: Partial<Record<ErasurePublication, Observation>> = {};
    for (const label of Object.keys(categories) as ErasurePublication[]) {
      const observed = this.labels[label];
      if (!observed) continue;
      labels[label] = { ...observed };
      const category = categories[label], group = groups[category];
      if (group) {
        group.count += observed.count;
        group.firstMs = Math.min(group.firstMs, observed.firstMs);
        group.lastMs = Math.max(group.lastMs, observed.lastMs);
      } else groups[category] = { ...observed };
    }
    const ready = labels['ready-durable']?.lastMs;
    const inventory = labels['inventory-durable']?.lastMs;
    const removed = labels['owner-root-removed-durable']?.lastMs;
    const span = (start: number | undefined, end: number | undefined) =>
      start === undefined || end === undefined ? undefined : end - start;
    // ready-durable precedes remaining head proof/handoff; this is explicitly
    // included in readyToInventoryMs rather than presented as pure inventory I/O.
    const boundarySpans = { operationStartToReadyMs: ready,
      readyToInventoryMs: span(ready, inventory), inventoryToOwnerRootRemovedMs: span(inventory, removed),
      ownerRootRemovedToWorkReportMs: span(removed, this.workReportMs) };
    return { basis: 'hook-entry offsets from operation start; inclusive spans, not syscall timings',
      groups, labels, boundarySpans, afterErasureWorkMs: this.workReportMs };
  }
}

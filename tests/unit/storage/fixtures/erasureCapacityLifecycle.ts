import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';

export const CAPACITY_OBSERVER_TIMEOUT_MS = 65_000;
interface LifecycleOptions {
  deadlineMs: number;
  label: string;
  /** Small isolated subprocess tests only; qualification uses the fixed default. */
  watchdogMs?: number;
  completed?: (timing: { cleanupMs: number; wholeMs: number; failed: boolean }) => void;
}

/** Test-only: never reject a timing observer while case writes remain active. */
export async function runErasureCapacityLifecycle(options: LifecycleOptions, body: (scope: {
  started: number;
  phase: (name: string) => void;
  registerCleanup: (cleanup: () => Promise<unknown>, root: string) => void;
}) => Promise<void>): Promise<void> {
  const started = performance.now();
  let phase = 'setup', root: string | undefined;
  let cleanup: (() => Promise<unknown>) | undefined;
  const failures: unknown[] = [];
  const retainFailure = (cause: unknown) => { if (!failures.includes(cause)) failures.push(cause); };
  // A referenced real timer terminates the dedicated process before Jest's
  // observer can reject and advance. Hard termination cannot claim cleanup.
  const watchdog = setTimeout(() => {
    try {
      writeSync(2, `ERASURE capacity terminal watchdog ${JSON.stringify({
        label: options.label.slice(0, 256), phase, root: root?.slice(0, 1024),
        elapsedMs: performance.now() - started, deadlineMs: options.deadlineMs,
        cleanupCompleted: false,
      })}\n`);
    } finally {
      process.exit(98);
    }
  }, options.watchdogMs ?? 60_000);
  let cleanupMs = 0;
  try {
    try {
      await body({ started, phase: name => { phase = name; }, registerCleanup: (next, allocatedRoot) => {
        cleanup = next; root = allocatedRoot;
      } });
    } catch (cause) { retainFailure(cause); }
    finally {
      phase = 'cleanup';
      const cleanupStarted = performance.now();
      try { if (cleanup) await cleanup(); }
      catch (cause) { retainFailure(cause); }
      cleanupMs = performance.now() - cleanupStarted;
    }
    const wholeMs = performance.now() - started;
    if (wholeMs > options.deadlineMs) failures.push(new Error(
      `Erasure capacity whole case exceeded ${options.deadlineMs} ms after awaited cleanup (${wholeMs.toFixed(3)} ms)`));
    phase = 'completed';
    try { options.completed?.({ cleanupMs, wholeMs, failed: failures.length > 0 }); }
    catch (cause) { retainFailure(cause); }
  } finally { clearTimeout(watchdog); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Erasure capacity body, cleanup or whole-case deadline failed', { cause: failures[0] });
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { runErasureCapacityLifecycle } from './erasureCapacityLifecycle.js';

type Scope = Parameters<Parameters<typeof runErasureCapacityLifecycle>[1]>[0];
interface FixtureScope {
  scope: Scope;
  cleanups: Map<string, () => Promise<unknown>>;
}
const active = new AsyncLocalStorage<FixtureScope>();

/** Only the dedicated ordinary erasure suite opts into this test-local context. */
export function runOrdinaryErasureCase(label: string, body: () => Promise<void>): Promise<void> {
  return runErasureCapacityLifecycle({ deadlineMs: 10_000, label,
    completed: timing => console.info('ERASURE ordinary complete', JSON.stringify({ label, ...timing, deadlineMs: 10_000 })),
  }, scope => {
    scope.phase('ordinary test body (includes setup and finally)');
    return active.run({ scope, cleanups: new Map() }, body);
  });
}

/** Register before setup awaits; outside the opted-in suite this is a no-op. */
export function registerOrdinaryErasureFixture(root: string, cleanup: () => Promise<unknown>): () => Promise<unknown> {
  const context = active.getStore();
  if (!context) return cleanup;
  let attempt: Promise<unknown> | undefined;
  const once = () => attempt ??= Promise.resolve().then(cleanup);
  context.cleanups.set(root, once);
  context.scope.registerCleanup(async () => {
    const failures: unknown[] = [];
    for (const remove of context.cleanups.values()) {
      try { await remove(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Ordinary erasure fixture cleanup failed', { cause: failures[0] });
  }, root);
  return once;
}

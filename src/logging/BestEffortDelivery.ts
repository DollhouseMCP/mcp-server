import { writeSync } from 'node:fs';

type DeliveryResult<T> = { delivered: true; value: T } | { delivered: false };
type FailureReporter = (source: string, suppressed: number, errorType: string) => void;
const REPORT_INTERVAL_MS = 60_000;

function reportFailure(source: string, suppressed: number, errorType: string): void {
  // This diagnostic must stay outside the logging pipeline.
  writeSync(2, `[${source}] Optional log delivery failed: ${errorType} (${suppressed} reports suppressed)\n`);
}

function failureType(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'non-error';
    const name: unknown = error.name;
    return typeof name === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.exec(name)?.[0] === name ? name : 'Error';
  } catch {
    return 'Error';
  }
}

/** Isolates optional observation. Never use for awaited, durable audit writes. */
export class BestEffortDelivery {
  private failures = 0;
  private failing = false;
  private lastReport = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(
    private readonly source: string,
    private readonly report: FailureReporter = reportFailure,
    private readonly now: () => number = Date.now,
  ) {}

  get failureCount(): number { return this.failures; }

  run<T>(deliver: () => T): DeliveryResult<T> {
    try {
      const value = deliver();
      // Promises/A+ thenables may be functions as well as objects.
      const then = value !== null && (typeof value === 'object' || typeof value === 'function')
        ? (value as { then?: unknown }).then : undefined;
      if (typeof then === 'function') {
        const pending = new Promise((resolve, reject) => { then.call(value, resolve, reject); });
        void pending.then(() => { this.failing = false; }, error => { this.failed(error); });
      } else {
        this.failing = false;
      }
      return { delivered: true, value };
    } catch (error) {
      this.failed(error);
      return { delivered: false };
    }
  }

  async runAsync(deliver: () => Promise<void>): Promise<void> {
    try {
      await deliver();
      this.failing = false;
    } catch (error) {
      this.failed(error);
    }
  }

  wrap<Args extends unknown[]>(deliver: (...args: Args) => void): (...args: Args) => void {
    return (...args) => { this.run(() => deliver(...args)); };
  }

  private failed(error: unknown): void {
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
    try {
      const now = this.now();
      if (this.failing || now - this.lastReport < REPORT_INTERVAL_MS) {
        this.suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed + 1);
        this.failing = true;
        return;
      }
      this.failing = true;
      const suppressed = this.suppressed;
      this.suppressed = 0;
      this.lastReport = now;
      this.report(this.source, suppressed, failureType(error));
    } catch { /* Diagnostics are also best effort. */ }
  }
}

/** Each subscription has independent failure health and an exact unsubscribe. */
export class BestEffortListeners<Args extends unknown[]> {
  private readonly listeners = new Map<(...args: Args) => void, BestEffortDelivery>();

  constructor(private readonly source: string) {}

  add(listener: (...args: Args) => void): { deliver: (...args: Args) => void; remove: () => void } {
    const guard = new BestEffortDelivery(this.source);
    const deliver = guard.wrap(listener);
    this.listeners.set(deliver, guard);
    return { deliver, remove: () => { this.listeners.delete(deliver); } };
  }

  emit(...args: Args): void {
    Array.from(this.listeners.keys()).forEach(listener => listener(...args));
  }
}

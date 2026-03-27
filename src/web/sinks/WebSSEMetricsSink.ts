/**
 * Thin IMetricsSink adapter that bridges MetricsManager to the web console SSE stream.
 *
 * onSnapshot() calls the onSnapshot function from metricsRoutes.
 * flush()/close() are no-ops — the SSE connections are managed by Express.
 */

import type { IMetricsSink, MetricSnapshot } from '../../metrics/types.js';

export class WebSSEMetricsSink implements IMetricsSink {
  readonly name = 'WebSSEMetricsSink';

  constructor(private readonly pushSnapshot: (snapshot: MetricSnapshot) => void) {}

  onSnapshot(snapshot: MetricSnapshot): void {
    this.pushSnapshot(snapshot);
  }

  async flush(): Promise<void> {
    // No-op — SSE writes are immediate.
  }

  async close(): Promise<void> {
    // No-op — SSE connections managed by Express.
  }
}

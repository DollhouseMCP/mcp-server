/**
 * Thin ILogSink adapter that bridges LogManager to the web console SSE stream.
 *
 * write() calls the broadcast function from logRoutes.
 * flush()/close() are no-ops — the SSE connections are managed by Express.
 */

import type { ILogSink, UnifiedLogEntry } from '../../logging/types.js';

export class WebSSELogSink implements ILogSink {
  constructor(private readonly broadcast: (entry: UnifiedLogEntry) => void) {}

  write(entry: UnifiedLogEntry): void {
    this.broadcast(entry);
  }

  async flush(): Promise<void> {
    // No-op — SSE writes are immediate.
  }

  async close(): Promise<void> {
    // No-op — SSE connections managed by Express.
  }
}

/**
 * Observes Node SSE backpressure and closes persistently stalled clients.
 * The SDK owns heartbeat writes; its keepalive does not detect stalled clients.
 */
import type { ServerResponse } from 'node:http';

// Close a stalled response after three consecutive intervals without drain.
const MAX_MISSED_DRAIN_INTERVALS = 3;

export interface ISseStallWatcher {
  attach(response: ServerResponse): () => void;
}

export class SseStallWatcher implements ISseStallWatcher {
  constructor(private readonly intervalMs: number) {}

  attach(response: ServerResponse): () => void {
    if (this.intervalMs <= 0 || !isAcceptedSseResponse(response)) return () => {};
    let missed = 0;
    const stop = (): void => {
      clearInterval(timer);
      response.off('close', stop);
      response.off('finish', stop);
      response.off('error', stop);
    };
    const timer = setInterval(() => {
      if (!isAcceptedSseResponse(response)) { stop(); return; }
      if (response.writableNeedDrain) {
        if (++missed >= MAX_MISSED_DRAIN_INTERVALS) { stop(); response.destroy(); }
        return;
      }
      missed = 0;
    }, this.intervalMs);
    timer.unref();
    response.once('close', stop);
    response.once('finish', stop);
    response.once('error', stop);
    return stop;
  }
}

function isAcceptedSseResponse(response: ServerResponse): boolean {
  return response.headersSent && response.statusCode === 200 &&
    /^text\/event-stream(?:\s*;|$)/i.test(String(response.getHeader('content-type') ?? '')) &&
    !response.writableEnded && !response.destroyed;
}

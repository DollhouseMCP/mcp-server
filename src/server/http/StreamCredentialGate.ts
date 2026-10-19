import type { ServerResponse } from 'node:http';

const SDK_KEEPALIVE = ': keepalive\n\n';
const SDK_KEEPALIVE_BYTES = new TextEncoder().encode(SDK_KEEPALIVE);

function isSdkKeepalive(chunk: unknown, encoding?: BufferEncoding | WriteCallback): boolean {
  if (chunk instanceof Uint8Array) {
    return chunk.length === SDK_KEEPALIVE_BYTES.length && chunk.every((byte, index) => byte === SDK_KEEPALIVE_BYTES[index]);
  }
  return chunk === SDK_KEEPALIVE && (encoding === undefined || typeof encoding === 'function' || encoding === 'utf8');
}

type WriteCallback = (error?: Error | null) => void;

/**
 * Scope the gate to one standalone GET response, never a transport or POST.
 * SDK 1.31.0 enqueues complete SSE events; Hono forwards those chunks through
 * write(), including prefetched chunks. end(data) is gated defensively too.
 * Only the exact SDK heartbeat frame may pass after expiry: no SSE/JSON parsing,
 * retained payloads, callback replacement, or private SDK routing access.
 */
export function gateStreamWrites(response: ServerResponse, expired: () => boolean, onDrop?: () => void): () => void {
  // Exactly one gate per response; stop restores only our methods, never unwinding a later wrapper.
  const originalWrite = response.write;
  const originalEnd = response.end;
  const forwardWrite = originalWrite.bind(response);
  const forwardEnd = originalEnd.bind(response);
  const drop = (chunk: unknown, encoding?: BufferEncoding | WriteCallback): boolean => {
    const gated = expired();
    const dropped = gated && !isSdkKeepalive(chunk, encoding);
    if (dropped) onDrop?.();
    return dropped;
  };
  const write: ServerResponse['write'] = (chunk: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    if (drop(chunk, encoding)) {
      // Report consumed data so the SDK drains and discards instead of queuing.
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) queueMicrotask(() => done());
      return true;
    }
    return typeof encoding === 'string' ? forwardWrite(chunk, encoding, callback) : forwardWrite(chunk, encoding ?? callback);
  };
  const end: ServerResponse['end'] = (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): ServerResponse => {
    if (chunk !== undefined && typeof chunk !== 'function' && drop(chunk, encoding)) {
      return forwardEnd(typeof encoding === 'function' ? encoding : callback);
    }
    return typeof encoding === 'string' ? forwardEnd(chunk, encoding, callback) : forwardEnd(chunk, encoding ?? callback);
  };
  response.write = write;
  response.end = end;
  return () => {
    if (response.write === write) response.write = originalWrite;
    if (response.end === end) response.end = originalEnd;
  };
}

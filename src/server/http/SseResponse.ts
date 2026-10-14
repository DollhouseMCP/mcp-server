import type { ServerResponse } from 'node:http';

/** Public response state shared by stream acceptance and backpressure observation. */
export function isAcceptedSseResponse(response: ServerResponse): boolean {
  return response.headersSent && response.statusCode === 200 &&
    /^text\/event-stream(?:\s*;|$)/i.test(String(response.getHeader('content-type') ?? '')) &&
    !response.writableEnded && !response.destroyed;
}

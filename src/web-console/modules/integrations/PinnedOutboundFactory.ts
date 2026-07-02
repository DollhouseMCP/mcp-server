import type { LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

/**
 * A DNS resolution vetted by the public-host guard. The connection must reach
 * only `address`; `hostname` is preserved for SNI, the Host header, and TLS
 * certificate validation.
 */
export interface OutboundPin {
  readonly hostname: string;
  readonly address: string;
  readonly family: number;
}

export type PinnedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * A fetch bound to connect only to a pinned address, plus the socket-pool
 * lifetime it owns. Callers must close() once the response bodies they read
 * through `fetch` are fully consumed.
 */
export interface PinnedOutbound {
  readonly fetch: PinnedFetch;
  close(): Promise<void>;
}

/**
 * Given a vetted resolution, produce an outbound transport that connects ONLY
 * to the pinned address. This is the seam between the SSRF guard and the
 * network layer: a plain `typeof fetch` cannot express address pinning, so
 * every guarded outbound path consumes this factory instead.
 */
export type PinnedOutboundFactory = (pin: OutboundPin) => PinnedOutbound;

/**
 * Production factory: an undici Agent whose connect-time lookup returns only
 * the pinned address, so no second DNS resolution can influence the socket
 * target. The request URL keeps the original hostname, which undici uses for
 * SNI / Host / certificate validation.
 */
export function createPinnedOutboundFactory(): PinnedOutboundFactory {
  return pin => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: pin.address, family: pin.family }]);
        return;
      }
      callback(null, pin.address, pin.family);
    };
    const dispatcher = new Agent({
      connect: {
        lookup: pinnedLookup,
      },
    });
    const pinnedFetch: PinnedFetch = async (input, init) => {
      const response = await undiciFetch(input, {
        ...(init as UndiciRequestInit),
        dispatcher,
      });
      return response as unknown as Response;
    };
    return {
      fetch: pinnedFetch,
      close: () => dispatcher.close(),
    };
  };
}

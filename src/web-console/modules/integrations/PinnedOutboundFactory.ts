import type { LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

export interface OutboundPin {
  readonly hostname: string;
  readonly address: string;
  readonly family: number;
}

export type PinnedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PinnedOutbound {
  readonly fetch: PinnedFetch;
  close(): Promise<void>;
}

export type PinnedOutboundFactory = (pin: OutboundPin) => PinnedOutbound;

/** Create an outbound pool whose connect-time lookup can use only the vetted address. */
export function createPinnedOutboundFactory(): PinnedOutboundFactory {
  return pin => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: pin.address, family: pin.family }]);
        return;
      }
      callback(null, pin.address, pin.family);
    };
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
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

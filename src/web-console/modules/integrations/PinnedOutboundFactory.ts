import type { LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import { canonicalizeIntegrationApiHost } from '../../security/IntegrationApiHosts.js';

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
    const canonicalPinHostname = canonicalizeIntegrationApiHost(pin.hostname, 'pinned outbound hostname');
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: pin.address, family: pin.family }]);
        return;
      }
      callback(null, pin.address, pin.family);
    };
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
    const pinnedFetch: PinnedFetch = async (input, init) => {
      const url = new URL(input);
      const requestedHostname = url.hostname.toLowerCase().replace(/\.$/, '');
      if (requestedHostname !== canonicalPinHostname) {
        throw new Error('pinned outbound URL hostname does not match vetted hostname');
      }
      const response = await undiciFetch(url, {
        ...(init as UndiciRequestInit),
        // A credential-bearing request must never be replayed to a redirect target.
        redirect: 'error',
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

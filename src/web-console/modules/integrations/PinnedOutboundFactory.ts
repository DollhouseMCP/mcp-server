import type { LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import { canonicalizeIntegrationApiHost } from '../../security/IntegrationApiHosts.js';

/**
 * A DNS resolution vetted by the public-host guard. The connection must reach
 * only `address`; `hostname` remains the Host/SNI/certificate identity.
 */
export interface OutboundPin {
  readonly hostname: string;
  readonly address: string;
  readonly family: number;
}

export type PinnedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A host-bound fetch and the socket pool whose lifetime it owns. */
export interface PinnedOutbound {
  readonly fetch: PinnedFetch;
  close(): Promise<void>;
}

/** Convert one vetted DNS answer into a transport pinned to that address. */
export type PinnedOutboundFactory = (pin: OutboundPin) => PinnedOutbound;

/**
 * Create an undici Agent whose connect-time lookup can return only the vetted
 * address. The URL retains the vetted hostname for Host, SNI, and certificate
 * validation, and redirects cannot replay a credential-bearing request.
 */
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

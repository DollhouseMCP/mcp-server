/**
 * Optional DI override points for the outbound integration transport. When a service
 * is registered under one of these names, the gateway / remote-MCP bridge / OAuth
 * provider use it instead of the production default (pinned undici outbound / DNS
 * resolver / SDK MCP client). Defaults to production behavior when unregistered.
 * Wired integration tests register these to route outbound calls through a local
 * server while keeping the SSRF host guard fully enforced (the injected DNS resolver
 * returns a controlled public address; the injected pinned-outbound factory may
 * ignore the pin when routing by URL).
 *
 * Lives in the integrations module (not `di/Container.ts`) so registrars that only
 * see `DiContainerFacade` can resolve these names without importing the container.
 */
export const INTEGRATION_OUTBOUND_OVERRIDES = {
  pinnedOutboundFactory: 'IntegrationPinnedOutboundFactory',
  dnsLookup: 'IntegrationOutboundDnsLookup',
  remoteMcpClientFactory: 'IntegrationRemoteMcpClientFactory',
} as const;

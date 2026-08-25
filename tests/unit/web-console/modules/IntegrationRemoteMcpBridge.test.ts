import { describe, expect, it, jest } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import {
  ConfiguredOAuthIntegrationProvider,
  InMemoryIntegrationDescriptorStore,
  InMemoryUserIntegrationStore,
  IntegrationProviderRegistry,
  IntegrationTokenRefreshService,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
} from '../../../../src/web-console/index.js';
import {
  IntegrationRemoteMcpBridge,
  type IntegrationRemoteMcpBridgeError,
  type RemoteMcpClientFactory,
} from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';
import { integrationSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import type { DnsLookup } from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';
import type {
  OutboundPin,
  PinnedOutboundFactory,
} from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR_ID = '00000000-0000-4000-8000-000000000002';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000003';
const TIMESTAMP = new Date('2026-06-18T00:00:00Z');
const REMOTE_DOCS = 'remote-docs';
const LOOPBACK_IP = ['127', '0', '0', '1'].join('.');
const PRIVATE_IP = ['10', '0', '0', '5'].join('.');
const PUBLIC_IP = ['8', '8', '8', '8'].join('.');

describe('IntegrationRemoteMcpBridge', () => {
  it('discovers only allowlisted remote MCP tools for connected visible integrations', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn().mockResolvedValue({
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
          { name: 'delete_everything', description: 'Delete', inputSchema: { type: 'object', properties: {} } },
        ],
      }),
      callTool: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker, pins, closePinned } = fixture({ clientFactory });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(clientFactory).toHaveBeenCalledWith({
      serverUrl: new URL('https://mcp.example.com/mcp'),
      bearerToken: 'remote-access-token',
      pinnedFetch: expect.any(Function),
    });
    expect(pins).toEqual([{ hostname: 'mcp.example.com', address: PUBLIC_IP, family: 4 }]);
    expect(closePinned).toHaveBeenCalledTimes(1);
    expect(tools).toEqual([{
      provider: REMOTE_DOCS,
      remoteName: 'search',
      localName: 'remote_mcp_remote_docs_search',
      description: 'Search',
      inputSchema: { type: 'object', properties: {} },
      serverUrl: 'https://mcp.example.com/mcp',
    }]);
  });

  it('normalizes punctuation runs in generated local tool names', async () => {
    const remoteName = '---Search Docs///Now---';
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn().mockResolvedValue({
        tools: [{ name: remoteName, description: 'Search', inputSchema: { type: 'object' } }],
      }),
      callTool: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({
      clientFactory,
      descriptor: descriptor({
        operationPromotion: {
          remoteMcp: {
            serverUrl: 'https://mcp.example.com/mcp',
            tools: [remoteName],
          },
        },
      }),
    });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toHaveLength(1);
    expect(tools[0].localName).toBe('remote_mcp_remote_docs_search_docs_now');
  });

  it('proxies calls with decrypted credentials and untrusted provenance', async () => {
    const callTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn(),
      callTool,
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({ clientFactory });

    const result = await runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: { q: 'status' },
    }));

    expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'status' } });
    expect(result).toMatchObject({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      result: { content: [{ type: 'text', text: 'result' }] },
      provenance: {
        source: 'third_party_integration',
        trust: 'untrusted',
        handling: 'data_only_not_instructions',
      },
    });
  });

  it('refreshes an expired OAuth credential before retrying remote MCP discovery', async () => {
    const secretEncryption = encryption();
    const staleIntegration = {
      ...integration(secretEncryption),
      refreshTokenCiphertext: secretEncryption.encrypt(
        Buffer.from('remote-refresh-token', 'utf8'),
        integrationSecretContext('refresh_token', USER_ID, REMOTE_DOCS),
      ),
    };
    const refreshProvider = new ConfiguredOAuthIntegrationProvider({
      descriptor: descriptor(),
      clientSecret: 'remote-client-secret',
      dnsLookup: publicDnsLookup,
      pinnedOutbound: () => ({
        fetch: () => Promise.resolve(new Response(JSON.stringify({
          access_token: 'remote-refreshed-access-token',
          refresh_token: 'remote-rotated-refresh-token',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
        close: () => Promise.resolve(),
      }),
    });
    const bearerTokens: string[] = [];
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockImplementation(({ bearerToken, pinnedFetch }) => {
      bearerTokens.push(bearerToken);
      return Promise.resolve({
        listTools: bearerToken === 'remote-access-token'
          ? async () => {
              await pinnedFetch('https://mcp.example.com/mcp');
              throw new Error('Remote MCP request failed with HTTP 401');
            }
          : () => Promise.resolve({
              tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
            }),
        callTool: jest.fn(),
        close: jest.fn(() => Promise.resolve()),
      });
    });
    const { bridge, contextTracker } = fixture({
      integration: staleIntegration,
      providers: new IntegrationProviderRegistry([refreshProvider]),
      clientFactory,
      pinnedOutbound: () => ({
        fetch: () => Promise.resolve(new Response(null, { status: 401 })),
        close: () => Promise.resolve(),
      }),
    });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toHaveLength(1);
    expect(bearerTokens).toEqual(['remote-access-token', 'remote-refreshed-access-token']);
  });

  it('rejects remote MCP server URLs outside descriptor apiHosts', async () => {
    const { bridge, contextTracker } = fixture({
      descriptor: descriptor({
        operationPromotion: {
          remoteMcp: {
            serverUrl: 'https://evil.example.com/mcp',
            tools: ['search'],
          },
        },
      }),
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_server_not_allowed',
      status: 400,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
  });

  it('skips remote MCP discovery when DNS resolves to a private address', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>();
    const { bridge, contextTracker } = fixture({
      clientFactory,
      dnsLookup: () => Promise.resolve([{ address: LOOPBACK_IP, family: 4 }]),
    });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toEqual([]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects remote MCP calls when DNS resolves to a private address', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>();
    const { bridge, contextTracker } = fixture({
      clientFactory,
      dnsLookup: () => Promise.resolve([{ address: PRIVATE_IP, family: 4 }]),
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_host_not_allowed',
      status: 403,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects oversized remote MCP response streams', async () => {
    const oversizedBody = new Uint8Array(1024 * 1024 + 1);
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockImplementation(async ({ pinnedFetch }) => ({
      listTools: jest.fn(),
      callTool: jest.fn(async () => {
        const response = await pinnedFetch('https://mcp.example.com/mcp');
        await response.arrayBuffer();
        return {};
      }),
      close: jest.fn(() => Promise.resolve()),
    }));
    const close = jest.fn(() => Promise.resolve());
    const { bridge, contextTracker } = fixture({
      clientFactory,
      pinnedOutbound: () => ({
        fetch: () => Promise.resolve(new Response(oversizedBody)),
        close,
      }),
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_response_too_large',
      status: 502,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not use credentials from a revoked connected record', async () => {
    const secretEncryption = encryption();
    const revoked = {
      ...integration(secretEncryption),
      revokedAt: TIMESTAMP,
    };
    const clientFactory = jest.fn<RemoteMcpClientFactory>();
    const { bridge, contextTracker } = fixture({
      integration: revoked,
      clientFactory,
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_not_connected',
      status: 409,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('isolates failed and timed-out remote MCP discovery without failing the whole list', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>()
      .mockRejectedValueOnce(new Error('downstream unavailable'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { bridge, contextTracker } = fixture({
      descriptors: [
        descriptor({ provider: 'remote-down', id: '00000000-0000-4000-8000-000000000101' }),
        descriptor({ provider: 'remote-slow', id: '00000000-0000-4000-8000-000000000102' }),
      ],
      integrations: [
        integration(encryption(), 'remote-down'),
        integration(encryption(), 'remote-slow'),
      ],
      clientFactory,
      timeoutMs: 1,
    });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toEqual([]);
    expect(clientFactory).toHaveBeenCalledTimes(2);
  });

  it('rejects non-allowlisted remote tool calls', async () => {
    const { bridge, contextTracker } = fixture();

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'delete_everything',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_tool_not_allowed',
      status: 403,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
  });
});

function fixture(options: {
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly descriptors?: readonly IntegrationDescriptorRecord[];
  readonly integration?: UserIntegrationRecord;
  readonly integrations?: readonly UserIntegrationRecord[];
  readonly clientFactory?: RemoteMcpClientFactory;
  readonly providers?: IntegrationProviderRegistry;
  readonly pinnedOutbound?: PinnedOutboundFactory;
  readonly dnsLookup?: DnsLookup;
  readonly timeoutMs?: number;
} = {}) {
  const contextTracker = new ContextTracker();
  const secretEncryption = encryption();
  const descriptorRecords = options.descriptors ?? [options.descriptor ?? descriptor()];
  const integrationRecords = options.integrations ?? [options.integration ?? integration(secretEncryption)];
  const integrationStore = new InMemoryUserIntegrationStore(integrationRecords);
  const pins: OutboundPin[] = [];
  const closePinned = jest.fn(() => Promise.resolve());
  const pinnedOutbound: PinnedOutboundFactory = options.pinnedOutbound ?? (pin => {
    pins.push(pin);
    return {
      fetch: () => Promise.reject(new Error('fixture pinned fetch was not expected to run')),
      close: closePinned,
    };
  });
  return {
    contextTracker,
    pins,
    closePinned,
    bridge: new IntegrationRemoteMcpBridge({
      descriptorStore: new InMemoryIntegrationDescriptorStore(descriptorRecords),
      integrationStore,
      secretEncryption,
      contextTracker,
      tokenRefresh: options.providers
        ? new IntegrationTokenRefreshService({
            store: integrationStore,
            providers: options.providers,
            secretEncryption,
          })
        : undefined,
      pinnedOutbound,
      dnsLookup: options.dnsLookup ?? publicDnsLookup,
      timeoutMs: options.timeoutMs,
      clientFactory: options.clientFactory ?? (() => Promise.resolve({
        listTools: () => Promise.resolve({ tools: [] }),
        callTool: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      })),
    }),
  };
}

function descriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: DESCRIPTOR_ID,
    provider: REMOTE_DOCS,
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Remote Docs',
    category: 'knowledge',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['mcp.example.com'],
    oauth: {
      clientId: 'remote-docs-client',
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['docs.read'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    credentialKeyVersion: 'v1',
    operationPromotion: {
      remoteMcp: {
        serverUrl: 'https://mcp.example.com/mcp',
        tools: ['search'],
      },
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function integration(secretEncryption: AeadSecretEncryptionService, provider = REMOTE_DOCS): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['docs.read'] },
    accessTokenCiphertext: secretEncryption.encrypt(
      Buffer.from('remote-access-token', 'utf8'),
      integrationSecretContext('access_token', USER_ID, provider),
    ),
    refreshTokenCiphertext: null,
    credentialKeyVersion: 'v1',
    status: 'connected',
    errorReason: null,
    connectedAt: TIMESTAMP,
    lastSyncAt: null,
    revokedAt: null,
  };
}

const publicDnsLookup: DnsLookup = () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);

function encryption(): AeadSecretEncryptionService {
  return new AeadSecretEncryptionService({
    keyId: 'integration-test-key',
    key: Buffer.alloc(32, 9),
  });
}

async function runAsUser<T>(contextTracker: ContextTracker, fn: () => Promise<T>): Promise<T> {
  const context = contextTracker.createSessionContext('llm-request', {
    kind: 'http',
    sessionId: 'mcp-session-1',
    userId: USER_ID,
    tenantId: null,
    privilegeLevel: 'user',
  }, { toolName: 'remote_mcp_test' });
  return contextTracker.runAsync(context, fn);
}

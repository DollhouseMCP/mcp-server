import { describe, expect, it, jest } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryUserIntegrationStore,
  type IntegrationDescriptorRecord,
  type IUserIntegrationStore,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationRemoteMcpBridge,
  type IntegrationRemoteMcpBridgeError,
  type RemoteMcpClientFactory,
} from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';
import { integrationSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import type { DnsLookup } from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';
import type { PinnedFetch, PinnedOutboundFactory } from '../../../../src/web-console/modules/integrations/PinnedOutboundFactory.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR_ID = '00000000-0000-4000-8000-000000000002';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000003';
const TIMESTAMP = new Date('2026-06-18T00:00:00Z');
const REMOTE_DOCS = 'remote-docs';
const LOOPBACK_IP = ['127', '0', '0', '1'].join('.');
const PRIVATE_IP = ['10', '0', '0', '5'].join('.');
const PUBLIC_IP = ['8', '8', '8', '8'].join('.');

describe('IntegrationRemoteMcpBridge', () => {
  it('rejects a connected credential bound to a different same-name descriptor', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>();
    const { bridge, contextTracker } = fixture({
      integration: {
        ...integration(encryption()),
        integrationDescriptorId: '00000000-0000-4000-8000-000000000199',
      },
      clientFactory,
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({ code: 'remote_mcp_not_connected', status: 409 });
    expect(clientFactory).not.toHaveBeenCalled();
  });

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
    const { bridge, contextTracker } = fixture({ clientFactory });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(clientFactory).toHaveBeenCalledWith({
      serverUrl: new URL('https://mcp.example.com/mcp'),
      bearerToken: 'remote-access-token',
      pinnedFetch: expect.any(Function),
    });
    expect(tools).toEqual([{
      provider: REMOTE_DOCS,
      remoteName: 'search',
      localName: 'remote_mcp_remote_docs_search',
      description: 'Search',
      inputSchema: { type: 'object', properties: {} },
      serverUrl: 'https://mcp.example.com/mcp',
    }]);
  });

  it('accepts an equivalent canonical spelling of an allowlisted remote MCP host', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn().mockResolvedValue({
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({
      clientFactory,
      descriptor: descriptor({
        operationPromotion: {
          remoteMcp: {
            serverUrl: 'https://MCP.EXAMPLE.COM./mcp',
            tools: ['search'],
          },
        },
      }),
    });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toHaveLength(1);
    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: new URL('https://mcp.example.com./mcp'),
    }));
  });

  it('skips discovery for providers the discovery gate refuses, before any credential use', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>();
    const discoveryGate = jest.fn<(provider: string) => Promise<boolean>>().mockResolvedValue(false);
    const integrationStore = {
      findByProvider: jest.fn(),
    } as unknown as IUserIntegrationStore;
    const { bridge, contextTracker } = fixture({ clientFactory, discoveryGate, integrationStore });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(tools).toEqual([]);
    expect(discoveryGate).toHaveBeenCalledWith(REMOTE_DOCS);
    // Gate refusal must short-circuit BEFORE the credential lookup/decrypt and
    // before any outbound connection is attempted.
    expect(integrationStore.findByProvider).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('proxies calls with decrypted credentials and untrusted provenance', async () => {
    SecurityMonitor.clearAllEventsForTesting();
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

    await runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: { q: 'status' },
    }));
    const events = SecurityMonitor.getRecentEvents()
      .filter(entry => entry.source === 'IntegrationRemoteMcpBridge' && entry.details.includes('tool_call allowed'));
    expect(events).toHaveLength(2);
    expect(events[0]?.details).toBe(events[1]?.details);
  });

  it('redacts bearer-token echoes throughout remote MCP call results', async () => {
    const credential = 'remote-access-token';
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn(),
      callTool: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: `remote echoed ${credential}` }],
        structuredContent: {
          nested: [`Bearer ${credential}`, { [credential]: credential }],
        },
      }),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({ clientFactory });

    const result = await runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }));

    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.result).toMatchObject({
      content: [{ text: 'remote echoed [redacted]' }],
      structuredContent: {
        nested: ['Bearer [redacted]', { '[redacted]': '[redacted]' }],
      },
    });
  });

  it('replaces credential-bearing remote MCP errors with a static failure', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn(),
      callTool: jest.fn().mockRejectedValue(new Error('Bearer remote-access-token was rejected')),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({ clientFactory });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_call_failed',
      message: 'Remote MCP tool call failed.',
      status: 502,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationRemoteMcpBridge',
      details: expect.stringContaining('tool_call remote_mcp_call_failed'),
    }));
  });

  it('redacts bearer-token echoes from discovered tool metadata', async () => {
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn().mockResolvedValue({
        tools: [{
          name: 'search',
          description: 'Use remote-access-token to search',
          inputSchema: { type: 'object', description: 'Bearer remote-access-token' },
        }],
      }),
      callTool: jest.fn(),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({ clientFactory });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(JSON.stringify(tools)).not.toContain('remote-access-token');
    expect(tools[0]).toMatchObject({
      description: 'Use [redacted] to search',
      inputSchema: { description: 'Bearer [redacted]' },
    });
  });

  it('fails closed when a credential collides with behavior-defining wrapper metadata', async () => {
    const secretEncryption = encryption();
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockResolvedValue({
      listTools: jest.fn(),
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
      close: jest.fn(() => Promise.resolve()),
    });
    const { bridge, contextTracker } = fixture({
      clientFactory,
      integrations: [integration(secretEncryption, REMOTE_DOCS, REMOTE_DOCS)],
      secretEncryption,
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_response_invalid',
      status: 502,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
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

  it('rejects remote MCP server URLs containing user information', async () => {
    const { bridge, contextTracker } = fixture({
      descriptor: descriptor({
        operationPromotion: {
          remoteMcp: {
            serverUrl: 'https://user:password@mcp.example.com/mcp',
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
      code: 'remote_mcp_invalid_server_url',
      status: 400,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
  });

  it('rejects chunked remote MCP POST responses that exceed the byte cap', async () => {
    const encoder = new TextEncoder();
    const rawFetch = jest.fn<PinnedFetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('12345'));
        controller.enqueue(encoder.encode('67890'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const pinnedOutbound: PinnedOutboundFactory = () => ({
      fetch: rawFetch,
      close: () => Promise.resolve(),
    });
    const clientFactory = jest.fn<RemoteMcpClientFactory>().mockImplementation(async ({ pinnedFetch, serverUrl }) => {
      const response = await pinnedFetch(serverUrl, { method: 'POST' });
      await response.text();
      return {
        listTools: () => Promise.resolve({ tools: [] }),
        callTool: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      };
    });
    const { bridge, contextTracker } = fixture({
      clientFactory,
      pinnedOutbound,
      maxResponseBytes: 8,
    });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: {},
    }))).rejects.toMatchObject({
      code: 'remote_mcp_connect_failed',
      message: 'Remote MCP server connection failed.',
      status: 502,
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
        integration(encryption(), 'remote-down', 'remote-access-token', '00000000-0000-4000-8000-000000000201'),
        integration(encryption(), 'remote-slow', 'remote-access-token', '00000000-0000-4000-8000-000000000202'),
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

  it('denies remote MCP calls when the store returns a connected-but-revoked record (revocation race)', async () => {
    // A racing/future store implementation could hand back a record whose status
    // still reads 'connected' after revocation. The bridge must gate on the
    // shared isIntegrationConnected predicate (which checks revokedAt), not trust
    // the store's own read-time filtering.
    const revoked: UserIntegrationRecord = {
      ...integration(encryption()),
      status: 'connected',
      revokedAt: TIMESTAMP,
    };
    const integrationStore = {
      findByProvider: () => Promise.resolve(revoked),
    } as unknown as IUserIntegrationStore;
    const { bridge, contextTracker } = fixture({ integrationStore });

    await expect(runAsUser(contextTracker, () => bridge.callTool({
      provider: REMOTE_DOCS,
      remoteName: 'search',
      arguments: { q: 'status' },
    }))).rejects.toMatchObject({
      code: 'remote_mcp_not_connected',
      status: 409,
    } satisfies Partial<IntegrationRemoteMcpBridgeError>);
  });
});

function fixture(options: {
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly descriptors?: readonly IntegrationDescriptorRecord[];
  readonly integration?: UserIntegrationRecord;
  readonly integrations?: readonly UserIntegrationRecord[];
  readonly integrationStore?: IUserIntegrationStore;
  readonly secretEncryption?: AeadSecretEncryptionService;
  readonly clientFactory?: RemoteMcpClientFactory;
  readonly dnsLookup?: DnsLookup;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly pinnedOutbound?: PinnedOutboundFactory;
  readonly discoveryGate?: (provider: string) => Promise<boolean>;
} = {}) {
  const contextTracker = new ContextTracker();
  const secretEncryption = options.secretEncryption ?? encryption();
  const descriptorRecords = options.descriptors ?? [options.descriptor ?? descriptor()];
  const integrationRecords = options.integrations ?? [options.integration ?? integration(secretEncryption)];
  const boundIntegrationRecords = integrationRecords.map(record => ({
    ...record,
    integrationDescriptorId: record.integrationDescriptorId
      ?? descriptorRecords.find(candidate => candidate.provider === record.provider)?.id
      ?? null,
  }));
  return {
    contextTracker,
    bridge: new IntegrationRemoteMcpBridge({
      descriptorStore: new InMemoryIntegrationDescriptorStore(descriptorRecords),
      integrationStore: options.integrationStore ?? new InMemoryUserIntegrationStore(boundIntegrationRecords),
      secretEncryption,
      contextTracker,
      discoveryGate: options.discoveryGate ?? (() => Promise.resolve(true)),
      dnsLookup: options.dnsLookup ?? publicDnsLookup,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      pinnedOutbound: options.pinnedOutbound,
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

function integration(
  secretEncryption: AeadSecretEncryptionService,
  provider = REMOTE_DOCS,
  accessToken = 'remote-access-token',
  id = INTEGRATION_ID,
): UserIntegrationRecord {
  return {
    id,
    userId: USER_ID,
    provider,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['docs.read'] },
    accessTokenCiphertext: secretEncryption.encrypt(
      Buffer.from(accessToken, 'utf8'),
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

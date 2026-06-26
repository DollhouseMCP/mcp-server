import { describe, expect, it, jest } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryUserIntegrationStore,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationRemoteMcpBridge,
  type IntegrationRemoteMcpBridgeError,
  type RemoteMcpClientFactory,
} from '../../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';
import { integrationSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import type { DnsLookup } from '../../../../src/web-console/modules/integrations/IntegrationPublicHostGuard.js';

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
    const { bridge, contextTracker } = fixture({ clientFactory });

    const tools = await runAsUser(contextTracker, () => bridge.listAllowedTools());

    expect(clientFactory).toHaveBeenCalledWith({
      serverUrl: new URL('https://mcp.example.com/mcp'),
      bearerToken: 'remote-access-token',
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
  readonly dnsLookup?: DnsLookup;
  readonly timeoutMs?: number;
} = {}) {
  const contextTracker = new ContextTracker();
  const secretEncryption = encryption();
  const descriptorRecords = options.descriptors ?? [options.descriptor ?? descriptor()];
  const integrationRecords = options.integrations ?? [options.integration ?? integration(secretEncryption)];
  return {
    contextTracker,
    bridge: new IntegrationRemoteMcpBridge({
      descriptorStore: new InMemoryIntegrationDescriptorStore(descriptorRecords),
      integrationStore: new InMemoryUserIntegrationStore(integrationRecords),
      secretEncryption,
      contextTracker,
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

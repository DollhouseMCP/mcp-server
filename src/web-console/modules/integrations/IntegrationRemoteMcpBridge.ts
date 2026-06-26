import { lookup as dnsLookup } from 'node:dns/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import { logger } from '../../../utils/logger.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore, IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type { IUserIntegrationStore, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
} from './IntegrationPublicHostGuard.js';

const DEFAULT_REMOTE_MCP_TIMEOUT_MS = 5_000;

export interface IntegrationRemoteMcpBridgeOptions {
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly integrationStore: IUserIntegrationStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly contextTracker: ContextTracker;
  readonly clientFactory?: RemoteMcpClientFactory;
  readonly dnsLookup?: DnsLookup;
  readonly timeoutMs?: number;
}

export interface RemoteMcpTool {
  readonly provider: string;
  readonly remoteName: string;
  readonly localName: string;
  readonly description: string | undefined;
  readonly inputSchema: Tool['inputSchema'];
  readonly serverUrl: string;
}

export interface RemoteMcpCallInput {
  readonly provider: string;
  readonly remoteName: string;
  readonly arguments?: unknown;
}

export interface RemoteMcpCallResult {
  readonly provider: string;
  readonly remoteName: string;
  readonly result: unknown;
  readonly provenance: {
    readonly source: 'third_party_integration';
    readonly trust: 'untrusted';
    readonly provider: string;
    readonly remoteTool: string;
    readonly handling: 'data_only_not_instructions';
  };
}

export interface RemoteMcpClient {
  listTools(): Promise<{ tools: readonly Tool[] }>;
  callTool(input: { name: string; arguments?: Readonly<Record<string, unknown>> }): Promise<unknown>;
  close(): Promise<void>;
}

export type RemoteMcpClientFactory = (input: {
  readonly serverUrl: URL;
  readonly bearerToken: string;
}) => Promise<RemoteMcpClient>;

export class IntegrationRemoteMcpBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'IntegrationRemoteMcpBridgeError';
  }
}

export class IntegrationRemoteMcpBridge {
  private readonly clientFactory: RemoteMcpClientFactory;
  private readonly dnsLookupImpl: DnsLookup;
  private readonly timeoutMs: number;

  constructor(private readonly options: IntegrationRemoteMcpBridgeOptions) {
    this.clientFactory = options.clientFactory ?? createSdkRemoteMcpClient;
    this.dnsLookupImpl = options.dnsLookup ?? dnsLookup;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_MCP_TIMEOUT_MS;
  }

  async listAllowedTools(): Promise<readonly RemoteMcpTool[]> {
    const session = this.options.contextTracker.requireSessionContext('IntegrationRemoteMcpBridge');
    const descriptors = await this.options.descriptorStore.listVisible(session.userId);
    const tools: RemoteMcpTool[] = [];
    for (const descriptor of descriptors) {
      try {
        const discovered = await this.listDescriptorTools(descriptor, session.userId);
        tools.push(...discovered);
      } catch (error) {
        logger.warn('Remote MCP tool discovery skipped for integration descriptor', {
          provider: descriptor.provider,
          descriptorId: descriptor.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return tools.sort((left, right) => left.localName.localeCompare(right.localName));
  }

  private async listDescriptorTools(
    descriptor: IntegrationDescriptorRecord,
    userId: string,
  ): Promise<readonly RemoteMcpTool[]> {
    const config = readRemoteMcpConfig(descriptor);
    if (!config) return [];
    const integration = await this.options.integrationStore.findByProvider(userId, descriptor.provider);
    if (!isConnected(integration)) return [];
    await this.assertRemoteMcpPublicHost(config.serverUrl.hostname);
    const bearerToken = this.decryptAccessToken(integration, userId);
    const client = await this.connectClient(config.serverUrl, bearerToken);
    try {
      const listed = await withTimeout(
        client.listTools(),
        this.timeoutMs,
        'remote_mcp_list_timeout',
        'Remote MCP tools/list timed out.',
      );
      return listed.tools.flatMap(tool => {
        if (!config.allowedTools.has(tool.name)) return [];
        return [{
          provider: descriptor.provider,
          remoteName: tool.name,
          localName: remoteMcpLocalToolName(descriptor.provider, tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          serverUrl: config.serverUrl.toString(),
        }];
      });
    } finally {
      await client.close();
    }
  }

  async callTool(input: RemoteMcpCallInput): Promise<RemoteMcpCallResult> {
    const session = this.options.contextTracker.requireSessionContext('IntegrationRemoteMcpBridge');
    const descriptor = await this.options.descriptorStore.findVisibleByProvider(session.userId, input.provider);
    if (!descriptor) {
      throw new IntegrationRemoteMcpBridgeError('remote_mcp_descriptor_not_found', 'Remote MCP descriptor was not found.', 404);
    }
    const config = readRemoteMcpConfig(descriptor);
    if (!config?.allowedTools.has(input.remoteName)) {
      throw new IntegrationRemoteMcpBridgeError('remote_mcp_tool_not_allowed', 'Remote MCP tool is not allowlisted for this integration.', 403);
    }
    const integration = await this.options.integrationStore.findByProvider(session.userId, descriptor.provider);
    if (!isConnected(integration)) {
      throw new IntegrationRemoteMcpBridgeError('remote_mcp_not_connected', 'Remote MCP integration is not connected.', 409);
    }
    await this.assertRemoteMcpPublicHost(config.serverUrl.hostname);
    const client = await this.connectClient(config.serverUrl, this.decryptAccessToken(integration, session.userId));
    try {
      const result = await withTimeout(
        client.callTool({ name: input.remoteName, arguments: readArguments(input.arguments) }),
        this.timeoutMs,
        'remote_mcp_call_timeout',
        'Remote MCP tool call timed out.',
      );
      return {
        provider: descriptor.provider,
        remoteName: input.remoteName,
        result,
        provenance: {
          source: 'third_party_integration',
          trust: 'untrusted',
          provider: descriptor.provider,
          remoteTool: input.remoteName,
          handling: 'data_only_not_instructions',
        },
      };
    } finally {
      await client.close();
    }
  }

  private decryptAccessToken(record: UserIntegrationRecord, userId: string): string {
    if (!record.accessTokenCiphertext) {
      throw new IntegrationRemoteMcpBridgeError('remote_mcp_credential_missing', 'Remote MCP credential is missing.', 409);
    }
    try {
      return this.options.secretEncryption.decrypt(
        record.accessTokenCiphertext,
        integrationSecretContext('access_token', userId, record.provider),
      ).toString('utf8');
    } catch {
      throw new IntegrationRemoteMcpBridgeError('remote_mcp_credential_decrypt_failed', 'Remote MCP credential could not be decrypted.', 409);
    }
  }

  private async assertRemoteMcpPublicHost(hostname: string): Promise<void> {
    try {
      await assertPublicResolvedHost(hostname, this.dnsLookupImpl);
    } catch (error) {
      if (error instanceof PublicHostGuardError) {
        if (error.reason === 'resolution_failed') {
          throw new IntegrationRemoteMcpBridgeError('remote_mcp_host_resolution_failed', 'Remote MCP host could not be resolved.', 502);
        }
        throw new IntegrationRemoteMcpBridgeError('remote_mcp_host_not_allowed', 'Remote MCP host is not allowed.', 403);
      }
      throw error;
    }
  }

  private async connectClient(serverUrl: URL, bearerToken: string): Promise<RemoteMcpClient> {
    const clientPromise = this.clientFactory({ serverUrl, bearerToken });
    try {
      return await withTimeout(
        clientPromise,
        this.timeoutMs,
        'remote_mcp_connect_timeout',
        'Remote MCP server connection timed out.',
      );
    } catch (error) {
      // If the connection resolves after the timeout fired, close it so we don't leak
      // a dangling transport (the try/finally below only covers the post-connect phase).
      void clientPromise.then(client => client.close()).catch(() => { /* best-effort cleanup */ });
      throw error;
    }
  }
}

async function createSdkRemoteMcpClient(input: {
  readonly serverUrl: URL;
  readonly bearerToken: string;
}): Promise<RemoteMcpClient> {
  const client = new Client({ name: 'dollhousemcp-remote-bridge', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(input.serverUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${input.bearerToken}`,
      },
    },
  });
  await client.connect(transport);
  return {
    listTools: () => client.listTools(),
    callTool: request => client.callTool(request as { name: string; arguments?: Record<string, unknown> }),
    close: () => transport.close(),
  };
}

function readRemoteMcpConfig(descriptor: IntegrationDescriptorRecord): {
  readonly serverUrl: URL;
  readonly allowedTools: ReadonlySet<string>;
} | null {
  const remoteMcp = asRecord(descriptor.operationPromotion.remoteMcp);
  const serverUrlValue = remoteMcp.serverUrl;
  const tools = remoteMcp.tools;
  if (typeof serverUrlValue !== 'string' || !Array.isArray(tools)) return null;
  const serverUrl = parseAllowedServerUrl(serverUrlValue, descriptor);
  const allowedTools = new Set(tools.filter((tool): tool is string => typeof tool === 'string' && tool.trim() !== ''));
  return allowedTools.size > 0 ? { serverUrl, allowedTools } : null;
}

function parseAllowedServerUrl(value: string, descriptor: IntegrationDescriptorRecord): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationRemoteMcpBridgeError('remote_mcp_invalid_server_url', 'Remote MCP server URL is invalid.', 400);
  }
  if (url.protocol !== 'https:' || !descriptor.apiHosts.includes(url.hostname)) {
    throw new IntegrationRemoteMcpBridgeError(
      'remote_mcp_server_not_allowed',
      'Remote MCP server URL must use HTTPS and a descriptor apiHosts host.',
      400,
    );
  }
  return url;
}

function remoteMcpLocalToolName(provider: string, remoteName: string): string {
  return `remote_mcp_${sanitizeToolName(provider)}_${sanitizeToolName(remoteName)}`.slice(0, 96);
}

function sanitizeToolName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_').replaceAll(/^_{1,256}|_{1,256}$/g, '') || 'tool';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new IntegrationRemoteMcpBridgeError('remote_mcp_invalid_arguments', 'Remote MCP tool arguments must be an object.', 400);
}

function isConnected(record: UserIntegrationRecord | null): record is UserIntegrationRecord {
  return record?.status === 'connected';
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new IntegrationRemoteMcpBridgeError(code, message, 504));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

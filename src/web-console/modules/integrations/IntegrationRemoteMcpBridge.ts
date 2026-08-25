import { lookup as dnsLookup } from 'node:dns/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { ContextTracker } from '../../../security/encryption/ContextTracker.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import { logger } from '../../../utils/logger.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { IIntegrationDescriptorStore, IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';
import type { IUserIntegrationStore, UserIntegrationRecord } from '../../stores/IUserIntegrationStore.js';
import { integrationSecretContext } from './IntegrationSecretContext.js';
import { normalizeIntegrationToolName } from './IntegrationToolName.js';
import type { IntegrationTokenRefreshService } from './IntegrationTokenRefreshService.js';
import {
  assertPublicResolvedHost,
  PublicHostGuardError,
  type DnsLookup,
  type DnsLookupAddress,
} from './IntegrationPublicHostGuard.js';
import {
  createPinnedOutboundFactory,
  type PinnedFetch,
  type PinnedOutboundFactory,
} from './PinnedOutboundFactory.js';

const DEFAULT_REMOTE_MCP_TIMEOUT_MS = 5_000;
const MAX_REMOTE_MCP_RESPONSE_BYTES = 1024 * 1024;
const MAX_REMOTE_MCP_RESULT_DEPTH = 64;
const MAX_REMOTE_MCP_RESULT_NODES = 50_000;
const REDACTED_REMOTE_CREDENTIAL = '[redacted]';
const REMOTE_CREDENTIAL_VALUE_PATTERNS = [
  /\bBearer\s+[\w.+/=-]{8,}/gi,
  /\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[abprs]-)[\w-]{8,}/g,
  /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{20,}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,
];

export interface IntegrationRemoteMcpBridgeOptions {
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly integrationStore: IUserIntegrationStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly contextTracker: ContextTracker;
  readonly tokenRefresh?: IntegrationTokenRefreshService | null;
  readonly clientFactory?: RemoteMcpClientFactory;
  readonly pinnedOutbound?: PinnedOutboundFactory;
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
  readonly pinnedFetch: PinnedFetch;
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
  private readonly pinnedOutboundFactory: PinnedOutboundFactory;
  private readonly dnsLookupImpl: DnsLookup;
  private readonly timeoutMs: number;

  constructor(private readonly options: IntegrationRemoteMcpBridgeOptions) {
    this.clientFactory = options.clientFactory ?? createSdkRemoteMcpClient;
    this.pinnedOutboundFactory = options.pinnedOutbound ?? createPinnedOutboundFactory();
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
        this.auditRemote('discovery', 'failed');
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
    if (!isConnected(integration)) {
      this.auditRemote('discovery', 'not_connected');
      return [];
    }
    const vetted = await this.assertRemoteMcpPublicHost(config.serverUrl.hostname);
    const tools = await this.withRefreshablePinnedClient(descriptor, integration, userId, config.serverUrl, vetted, async (client, credential) => {
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
          description: tool.description === undefined
            ? undefined
            : redactRemoteCredentialString(tool.description, credential),
          inputSchema: redactRemoteMcpValue(
            tool.inputSchema,
            credential,
            new WeakSet<object>(),
            { nodes: 0 },
            0,
            false,
          ) as Tool['inputSchema'],
          serverUrl: config.serverUrl.toString(),
        }];
      });
    });
    this.auditRemote('discovery', 'allowed');
    return tools;
  }

  async callTool(input: RemoteMcpCallInput): Promise<RemoteMcpCallResult> {
    try {
      const result = await this.callToolInternal(input);
      this.auditRemote('tool_call', 'allowed');
      return result;
    } catch (error) {
      this.auditRemote('tool_call', 'failed');
      throw error;
    }
  }

  private async callToolInternal(input: RemoteMcpCallInput): Promise<RemoteMcpCallResult> {
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
    const vetted = await this.assertRemoteMcpPublicHost(config.serverUrl.hostname);
    return this.withRefreshablePinnedClient(descriptor, integration, session.userId, config.serverUrl, vetted, async (client, credential) => {
      const result = await withTimeout(
        client.callTool({ name: input.remoteName, arguments: readArguments(input.arguments) }),
        this.timeoutMs,
        'remote_mcp_call_timeout',
        'Remote MCP tool call timed out.',
      );
      return {
        provider: descriptor.provider,
        remoteName: input.remoteName,
        result: redactRemoteMcpResult(result, credential),
        provenance: {
          source: 'third_party_integration',
          trust: 'untrusted',
          provider: descriptor.provider,
          remoteTool: input.remoteName,
          handling: 'data_only_not_instructions',
        },
      };
    });
  }

  private auditRemote(action: 'discovery' | 'tool_call', outcome: string): void {
    SecurityMonitor.logSecurityEvent({
      type: outcome === 'allowed' ? 'OPERATION_COMPLETED' : 'OPERATION_FAILED',
      severity: outcome === 'allowed' ? 'LOW' : 'MEDIUM',
      source: 'IntegrationRemoteMcpBridge',
      details: `Remote MCP ${action} security decision recorded`,
      additionalData: { action, outcome },
    });
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

  private async assertRemoteMcpPublicHost(hostname: string): Promise<DnsLookupAddress> {
    try {
      return await assertPublicResolvedHost(hostname, this.dnsLookupImpl);
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

  private async withPinnedClient<T>(
    serverUrl: URL,
    bearerToken: string,
    vetted: DnsLookupAddress,
    work: (client: RemoteMcpClient) => Promise<T>,
  ): Promise<T> {
    const outbound = this.pinnedOutboundFactory({
      hostname: serverUrl.hostname,
      address: vetted.address,
      family: vetted.family,
    });
    let receivedUnauthorized = false;
    const observedFetch: PinnedFetch = async (input, init) => {
      const response = await outbound.fetch(input, init);
      if (response.status === 401) receivedUnauthorized = true;
      return response;
    };
    try {
      const client = await this.connectClient(serverUrl, bearerToken, observedFetch);
      try {
        return await work(client);
      } finally {
        await client.close();
      }
    } catch (error) {
      if (receivedUnauthorized) throw new RemoteMcpUnauthorizedResponseError(error);
      throw error;
    } finally {
      await outbound.close();
    }
  }

  private async withRefreshablePinnedClient<T>(
    descriptor: IntegrationDescriptorRecord,
    integration: UserIntegrationRecord,
    userId: string,
    serverUrl: URL,
    vetted: DnsLookupAddress,
    work: (client: RemoteMcpClient, credential: string) => Promise<T>,
  ): Promise<T> {
    const firstCredential = this.decryptAccessToken(integration, userId);
    try {
      return await this.withPinnedClient(serverUrl, firstCredential, vetted, client => work(client, firstCredential));
    } catch (error) {
      const tokenRefresh = this.options.tokenRefresh;
      if (!(error instanceof RemoteMcpUnauthorizedResponseError) ||
          !tokenRefresh?.canRefresh(descriptor, integration)) {
        throw unwrapRemoteMcpUnauthorizedError(error);
      }

      const refreshed = await tokenRefresh.refreshOnDemand({
        userId,
        provider: descriptor.provider,
        staleAccessTokenCiphertext: integration.accessTokenCiphertext,
      });
      if (refreshed.kind !== 'refreshed' && refreshed.kind !== 'reused') {
        throw new IntegrationRemoteMcpBridgeError(
          'remote_mcp_token_refresh_failed',
          'Remote MCP credential refresh failed.',
          502,
        );
      }
      const refreshedCredential = this.decryptAccessToken(refreshed.record, userId);
      try {
        return await this.withPinnedClient(serverUrl, refreshedCredential, vetted, client => work(client, refreshedCredential));
      } catch (retryError) {
        throw unwrapRemoteMcpUnauthorizedError(retryError);
      }
    }
  }

  private async connectClient(
    serverUrl: URL,
    bearerToken: string,
    pinnedFetch: PinnedFetch,
  ): Promise<RemoteMcpClient> {
    const clientPromise = this.clientFactory({
      serverUrl,
      bearerToken,
      pinnedFetch: boundedRemoteMcpFetch(pinnedFetch),
    });
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
  readonly pinnedFetch: PinnedFetch;
}): Promise<RemoteMcpClient> {
  const client = new Client({ name: 'dollhousemcp-remote-bridge', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(input.serverUrl, {
    fetch: input.pinnedFetch,
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
  return normalizeIntegrationToolName(value, 'tool');
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
  return record?.status === 'connected' && record.revokedAt === null;
}

function redactRemoteMcpResult(value: unknown, activeCredential: string): unknown {
  const seen = new WeakSet<object>();
  const budget = { nodes: 0 };
  return redactRemoteMcpValue(value, activeCredential, seen, budget, 0, true);
}

function redactRemoteMcpValue(
  value: unknown,
  activeCredential: string,
  seen: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
  redactCredentialKeys: boolean,
): unknown {
  budget.nodes += 1;
  if (depth > MAX_REMOTE_MCP_RESULT_DEPTH || budget.nodes > MAX_REMOTE_MCP_RESULT_NODES) {
    return REDACTED_REMOTE_CREDENTIAL;
  }
  if (typeof value === 'string') return redactRemoteCredentialString(value, activeCredential);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED_REMOTE_CREDENTIAL;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => redactRemoteMcpValue(
      item,
      activeCredential,
      seen,
      budget,
      depth + 1,
      redactCredentialKeys,
    ));
  }
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const safeKey = redactRemoteCredentialString(key, activeCredential);
    output[safeKey] = redactCredentialKeys && isRemoteCredentialKey(key)
      ? REDACTED_REMOTE_CREDENTIAL
      : redactRemoteMcpValue(field, activeCredential, seen, budget, depth + 1, redactCredentialKeys);
  }
  return output;
}

function redactRemoteCredentialString(value: string, activeCredential: string): string {
  let redacted = activeCredential === ''
    ? value
    : value.replaceAll(activeCredential, REDACTED_REMOTE_CREDENTIAL);
  for (const pattern of REMOTE_CREDENTIAL_VALUE_PATTERNS) {
    redacted = redacted.replaceAll(pattern, REDACTED_REMOTE_CREDENTIAL);
  }
  return redacted;
}

function isRemoteCredentialKey(key: string): boolean {
  return /(^|_)(access|refresh)?_?token($|_)|authorization|api[_-]?key|secret|password|cookie|ciphertext/i.test(key);
}

function boundedRemoteMcpFetch(pinnedFetch: PinnedFetch): PinnedFetch {
  return async (input, init) => {
    const response = await pinnedFetch(input, init);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_MCP_RESPONSE_BYTES) {
      throw remoteMcpResponseTooLarge();
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_REMOTE_MCP_RESPONSE_BYTES) {
          controller.error(remoteMcpResponseTooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function remoteMcpResponseTooLarge(): IntegrationRemoteMcpBridgeError {
  return new IntegrationRemoteMcpBridgeError(
    'remote_mcp_response_too_large',
    'Remote MCP response exceeded the maximum allowed size.',
    502,
  );
}

class RemoteMcpUnauthorizedResponseError extends Error {
  constructor(readonly originalError: unknown) {
    super('Remote MCP server rejected the integration credential.');
    this.name = 'RemoteMcpUnauthorizedResponseError';
  }
}

function unwrapRemoteMcpUnauthorizedError(error: unknown): unknown {
  return error instanceof RemoteMcpUnauthorizedResponseError ? error.originalError : error;
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

/**
 * Shared harness for the Integrations v2 end-of-phase WIRED tests.
 *
 * Boots a REAL DollhouseContainer with in-memory web-console integration stores,
 * registers the additive outbound-transport overrides so outbound calls reach a LOCAL
 * fake upstream while the SSRF host guard stays fully enforced (injected DNS returns a
 * public address; injected fetch routes to 127.0.0.1), seeds a descriptor + connected
 * credential (+ OpenAPI spec), and creates an HTTP session.
 *
 * Tests can drive the per-session tools either directly (`callViaRegistry`) or over the
 * real MCP protocol (`connectMcpClient`, using an in-memory linked transport pair).
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { INTEGRATION_OUTBOUND_OVERRIDES, type DollhouseContainer } from '../../../src/di/Container.js';
import { WebConsoleRegistrar, WEB_CONSOLE_SERVICE_NAMES } from '../../../src/web-console/WebConsoleRegistrar.js';
import { createHttpSession } from '../../../src/context/HttpSession.js';
import { integrationSecretContext } from '../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import { createIntegrationContainer, type IntegrationContainer } from '../../helpers/integration-container.js';
import type { ToolRegistry } from '../../../src/handlers/ToolRegistry.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { ISecretEncryptionService } from '../../../src/web-console/security/SecretEncryption.js';
import type { IIntegrationDescriptorStore } from '../../../src/web-console/stores/IIntegrationDescriptorStore.js';
import type { IIntegrationOpenApiSpecStore } from '../../../src/web-console/stores/IIntegrationOpenApiSpecStore.js';
import type { IUserIntegrationStore } from '../../../src/web-console/stores/IUserIntegrationStore.js';
import type { IPortfolioElementStore } from '../../../src/web-console/stores/IPortfolioElementStore.js';
import type { RemoteMcpClientFactory } from '../../../src/web-console/modules/integrations/IntegrationRemoteMcpBridge.js';
import type { SessionContext } from '../../../src/context/SessionContext.js';

export const PROVIDER = 'wired-rest';
export const API_HOST = 'api.wired.test';
export const ACCESS_TOKEN = 'wired-access-token';
const PUBLIC_DNS_ADDRESS = ['8', '8', '8', '8'].join('.');
const TIMESTAMP = new Date('2026-06-20T00:00:00Z');

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface ToolEnvelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface McpClientHandle {
  listToolNames(): Promise<readonly string[]>;
  callTool(name: string, args: unknown): Promise<ToolEnvelope>;
  close(): Promise<void>;
}

export interface WiredHarness {
  readonly container: DollhouseContainer;
  readonly userId: string;
  readonly curatedDescriptorId: string;
  readonly sessionContext: Readonly<SessionContext>;
  readonly descriptorStore: IIntegrationDescriptorStore;
  readonly specStore: IIntegrationOpenApiSpecStore;
  readonly userStore: IUserIntegrationStore;
  readonly portfolioStore: IPortfolioElementStore;
  readonly secretEncryption: ISecretEncryptionService;
  lastRequest(): CapturedRequest | undefined;
  hasTool(name: string): boolean;
  encryptAccessToken(userId: string, provider: string, token: string): Buffer;
  /** Seeds a BYO descriptor owned by the session user + a connected credential. Returns the descriptor id. */
  seedConnectedByoDescriptor(provider: string, host: string): Promise<string>;
  /** Reads a generated skill from the portfolio inside the session context. */
  findSkill(skillName: string): Promise<{ readonly content: string; readonly metadata: Readonly<Record<string, unknown>> } | null>;
  callViaRegistry(toolName: string, args: unknown): Promise<ToolEnvelope>;
  /** The bearer token most recently handed to the (default) remote-MCP client factory. */
  lastRemoteMcpBearerToken(): string | undefined;
  /** Opens a second per-session tool surface for a different user (for isolation tests). */
  openSession(forUserId: string): Promise<(toolName: string, args: unknown) => Promise<ToolEnvelope>>;
  connectMcpClient(): Promise<McpClientHandle>;
  dispose(): Promise<void>;
}

export interface WiredHarnessOptions {
  /** Adds a remoteMcp config to the curated descriptor (for remote-MCP bridge coverage). */
  readonly remoteMcp?: { readonly tools: readonly string[] };
  /** Injected remote MCP client factory (defaults to a stub echo client). */
  readonly remoteMcpClientFactory?: RemoteMcpClientFactory;
}

export function openApiSpec(host: string = API_HOST): Record<string, unknown> {
  return {
    openapi: '3.0.0',
    info: { title: 'Wired Test API', version: '1.0.0' },
    servers: [{ url: `https://${host}` }],
    paths: {
      '/things/{id}': {
        get: {
          operationId: 'getThing',
          summary: 'Fetch a thing by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/things': {
        post: {
          operationId: 'createThing',
          summary: 'Create a thing',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 201: { description: 'created' } },
        },
      },
    },
  };
}

function requestHref(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function startLocalUpstream(): Promise<{
  readonly baseUrl: URL;
  readonly captured: { value: CapturedRequest | undefined };
  close(): Promise<void>;
}> {
  const captured: { value: CapturedRequest | undefined } = { value: undefined };
  const server: HttpServer = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      captured.value = { method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      // A `/redact`-prefixed path returns a credential-shaped body so the gateway's
      // response redaction can be exercised end-to-end.
      const responseBody = (req.url ?? '').includes('redact')
        ? { access_token: 'leaked-by-upstream', data: 'ok' }
        : { ok: true, path: req.url, received: body || null };
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: new URL(`http://127.0.0.1:${port}`),
    captured,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function defaultRemoteMcpClientFactory(captureBearer: (token: string) => void): RemoteMcpClientFactory {
  return input => {
    captureBearer(input.bearerToken);
    return Promise.resolve({
      listTools: () => Promise.resolve({
        tools: [
          { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: {} } },
          { name: 'secret', description: 'Not allowlisted', inputSchema: { type: 'object', properties: {} } },
        ],
      }),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'remote-echo' }] }),
      close: () => Promise.resolve(),
    });
  };
}

function parseToolEnvelope(text: string): ToolEnvelope {
  return JSON.parse(text) as ToolEnvelope;
}

export async function bootWiredIntegration(options: WiredHarnessOptions = {}): Promise<WiredHarness> {
  const upstream = await startLocalUpstream();
  const ic: IntegrationContainer = await createIntegrationContainer({ initializePortfolio: true });
  const container: DollhouseContainer = ic.container;
  await container.preparePortfolio();

  // Additive outbound-transport overrides — pass the SSRF guard with a public DNS answer
  // while routing the actual bytes to the local upstream.
  const dnsLookup = () => Promise.resolve([{ address: PUBLIC_DNS_ADDRESS, family: 4 }]);
  const routedFetch: typeof fetch = (input, init) => {
    const requested = new URL(requestHref(input));
    return fetch(new URL(`${requested.pathname}${requested.search}`, upstream.baseUrl), init);
  };
  const remoteMcpBearer: { value: string | undefined } = { value: undefined };
  container.register(INTEGRATION_OUTBOUND_OVERRIDES.dnsLookup, () => dnsLookup);
  container.register(INTEGRATION_OUTBOUND_OVERRIDES.fetch, () => routedFetch);
  container.register(
    INTEGRATION_OUTBOUND_OVERRIDES.remoteMcpClientFactory,
    () => options.remoteMcpClientFactory ?? defaultRemoteMcpClientFactory(token => { remoteMcpBearer.value = token; }),
  );

  await new WebConsoleRegistrar({
    opaqueValueHmacKey: Buffer.alloc(32, 11),
    secretEncryptionKey: { keyId: 'wired-test-key', key: Buffer.alloc(32, 7) },
    registerCleanup: false,
    now: () => TIMESTAMP,
  }).bootstrapAndRegister(container);

  const userId = randomUUID();
  const descriptorStore = container.resolve<IIntegrationDescriptorStore>(WEB_CONSOLE_SERVICE_NAMES.integrationDescriptorStore);
  const specStore = container.resolve<IIntegrationOpenApiSpecStore>(WEB_CONSOLE_SERVICE_NAMES.integrationOpenApiSpecStore);
  const userStore = container.resolve<IUserIntegrationStore>(WEB_CONSOLE_SERVICE_NAMES.integrationStore);
  const portfolioStore = container.resolve<IPortfolioElementStore>(WEB_CONSOLE_SERVICE_NAMES.portfolioStore);
  const secretEncryption = container.resolve<ISecretEncryptionService>(WEB_CONSOLE_SERVICE_NAMES.secretEncryption);
  const encryptAccessToken = (forUser: string, provider: string, token: string): Buffer =>
    secretEncryption.encrypt(Buffer.from(token), integrationSecretContext('access_token', forUser, provider));

  const descriptor = await descriptorStore.upsert({
    provider: PROVIDER,
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Wired Test REST',
    category: 'testing',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: [API_HOST],
    oauth: {
      clientId: 'wired-client',
      authorizationUrl: 'https://auth.wired.test/authorize',
      tokenUrl: 'https://auth.wired.test/token',
      scopes: ['things.read', 'things.write'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: secretEncryption.encrypt(Buffer.from('wired-client-secret'), integrationSecretContext('client_secret', 'system', PROVIDER)),
    credentialKeyVersion: 'v1',
    operationPromotion: {
      operations: ['getThing'],
      ...(options.remoteMcp ? { remoteMcp: { serverUrl: `https://${API_HOST}/mcp`, tools: options.remoteMcp.tools } } : {}),
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });

  await specStore.upsert({
    descriptorId: descriptor.id,
    spec: openApiSpec(),
    sourceUrl: `https://${API_HOST}/openapi.json`,
    specHash: 'b'.repeat(64),
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });

  await userStore.connect({
    userId,
    provider: PROVIDER,
    externalAccountLabel: 'wired@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes: ['things.read', 'things.write'] },
    accessTokenCiphertext: encryptAccessToken(userId, PROVIDER, ACCESS_TOKEN),
    refreshTokenCiphertext: null,
    credentialKeyVersion: 'v1',
    connectedAt: TIMESTAMP,
  });

  await container.bootstrapHttpHandlers();

  const sessionContext = createHttpSession({ userId });
  const { server, dispose: disposeSession } = await container.createServerForHttpSession(sessionContext);

  const childRegistry = container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
  const child = childRegistry.get(sessionContext.sessionId);
  if (!child) throw new Error('per-session container was not registered');
  const toolRegistry = child.resolve<ToolRegistry>('ToolRegistry');
  const contextTracker = container.resolve<ContextTracker>('ContextTracker');

  const clients: McpClientHandle[] = [];
  const extraSessionDisposers: Array<() => Promise<void>> = [];

  return {
    container,
    userId,
    curatedDescriptorId: descriptor.id,
    sessionContext,
    descriptorStore,
    specStore,
    userStore,
    portfolioStore,
    secretEncryption,
    encryptAccessToken,
    lastRequest: () => upstream.captured.value,
    hasTool: name => toolRegistry.has(name),
    seedConnectedByoDescriptor: async (provider, host) => {
      const byo = await descriptorStore.upsert({
        provider,
        ownership: 'byo',
        ownerUserId: userId,
        displayName: `BYO ${provider}`,
        category: 'testing',
        authStrategy: 'oauth2_authorization_code',
        apiHosts: [host],
        oauth: {
          clientId: `${provider}-client`,
          authorizationUrl: `https://auth.${host}/authorize`,
          tokenUrl: `https://auth.${host}/token`,
          scopes: ['things.read'],
          pkce: 'required',
          refresh: 'rotating',
          tokenExchange: {},
          accountLabel: {},
        },
        staticApiKey: null,
        clientSecretCiphertext: secretEncryption.encrypt(Buffer.from('byo-secret'), integrationSecretContext('client_secret', 'system', provider)),
        credentialKeyVersion: 'v1',
        operationPromotion: {},
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
      await userStore.connect({
        userId,
        provider,
        externalAccountLabel: 'byo@example.com',
        externalInstallationId: null,
        authorizedPermissions: { scopes: ['things.read'] },
        accessTokenCiphertext: encryptAccessToken(userId, provider, `${provider}-token`),
        refreshTokenCiphertext: null,
        credentialKeyVersion: 'v1',
        connectedAt: TIMESTAMP,
      });
      return byo.id;
    },
    callViaRegistry: async (toolName, args) => {
      const handler = toolRegistry.getHandler(toolName);
      if (!handler) throw new Error(`tool not registered: ${toolName}`);
      const ctx = contextTracker.createSessionContext('llm-request', sessionContext, { toolName });
      const response = await contextTracker.runAsync(ctx, () => handler(args));
      return parseToolEnvelope((response as { content: { text: string }[] }).content[0].text);
    },
    findSkill: skillName => {
      const ctx = contextTracker.createSessionContext('llm-request', sessionContext, { toolName: 'find_skill' });
      return contextTracker.runAsync(ctx, () => portfolioStore.findByName(userId, 'skills', skillName));
    },
    lastRemoteMcpBearerToken: () => remoteMcpBearer.value,
    openSession: async forUserId => {
      const otherContext = createHttpSession({ userId: forUserId });
      const { dispose: disposeOther } = await container.createServerForHttpSession(otherContext);
      extraSessionDisposers.push(disposeOther);
      const otherChild = childRegistry.get(otherContext.sessionId);
      if (!otherChild) throw new Error('per-session container was not registered');
      const otherRegistry = otherChild.resolve<ToolRegistry>('ToolRegistry');
      return async (toolName, args) => {
        const handler = otherRegistry.getHandler(toolName);
        if (!handler) throw new Error(`tool not registered: ${toolName}`);
        const ctx = contextTracker.createSessionContext('llm-request', otherContext, { toolName });
        const response = await contextTracker.runAsync(ctx, () => handler(args));
        return parseToolEnvelope((response as { content: { text: string }[] }).content[0].text);
      };
    },
    connectMcpClient: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'wired-test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      const handle: McpClientHandle = {
        listToolNames: async () => {
          const listed = await client.listTools();
          return listed.tools.map(tool => tool.name);
        },
        callTool: async (name, args) => {
          const result = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
          const content = (result.content as { type: string; text: string }[])[0];
          return parseToolEnvelope(content.text);
        },
        close: () => client.close(),
      };
      clients.push(handle);
      return handle;
    },
    dispose: async () => {
      for (const handle of clients) await handle.close();
      for (const disposeOther of extraSessionDisposers) await disposeOther();
      await disposeSession();
      await ic.dispose();
      await upstream.close();
    },
  };
}

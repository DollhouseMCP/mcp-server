/**
 * HTTP Transport Test Helpers
 *
 * Provides test infrastructure for Streamable HTTP transport integration tests.
 * Creates in-process HTTP servers using the shared-container architecture
 * (same pattern as production startStreamableHttpServer) and connects
 * SDK clients for end-to-end testing.
 *
 * @module tests/helpers/httpTransportHelper
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DollhouseContainer } from '../../src/di/Container.js';
import {
  createStreamableHttpRuntime,
  type StreamableHttpRuntimeHandle,
} from '../../src/server/StreamableHttpServer.js';
import { createHttpSession } from '../../src/context/HttpSession.js';
import { setHttpModeActive } from '../../src/index.js';
import {
  createIngestRoutes,
  type IngestRoutesResult,
} from '../../src/web/console/IngestRoutes.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HttpTestEnvironmentOptions {
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
  sessionIdleTimeoutMs?: number;
  sessionPoolSize?: number;
}

export interface HttpTestEnvironment {
  runtime: StreamableHttpRuntimeHandle;
  container: DollhouseContainer;
  testDir: string;
  cleanup: () => Promise<void>;
}

export interface HttpTestEnvironmentWithConsole extends HttpTestEnvironment {
  ingestRoutes: IngestRoutesResult;
}

export interface HttpClientHandle {
  client: Client;
  disconnect: () => Promise<void>;
}

// ── Environment factory ────────────────────────────────────────────────────

const ELEMENT_TYPES = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];

/**
 * Create an isolated HTTP test environment with an in-process server.
 *
 * Boots a real Streamable HTTP server on a random port (port 0) using the
 * shared-container architecture. The server is ready to accept SDK client
 * connections when this function resolves.
 *
 * Call cleanup() in afterAll to shut down the server and remove temp files.
 */
export async function createHttpTestEnvironment(
  options: HttpTestEnvironmentOptions = {},
): Promise<HttpTestEnvironment> {
  // Save env vars for restoration
  const savedEnv: Record<string, string | undefined> = {
    DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
    MCP_INTERFACE_MODE: process.env.MCP_INTERFACE_MODE,
    DOLLHOUSE_WEB_CONSOLE: process.env.DOLLHOUSE_WEB_CONSOLE,
    DOLLHOUSE_PERMISSION_SERVER: process.env.DOLLHOUSE_PERMISSION_SERVER,
  };

  // Create isolated portfolio directory
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-http-parity-'));
  await Promise.all(
    ELEMENT_TYPES.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })),
  );

  // Configure env before container construction
  process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
  process.env.MCP_INTERFACE_MODE = 'mcpaql';
  process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
  process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';

  // Bootstrap shared container (same pattern as startStreamableHttpServer)
  const container = new DollhouseContainer();
  await container.preparePortfolio();
  await container.bootstrapHttpHandlers();
  await container.completeSinkSetup();

  setHttpModeActive(true);

  // Create HTTP runtime with session factory
  const runtime = await createStreamableHttpRuntime(
    async (transport) => {
      const sessionContext = createHttpSession();
      const { server, dispose } = await container.createServerForHttpSession(sessionContext);
      await server.connect(transport);
      return { dispose };
    },
    {
      host: '127.0.0.1',
      port: 0,
      mcpPath: '/mcp',
      rateLimitMaxRequests: options.rateLimitMaxRequests ?? 0,
      rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
      sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? 0,
      sessionPoolSize: options.sessionPoolSize ?? 0,
      registerSignalHandlers: false,
    },
  );

  return {
    runtime,
    container,
    testDir,
    cleanup: async () => {
      await runtime.close();
      await container.dispose().catch(() => {});
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
      setHttpModeActive(false);
      // Restore env vars
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

/**
 * Create an HTTP test environment WITH IngestRoutes for console integration testing.
 *
 * HTTP session lifecycle events (connect/disconnect) are forwarded to the
 * IngestRoutes session registry, so tests can verify sessions appear in
 * getSessions() and respond correctly to kill requests.
 */
export async function createHttpTestEnvironmentWithConsole(
  options: HttpTestEnvironmentOptions = {},
): Promise<HttpTestEnvironmentWithConsole> {
  const savedEnv: Record<string, string | undefined> = {
    DOLLHOUSE_PORTFOLIO_DIR: process.env.DOLLHOUSE_PORTFOLIO_DIR,
    MCP_INTERFACE_MODE: process.env.MCP_INTERFACE_MODE,
    DOLLHOUSE_WEB_CONSOLE: process.env.DOLLHOUSE_WEB_CONSOLE,
    DOLLHOUSE_PERMISSION_SERVER: process.env.DOLLHOUSE_PERMISSION_SERVER,
  };

  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-http-console-'));
  await Promise.all(
    ELEMENT_TYPES.map(t => fs.mkdir(path.join(testDir, t), { recursive: true })),
  );

  process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
  process.env.MCP_INTERFACE_MODE = 'mcpaql';
  process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
  process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';

  const container = new DollhouseContainer();
  await container.preparePortfolio();
  await container.bootstrapHttpHandlers();
  await container.completeSinkSetup();

  setHttpModeActive(true);

  // Create IngestRoutes for session tracking (same as startHttpConsole)
  const ingestRoutes = createIngestRoutes({
    logBroadcast: () => {},
  });
  ingestRoutes.registerConsoleSession();

  const runtime = await createStreamableHttpRuntime(
    async (transport) => {
      const sessionContext = createHttpSession();
      const { server, dispose } = await container.createServerForHttpSession(sessionContext);
      await server.connect(transport);
      return { dispose };
    },
    {
      host: '127.0.0.1',
      port: 0,
      mcpPath: '/mcp',
      rateLimitMaxRequests: options.rateLimitMaxRequests ?? 0,
      rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
      sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? 0,
      sessionPoolSize: options.sessionPoolSize ?? 0,
      registerSignalHandlers: false,
      onSessionCreated: (sessionId) => {
        ingestRoutes.registerHttpSession(sessionId, Date.now());
      },
      onSessionDisposed: (sessionId) => {
        ingestRoutes.deregisterHttpSession(sessionId);
      },
    },
  );

  return {
    runtime,
    container,
    testDir,
    ingestRoutes,
    cleanup: async () => {
      await runtime.close();
      await container.dispose().catch(() => {});
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
      setHttpModeActive(false);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

// ── Client connection ──────────────────────────────────────────────────────

/**
 * Connect an SDK client to a running HTTP test server.
 *
 * Each call creates a new MCP session (the server creates a fresh
 * SessionContext per connection).
 */
export async function connectHttpClient(
  runtime: StreamableHttpRuntimeHandle,
): Promise<HttpClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL(runtime.url));

  const client = new Client(
    { name: 'http-parity-test', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    client,
    disconnect: async () => {
      // terminateSession() sends DELETE to the server, which triggers
      // onSessionDisposed. client.close() alone doesn't notify the server.
      try { await transport.terminateSession(); } catch { /* best effort */ }
      try { await client.close(); } catch { /* best effort */ }
    },
  };
}

// ── Shared MCP tool helpers ────────────────────────────────────────────────

/**
 * Extract text content from an MCP tool call result.
 * Identical to the helper in mcp-protocol-smoke.test.ts.
 */
export function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  if (!content?.[0]?.text) {
    return JSON.stringify(content);
  }
  return content[0].text;
}

export async function callTool(
  client: Client,
  tool: 'mcp_aql_create' | 'mcp_aql_read' | 'mcp_aql_update' | 'mcp_aql_delete' | 'mcp_aql_execute',
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: args });
  return resultText(result);
}

export async function create(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_create', args);
}

export async function read(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_read', args);
}

export async function update(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_update', args);
}

export async function del(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_delete', args);
}

export async function execute(client: Client, args: Record<string, unknown>): Promise<string> {
  return callTool(client, 'mcp_aql_execute', args);
}

export async function confirm(client: Client, operation: string): Promise<string> {
  return execute(client, {
    operation: 'confirm_operation',
    params: { operation },
  });
}

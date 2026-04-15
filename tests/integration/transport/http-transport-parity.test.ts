/**
 * HTTP Transport Parity Tests
 *
 * Verifies that the Streamable HTTP transport produces correct results
 * equivalent to stdio, and that HTTP-specific behaviors (sessions, rate
 * limiting, health endpoints) function properly.
 *
 * These tests use the shared-container architecture from Phase 2.1:
 * one DollhouseContainer bootstrapped at startup, per-session MCP Servers
 * created via createServerForHttpSession().
 *
 * Test categories:
 *   1. Connection and introspection parity
 *   2. CRUD parity (persona lifecycle)
 *   3. Session context propagation
 *   4. HTTP-specific behaviors (health, sessions, rate limiting, concurrency)
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  create,
  read,
  update,
  del,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../helpers/httpTransportHelper.js';
import { preConfirmAllOperations } from '../../helpers/portfolioTestHelper.js';

// ── Constants ──────────────────────────────────────────────────────────────

const ENV_STARTUP_TIMEOUT = 20_000;
const CONCURRENT_TIMEOUT = 45_000;

// ── 1. Connection and Introspection Parity ─────────────────────────────────

describe('HTTP Transport — Connection and Introspection Parity', () => {
  let env: HttpTestEnvironment;
  let handle: HttpClientHandle;

  beforeAll(async () => {
    env = await createHttpTestEnvironment();
    handle = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handle?.disconnect();
    await env?.cleanup();
  });

  it('should list MCP-AQL tools', async () => {
    const result = await handle.client.listTools();
    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain('mcp_aql_create');
    expect(toolNames).toContain('mcp_aql_read');
    expect(toolNames).toContain('mcp_aql_update');
    expect(toolNames).toContain('mcp_aql_delete');
    expect(toolNames).toContain('mcp_aql_execute');
  });

  it('should respond to introspect', async () => {
    const text = await read(handle.client, { operation: 'introspect' });
    expect(text).toBeTruthy();
    expect(text.length).toBeGreaterThan(0);
  });

  it('should return build info', async () => {
    const text = await read(handle.client, { operation: 'get_build_info' });
    expect(text).toContain('Build Information');
    expect(text).toContain('@dollhousemcp/mcp-server');
  });

  it('should return gatekeeper capabilities', async () => {
    const text = await read(handle.client, { operation: 'get_capabilities' });
    expect(text).toBeTruthy();
    expect(text.toLowerCase()).toMatch(/gatekeeper|capabilities/);
  });

  it('should return portfolio status', async () => {
    const text = await read(handle.client, { operation: 'list_elements' });
    expect(text).toBeTruthy();
  });
});

// ── 2. CRUD Parity — Persona Lifecycle ─────────────────────────────────────

describe('HTTP Transport — CRUD Parity (Persona Lifecycle)', () => {
  let env: HttpTestEnvironment;
  let handle: HttpClientHandle;
  const PERSONA_NAME = 'http-parity-test-persona';

  beforeAll(async () => {
    env = await createHttpTestEnvironment();
    preConfirmAllOperations(env.container);
    handle = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handle?.disconnect();
    await env?.cleanup();
  });

  it('should create a persona', async () => {
    const text = await create(handle.client, {
      operation: 'create_element',
      params: {
        element_name: PERSONA_NAME,
        element_type: 'persona',
        description: 'HTTP parity test persona',
        instructions: 'You are a test persona for HTTP transport validation.',
      },
    });
    expect(text.toLowerCase()).toMatch(/created|success/);
  });

  it('should list elements containing the persona', async () => {
    const text = await read(handle.client, {
      operation: 'list_elements',
      params: { element_type: 'persona' },
    });
    expect(text).toContain(PERSONA_NAME);
  });

  it('should get element details', async () => {
    const text = await read(handle.client, {
      operation: 'get_element_details',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text).toContain(PERSONA_NAME);
    expect(text).toContain('HTTP parity test persona');
  });

  it('should edit the persona', async () => {
    const text = await update(handle.client, {
      operation: 'edit_element',
      params: {
        element_name: PERSONA_NAME,
        element_type: 'persona',
        input: { description: 'Edited via HTTP transport' },
      },
    });
    expect(text.toLowerCase()).toMatch(/updated|success|edit/);
  });

  it('should reflect the edit in details', async () => {
    const text = await read(handle.client, {
      operation: 'get_element_details',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text).toContain('Edited via HTTP transport');
  });

  it('should validate the persona', async () => {
    const text = await read(handle.client, {
      operation: 'validate_element',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text.toLowerCase()).toMatch(/valid|pass|ok/);
  });

  it('should activate the persona', async () => {
    // activate_element is a READ operation per OperationRouter
    const text = await read(handle.client, {
      operation: 'activate_element',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text.toLowerCase()).toMatch(/activat/);
  });

  it('should show persona in active elements', async () => {
    const text = await read(handle.client, {
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    expect(text).toContain(PERSONA_NAME);
  });

  it('should deactivate the persona', async () => {
    // deactivate_element is a READ operation per OperationRouter
    const text = await read(handle.client, {
      operation: 'deactivate_element',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text.toLowerCase()).toMatch(/deactivat/);
  });

  it('should not show persona in active elements after deactivate', async () => {
    const text = await read(handle.client, {
      operation: 'get_active_elements',
      params: { element_type: 'persona' },
    });
    expect(text).not.toContain(PERSONA_NAME);
  });

  it('should delete the persona', async () => {
    const text = await del(handle.client, {
      operation: 'delete_element',
      params: { element_name: PERSONA_NAME, element_type: 'persona' },
    });
    expect(text.toLowerCase()).toMatch(/delet|remov|success/);
  });

  it('should not list persona after deletion', async () => {
    const text = await read(handle.client, {
      operation: 'list_elements',
      params: { element_type: 'persona' },
    });
    expect(text).not.toContain(PERSONA_NAME);
  });
});

// ── 3. Session Context Propagation ─────────────────────────────────────────

describe('HTTP Transport — Session Context Propagation', () => {
  let env: HttpTestEnvironment;
  let handle: HttpClientHandle;

  beforeAll(async () => {
    env = await createHttpTestEnvironment();
    handle = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handle?.disconnect();
    await env?.cleanup();
  });

  it('should propagate HTTP session identity to logs', async () => {
    // Trigger an operation that generates log entries
    await read(handle.client, { operation: 'get_build_info' });

    // Query logs to inspect session attribution
    const logsText = await read(handle.client, {
      operation: 'query_logs',
      params: { limit: 50 },
    });

    // Log entries should contain http-user (HTTP session default)
    expect(logsText).toContain('http-user');
  });

  it('should give each session a unique sessionId', async () => {
    // Connect a second client (creates a new session)
    const handle2 = await connectHttpClient(env.runtime);

    try {
      // Both clients perform an operation
      await read(handle.client, { operation: 'get_build_info' });
      await read(handle2.client, { operation: 'get_build_info' });

      // query_logs is session-scoped: each session sees only its own entries.
      // Query from both sessions and extract their session UUIDs.
      const logsText1 = await read(handle.client, {
        operation: 'query_logs',
        params: { limit: 50 },
      });
      const logsText2 = await read(handle2.client, {
        operation: 'query_logs',
        params: { limit: 50 },
      });

      // Each session's logs should contain UUID patterns (sessionId, correlationId)
      const uuids1 = logsText1.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
      const uuids2 = logsText2.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
      expect(uuids1).not.toBeNull();
      expect(uuids2).not.toBeNull();

      // The session UUIDs should be distinct across sessions
      const set1 = new Set(uuids1);
      const set2 = new Set(uuids2);
      const combined = new Set([...set1, ...set2]);
      expect(combined.size).toBeGreaterThan(set1.size);
    } finally {
      await handle2.disconnect();
    }
  });

  it('should use http-user identity (not stdio local-user)', async () => {
    await read(handle.client, { operation: 'introspect' });

    const logsText = await read(handle.client, {
      operation: 'query_logs',
      params: { limit: 50 },
    });

    // HTTP sessions use 'http-user', stdio uses 'local-user'
    expect(logsText).toContain('http-user');
    expect(logsText).not.toContain('local-user');
  });
});

// ── 4. HTTP-Specific Behaviors ─────────────────────────────────────────────

describe('HTTP Transport — HTTP-Specific Behaviors', () => {

  // ── Health Endpoints ──────────────────────────────────────────────────

  describe('Health Endpoints', () => {
    let env: HttpTestEnvironment;

    beforeAll(async () => {
      env = await createHttpTestEnvironment();
    }, ENV_STARTUP_TIMEOUT);

    afterAll(async () => {
      await env?.cleanup();
    });

    it('GET /healthz returns health status', async () => {
      const res = await request(env.runtime.app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.transport).toBe('streamable-http');
      expect(res.body.sessions).toBeDefined();
      expect(typeof res.body.sessions.active).toBe('number');
    });

    it('GET /readyz returns readiness status', async () => {
      const res = await request(env.runtime.app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.sessionTelemetry).toBeDefined();
    });

    it('GET / returns server info', async () => {
      const res = await request(env.runtime.app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('dollhousemcp');
      expect(res.body.transport).toBe('streamable-http');
      expect(res.body.mcpPath).toBe('/mcp');
    });
  });

  // ── Session Lifecycle ─────────────────────────────────────────────────

  describe('Session Lifecycle', () => {
    let env: HttpTestEnvironment;

    beforeAll(async () => {
      env = await createHttpTestEnvironment();
    }, ENV_STARTUP_TIMEOUT);

    afterAll(async () => {
      await env?.cleanup();
    });

    it('should reject request with unknown session ID', async () => {
      const res = await request(env.runtime.app)
        .delete(env.runtime.mcpPath)
        .set('mcp-session-id', 'nonexistent-uuid');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unknown MCP session' },
      });
    });

    it('should reject non-initialize request without session', async () => {
      const res = await request(env.runtime.app)
        .post(env.runtime.mcpPath)
        .send({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Initialization request required');
    });

    it('should track active session count', async () => {
      const before = env.runtime.activeSessionCount();
      const handle = await connectHttpClient(env.runtime);

      expect(env.runtime.activeSessionCount()).toBe(before + 1);

      await handle.disconnect();
      // Allow time for session cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
    });
  });

  // ── Rate Limiting ─────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    let env: HttpTestEnvironment;

    beforeAll(async () => {
      env = await createHttpTestEnvironment({
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 60_000,
      });
    }, ENV_STARTUP_TIMEOUT);

    afterAll(async () => {
      await env?.cleanup();
    });

    it('should return 429 with Retry-After after limit exceeded', async () => {
      // First two requests consume the limit
      await request(env.runtime.app).get(env.runtime.mcpPath);
      await request(env.runtime.app).get(env.runtime.mcpPath);

      // Third request should be rate limited
      const res = await request(env.runtime.app).get(env.runtime.mcpPath);
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.error.message).toContain('Rate limit exceeded');
    });
  });

  // ── Concurrent Sessions ───────────────────────────────────────────────

  describe('Concurrent Sessions', () => {
    let env: HttpTestEnvironment;

    beforeAll(async () => {
      env = await createHttpTestEnvironment();
    }, ENV_STARTUP_TIMEOUT);

    afterAll(async () => {
      await env?.cleanup();
    });

    it('should handle multiple simultaneous sessions', async () => {
      const handles = await Promise.all([
        connectHttpClient(env.runtime),
        connectHttpClient(env.runtime),
        connectHttpClient(env.runtime),
      ]);

      try {
        expect(env.runtime.activeSessionCount()).toBeGreaterThanOrEqual(3);

        // All three clients perform introspect concurrently
        const results = await Promise.all(
          handles.map(h => read(h.client, { operation: 'introspect' })),
        );

        for (const text of results) {
          expect(text).toBeTruthy();
          expect(text.length).toBeGreaterThan(0);
        }

        // Telemetry should reflect creations
        const healthRes = await request(env.runtime.app).get('/healthz');
        expect(healthRes.body.sessions.created).toBeGreaterThanOrEqual(3);
      } finally {
        await Promise.all(handles.map(h => h.disconnect()));
      }
    }, CONCURRENT_TIMEOUT);
  });

  // ── Session Pool ──────────────────────────────────────────────────────

  describe('Session Pool', () => {
    let env: HttpTestEnvironment;

    beforeAll(async () => {
      env = await createHttpTestEnvironment({ sessionPoolSize: 2 });
      // Wait for pool to warm up
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }, ENV_STARTUP_TIMEOUT);

    afterAll(async () => {
      await env?.cleanup();
    });

    it('should warm session pool and track pool hits', async () => {
      // Pool should have warmed sessions
      expect(env.runtime.pooledSessionCount()).toBeGreaterThanOrEqual(1);

      // Connect a client — should consume a pooled session
      const handle = await connectHttpClient(env.runtime);

      try {
        const readyRes = await request(env.runtime.app).get('/readyz');
        expect(readyRes.body.sessionTelemetry.poolHits).toBeGreaterThanOrEqual(1);
      } finally {
        await handle.disconnect();
      }
    });
  });
});

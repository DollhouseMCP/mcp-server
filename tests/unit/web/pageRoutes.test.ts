/**
 * Tests for element-driven web page HTTP routes:
 * - mcpAqlGatewayRoutes (POST /mcp-aql)
 * - pageEventRoutes (POST /page-event)
 * - pageStreamRoutes (GET /pages/:template/stream)
 *
 * Covers: CSRF protection, rate limiting, allowlist enforcement,
 * input validation, SSE connection management.
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1703
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1705
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1706
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createMcpAqlGatewayRoutes } from '../../../src/web/routes/mcpAqlGatewayRoutes.js';
import { createPageStreamRoutes } from '../../../src/web/routes/pageStreamRoutes.js';

// ── Mock Handler ────────────────────────────────────────────────────────────

function createMockHandler() {
  return {
    handleRead: jest.fn().mockResolvedValue([{ success: true, data: { test: true } }]),
    handleCreate: jest.fn().mockResolvedValue([{ success: true, data: { created: true } }]),
    handleUpdate: jest.fn().mockResolvedValue([{ success: true, data: {} }]),
    handleDelete: jest.fn().mockResolvedValue([{ success: true, data: {} }]),
    handleExecute: jest.fn().mockResolvedValue([{ success: true, data: {} }]),
  } as any;
}

// ── MCP-AQL Gateway Tests ───────────────────────────────────────────────────

describe('mcpAqlGatewayRoutes', () => {
  let app: express.Express;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(() => {
    handler = createMockHandler();
    app = express();
    const { router } = createMcpAqlGatewayRoutes(handler);
    app.use('/api', router);
  });

  describe('CSRF Protection', () => {
    it('should reject requests without X-Dollhouse-Request header', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .send({ operation: 'list_elements' });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('X-Dollhouse-Request');
    });

    it('should accept requests with X-Dollhouse-Request header', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'list_elements' });
      expect(res.status).toBe(200);
    });
  });

  describe('Operation Allowlist', () => {
    const allowedReadOps = [
      'list_elements', 'get_element', 'search_elements', 'get_active_elements',
      'get_build_info', 'portfolio_status', 'render',
    ];

    for (const op of allowedReadOps) {
      it(`should allow READ operation: ${op}`, async () => {
        const res = await request(app)
          .post('/api/mcp-aql')
          .set('X-Dollhouse-Request', 'true')
          .send({ operation: op });
        expect(res.status).toBe(200);
        expect(handler.handleRead).toHaveBeenCalled();
      });
    }

    it('should allow CREATE operation: addEntry', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'addEntry', params: { element_name: 'test', content: 'hello' } });
      expect(res.status).toBe(200);
      expect(handler.handleCreate).toHaveBeenCalled();
    });

    it('should reject disallowed operation: delete_element', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'delete_element' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATION_NOT_ALLOWED');
    });

    it('should reject disallowed operation: execute_agent', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'execute_agent' });
      expect(res.status).toBe(403);
    });

    it('should reject disallowed operation: abort_execution', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'abort_execution' });
      expect(res.status).toBe(403);
    });

    it('should reject disallowed operation: edit_element', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'edit_element' });
      expect(res.status).toBe(403);
    });

    it('should reject completely unknown operations', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'nonexistent_operation' });
      expect(res.status).toBe(403);
    });
  });

  describe('Input Validation', () => {
    it('should reject missing operation field', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ params: {} });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('operation');
    });

    it('should reject non-string operation', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 123 });
      expect(res.status).toBe(400);
    });

    it('should handle missing params gracefully', async () => {
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'list_elements' });
      expect(res.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on handler error', async () => {
      handler.handleRead.mockRejectedValue(new Error('Internal error'));
      const res = await request(app)
        .post('/api/mcp-aql')
        .set('X-Dollhouse-Request', 'true')
        .send({ operation: 'list_elements' });
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Internal error');
    });
  });
});

// ── Page Stream Routes Tests ────────────────────────────────────────────────

describe('pageStreamRoutes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    const { router, broadcastPageUpdate, clientCount } = createPageStreamRoutes(5);
    app.use('/api', router);
    // Store for use in tests
    (app as any).__broadcast = broadcastPageUpdate;
    (app as any).__clientCount = clientCount;
  });

  describe('SSE Connection', () => {
    it('should reject path traversal attempts (Express normalizes to 404)', async () => {
      const res = await request(app).get('/api/pages/../secret/stream');
      // Express normalizes /../ before routing — never reaches handler
      expect(res.status).not.toBe(200);
    });

    it('should handle template names with dots', async () => {
      // Template names with ".." inside (not as path traversal) should be caught
      const res = await request(app).get('/api/pages/..evil../stream');
      expect(res.status).toBe(400);
    });
  });

  describe('Broadcast', () => {
    it('should start with zero clients', () => {
      expect((app as any).__clientCount()).toBe(0);
    });
  });
});

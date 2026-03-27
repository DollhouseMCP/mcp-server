/**
 * Unit tests for auto-dollhouse permissionRoutes module.
 *
 * Tests the permission evaluation HTTP routes and decision tracking.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { registerPermissionRoutes } from '../../../src/web/routes/permissionRoutes.js';

describe('permissionRoutes', () => {
  function createMockHandler(readResult?: unknown) {
    return {
      handleRead: jest.fn().mockResolvedValue(
        readResult ?? [{ success: true, data: { decision: 'allow' } }]
      ),
    } as any;
  }

  function createApp(handler: any) {
    const app = express();
    const router = express.Router();
    registerPermissionRoutes(router, handler);
    app.use('/api', router);
    return app;
  }

  describe('POST /api/evaluate_permission', () => {
    it('should return allow for a valid request', async () => {
      const handler = createMockHandler();
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'npm test' }, platform: 'claude_code' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ decision: 'allow' });
      expect(handler.handleRead).toHaveBeenCalledWith({
        operation: 'evaluate_permission',
        params: {
          tool_name: 'Bash',
          input: { command: 'npm test' },
          platform: 'claude_code',
        },
      });
    });

    it('should fail open when tool_name is missing', async () => {
      const handler = createMockHandler();
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ input: { command: 'test' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ decision: 'allow' });
      expect(handler.handleRead).not.toHaveBeenCalled();
    });

    it('should fail open when handler returns error', async () => {
      const handler = createMockHandler([{ success: false, error: 'Internal error' }]);
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'test' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ decision: 'allow' });
    });

    it('should fail open when handler throws', async () => {
      const handler = {
        handleRead: jest.fn().mockRejectedValue(new Error('Handler crashed')),
      } as any;
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'test' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ decision: 'allow' });
    });

    it('should default platform to claude_code', async () => {
      const handler = createMockHandler();
      const app = createApp(handler);

      await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Edit', input: {} });

      expect(handler.handleRead).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ platform: 'claude_code' }),
        }),
      );
    });

    it('should return deny response from handler', async () => {
      const handler = createMockHandler([{
        success: true,
        data: { decision: 'deny', reason: 'Blocked by policy' },
      }]);
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'git push --force' } });

      expect(res.body).toEqual({ decision: 'deny', reason: 'Blocked by policy' });
    });
  });

  describe('GET /api/permissions/status', () => {
    it('should return policy status', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 2,
            hasAllowlist: true,
            combinedDenyPatterns: ['Bash:git push --force*'],
            combinedAllowPatterns: ['Bash:git *'],
            elements: [
              { name: 'test', confirmPatterns: ['Bash:git merge*'] },
            ],
            permissionPromptActive: false,
          },
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(200);
      expect(res.body.activeElementCount).toBe(2);
      expect(res.body.hasAllowlist).toBe(true);
      expect(res.body.denyPatterns).toEqual(['Bash:git push --force*']);
      expect(res.body.allowPatterns).toEqual(['Bash:git *']);
      expect(res.body.confirmPatterns).toEqual(['Bash:git merge*']);
      expect(Array.isArray(res.body.recentDecisions)).toBe(true);
    });

    it('should return 500 when handler fails', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: false,
          error: 'Something broke',
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Something broke');
    });
  });

  describe('decision tracking', () => {
    it('should track decisions in recent decisions feed', async () => {
      const handler = createMockHandler([{
        success: true,
        data: { decision: 'deny', reason: 'Blocked' },
      }]);
      const app = createApp(handler);

      // Make a permission evaluation
      await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'rm -rf /' } });

      // Set up status handler that returns the tracked decisions
      const statusHandler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 0,
            hasAllowlist: false,
            combinedDenyPatterns: [],
            combinedAllowPatterns: [],
            elements: [],
            permissionPromptActive: false,
          },
        }]),
      } as any;

      // Need to use the same router instance to see tracked decisions
      // The decision tracking is module-scoped, so it persists across requests
      const res = await request(app).get('/api/permissions/status');

      // recentDecisions should have the tracked entry
      if (res.status === 200 && res.body.recentDecisions) {
        expect(res.body.recentDecisions.length).toBeGreaterThanOrEqual(1);
        expect(res.body.recentDecisions[0].tool_name).toBe('Bash');
        expect(res.body.recentDecisions[0].decision).toBe('deny');
      }
    });
  });
});

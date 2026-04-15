/**
 * Unit tests for auto-dollhouse permissionRoutes module.
 *
 * Tests the permission evaluation HTTP routes and decision tracking.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { registerPermissionRoutes } from '../../../src/web/routes/permissionRoutes.js';

function createMockHandler(readResult?: unknown) {
  return {
    handleRead: jest.fn().mockResolvedValue(
      readResult ?? [{
        success: true,
        data: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        },
      }]
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

describe('permissionRoutes', () => {
  describe('POST /api/evaluate_permission', () => {
    it('should return allow for a valid request', async () => {
      const handler = createMockHandler();
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'npm test' }, platform: 'claude_code' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      expect(handler.handleRead).toHaveBeenCalledWith({
        operation: 'evaluate_permission',
        params: {
          tool_name: 'Bash',
          input: { command: 'npm test' },
          platform: 'claude_code',
        },
      });
    });

    it('should pass session_id through to evaluate_permission when provided', async () => {
      const handler = createMockHandler();
      const app = createApp(handler);

      await request(app)
        .post('/api/evaluate_permission')
        .send({
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/demo' },
          platform: 'claude_code',
          session_id: 'session-follower-1',
        });

      expect(handler.handleRead).toHaveBeenCalledWith({
        operation: 'evaluate_permission',
        params: {
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/demo' },
          platform: 'claude_code',
          session_id: 'session-follower-1',
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
      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
      expect(handler.handleRead).not.toHaveBeenCalled();
    });

    it('should fail open when handler returns error', async () => {
      const handler = createMockHandler([{ success: false, error: 'Internal error' }]);
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'test' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
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
      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
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
        data: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Blocked by policy',
          },
        },
      }]);
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'git push --force' } });

      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      });
    });

    it('should wrap legacy flat Claude responses into hookSpecificOutput', async () => {
      const handler = createMockHandler([{
        success: true,
        data: { decision: 'deny', reason: 'Blocked by policy' },
      }]);
      const app = createApp(handler);

      const res = await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'git push --force' }, platform: 'claude_code' });

      expect(res.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      });
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
            combinedDenyOperations: ['delete_*'],
            combinedAllowOperations: ['read_*'],
            combinedConfirmOperations: ['edit_*'],
            elements: [
              {
                name: 'test',
                confirmPatterns: ['Bash:git merge*'],
                confirmOperations: ['edit_*'],
              },
            ],
            permissionPromptActive: false,
            hookInstalled: false,
            enforcementReady: false,
            advisory: 'Policies are loaded but NOT enforced.',
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
      expect(res.body.confirmPatterns).toEqual([]);
      expect(res.body.denyOperations).toEqual(['delete_*']);
      expect(res.body.allowOperations).toEqual(['read_*']);
      expect(res.body.confirmOperations).toEqual(['edit_*']);
      expect(res.body.denyRules).toEqual(['Bash:git push --force*', 'delete_*']);
      expect(res.body.allowRules).toEqual(['Bash:git *', 'read_*']);
      expect(res.body.confirmRules).toEqual(['edit_*']);
      expect(res.body.elements).toEqual([
        expect.objectContaining({
          name: 'test',
          element_name: 'test',
          confirmRules: ['Bash:git merge*', 'edit_*'],
        }),
      ]);
      expect(res.body.hookInstalled).toBe(false);
      expect(res.body.enforcementReady).toBe(false);
      expect(res.body.advisory).toContain('NOT enforced');
      expect(Array.isArray(res.body.recentDecisions)).toBe(true);
      expect(handler.handleRead).toHaveBeenCalledWith({
        operation: 'get_effective_cli_policies',
        params: {
          reporting_scope: 'dashboard',
        },
      });
    });

    it('should pass session selection through to the dashboard policy query', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 1,
            hasAllowlist: false,
            combinedDenyPatterns: ['Bash:rm*'],
            combinedAllowPatterns: [],
            combinedConfirmPatterns: ['Bash:git push*'],
            elements: [],
            permissionPromptActive: false,
          },
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status?sessionId=session-abc');

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe('session-abc');
      expect(res.body.confirmPatterns).toEqual(['Bash:git push*']);
      expect(handler.handleRead).toHaveBeenCalledWith({
        operation: 'get_effective_cli_policies',
        params: {
          reporting_scope: 'dashboard',
          session_id: 'session-abc',
        },
      });
    });

    it('should surface top-level gatekeeper rules even when no external tool patterns exist', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 1,
            hasAllowlist: true,
            combinedDenyPatterns: [],
            combinedAllowPatterns: [],
            combinedConfirmPatterns: [],
            combinedDenyOperations: ['delete_*'],
            combinedAllowOperations: ['read_*'],
            combinedConfirmOperations: ['edit_*'],
            elements: [
              {
                name: 'perm-read-only',
                allowOperations: ['read_*'],
                denyOperations: ['delete_*'],
                confirmOperations: ['edit_*'],
              },
            ],
            permissionPromptActive: false,
            hookInstalled: false,
            enforcementReady: false,
            advisory: 'MCP-AQL operation policies are active for Dollhouse actions in this session.',
          },
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(200);
      expect(res.body.allowRules).toEqual(['read_*']);
      expect(res.body.confirmRules).toEqual(['edit_*']);
      expect(res.body.denyRules).toEqual(['delete_*']);
      expect(res.body.elements).toEqual([
        expect.objectContaining({
          name: 'perm-read-only',
          allowRules: ['read_*'],
          confirmRules: ['edit_*'],
          denyRules: ['delete_*'],
        }),
      ]);
    });

    it('should surface invalid gatekeeper policy state without hiding the active element', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 1,
            hasAllowlist: false,
            combinedDenyPatterns: [],
            combinedAllowPatterns: [],
            combinedConfirmPatterns: [],
            combinedDenyOperations: [],
            combinedAllowOperations: [],
            combinedConfirmOperations: [],
            elements: [
              {
                name: 'broken-guardian',
                type: 'skill',
                invalidGatekeeperPolicy: true,
                invalidGatekeeperMessage: 'gatekeeper.externalRestrictions.description is required',
              },
            ],
            invalidPolicyElementCount: 1,
            permissionPromptActive: false,
            advisory: '1 active element has malformed gatekeeper policy. The element remains active, but that policy is not enforceable until fixed.',
          },
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(200);
      expect(res.body.invalidPolicyElementCount).toBe(1);
      expect(res.body.advisory).toContain('malformed gatekeeper policy');
      expect(res.body.elements).toEqual([
        expect.objectContaining({
          name: 'broken-guardian',
          invalidGatekeeperPolicy: true,
          invalidGatekeeperMessage: 'gatekeeper.externalRestrictions.description is required',
        }),
      ]);
    });

    it('should expose known persisted policy sessions for the session picker', async () => {
      const handler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 2,
            hasAllowlist: false,
            combinedDenyPatterns: [],
            combinedAllowPatterns: [],
            combinedConfirmPatterns: [],
            elements: [
              { name: 'guard-a', sessionIds: ['session-b', 'session-a'] },
              { name: 'guard-b', sessionIds: ['session-a'] },
              { name: 'guard-c' },
            ],
            permissionPromptActive: false,
          },
        }]),
      } as any;
      const app = createApp(handler);

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(200);
      expect(res.body.knownSessions).toEqual([
        { sessionId: 'session-a', displayName: 'session-a', source: 'policy' },
        { sessionId: 'session-b', displayName: 'session-b', source: 'policy' },
      ]);
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
    it('should accumulate recent decisions newest-first within one app instance', async () => {
      const handler = {
        handleRead: jest
          .fn()
          .mockResolvedValueOnce([{ success: true, data: { decision: 'allow', reason: 'Safe read' } }])
          .mockResolvedValueOnce([{ success: true, data: { decision: 'deny', reason: 'Blocked delete' } }])
          .mockResolvedValueOnce([{
            success: true,
            data: {
              activeElementCount: 0,
              hasAllowlist: false,
              combinedDenyPatterns: [],
              combinedAllowPatterns: [],
              combinedConfirmPatterns: [],
              elements: [],
              permissionPromptActive: false,
            },
          }]),
      } as any;
      const app = createApp(handler);

      await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Read', input: { file_path: './README.md' } });

      await request(app)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'rm -rf /tmp/demo' } });

      const res = await request(app).get('/api/permissions/status');

      expect(res.status).toBe(200);
      expect(res.body.recentDecisions).toHaveLength(2);
      expect(res.body.recentDecisions.map((entry: any) => entry.tool_name)).toEqual(['Bash', 'Read']);
      expect(res.body.recentDecisions.map((entry: any) => entry.decision)).toEqual(['deny', 'allow']);
      expect(res.body.recentDecisions[0].command).toBe('rm -rf /tmp/demo');
    });

    it('should isolate recent decisions between separate router instances', async () => {
      const firstHandler = {
        handleRead: jest
          .fn()
          .mockResolvedValueOnce([{ success: true, data: { decision: 'deny', reason: 'Blocked' } }])
          .mockResolvedValue([{
            success: true,
            data: {
              activeElementCount: 0,
              hasAllowlist: false,
              combinedDenyPatterns: [],
              combinedAllowPatterns: [],
              combinedConfirmPatterns: [],
              elements: [],
              permissionPromptActive: false,
            },
          }]),
      } as any;
      const secondHandler = {
        handleRead: jest.fn().mockResolvedValue([{
          success: true,
          data: {
            activeElementCount: 0,
            hasAllowlist: false,
            combinedDenyPatterns: [],
            combinedAllowPatterns: [],
            combinedConfirmPatterns: [],
            elements: [],
            permissionPromptActive: false,
          },
        }]),
      } as any;

      const firstApp = createApp(firstHandler);
      const secondApp = createApp(secondHandler);

      await request(firstApp)
        .post('/api/evaluate_permission')
        .send({ tool_name: 'Bash', input: { command: 'rm -rf /' } });

      const firstStatus = await request(firstApp).get('/api/permissions/status');
      const secondStatus = await request(secondApp).get('/api/permissions/status');

      expect(firstStatus.status).toBe(200);
      expect(firstStatus.body.recentDecisions).toHaveLength(1);
      expect(firstStatus.body.recentDecisions[0].tool_name).toBe('Bash');

      expect(secondStatus.status).toBe(200);
      expect(secondStatus.body.recentDecisions).toEqual([]);
    });

    it('should track platform-specific hook responses with their real decision', async () => {
      const handler = {
        handleRead: jest
          .fn()
          .mockResolvedValueOnce([{
            success: true,
            data: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Blocked by policy',
              },
            },
          }])
          .mockResolvedValueOnce([{
            success: true,
            data: {
              activeElementCount: 0,
              hasAllowlist: false,
              combinedDenyPatterns: [],
              combinedAllowPatterns: [],
              combinedConfirmPatterns: [],
              elements: [],
              permissionPromptActive: false,
            },
          }]),
      } as any;
      const app = createApp(handler);

      await request(app)
        .post('/api/evaluate_permission')
        .send({
          tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/demo' },
          platform: 'claude_code',
          session_id: 'session-a',
        });

      const status = await request(app).get('/api/permissions/status');
      expect(status.body.recentDecisions).toEqual([
        expect.objectContaining({
          session_id: 'session-a',
          decision: 'deny',
          reason: 'Blocked by policy',
        }),
      ]);
    });

    it('should include useful audit detail fields for tracked decisions', async () => {
      const handler = {
        handleRead: jest
          .fn()
          .mockResolvedValueOnce([{
            success: true,
            data: {
              decision: 'ask',
              reason: 'Needs confirmation',
              matched_pattern: 'Edit:*',
            },
          }])
          .mockResolvedValueOnce([{
            success: true,
            data: {
              activeElementCount: 0,
              hasAllowlist: false,
              combinedDenyPatterns: [],
              combinedAllowPatterns: [],
              combinedConfirmPatterns: [],
              elements: [],
              permissionPromptActive: false,
            },
          }]),
      } as any;
      const app = createApp(handler);

      await request(app)
        .post('/api/evaluate_permission')
        .send({
          tool_name: 'Edit',
          input: { file_path: '/tmp/example.txt' },
          platform: 'cursor',
        });

      const status = await request(app).get('/api/permissions/status');

      expect(status.body.recentDecisions[0]).toEqual(expect.objectContaining({
        tool_name: 'Edit',
        decision: 'ask',
        platform: 'cursor',
        target: '/tmp/example.txt',
        targetLabel: 'File',
      }));
      expect(status.body.recentDecisions[0].details).toEqual(expect.arrayContaining([
        { label: 'Platform', value: 'cursor', monospace: true },
        { label: 'File', value: '/tmp/example.txt', monospace: true },
        { label: 'Matched Pattern', value: 'Edit:*', monospace: true },
      ]));
    });
  });
});

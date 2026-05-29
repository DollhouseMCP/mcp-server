/**
 * Unit tests for GatekeeperSession CLI approval store (Issue #625 Phase 3)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { GatekeeperSession } from '../../../../src/handlers/mcp-aql/GatekeeperSession.js';
import type { CreateCliApprovalArgs } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { StaticAuditHmacKeyResolver } from '../../../../src/security/auditHmacKey.js';
import type { CliApprovalRecord } from '../../../../src/handlers/mcp-aql/GatekeeperTypes.js';

const TOOL_BASH = 'Bash';
const NPM_INSTALL = { command: 'npm install' };

const dangerousArgs = (
  toolName: string,
  toolInput: Record<string, unknown> = {},
  denyReason = 'test',
  ttlMs?: number,
): CreateCliApprovalArgs => ({
  toolName, toolInput, riskLevel: 'dangerous', riskScore: 80, irreversible: false, denyReason, ttlMs,
});

const moderateArgs = (
  toolName: string,
  toolInput: Record<string, unknown> = {},
  denyReason = 'test',
): CreateCliApprovalArgs => ({
  toolName, toolInput, riskLevel: 'moderate', riskScore: 40, irreversible: false, denyReason,
});

function requireRecord(record: CliApprovalRecord | undefined): CliApprovalRecord {
  if (!record) throw new Error('expected CLI approval record');
  return record;
}

describe('GatekeeperSession CLI approval store', () => {
  let session: GatekeeperSession;
  const auditResolver = new StaticAuditHmacKeyResolver('55'.repeat(32));

  beforeEach(() => {
    session = new GatekeeperSession(undefined, 100, 50, undefined, undefined, auditResolver);
  });

  describe('createCliApprovalRequest', () => {
    it('should create a request with cli- prefixed UUID', async () => {
      const requestId = await session.createCliApprovalRequest(
        dangerousArgs(TOOL_BASH, NPM_INSTALL, 'dangerous command'),
      );
      expect(requestId).toMatch(/^cli-[0-9a-f-]{36}$/);
    });

    it('should store the request as pending', async () => {
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL, 'dangerous command'));
      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe(TOOL_BASH);
      expect(pending[0].approvedAt).toBeUndefined();
    });

    it('should evict oldest when at max capacity', async () => {
      // Create session with max 3 CLI approvals
      const smallSession = new GatekeeperSession(undefined, 100, 3, undefined, undefined, auditResolver);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(await smallSession.createCliApprovalRequest(moderateArgs(`Tool${i}`)));
      }
      const pending = smallSession.getPendingCliApprovals();
      expect(pending).toHaveLength(3);
      // First one should be evicted
      expect(pending.find(p => p.requestId === ids[0])).toBeUndefined();
    });
  });

  describe('approveCliRequest', () => {
    it('should set approvedAt on approval', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      const record = requireRecord(session.approveCliRequest(requestId, 'single'));
      expect(record.approvedAt).toBeDefined();
    });

    it('should return undefined for nonexistent request', () => {
      const record = session.approveCliRequest('cli-nonexistent', 'single');
      expect(record).toBeUndefined();
    });

    it('should return undefined for already approved request', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.approveCliRequest(requestId, 'single');
      const secondApproval = session.approveCliRequest(requestId, 'single');
      expect(secondApproval).toBeUndefined();
    });

    it('should refuse denied and expired requests', async () => {
      const deniedId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      expect(session.denyCliRequest(deniedId)).toBeDefined();
      expect(session.approveCliRequest(deniedId, 'single')).toBeUndefined();

      const expiredId = await session.createCliApprovalRequest(dangerousArgs('Edit', {}, 'old', 1_000));
      const expired = requireRecord(session.getCliApproval(expiredId));
      expired.requestedAt = new Date(Date.now() - 5_000).toISOString();

      expect(session.approveCliRequest(expiredId, 'single')).toBeUndefined();
      expect(session.getCliApproval(expiredId)?.expiredAt).toBeDefined();
    });

    it('should promote to session approvals for tool_session scope', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.approveCliRequest(requestId, 'tool_session');

      // Should be findable via checkCliApproval for same tool
      const found = requireRecord(session.checkCliApproval(TOOL_BASH, { command: 'different command' }));
      expect(found.scope).toBe('tool_session');
    });
  });

  describe('checkCliApproval', () => {
    it('should return and consume single-scope approvals', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.approveCliRequest(requestId, 'single');

      // First check returns the approval
      const first = requireRecord(session.checkCliApproval(TOOL_BASH, NPM_INSTALL));
      expect(first.consumed).toBe(true);

      // Second check returns nothing (consumed)
      const second = session.checkCliApproval(TOOL_BASH, NPM_INSTALL);
      expect(second).toBeUndefined();
    });

    it('should return but preserve tool_session-scope approvals', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.approveCliRequest(requestId, 'tool_session');

      // Multiple checks should all succeed
      const first = session.checkCliApproval(TOOL_BASH, NPM_INSTALL);
      expect(first).toBeDefined();

      const second = session.checkCliApproval(TOOL_BASH, { command: 'git push --force' });
      expect(second).toBeDefined();

      const third = session.checkCliApproval(TOOL_BASH, {});
      expect(third).toBeDefined();
    });

    it('should return undefined for unapproved requests', async () => {
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      const result = session.checkCliApproval(TOOL_BASH, NPM_INSTALL);
      expect(result).toBeUndefined();
    });

    it('should not consume denied, cancelled, or expired approvals', async () => {
      const deniedId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.denyCliRequest(deniedId);
      expect(session.checkCliApproval(TOOL_BASH, NPM_INSTALL)).toBeUndefined();

      const cancelledId = await session.createCliApprovalRequest(dangerousArgs('Edit', { file_path: 'a.ts' }));
      const cancelled = requireRecord(session.getCliApproval(cancelledId));
      cancelled.approvedAt = new Date().toISOString();
      cancelled.cancelledAt = new Date().toISOString();
      expect(session.checkCliApproval('Edit', { file_path: 'a.ts' })).toBeUndefined();

      const expiredId = await session.createCliApprovalRequest(dangerousArgs('Write', { file_path: 'b.ts' }));
      const expired = requireRecord(session.getCliApproval(expiredId));
      expired.approvedAt = new Date().toISOString();
      expired.expiredAt = new Date().toISOString();
      expect(session.checkCliApproval('Write', { file_path: 'b.ts' })).toBeUndefined();
    });

    it('should ignore terminal session-scoped fast-path approvals', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      const approved = requireRecord(session.approveCliRequest(requestId, 'tool_session'));
      approved.deniedAt = new Date().toISOString();

      expect(session.checkCliApproval(TOOL_BASH, NPM_INSTALL)).toBeUndefined();
    });

    it('should not match different tool names', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      session.approveCliRequest(requestId, 'single');

      const result = session.checkCliApproval('Edit', { file_path: 'foo.ts' });
      expect(result).toBeUndefined();
    });
  });

  describe('getPendingCliApprovals', () => {
    it('should return only unapproved records', async () => {
      const id1 = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH));
      await session.createCliApprovalRequest(moderateArgs('Edit'));
      session.approveCliRequest(id1, 'single');

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe('Edit');
    });

    it('should return empty array when no pending', () => {
      expect(session.getPendingCliApprovals()).toHaveLength(0);
    });

    it('should cancel pending approvals on session termination', async () => {
      const requestId = await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));

      expect(session.cancelPendingCliApprovals('2026-05-29T15:00:00.000Z')).toBe(1);

      expect(session.getPendingCliApprovals()).toEqual([]);
      expect(session.getCliApproval(requestId)).toMatchObject({
        cancelledAt: '2026-05-29T15:00:00.000Z',
      });
      expect(session.checkCliApproval(TOOL_BASH, NPM_INSTALL)).toBeUndefined();
    });
  });

  describe('expiry', () => {
    it('should mark stale unapproved requests expired and remove them from pending', async () => {
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));

      // Manually backdate the request
      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);

      // Backdate to 10 minutes ago
      (pending[0] as any).requestedAt = new Date(Date.now() - 600_000).toISOString();

      // Creating a new request triggers lazy expiry
      await session.createCliApprovalRequest(moderateArgs('Edit'));

      const remaining = session.getPendingCliApprovals();
      // Original should be expired, only the new one remains
      expect(remaining).toHaveLength(1);
      expect(remaining[0].toolName).toBe('Edit');
      const retained = session.getAllCliApprovals().find(record => record.toolName === TOOL_BASH);
      expect(retained?.expiredAt).toBeDefined();
    });

    it('should use per-record ttlMs when set (Issue #644)', async () => {
      // Create a record with 60s TTL
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL, 'test', 60_000));

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].ttlMs).toBe(60_000);

      // Backdate to 70s ago (past the 60s TTL, but within default 300s)
      (pending[0] as any).requestedAt = new Date(Date.now() - 70_000).toISOString();

      // Trigger lazy expiry
      await session.createCliApprovalRequest(moderateArgs('Edit'));

      const remaining = session.getPendingCliApprovals();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].toolName).toBe('Edit');
    });

    it('should use default 300s TTL when ttlMs is not set (Issue #644)', async () => {
      // Create a record without TTL
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);

      // Backdate to 200s ago (within default 300s TTL)
      (pending[0] as any).requestedAt = new Date(Date.now() - 200_000).toISOString();

      // Trigger lazy expiry
      await session.createCliApprovalRequest(moderateArgs('Edit'));

      const remaining = session.getPendingCliApprovals();
      // Original should NOT be expired (200s < 300s default)
      expect(remaining).toHaveLength(2);
    });

    it('should purge old denied terminal records from memory and backing store', async () => {
      const store = {
        initialize: jest.fn<() => Promise<void>>().mockResolvedValue(),
        persist: jest.fn<() => Promise<void>>().mockResolvedValue(),
        getAllConfirmations: jest.fn().mockReturnValue([]),
        getAllCliApprovals: jest.fn().mockReturnValue([]),
        getAllCliSessionApprovals: jest.fn().mockReturnValue([]),
        getPermissionPromptActive: jest.fn().mockReturnValue(false),
        saveConfirmation: jest.fn(),
        getConfirmation: jest.fn(),
        deleteConfirmation: jest.fn(),
        clearAllConfirmations: jest.fn(),
        saveCliApproval: jest.fn(),
        getCliApproval: jest.fn(),
        deleteCliApproval: jest.fn(),
        saveCliSessionApproval: jest.fn(),
        getCliSessionApproval: jest.fn(),
        findApprovals: jest.fn().mockResolvedValue([]),
        getRawApprovalDetail: jest.fn().mockResolvedValue(null),
        savePermissionPromptActive: jest.fn(),
        getSessionId: jest.fn().mockReturnValue('test-session'),
      };
      const durableSession = new GatekeeperSession(undefined, 100, 50, store, 'test-session', auditResolver);
      const requestId = await durableSession.createCliApprovalRequest(dangerousArgs(TOOL_BASH, NPM_INSTALL));
      const denied = durableSession.denyCliRequest(requestId);
      expect(denied).toBeDefined();
      if (!denied) throw new Error('expected denied approval');
      denied.deniedAt = new Date(Date.now() - 90_000_000).toISOString();

      await durableSession.createCliApprovalRequest(moderateArgs('Edit'));

      expect(durableSession.getCliApproval(requestId)).toBeUndefined();
      expect(store.deleteCliApproval).toHaveBeenCalledWith(requestId);
    });
  });

  describe('summary', () => {
    it('should include cliApprovalCount in summary', async () => {
      await session.createCliApprovalRequest(dangerousArgs(TOOL_BASH));
      await session.createCliApprovalRequest(moderateArgs('Edit'));

      const summary = session.getSummary();
      expect(summary.cliApprovalCount).toBe(2);
    });
  });

  describe('permissionPromptActive (Issue #625 Phase 4)', () => {
    it('should default to false', () => {
      expect(session.isPermissionPromptActive).toBe(false);
      expect(session.getSummary().permissionPromptActive).toBe(false);
    });

    it('should be true after markPermissionPromptActive()', () => {
      session.markPermissionPromptActive();
      expect(session.isPermissionPromptActive).toBe(true);
      expect(session.getSummary().permissionPromptActive).toBe(true);
    });
  });
});

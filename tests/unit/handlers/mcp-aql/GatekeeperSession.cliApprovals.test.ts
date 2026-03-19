/**
 * Unit tests for GatekeeperSession CLI approval store (Issue #625 Phase 3)
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { GatekeeperSession } from '../../../../src/handlers/mcp-aql/GatekeeperSession.js';

describe('GatekeeperSession CLI approval store', () => {
  let session: GatekeeperSession;

  beforeEach(() => {
    session = new GatekeeperSession(undefined, 100, 50);
  });

  describe('createCliApprovalRequest', () => {
    it('should create a request with cli- prefixed UUID', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'dangerous command'
      );
      expect(requestId).toMatch(/^cli-[0-9a-f-]{36}$/);
    });

    it('should store the request as pending', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'dangerous command'
      );
      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe('Bash');
      expect(pending[0].approvedAt).toBeUndefined();
    });

    it('should evict oldest when at max capacity', () => {
      // Create session with max 3 CLI approvals
      const smallSession = new GatekeeperSession(undefined, 100, 3);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(smallSession.createCliApprovalRequest(
          `Tool${i}`, {}, 'moderate', 40, false, 'test'
        ));
      }
      const pending = smallSession.getPendingCliApprovals();
      expect(pending).toHaveLength(3);
      // First one should be evicted
      expect(pending.find(p => p.requestId === ids[0])).toBeUndefined();
    });
  });

  describe('approveCliRequest', () => {
    it('should set approvedAt on approval', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      const record = session.approveCliRequest(requestId, 'single');
      expect(record).toBeDefined();
      expect(record!.approvedAt).toBeDefined();
    });

    it('should return undefined for nonexistent request', () => {
      const record = session.approveCliRequest('cli-nonexistent', 'single');
      expect(record).toBeUndefined();
    });

    it('should return undefined for already approved request', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');
      const secondApproval = session.approveCliRequest(requestId, 'single');
      expect(secondApproval).toBeUndefined();
    });

    it('should promote to session approvals for tool_session scope', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'tool_session');

      // Should be findable via checkCliApproval for same tool
      const found = session.checkCliApproval('Bash', { command: 'different command' });
      expect(found).toBeDefined();
      expect(found!.scope).toBe('tool_session');
    });
  });

  describe('checkCliApproval', () => {
    it('should return and consume single-scope approvals', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');

      // First check returns the approval
      const first = session.checkCliApproval('Bash', { command: 'npm install' });
      expect(first).toBeDefined();
      expect(first!.consumed).toBe(true);

      // Second check returns nothing (consumed)
      const second = session.checkCliApproval('Bash', { command: 'npm install' });
      expect(second).toBeUndefined();
    });

    it('should return but preserve tool_session-scope approvals', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'tool_session');

      // Multiple checks should all succeed
      const first = session.checkCliApproval('Bash', { command: 'npm install' });
      expect(first).toBeDefined();

      const second = session.checkCliApproval('Bash', { command: 'git push --force' });
      expect(second).toBeDefined();

      const third = session.checkCliApproval('Bash', {});
      expect(third).toBeDefined();
    });

    it('should return undefined for unapproved requests', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      const result = session.checkCliApproval('Bash', { command: 'npm install' });
      expect(result).toBeUndefined();
    });

    it('should not match different tool names', () => {
      const requestId = session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );
      session.approveCliRequest(requestId, 'single');

      const result = session.checkCliApproval('Edit', { file_path: 'foo.ts' });
      expect(result).toBeUndefined();
    });
  });

  describe('getPendingCliApprovals', () => {
    it('should return only unapproved records', () => {
      const id1 = session.createCliApprovalRequest('Bash', {}, 'dangerous', 80, false, 'test');
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');
      session.approveCliRequest(id1, 'single');

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe('Edit');
    });

    it('should return empty array when no pending', () => {
      expect(session.getPendingCliApprovals()).toHaveLength(0);
    });
  });

  describe('expiry', () => {
    it('should expire stale unapproved requests', () => {
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );

      // Manually backdate the request
      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);

      // Backdate to 10 minutes ago
      (pending[0] as any).requestedAt = new Date(Date.now() - 600_000).toISOString();

      // Creating a new request triggers lazy expiry
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const remaining = session.getPendingCliApprovals();
      // Original should be expired, only the new one remains
      expect(remaining).toHaveLength(1);
      expect(remaining[0].toolName).toBe('Edit');
    });

    it('should use per-record ttlMs when set (Issue #644)', () => {
      // Create a record with 60s TTL
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test', undefined, 60_000
      );

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].ttlMs).toBe(60_000);

      // Backdate to 70s ago (past the 60s TTL, but within default 300s)
      (pending[0] as any).requestedAt = new Date(Date.now() - 70_000).toISOString();

      // Trigger lazy expiry
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const remaining = session.getPendingCliApprovals();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].toolName).toBe('Edit');
    });

    it('should use default 300s TTL when ttlMs is not set (Issue #644)', () => {
      // Create a record without TTL
      session.createCliApprovalRequest(
        'Bash', { command: 'npm install' }, 'dangerous', 80, false, 'test'
      );

      const pending = session.getPendingCliApprovals();
      expect(pending).toHaveLength(1);

      // Backdate to 200s ago (within default 300s TTL)
      (pending[0] as any).requestedAt = new Date(Date.now() - 200_000).toISOString();

      // Trigger lazy expiry
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

      const remaining = session.getPendingCliApprovals();
      // Original should NOT be expired (200s < 300s default)
      expect(remaining).toHaveLength(2);
    });
  });

  describe('summary', () => {
    it('should include cliApprovalCount in summary', () => {
      session.createCliApprovalRequest('Bash', {}, 'dangerous', 80, false, 'test');
      session.createCliApprovalRequest('Edit', {}, 'moderate', 40, false, 'test');

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

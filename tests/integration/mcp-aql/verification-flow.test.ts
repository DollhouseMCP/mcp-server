import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { join as joinPath } from 'node:path';
/**
 * Integration tests for Danger Zone Verification Flow (Issue #142)
 *
 * Tests the full round-trip:
 * 1. VerificationStore stores a challenge code
 * 2. verify_challenge operation validates the code
 * 3. DangerZoneEnforcer unblocks the agent
 * 4. Metrics are tracked correctly
 *
 * NOTE: This test uses the real Container wiring but mocks the OS dialog
 * (showVerificationDialog) since integration tests run headless.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { VerificationStore } from '@dollhousemcp/safety';
import type { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import crypto from 'crypto';

const TEST_ADMIN_TOKEN = 'integration-clear-all-token';

describe('Danger Zone Verification Flow Integration (Issue #142)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let verificationStore: VerificationStore;
  let dangerZoneEnforcer: DangerZoneEnforcer;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-verification');
    container = new DollhouseContainer();
    container.register('DangerZoneBlockStore', () => new FileDangerZoneBlockStore(container.resolve('FileOperationsService'), joinPath(env.testDir, 'security')), { override: true });
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    await container.resolve<import('../../../src/security/DangerZoneEnforcer.js').DangerZoneEnforcer>('DangerZoneEnforcer').initialize(); // Initialize server
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    verificationStore = container.resolve<VerificationStore>('VerificationStore');
    dangerZoneEnforcer = container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
    dangerZoneEnforcer.setAdminToken(TEST_ADMIN_TOKEN);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    verificationStore.clear();
    await dangerZoneEnforcer.clearAll(TEST_ADMIN_TOKEN);
    await server.dispose();
    await env.cleanup();
  });

  it('retains a verified challenge when storage cannot release the agent', async () => {
    const challengeId = crypto.randomUUID();
    const challenge = { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Review required' };
    verificationStore.set(challengeId, challenge);
    await dangerZoneEnforcer.block('agent', 'Review required', [], challengeId);
    const backing = container.resolve<FileDangerZoneBlockStore>('DangerZoneBlockStore');
    jest.spyOn(backing, 'apply').mockRejectedValueOnce(new Error('storage unavailable'));
    const result = await mcpAqlHandler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, code: challenge.code } });
    expect(result.success).toBe(false);
    expect(verificationStore.get(challengeId)).toEqual(challenge);
    expect((await dangerZoneEnforcer.check('agent')).blocked).toBe(true);
    await dangerZoneEnforcer.initialize();
    expect(await dangerZoneEnforcer.check('agent')).toMatchObject({ blocked: true, verificationId: challengeId });
    const retried = await mcpAqlHandler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, code: challenge.code } });
    expect(retried.success).toBe(true);
    expect((await dangerZoneEnforcer.check('agent')).blocked).toBe(false);
  });

  it('verifies an ordinary challenge while an unrelated agent remains blocked', async () => {
    const challengeId = crypto.randomUUID();
    verificationStore.set(challengeId, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Review required' });
    await dangerZoneEnforcer.block('other-agent', 'Separate review', [], 'other-code');
    const result = await mcpAqlHandler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, code: 'ABC123' } });
    expect(result.success).toBe(true);
    expect(verificationStore.get(challengeId)).toBeUndefined();
    expect(await dangerZoneEnforcer.check('other-agent')).toMatchObject({ blocked: true, verificationId: 'other-code' });
  });

  it('completes verification while a healthy refresh is in progress', async () => {
    const challengeId = crypto.randomUUID();
    verificationStore.set(challengeId, { code: 'ABC123', expiresAt: Date.now() + 300000, reason: 'Review required' });
    await dangerZoneEnforcer.block('agent', 'Review required', [], challengeId);
    const backing = container.resolve<FileDangerZoneBlockStore>('DangerZoneBlockStore');
    const originalLoad = backing.load.bind(backing);
    const originalUnblock = dangerZoneEnforcer.unblock.bind(dangerZoneEnforcer);
    jest.spyOn(dangerZoneEnforcer, 'unblock').mockImplementationOnce(async (...args) => {
      let finish!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      jest.spyOn(backing, 'load').mockImplementationOnce(async () => { await held; return originalLoad(); });
      const checking = dangerZoneEnforcer.check('other');
      const releasing = originalUnblock(...args);
      finish();
      await checking;
      return releasing;
    });
    const result = await mcpAqlHandler.handleCreate({ operation: 'verify_challenge', params: { challenge_id: challengeId, code: 'ABC123' } });
    expect(result.success).toBe(true);
    expect((await dangerZoneEnforcer.check('agent')).blocked).toBe(false);
    expect(verificationStore.get(challengeId)).toBeUndefined();
  });

  describe('Full verification round-trip', () => {
    it('should unblock agent after successful verify_challenge', async () => {
      const challengeId = crypto.randomUUID();
      const code = 'ABC123';

      // Step 1: Store a challenge (simulates what autonomyEvaluator does)
      verificationStore.set(challengeId, {
        code,
        expiresAt: Date.now() + 300_000, // 5 minutes
        reason: 'Integration test: danger zone verification',
      });

      // Step 2: Block the agent (simulates DangerZoneEnforcer.block())
      dangerZoneEnforcer.block(
        'test-agent',
        'Danger zone pattern matched: rm -rf',
        ['rm -rf'],
        challengeId
      );

      // Verify agent is blocked
      const blockCheck = (await dangerZoneEnforcer.check('test-agent'));
      expect(blockCheck.blocked).toBe(true);
      expect(blockCheck.verificationId).toBe(challengeId);

      // Step 3: Submit correct verification code via MCP-AQL
      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code },
      });

      // Step 4: Verify success and agent unblocked
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(expect.objectContaining({
          verified: true,
          unblockedAgent: 'test-agent',
        }));
      }

      // Agent should now be unblocked
      const afterCheck = (await dangerZoneEnforcer.check('test-agent'));
      expect(afterCheck.blocked).toBe(false);
    });

    it('should reject wrong verification code and keep agent blocked', async () => {
      const challengeId = crypto.randomUUID();

      verificationStore.set(challengeId, {
        code: 'CORRECT',
        expiresAt: Date.now() + 300_000,
        reason: 'Integration test: wrong code',
      });

      dangerZoneEnforcer.block('test-agent', 'Blocked', ['pattern'], challengeId);

      // Submit wrong code
      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code: 'WRONG' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('incorrect code');
      }

      // Agent should still be blocked
      const check = (await dangerZoneEnforcer.check('test-agent'));
      expect(check.blocked).toBe(true);
    });

    it('should reject expired challenge', async () => {
      const challengeId = crypto.randomUUID();

      // Store with already-expired timestamp
      verificationStore.set(challengeId, {
        code: 'ABC123',
        expiresAt: Date.now() - 1000, // Already expired
        reason: 'Integration test: expired',
      });

      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('challenge not found');
      }
    });

    it('should enforce one-time use — second attempt fails', async () => {
      const challengeId = crypto.randomUUID();
      const code = 'ONETIME';

      verificationStore.set(challengeId, {
        code,
        expiresAt: Date.now() + 300_000,
        reason: 'Integration test: one-time use',
      });

      // First attempt — succeeds
      const result1 = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code },
      });
      expect(result1.success).toBe(true);

      // Second attempt — fails (code consumed)
      const result2 = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code },
      });
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error).toContain('challenge not found');
      }
    });
  });

  describe('UUID v4 format validation', () => {
    it('should reject non-UUID challenge IDs', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: 'not-a-uuid', code: 'ABC123' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid challenge_id format');
      }
    });

    it('should accept valid UUID v4 format', async () => {
      const challengeId = crypto.randomUUID();
      verificationStore.set(challengeId, {
        code: 'VALID',
        expiresAt: Date.now() + 300_000,
        reason: 'UUID format test',
      });

      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code: 'VALID' },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Rate limiting', () => {
    it('should rate-limit after too many failed attempts', async () => {
      // Exhaust rate limit with wrong codes (default: 10 failures per 60s)
      for (let i = 0; i < 11; i++) {
        const challengeId = crypto.randomUUID();
        verificationStore.set(challengeId, {
          code: 'CORRECT',
          expiresAt: Date.now() + 300_000,
          reason: `Rate limit test ${i}`,
        });

        await mcpAqlHandler.handleCreate({
          operation: 'verify_challenge',
          params: { challenge_id: challengeId, code: 'WRONG' },
        });
      }

      // Next attempt should be rate-limited regardless of correctness
      const challengeId = crypto.randomUUID();
      verificationStore.set(challengeId, {
        code: 'CORRECT',
        expiresAt: Date.now() + 300_000,
        reason: 'Should be rate-limited',
      });

      const result = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: challengeId, code: 'CORRECT' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Too many failed verification attempts');
      }
    });
  });

  describe('Verification metrics', () => {
    it('should track metrics across multiple operations', async () => {
      const initialMetrics = mcpAqlHandler.getVerificationMetrics();
      expect(initialMetrics.totalAttempts).toBe(0);

      // Success
      const successId = crypto.randomUUID();
      verificationStore.set(successId, {
        code: 'OK',
        expiresAt: Date.now() + 300_000,
        reason: 'Metrics test: success',
      });
      await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: successId, code: 'OK' },
      });

      // Failure (wrong code)
      const failId = crypto.randomUUID();
      verificationStore.set(failId, {
        code: 'RIGHT',
        expiresAt: Date.now() + 300_000,
        reason: 'Metrics test: failure',
      });
      await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: failId, code: 'WRONG' },
      });

      // Expired
      const expiredId = crypto.randomUUID();
      verificationStore.set(expiredId, {
        code: 'X',
        expiresAt: Date.now() - 1000,
        reason: 'Metrics test: expired',
      });
      await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: expiredId, code: 'X' },
      });

      // Invalid format
      await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: { challenge_id: 'bad', code: 'X' },
      });

      const metrics = mcpAqlHandler.getVerificationMetrics();
      expect(metrics.totalAttempts).toBe(4);
      expect(metrics.totalSuccesses).toBe(1);
      expect(metrics.totalFailures).toBe(1);
      expect(metrics.totalExpired).toBe(1);
      expect(metrics.totalInvalidFormat).toBe(1);
    });
  });

  describe('DI wiring verification', () => {
    it('should have VerificationStore registered as singleton', () => {
      const store1 = container.resolve<VerificationStore>('VerificationStore');
      const store2 = container.resolve<VerificationStore>('VerificationStore');
      expect(store1).toBe(store2);
    });

    it('should have DangerZoneEnforcer accessible', () => {
      expect(dangerZoneEnforcer).toBeDefined();
      expect(typeof dangerZoneEnforcer.block).toBe('function');
      expect(typeof dangerZoneEnforcer.unblock).toBe('function');
      expect(typeof dangerZoneEnforcer.check).toBe('function');
    });
  });
});

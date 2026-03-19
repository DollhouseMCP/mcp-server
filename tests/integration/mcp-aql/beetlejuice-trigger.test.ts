/**
 * Integration tests for Beetlejuice Safe-Trigger (Issue #503, #522)
 *
 * Tests the beetlejuice_beetlejuice_beetlejuice operation which triggers
 * the full danger zone verification pipeline in a single call:
 *   1. Generates a challenge (UUID + display code)
 *   2. Stores it in VerificationStore
 *   3. Blocks the agent in DangerZoneEnforcer
 *   4. Shows code via OS dialog (VerificationNotifier) — NOT in MCP response
 *
 * Issue #522: The code is deliberately OMITTED from the MCP tool response.
 * Tests read the code from VerificationStore (via DI) instead.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { VerificationStore } from '@dollhousemcp/safety';
import type { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import type { VerificationNotifier } from '../../../src/services/VerificationNotifier.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Beetlejuice Safe-Trigger Integration (Issue #503, #522)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let verificationStore: VerificationStore;
  let dangerZoneEnforcer: DangerZoneEnforcer;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-beetlejuice');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    verificationStore = container.resolve<VerificationStore>('VerificationStore');
    dangerZoneEnforcer = container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');

    // Issue #522: Mock showCode to prevent real OS dialogs during tests
    const notifier = container.resolve<VerificationNotifier>('VerificationNotifier');
    jest.spyOn(notifier, 'showCode').mockImplementation(() => {});
  });

  afterEach(async () => {
    verificationStore.clear();
    dangerZoneEnforcer.clearAll();
    await server.dispose();
    await env.cleanup();
  });

  describe('Trigger behavior', () => {
    it('should return challenge details with UUID v4 format challenge_id', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.triggered).toBe(true);
        expect(data.challenge_id).toMatch(UUID_V4_REGEX);
        expect(data.agent_name).toBe('beetlejuice-test-agent');
        expect(data.message).toContain('blocked');
        // Issue #522: code and instructions must NOT be in the response
        expect(data.code).toBeUndefined();
        expect(data.instructions).toBeUndefined();
      }
    });

    it('should use custom agent_name when provided', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: { agent_name: 'my-custom-agent' },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        expect(data.agent_name).toBe('my-custom-agent');
      }
    });

    it('should block agent in DangerZoneEnforcer', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        const blockCheck = dangerZoneEnforcer.check(data.agent_name as string);
        expect(blockCheck.blocked).toBe(true);
        expect(blockCheck.verificationId).toBe(data.challenge_id);
      }
    });

    it('should store challenge in VerificationStore (code readable server-side only)', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as Record<string, unknown>;
        const stored = verificationStore.get(data.challenge_id as string);
        expect(stored).toBeDefined();
        expect(typeof stored!.code).toBe('string');
        expect(stored!.code.length).toBeGreaterThan(0);
        // Issue #522: code is in the store but NOT in the response
        expect(data.code).toBeUndefined();
      }
    });

    it('should call VerificationNotifier.showCode with the code', async () => {
      // The beforeEach already mocks showCode; get a reference to the existing spy
      const notifier = container.resolve<VerificationNotifier>('VerificationNotifier');
      const showCodeSpy = jest.spyOn(notifier, 'showCode').mockImplementation(() => {});

      const result = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });

      expect(result.success).toBe(true);
      expect(showCodeSpy).toHaveBeenCalledTimes(1);

      // Verify showCode was called with a non-empty code string
      const [codeArg, reasonArg] = showCodeSpy.mock.calls[0];
      expect(typeof codeArg).toBe('string');
      expect(codeArg.length).toBeGreaterThan(0);
      expect(typeof reasonArg).toBe('string');

      showCodeSpy.mockRestore();
    });
  });

  describe('Full round-trip (trigger → verify)', () => {
    it('should unblock agent after verify_challenge with store-read code', async () => {
      // Step 1: Trigger
      const triggerResult = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });
      expect(triggerResult.success).toBe(true);
      const triggerData = (triggerResult as { success: true; data: Record<string, unknown> }).data;

      // Verify agent is blocked
      const beforeCheck = dangerZoneEnforcer.check(triggerData.agent_name as string);
      expect(beforeCheck.blocked).toBe(true);

      // Issue #522: Read code from VerificationStore (simulates human reading OS dialog)
      const challengeId = triggerData.challenge_id as string;
      const stored = verificationStore.get(challengeId);
      expect(stored).toBeDefined();

      // Step 2: Verify with store-read code
      const verifyResult = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: {
          challenge_id: challengeId,
          code: stored!.code,
        },
      });

      expect(verifyResult.success).toBe(true);
      if (verifyResult.success) {
        const verifyData = verifyResult.data as Record<string, unknown>;
        expect(verifyData.verified).toBe(true);
        expect(verifyData.unblockedAgent).toBe(triggerData.agent_name);
      }

      // Agent should now be unblocked
      const afterCheck = dangerZoneEnforcer.check(triggerData.agent_name as string);
      expect(afterCheck.blocked).toBe(false);
    });

    it('should reject wrong code and keep agent blocked', async () => {
      // Trigger
      const triggerResult = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: {},
      });
      expect(triggerResult.success).toBe(true);
      const triggerData = (triggerResult as { success: true; data: Record<string, unknown> }).data;

      // Submit wrong code
      const verifyResult = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: {
          challenge_id: triggerData.challenge_id,
          code: 'WRONG-CODE-999',
        },
      });

      expect(verifyResult.success).toBe(false);

      // Agent should still be blocked
      const check = dangerZoneEnforcer.check(triggerData.agent_name as string);
      expect(check.blocked).toBe(true);
    });

    it('should work end-to-end with custom agent name', async () => {
      const customName = 'e2e-custom-agent';

      // Trigger with custom name
      const triggerResult = await mcpAqlHandler.handleCreate({
        operation: 'beetlejuice_beetlejuice_beetlejuice',
        params: { agent_name: customName },
      });
      expect(triggerResult.success).toBe(true);
      const triggerData = (triggerResult as { success: true; data: Record<string, unknown> }).data;
      expect(triggerData.agent_name).toBe(customName);

      // Verify agent is blocked
      expect(dangerZoneEnforcer.check(customName).blocked).toBe(true);

      // Issue #522: Read code from VerificationStore
      const stored = verificationStore.get(triggerData.challenge_id as string);
      expect(stored).toBeDefined();

      // Verify with correct code from store
      const verifyResult = await mcpAqlHandler.handleCreate({
        operation: 'verify_challenge',
        params: {
          challenge_id: triggerData.challenge_id,
          code: stored!.code,
        },
      });

      expect(verifyResult.success).toBe(true);
      if (verifyResult.success) {
        expect((verifyResult.data as Record<string, unknown>).unblockedAgent).toBe(customName);
      }

      // Agent should be unblocked
      expect(dangerZoneEnforcer.check(customName).blocked).toBe(false);
    });
  });
});

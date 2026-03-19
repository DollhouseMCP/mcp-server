/**
 * Integration tests for allowElementPolicyOverrides kill switch (Issue #679/#683)
 *
 * Validates that the DOLLHOUSE_GATEKEEPER_ELEMENT_POLICY_OVERRIDES flag correctly
 * controls whether active element gatekeeper policies affect operation enforcement.
 *
 * Two scenarios tested end-to-end through the full stack:
 *
 * 1. Flag = true (default): active element's `allow` policy elevates a
 *    normally-CONFIRM_SESSION operation to AUTO_APPROVE.
 *
 * 2. Flag = false (kill switch): the same element's `allow` policy is bypassed —
 *    the operation stays at its route default (CONFIRM_SESSION).
 *
 * The flag cannot be tested via env var in the same Jest process (env is parsed
 * once at module load time). Instead, the kill switch gatekeeper is installed
 * directly on the handler instance:
 *
 *   (mcpAqlHandler as any).gatekeeper = new Gatekeeper(undefined, { allowElementPolicyOverrides: false });
 *
 * This is necessary because MCPAQLHandler stores its Gatekeeper by reference at
 * construction time (`this.gatekeeper = handlers.gatekeeper`) — re-registering in
 * the container does not affect the already-constructed handler instance.
 *
 * Bootstrap pattern: persona creation requires a confirmed `create_element` session.
 * We use preConfirmAllOperations() to satisfy that for setup, then
 * resetGatekeeperConfirmations() to clear them so the actual assertion is driven
 * only by element policy (not a lingering session confirmation).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import {
  createPortfolioTestEnvironment,
  preConfirmAllOperations,
  resetGatekeeperConfirmations,
  waitForCacheSettle,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';

describe('Gatekeeper allowElementPolicyOverrides kill switch (Issue #679/#683)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('gatekeeper-kill-switch');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize container
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  /**
   * Install a kill-switch Gatekeeper directly on the handler instance.
   *
   * MCPAQLHandler stores `this.gatekeeper` by reference at construction time, so
   * container.register() alone would not affect the running instance. This helper
   * performs a single type-asserted write in one place, keeping the pattern
   * documented and centralized rather than scattered across test cases.
   */
  function installKillSwitchGatekeeper(): void {
    (mcpAqlHandler as any).gatekeeper = new Gatekeeper(undefined, {
      allowElementPolicyOverrides: false,
    });
  }

  /**
   * Helper: create a persona with an allow policy and activate it.
   * `create_element` is CONFIRM_SESSION by default — an elevatable operation —
   * making it a reliable canary for whether allow policies are being applied.
   */
  async function setupPermissivePersona(): Promise<void> {
    const createResult = await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'permissive-persona',
        element_type: 'personas',
        description: 'Persona that allows create_element without confirmation',
        content: '# Permissive Persona\n\nYou are a test persona.',
        metadata: {
          category: 'testing',
          gatekeeper: {
            allow: ['create_element'],
          },
        },
      },
    });
    expect(createResult.success).toBe(true);

    await waitForCacheSettle();

    const activateResult = await mcpAqlHandler.handleRead({
      operation: 'activate_element',
      params: {
        element_name: 'permissive-persona',
        element_type: 'personas',
      },
    });
    expect(activateResult.success).toBe(true);
  }

  describe('flag = true (default) — element allow policies are applied', () => {
    it('should auto-approve create_element when active persona has allow policy', async () => {
      // Baseline: create_element without active element policy requires confirmation
      const baselineResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'probe-skill',
          element_type: 'skills',
          description: 'Probe skill',
          content: '# Probe',
        },
      });
      // No confirmation recorded and no allow policy active — expect confirmation required.
      // The error must contain 'confirm_operation' (the suggestion to call confirm_operation
      // to approve), distinguishing a CONFIRM_SESSION response from a hard DENY.
      expect(baselineResult.success).toBe(false);
      if (!baselineResult.success) {
        expect(baselineResult.error).toContain('confirm_operation');
      }

      // Bootstrap: pre-confirm so persona creation can proceed, then clear confirmations.
      // After reset, only the element allow policy drives auto-approval — not a
      // lingering session confirmation.
      preConfirmAllOperations(container);
      await setupPermissivePersona();
      resetGatekeeperConfirmations(container);

      // Now create_element should be auto-approved by the persona's allow policy.
      // Assert both success and that data is present — confirming the element was
      // actually created, not just that the gatekeeper returned a truthy result.
      const elevatedResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'probe-skill-2',
          element_type: 'skills',
          description: 'Probe skill after elevation',
          content: '# Probe 2',
        },
      });
      expect(elevatedResult.success).toBe(true);
      if (elevatedResult.success) {
        expect(elevatedResult.data).toBeDefined();
      }
    });
  });

  describe('flag = false (kill switch) — element allow policies are bypassed', () => {
    it('should keep create_element at CONFIRM_SESSION even when active persona has allow policy', async () => {
      // Set up the permissive persona FIRST using the normal gatekeeper.
      // create_element is CONFIRM_SESSION, so we need a pre-confirmed session to
      // bootstrap persona creation before the kill switch is active.
      preConfirmAllOperations(container);
      await setupPermissivePersona();

      // Install the kill switch gatekeeper (fresh session, no confirmations).
      // See installKillSwitchGatekeeper() for why direct assignment is necessary.
      installKillSwitchGatekeeper();

      // create_element should still require confirmation — allow policy was bypassed
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'blocked-skill',
          element_type: 'skills',
          description: 'Should not be created without confirmation',
          content: '# Blocked',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // 'confirm_operation' in the error distinguishes CONFIRM_SESSION from a hard DENY —
        // the operation is waiting for approval, not permanently blocked.
        expect(result.error).toContain('confirm_operation');
      }
    });

    it('should still enforce deny policies when flag is false', async () => {
      // Route validation (Layer 1) is config-independent — the kill switch only
      // affects Layer 2 (element policies). Installing the kill switch here confirms
      // that disabling element policy overrides does not inadvertently weaken
      // Layer 1 route-level enforcement.
      installKillSwitchGatekeeper();

      // Route-level security: calling create_element via wrong endpoint must still fail
      const result = await mcpAqlHandler.handleRead({
        operation: 'create_element',
        params: {
          element_name: 'bad-skill',
          element_type: 'skills',
          description: 'Wrong endpoint',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Security violation');
      }
    });
  });

  describe('flag = false — element deny and confirm policies are also bypassed', () => {
    it('should not apply deny policy from active element when kill switch is on', async () => {
      // Bootstrap: pre-confirm so we can create the deny-policy persona before
      // the kill switch is active (create_element is CONFIRM_SESSION by default).
      preConfirmAllOperations(container);

      // Create and activate a persona with a deny policy on list_elements
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'restrictive-persona',
          element_type: 'personas',
          description: 'Persona that denies list_elements',
          content: '# Restrictive Persona',
          metadata: {
            category: 'testing',
            gatekeeper: {
              deny: ['list_elements'],
            },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'restrictive-persona', element_type: 'personas' },
      });

      // Now install the kill switch gatekeeper (fresh session, no confirmations).
      // The restrictive persona is still active in PersonaManager — only the
      // enforcement layer changes.
      installKillSwitchGatekeeper();

      // list_elements should still succeed — deny policy bypassed by kill switch
      const listResult = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        element_type: 'persona',
        params: {},
      });
      expect(listResult.success).toBe(true);
    });
  });

  describe('flag = true — policy priority with multiple active elements', () => {
    it('should prioritize confirm over allow when both are set by different active elements (Issue #674)', async () => {
      // This test validates the priority hierarchy fix from Issue #674:
      //   element deny > element confirm > element allow > route default
      //
      // An `allow` policy from one element MUST NOT override a `confirm` policy
      // from another active element, regardless of activation order.

      preConfirmAllOperations(container);

      // Create and activate the allow-policy persona
      const allowPersonaResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'allow-persona',
          element_type: 'personas',
          description: 'Persona that would auto-approve create_element',
          content: '# Allow Persona',
          metadata: { category: 'testing', gatekeeper: { allow: ['create_element'] } },
        },
      });
      expect(allowPersonaResult.success).toBe(true);
      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'allow-persona', element_type: 'personas' },
      });

      // Create and activate the confirm-policy persona
      const confirmPersonaResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'confirm-persona',
          element_type: 'personas',
          description: 'Persona that requires confirmation for create_element',
          content: '# Confirm Persona',
          metadata: { category: 'testing', gatekeeper: { confirm: ['create_element'] } },
        },
      });
      expect(confirmPersonaResult.success).toBe(true);
      await waitForCacheSettle();

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: { element_name: 'confirm-persona', element_type: 'personas' },
      });

      // Clear session confirmations — now enforcement is driven by element policies only
      resetGatekeeperConfirmations(container);

      // With both personas active, confirm-persona's policy must take precedence.
      // The allow-persona's `allow` cannot override the confirm-persona's `confirm`.
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'priority-test-skill',
          element_type: 'skills',
          description: 'Should require confirmation despite allow-persona being active',
          content: '# Priority Test',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // CONFIRM_SESSION (not a hard deny) — 'confirm_operation' is present in the message.
        // This is the key assertion: the operation is waiting for approval, not permanently
        // blocked. It proves confirm-persona's policy won over allow-persona's policy.
        expect(result.error).toContain('confirm_operation');
      }
    });
  });
});

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
 * Note: Issue #1653 changed the MCPAQLHandler to auto-confirm operations when
 * the host has already approved the MCP tool call. As a result, handler-level
 * tests cannot observe the confirmation requirement. These tests validate policy
 * resolution at the Gatekeeper.enforce() level, where decisions are visible
 * before handler auto-confirmation applies.
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
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import type { ActiveElement } from '../../../src/handlers/mcp-aql/policies/index.js';
import {
  createPortfolioTestEnvironment,
  preConfirmAllOperations,
  resetGatekeeperConfirmations,
  waitForCacheSettle,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';

/**
 * Build an ActiveElement array matching what the permissive persona provides.
 */
function buildPermissiveActiveElements(): ActiveElement[] {
  return [{
    type: 'persona',
    name: 'permissive-persona',
    metadata: {
      name: 'permissive-persona',
      description: 'Persona that allows create_element without confirmation',
      gatekeeper: {
        allow: ['create_element'],
      },
    },
  }];
}

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
  function installKillSwitchGatekeeper(): Gatekeeper {
    const killSwitchGatekeeper = new Gatekeeper(undefined, {
      allowElementPolicyOverrides: false,
    });
    (mcpAqlHandler as any).gatekeeper = killSwitchGatekeeper;
    return killSwitchGatekeeper;
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
      const gatekeeper = container.resolve<Gatekeeper>('gatekeeper');

      // Baseline: create_element without active element policy requires confirmation.
      // Gatekeeper.enforce() returns the raw decision before handler auto-confirmation (#1653).
      const baselineDecision = gatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
        activeElements: [],
      });
      expect(baselineDecision.allowed).toBe(false);
      expect(baselineDecision.confirmationPending).toBe(true);
      expect(baselineDecision.permissionLevel).toBe(PermissionLevel.CONFIRM_SESSION);

      // Bootstrap: pre-confirm so persona creation can proceed, then clear confirmations.
      preConfirmAllOperations(container);
      await setupPermissivePersona();
      resetGatekeeperConfirmations(container);

      // Now create_element should be auto-approved by the persona's allow policy.
      const elevatedDecision = gatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
        activeElements: buildPermissiveActiveElements(),
      });
      expect(elevatedDecision.allowed).toBe(true);
      expect(elevatedDecision.permissionLevel).toBe(PermissionLevel.AUTO_APPROVE);

      // Also verify end-to-end via handler — element was actually created
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
      preConfirmAllOperations(container);
      await setupPermissivePersona();

      // Install the kill switch gatekeeper (fresh session, no confirmations).
      const killSwitchGatekeeper = installKillSwitchGatekeeper();

      // Gatekeeper.enforce() should still require confirmation — allow policy was bypassed
      const decision = killSwitchGatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
        activeElements: buildPermissiveActiveElements(),
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SESSION);
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

      const gatekeeper = container.resolve<Gatekeeper>('gatekeeper');

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
      // Test at Gatekeeper.enforce() level to observe the raw policy decision
      // before handler auto-confirmation (#1653).
      const activeElements: ActiveElement[] = [
        {
          type: 'persona',
          name: 'allow-persona',
          metadata: {
            name: 'allow-persona',
            description: 'Persona that would auto-approve create_element',
            gatekeeper: { allow: ['create_element'] },
          },
        },
        {
          type: 'persona',
          name: 'confirm-persona',
          metadata: {
            name: 'confirm-persona',
            description: 'Persona that requires confirmation for create_element',
            gatekeeper: { confirm: ['create_element'] },
          },
        },
      ];

      const decision = gatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
        activeElements,
      });

      // CONFIRM_SESSION (not AUTO_APPROVE) — confirm-persona's policy won over
      // allow-persona's policy, proving the priority hierarchy.
      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SESSION);
    });
  });
});

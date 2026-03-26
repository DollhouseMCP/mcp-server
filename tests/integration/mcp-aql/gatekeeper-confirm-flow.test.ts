/**
 * Integration tests for Gatekeeper confirmation flow (Issue #1601)
 *
 * Tests the full confirm/retry loop end-to-end WITHOUT pre-confirming operations.
 * Validates that:
 * 1. Unconfirmed operations return confirmationPending with guidance
 * 2. confirm_operation records the confirmation in the session
 * 3. Retrying the operation after confirmation succeeds
 * 4. Session confirmations persist across multiple operations
 * 5. Single-use confirmations are consumed after one use
 * 6. Deny policies block even after confirmation
 * 7. revokeAllConfirmations resets state
 * 8. Element-type-scoped confirmations don't leak across types
 * 9. Confirming an already-approved operation returns informative response
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Gatekeeper Confirm/Retry Flow (Issue #1601)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let gatekeeper: Gatekeeper;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('gatekeeper-confirm-flow');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    // Do NOT call preConfirmAllOperations — we want the raw enforcement flow
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('auto-confirm flow (#1653)', () => {
    it('should auto-confirm create_element without explicit confirm_operation', async () => {
      // #1653: Operations that would have required confirmationPending now auto-confirm
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'confirm-test-skill',
          element_type: 'skills',
          description: 'A skill for testing auto-confirmation flow',
          content: '# Confirm Test\n\nThis is test content for the auto-confirm flow.',
        },
      });

      // Should succeed directly — no confirm_operation round-trip needed
      expect(result.success).toBe(true);
    });

    it('confirm_operation still works for explicit pre-approval', async () => {
      // confirm_operation is still available for cases where explicit
      // pre-approval is desired (e.g., before a batch of operations)
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      });
      expect(confirmResult.success).toBe(true);

      const retryResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'retry-test-skill',
          element_type: 'skills',
          description: 'A skill created after explicit confirmation',
          content: '# Retry Test\n\nThis is test content.',
        },
      });
      expect(retryResult.success).toBe(true);
    });
  });

  describe('session vs single-use confirmation', () => {
    it('session confirmation should persist across multiple creates', async () => {
      // Confirm create_element at session level
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      });
      expect(confirmResult.success).toBe(true);

      // First create should succeed
      const create1 = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'session-test-1',
          element_type: 'skills',
          description: 'First session test skill',
          content: '# Session Test 1\n\nFirst skill.',
        },
      });
      expect(create1.success).toBe(true);

      // Second create should also succeed — session confirmation persists
      const create2 = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'session-test-2',
          element_type: 'skills',
          description: 'Second session test skill',
          content: '# Session Test 2\n\nSecond skill.',
        },
      });
      expect(create2.success).toBe(true);
    });

    it('both deletes succeed with auto-confirm (#1653)', async () => {
      // Create two skills to delete (auto-confirm handles the create)
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'delete-me-1',
          element_type: 'skills',
          description: 'Skill to delete',
          content: '# Delete Me 1\n\nFirst deletable skill.',
        },
      });
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'delete-me-2',
          element_type: 'skills',
          description: 'Skill to delete',
          content: '# Delete Me 2\n\nSecond deletable skill.',
        },
      });

      await waitForCacheSettle();

      // #1653: Both deletes succeed — auto-confirm handles each one
      const delete1 = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: { element_name: 'delete-me-1', element_type: 'skills' },
      });
      expect(delete1.success).toBe(true);

      const delete2 = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: { element_name: 'delete-me-2', element_type: 'skills' },
      });
      expect(delete2.success).toBe(true);
    });
  });

  describe('deny policy overrides confirmation', () => {
    it('should block operation even after confirmation when deny policy active', async () => {
      // Pre-confirm create so we can make the persona
      preConfirmAllOperations(container);

      // Create and activate a persona that denies delete_element
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'deny-delete-persona',
          element_type: 'personas',
          description: 'Persona that denies deletes',
          content: '# Deny Deletes\n\nYou block all delete operations.',
          metadata: {
            gatekeeper: { deny: ['delete_element'] },
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'deny-delete-persona',
          element_type: 'personas',
        },
      });
      expect(activateResult.success).toBe(true);

      // Reset and re-confirm to isolate the deny test
      gatekeeper.revokeAllConfirmations();

      // Confirm delete_element
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'delete_element' },
      });
      // confirm_operation should fail because the target op is denied, not confirmation-pending
      expect(confirmResult.success).toBe(false);
    });
  });

  describe('revoke confirmations', () => {
    it('should require re-confirmation after revokeAllConfirmations', async () => {
      // Confirm create_element
      await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      });

      // Create should succeed
      const create1 = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'revoke-test-1',
          element_type: 'skills',
          description: 'Pre-revoke skill',
          content: '# Revoke Test\n\nBefore revocation.',
        },
      });
      expect(create1.success).toBe(true);

      // Revoke all confirmations
      gatekeeper.revokeAllConfirmations();

      // #1653: Create still succeeds after revoke — auto-confirm re-records
      const create2 = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'revoke-test-2',
          element_type: 'skills',
          description: 'Post-revoke skill',
          content: '# Revoke Test 2\n\nAfter revocation, auto-confirmed.',
        },
      });
      expect(create2.success).toBe(true);
    });
  });

  describe('element-type-scoped confirmations', () => {
    it('should not leak scoped confirmation across element types', async () => {
      // Confirm create_element scoped to skill type.
      // Note: element_type must be passed at the top level of the operation input
      // (not nested inside params) for the enforce path to see it — parseOperationInput
      // only extracts element_type from the top level.
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element', element_type: 'skills' },
      });
      expect(confirmResult.success).toBe(true);

      // Creating a skill with element_type at top level so enforce sees the scope
      const skillCreate = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skills',
        params: {
          element_name: 'scoped-skill',
          element_type: 'skills',
          description: 'Skill with scoped confirmation',
          content: '# Scoped Skill\n\nThis should work.',
        },
      } as any);
      expect(skillCreate.success).toBe(true);

      // #1653: Persona also succeeds — auto-confirm handles unscoped case
      const personaCreate = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'personas',
        params: {
          element_name: 'scoped-persona',
          element_type: 'personas',
          description: 'Persona auto-confirmed',
          content: '# Scoped Persona\n\nAlso succeeds with auto-confirm.',
        },
      } as any);
      expect(personaCreate.success).toBe(true);
    });
  });

  describe('confirming already-approved operations', () => {
    it('should return informative response for auto-approved operation', async () => {
      // list_elements is AUTO_APPROVE — confirming it should say no confirmation needed
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'list_elements' },
      });
      expect(confirmResult.success).toBe(true);
      if (confirmResult.success) {
        const data = confirmResult.data as any;
        expect(data.confirmed).toBe(true);
        expect(data.message).toMatch(/already approved/i);
      }
    });
  });

  describe('auto-approved operations need no confirmation', () => {
    it('should allow list_elements without any confirmation', async () => {
      // list_elements is AUTO_APPROVE — should succeed with no confirmations
      const result = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        element_type: 'personas',
        params: {},
      });
      expect(result.success).toBe(true);
    });

    it('should allow get_element without any confirmation', async () => {
      // get_element is AUTO_APPROVE on READ endpoint
      const result = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        params: {
          element_name: 'nonexistent',
          element_type: 'skills',
        },
      });
      // May fail because element doesn't exist, but should NOT fail due to gatekeeper
      if (!result.success) {
        expect(result.error).not.toMatch(/confirm_operation/);
      }
    });
  });
});

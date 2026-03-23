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

  describe('confirmation required flow', () => {
    it('should return confirmationPending for unconfirmed create_element', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'confirm-test-skill',
          element_type: 'skills',
          description: 'A skill for testing confirmation flow',
          content: '# Confirm Test\n\nThis is test content for the confirmation flow.',
        },
      });

      // Should fail with confirmation guidance
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/confirm_operation/);
        expect(result.error).toMatch(/create_element/);
      }
    });

    it('should succeed after confirm_operation then retry', async () => {
      // Step 1: Attempt create — should be blocked
      const firstAttempt = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'retry-test-skill',
          element_type: 'skills',
          description: 'A skill for testing retry after confirmation',
          content: '# Retry Test\n\nThis is test content for retry flow.',
        },
      });
      expect(firstAttempt.success).toBe(false);

      // Step 2: Confirm the operation
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'create_element' },
      });
      expect(confirmResult.success).toBe(true);
      if (confirmResult.success) {
        const data = confirmResult.data as any;
        expect(data.confirmed).toBe(true);
      }

      // Step 3: Retry — should now succeed
      const retryResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'retry-test-skill',
          element_type: 'skills',
          description: 'A skill for testing retry after confirmation',
          content: '# Retry Test\n\nThis is test content for retry flow.',
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

    it('single-use confirmation should be consumed after one delete', async () => {
      // Pre-confirm create so we can make elements to delete
      preConfirmAllOperations(container);

      // Create two skills to delete
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

      // Reset confirmations to test single-use flow
      gatekeeper.revokeAllConfirmations();

      // Confirm delete_element (single-use level)
      const confirmResult = await mcpAqlHandler.handleExecute({
        operation: 'confirm_operation',
        params: { operation: 'delete_element' },
      });
      expect(confirmResult.success).toBe(true);
      if (confirmResult.success) {
        const data = confirmResult.data as any;
        expect(data.level).toBe('single_use');
      }

      // First delete should succeed (consumes the confirmation)
      const delete1 = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'delete-me-1',
          element_type: 'skills',
        },
      });
      expect(delete1.success).toBe(true);

      // Second delete should require re-confirmation
      const delete2 = await mcpAqlHandler.handleDelete({
        operation: 'delete_element',
        params: {
          element_name: 'delete-me-2',
          element_type: 'skills',
        },
      });
      expect(delete2.success).toBe(false);
      if (!delete2.success) {
        expect(delete2.error).toMatch(/confirm_operation/);
      }
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

      // Create should now require confirmation again
      const create2 = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'revoke-test-2',
          element_type: 'skills',
          description: 'Post-revoke skill',
          content: '# Revoke Test 2\n\nAfter revocation.',
        },
      });
      expect(create2.success).toBe(false);
      if (!create2.success) {
        expect(create2.error).toMatch(/confirm_operation/);
      }
    });
  });

  describe('auto-approved operations need no confirmation', () => {
    it('should allow list_elements without any confirmation', async () => {
      // list_elements is AUTO_APPROVE — should succeed with no confirmations
      const result = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        element_type: 'persona',
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

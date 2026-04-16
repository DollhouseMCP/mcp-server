/**
 * Permission Flow Full Matrix (Issue #1669)
 *
 * Exhaustive verification of every operation's permission level, endpoint,
 * confirmation scope, and elevation constraints. This is the definitive
 * reference for how the permission system works across all 100+ operations.
 *
 * Tests are generated programmatically from the OperationRouter and
 * OperationPolicies, ensuring they stay in sync with the codebase.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { Gatekeeper } from '../../../src/handlers/mcp-aql/Gatekeeper.js';
import { PermissionLevel } from '../../../src/handlers/mcp-aql/GatekeeperTypes.js';
import { OPERATION_ROUTES, type CRUDEndpoint } from '../../../src/handlers/mcp-aql/OperationRouter.js';
import {
  getDefaultPermissionLevel,
  canOperationBeElevated,
  getAutoApprovedOperations,
  getConfirmationRequiredOperations,
  getOperationsAtLevel,
  OPERATION_POLICY_OVERRIDES,
} from '../../../src/handlers/mcp-aql/policies/OperationPolicies.js';
import {
  createPortfolioTestEnvironment,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';

// ── Constants derived from the codebase ──

const ENDPOINT_DEFAULTS: Record<CRUDEndpoint, PermissionLevel> = {
  READ: PermissionLevel.AUTO_APPROVE,
  CREATE: PermissionLevel.CONFIRM_SESSION,
  UPDATE: PermissionLevel.CONFIRM_SINGLE_USE,
  DELETE: PermissionLevel.CONFIRM_SINGLE_USE,
  EXECUTE: PermissionLevel.CONFIRM_SINGLE_USE,
};

const ALL_OPERATIONS = Object.keys(OPERATION_ROUTES);

// ── Structural Verification Tests ──

describe('Permission Flow Full Matrix (Issue #1669)', () => {

  describe('Operation inventory completeness', () => {
    it('should have a non-trivial number of operations registered', () => {
      expect(ALL_OPERATIONS.length).toBeGreaterThan(50);
    });

    it('every operation should have an endpoint mapping', () => {
      for (const op of ALL_OPERATIONS) {
        const route = OPERATION_ROUTES[op];
        expect(route).toBeDefined();
        expect(['CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE']).toContain(route.endpoint);
      }
    });

    it('every operation should resolve to a permission level', () => {
      for (const op of ALL_OPERATIONS) {
        const level = getDefaultPermissionLevel(op);
        expect([
          PermissionLevel.AUTO_APPROVE,
          PermissionLevel.CONFIRM_SESSION,
          PermissionLevel.CONFIRM_SINGLE_USE,
          PermissionLevel.DENY,
        ]).toContain(level);
      }
    });

    it('unknown operations should default to CONFIRM_SINGLE_USE (secure fallback)', () => {
      expect(getDefaultPermissionLevel('nonexistent_operation')).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
      expect(getDefaultPermissionLevel('sneaky_backdoor')).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
      expect(getDefaultPermissionLevel('')).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
    });
  });

  // ── Endpoint Default Level Verification ──

  describe('Endpoint default levels', () => {
    for (const [endpoint, expectedLevel] of Object.entries(ENDPOINT_DEFAULTS)) {
      describe(`${endpoint} endpoint`, () => {
        const opsOnEndpoint = ALL_OPERATIONS.filter(
          op => OPERATION_ROUTES[op].endpoint === endpoint
        );

        it(`should have operations mapped to ${endpoint}`, () => {
          expect(opsOnEndpoint.length).toBeGreaterThan(0);
        });

        // For each operation on this endpoint, verify it either matches
        // the endpoint default or has an explicit override
        for (const op of opsOnEndpoint) {
          const override = OPERATION_POLICY_OVERRIDES[op];
          const effectiveLevel = getDefaultPermissionLevel(op);

          if (override) {
            it(`${op}: overridden to ${override.defaultLevel} (reason: ${override.rationale?.slice(0, 60)}...)`, () => {
              expect(effectiveLevel).toBe(override.defaultLevel);
            });
          } else {
            it(`${op}: inherits endpoint default ${expectedLevel}`, () => {
              expect(effectiveLevel).toBe(expectedLevel);
            });
          }
        }
      });
    }
  });

  // ── Auto-Approved Operations (READ + overrides) ──

  describe('AUTO_APPROVE operations — no confirmation needed', () => {
    const autoApproved = getAutoApprovedOperations();

    it('should include all READ operations without overrides', () => {
      const readOps = ALL_OPERATIONS.filter(
        op => OPERATION_ROUTES[op].endpoint === 'READ' && !OPERATION_POLICY_OVERRIDES[op]
      );
      for (const op of readOps) {
        expect(autoApproved).toContain(op);
      }
    });

    it('should include gatekeeper infrastructure operations', () => {
      expect(autoApproved).toContain('confirm_operation');
      expect(autoApproved).toContain('permission_prompt');
      expect(autoApproved).toContain('approve_cli_permission');
    });

    it('should include verification flow operations', () => {
      expect(autoApproved).toContain('verify_challenge');
      expect(autoApproved).toContain('release_deadlock');
      expect(autoApproved).toContain('beetlejuice_beetlejuice_beetlejuice');
    });

    it('should NOT include any destructive operations', () => {
      expect(autoApproved).not.toContain('delete_element');
      expect(autoApproved).not.toContain('clear');
      expect(autoApproved).not.toContain('clear_github_auth');
    });

    it('should NOT include execute_agent', () => {
      expect(autoApproved).not.toContain('execute_agent');
    });

    // Verify each auto-approved operation
    for (const op of autoApproved) {
      it(`${op}: should be AUTO_APPROVE`, () => {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.AUTO_APPROVE);
      });
    }
  });

  // ── CONFIRM_SESSION Operations ──

  describe('CONFIRM_SESSION operations — confirm once per session', () => {
    const sessionOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SESSION);

    it('should include core CRUD additive operations', () => {
      expect(sessionOps).toContain('create_element');
      expect(sessionOps).toContain('import_element');
      expect(sessionOps).toContain('addEntry');
      expect(sessionOps).toContain('record_execution_step');
    });

    it('should include portfolio operations', () => {
      expect(sessionOps).toContain('init_portfolio');
      expect(sessionOps).toContain('sync_portfolio');
      expect(sessionOps).toContain('portfolio_element_manager');
    });

    it('should include collection operations', () => {
      expect(sessionOps).toContain('install_collection_content');
      expect(sessionOps).toContain('submit_collection_content');
    });

    it('should include auth setup operations', () => {
      expect(sessionOps).toContain('setup_github_auth');
    });

    it('should include execution lifecycle session operations', () => {
      expect(sessionOps).toContain('complete_execution');
      expect(sessionOps).toContain('continue_execution');
      expect(sessionOps).toContain('prepare_handoff');
    });

    // Verify each session operation
    for (const op of sessionOps) {
      it(`${op}: should be CONFIRM_SESSION`, () => {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.CONFIRM_SESSION);
      });
    }
  });

  // ── CONFIRM_SINGLE_USE Operations ──

  describe('CONFIRM_SINGLE_USE operations — confirm every time', () => {
    const singleUseOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SINGLE_USE);

    it('should include all DELETE operations', () => {
      const deleteOps = ALL_OPERATIONS.filter(
        op => OPERATION_ROUTES[op].endpoint === 'DELETE'
      );
      for (const op of deleteOps) {
        expect(singleUseOps).toContain(op);
      }
    });

    it('should include all UPDATE operations', () => {
      const updateOps = ALL_OPERATIONS.filter(
        op => OPERATION_ROUTES[op].endpoint === 'UPDATE'
      );
      for (const op of updateOps) {
        expect(singleUseOps).toContain(op);
      }
    });

    it('should include dangerous execute operations', () => {
      expect(singleUseOps).toContain('execute_agent');
      expect(singleUseOps).toContain('abort_execution');
      expect(singleUseOps).toContain('resume_from_handoff');
    });

    // Verify each single-use operation
    for (const op of singleUseOps) {
      it(`${op}: should be CONFIRM_SINGLE_USE`, () => {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
      });
    }
  });

  // ── canBeElevated Constraints ──

  describe('canBeElevated constraints — operations that cannot be loosened by element policies', () => {
    const NON_ELEVATABLE = [
      'delete_element',
      'clear',
      'clear_github_auth',
      'execute_agent',
      'abort_execution',
      'resume_from_handoff',
      'permission_prompt',
      'approve_cli_permission',
    ];

    const ELEVATABLE = [
      'complete_execution',
      'continue_execution',
      'prepare_handoff',
    ];

    for (const op of NON_ELEVATABLE) {
      it(`${op}: canBeElevated should be FALSE`, () => {
        expect(canOperationBeElevated(op)).toBe(false);
      });
    }

    for (const op of ELEVATABLE) {
      it(`${op}: canBeElevated should be TRUE`, () => {
        expect(canOperationBeElevated(op)).toBe(true);
      });
    }

    it('operations without explicit overrides should default to canBeElevated=true', () => {
      expect(canOperationBeElevated('create_element')).toBe(true);
      expect(canOperationBeElevated('list_elements')).toBe(true);
      expect(canOperationBeElevated('addEntry')).toBe(true);
      expect(canOperationBeElevated('import_element')).toBe(true);
    });
  });

  // ── Override Audit ──

  describe('Operation policy overrides audit', () => {
    it('every override should reference a valid operation in the router', () => {
      for (const op of Object.keys(OPERATION_POLICY_OVERRIDES)) {
        expect(OPERATION_ROUTES[op]).toBeDefined();
      }
    });

    it('overrides should have rationale explaining the deviation', () => {
      for (const [, policy] of Object.entries(OPERATION_POLICY_OVERRIDES)) {
        expect(policy.rationale).toBeDefined();
        expect(policy.rationale?.length).toBeGreaterThan(10);
      }
    });

    it('AUTO_APPROVE overrides on non-READ endpoints should have clear justification', () => {
      for (const [op, policy] of Object.entries(OPERATION_POLICY_OVERRIDES)) {
        if (policy.defaultLevel === PermissionLevel.AUTO_APPROVE) {
          const route = OPERATION_ROUTES[op];
          if (route.endpoint !== 'READ') {
            // These are special cases that bypass normal confirmation
            // Each should have a clear rationale about why
            expect(policy.rationale).toBeDefined();
            expect(policy.rationale).toMatch(
              /auto-approved|frictionless|avoid.*confirmation|avoid.*loop/i
            );
          }
        }
      }
    });
  });

  // ── Confirmation Category Completeness ──

  describe('Confirmation categories completeness', () => {
    it('auto-approved + confirmation-required should cover all operations', () => {
      const autoApproved = getAutoApprovedOperations();
      const confirmRequired = getConfirmationRequiredOperations();
      const allCovered = new Set([...autoApproved, ...confirmRequired]);

      for (const op of ALL_OPERATIONS) {
        expect(allCovered.has(op)).toBe(true);
      }
    });

    it('no operation should appear in both auto-approved and confirmation-required', () => {
      const autoApproved = new Set(getAutoApprovedOperations());
      const confirmRequired = getConfirmationRequiredOperations();

      for (const op of confirmRequired) {
        expect(autoApproved.has(op)).toBe(false);
      }
    });
  });

  // ── Live Gatekeeper Enforcement Verification ──

  describe('Live gatekeeper enforcement — verify enforce() matches policy declarations', () => {
    let env: PortfolioTestEnvironment;
    let container: DollhouseContainer;
    let server: DollhouseMCPServer;
    let gatekeeper: Gatekeeper;

    beforeEach(async () => {
      env = await createPortfolioTestEnvironment('permission-matrix');
      container = new DollhouseContainer();
      server = new DollhouseMCPServer(container);
      await server.listPersonas();
      gatekeeper = container.resolve<Gatekeeper>('gatekeeper');
    });

    afterEach(async () => {
      try { await server.dispose(); } catch { /* ignore disposal errors */ }
      await env.cleanup();
    });

    describe('AUTO_APPROVE operations should be allowed without confirmation', () => {
      const autoOps = getAutoApprovedOperations();

      for (const op of autoOps) {
        const route = OPERATION_ROUTES[op];
        it(`${op} (${route.endpoint}): enforce() should return allowed=true`, () => {
          const decision = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(decision.allowed).toBe(true);
          expect(decision.permissionLevel).toBe(PermissionLevel.AUTO_APPROVE);
        });
      }
    });

    describe('CONFIRM_SESSION operations should return confirmationPending without confirmation', () => {
      const sessionOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SESSION);

      for (const op of sessionOps) {
        const route = OPERATION_ROUTES[op];
        it(`${op} (${route.endpoint}): enforce() should return allowed=false, confirmationPending=true`, () => {
          const decision = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(decision.allowed).toBe(false);
          expect(decision.confirmationPending).toBe(true);
          expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SESSION);
        });
      }
    });

    describe('CONFIRM_SINGLE_USE operations should return confirmationPending without confirmation', () => {
      const singleOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SINGLE_USE);

      for (const op of singleOps) {
        const route = OPERATION_ROUTES[op];
        it(`${op} (${route.endpoint}): enforce() should return allowed=false, confirmationPending=true`, () => {
          const decision = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(decision.allowed).toBe(false);
          expect(decision.confirmationPending).toBe(true);
          expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
        });
      }
    });

    describe('Session-confirmed operations should pass enforce()', () => {
      const sessionOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SESSION);

      for (const op of sessionOps) {
        const route = OPERATION_ROUTES[op];
        it(`${op}: should be allowed after session confirmation`, () => {
          gatekeeper.recordConfirmation(op, PermissionLevel.CONFIRM_SESSION);
          const decision = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(decision.allowed).toBe(true);
        });
      }
    });

    describe('Single-use confirmed operations should pass once then require re-confirmation', () => {
      const singleOps = getOperationsAtLevel(PermissionLevel.CONFIRM_SINGLE_USE);

      for (const op of singleOps) {
        const route = OPERATION_ROUTES[op];
        it(`${op}: allowed once, then blocked again`, () => {
          gatekeeper.recordConfirmation(op, PermissionLevel.CONFIRM_SINGLE_USE);

          // First check — should be allowed (consumes the confirmation)
          const first = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(first.allowed).toBe(true);

          // Second check — should require re-confirmation
          const second = gatekeeper.enforce({
            operation: op,
            endpoint: route.endpoint,
          });
          expect(second.allowed).toBe(false);
          expect(second.confirmationPending).toBe(true);
        });
      }
    });
  });
});

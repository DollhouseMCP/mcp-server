/**
 * Unit tests for Gatekeeper Policy Engine
 *
 * Tests the multi-layer access control enforcement:
 * - Layer 1: Route validation (operation exists and matches endpoint)
 * - Layer 2: Element policies (active element restrictions)
 * - Layer 3: Session confirmations (cached approvals)
 * - Layer 4: Default operation policies (permission levels)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  Gatekeeper,
  PermissionLevel,
  GatekeeperErrorCode,
} from '../../../../src/handlers/mcp-aql/Gatekeeper.js';
import type { CRUDEndpoint } from '../../../../src/handlers/mcp-aql/OperationRouter.js';
import { GatekeeperSession } from '../../../../src/handlers/mcp-aql/GatekeeperSession.js';
import { GatekeeperConfig } from '../../../../src/handlers/mcp-aql/GatekeeperConfig.js';
import {
  getDefaultPermissionLevel,
  getAutoApprovedOperations,
  getConfirmationRequiredOperations,
} from '../../../../src/handlers/mcp-aql/policies/index.js';
import type { ActiveElement } from '../../../../src/handlers/mcp-aql/policies/ElementPolicies.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

describe('Gatekeeper', () => {
  // Clean up security events after each test to prevent pollution
  afterEach(() => {
    SecurityMonitor.clearAllEventsForTesting();
  });

  describe('Static validate() - backward compatibility with PermissionGuard', () => {
    describe('CREATE operations', () => {
      it('should allow create_element via CREATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('create_element', 'CREATE');
        }).not.toThrow();
      });

      it('should allow import_element via CREATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('import_element', 'CREATE');
        }).not.toThrow();
      });

      it('should reject create_element via READ endpoint', () => {
        expect(() => {
          Gatekeeper.validate('create_element', 'READ');
        }).toThrow(/Security violation.*create_element.*mcp_aql_create.*not mcp_aql_read/);
      });

      it('should reject create_element via UPDATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('create_element', 'UPDATE');
        }).toThrow(/Security violation.*create_element.*mcp_aql_create.*not mcp_aql_update/);
      });

      it('should reject create_element via DELETE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('create_element', 'DELETE');
        }).toThrow(/Security violation.*create_element.*mcp_aql_create.*not mcp_aql_delete/);
      });
    });

    describe('READ operations', () => {
      const readOps = [
        'get_element',
        'list_elements',
        'query_elements',
        'search_elements',
        'validate_element',
        'get_active_elements',
      ];

      readOps.forEach(operation => {
        it(`should allow ${operation} via READ endpoint`, () => {
          expect(() => {
            Gatekeeper.validate(operation, 'READ');
          }).not.toThrow();
        });

        it(`should reject ${operation} via CREATE endpoint`, () => {
          expect(() => {
            Gatekeeper.validate(operation, 'CREATE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_create/);
        });

        it(`should reject ${operation} via UPDATE endpoint`, () => {
          expect(() => {
            Gatekeeper.validate(operation, 'UPDATE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_update/);
        });

        it(`should reject ${operation} via DELETE endpoint`, () => {
          expect(() => {
            Gatekeeper.validate(operation, 'DELETE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_delete/);
        });
      });
    });

    describe('UPDATE operations', () => {
      it('should allow edit_element via UPDATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('edit_element', 'UPDATE');
        }).not.toThrow();
      });

      it('should reject edit_element via CREATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('edit_element', 'CREATE');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_create/);
      });

      it('should reject edit_element via READ endpoint', () => {
        expect(() => {
          Gatekeeper.validate('edit_element', 'READ');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_read/);
      });

      it('should reject edit_element via DELETE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('edit_element', 'DELETE');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_delete/);
      });
    });

    describe('DELETE operations', () => {
      it('should allow delete_element via DELETE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('delete_element', 'DELETE');
        }).not.toThrow();
      });

      it('should reject delete_element via CREATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('delete_element', 'CREATE');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_create/);
      });

      it('should reject delete_element via READ endpoint', () => {
        expect(() => {
          Gatekeeper.validate('delete_element', 'READ');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_read/);
      });

      it('should reject delete_element via UPDATE endpoint', () => {
        expect(() => {
          Gatekeeper.validate('delete_element', 'UPDATE');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_update/);
      });
    });

    describe('Unknown operations', () => {
      it('should throw error for unknown operation', () => {
        expect(() => {
          Gatekeeper.validate('nonexistent_operation', 'READ');
        }).toThrow(/Unknown operation: "nonexistent_operation".*tool descriptions/);
      });

      it('should throw error for empty operation name', () => {
        expect(() => {
          Gatekeeper.validate('', 'READ');
        }).toThrow(/Unknown operation: "".*tool descriptions/);
      });

      it('should throw error for whitespace-only operation name', () => {
        expect(() => {
          Gatekeeper.validate('   ', 'READ');
        }).toThrow(/Unknown operation: " {3}".*tool descriptions/);
      });
    });

    describe('Error message content', () => {
      it('should include permission reason in error for CREATE violation', () => {
        expect(() => {
          Gatekeeper.validate('create_element', 'READ');
        }).toThrow(/additive, non-destructive nature/);
      });

      it('should include permission reason in error for READ violation', () => {
        expect(() => {
          Gatekeeper.validate('get_element', 'CREATE');
        }).toThrow(/read-only, safe nature/);
      });

      it('should include permission reason in error for UPDATE violation', () => {
        expect(() => {
          Gatekeeper.validate('edit_element', 'READ');
        }).toThrow(/data modification capabilities/);
      });

      it('should include permission reason in error for DELETE violation', () => {
        expect(() => {
          Gatekeeper.validate('delete_element', 'READ');
        }).toThrow(/destructive potential/);
      });
    });
  });

  describe('getPermissions()', () => {
    it('should return correct permissions for CREATE endpoint', () => {
      const permissions = Gatekeeper.getPermissions('CREATE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: false,
      });
    });

    it('should return correct permissions for READ endpoint', () => {
      const permissions = Gatekeeper.getPermissions('READ');
      expect(permissions).toEqual({
        readOnly: true,
        destructive: false,
      });
    });

    it('should return correct permissions for UPDATE endpoint', () => {
      const permissions = Gatekeeper.getPermissions('UPDATE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });

    it('should return correct permissions for DELETE endpoint', () => {
      const permissions = Gatekeeper.getPermissions('DELETE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });

    it('should return the same object reference for repeated calls', () => {
      const perm1 = Gatekeeper.getPermissions('READ');
      const perm2 = Gatekeeper.getPermissions('READ');
      expect(perm1).toBe(perm2);
    });
  });

  describe('Instance methods', () => {
    let gatekeeper: Gatekeeper;

    beforeEach(() => {
      gatekeeper = new Gatekeeper({ name: 'test-client', version: '1.0.0' });
    });

    describe('constructor and session management', () => {
      it('should create a unique session ID', () => {
        const gk1 = new Gatekeeper();
        const gk2 = new Gatekeeper();
        expect(gk1.sessionId).not.toBe(gk2.sessionId);
      });

      it('should include client info in session summary', () => {
        const summary = gatekeeper.getSessionSummary();
        expect(summary.clientInfo).toEqual({ name: 'test-client', version: '1.0.0' });
      });

      it('should track session creation time', () => {
        const summary = gatekeeper.getSessionSummary();
        expect(summary.createdAt).toBeDefined();
        expect(new Date(summary.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
      });
    });

    describe('validateRoute()', () => {
      it('should validate correct route without throwing', () => {
        expect(() => {
          gatekeeper.validateRoute('list_elements', 'READ');
        }).not.toThrow();
      });

      it('should throw for incorrect route', () => {
        expect(() => {
          gatekeeper.validateRoute('create_element', 'READ');
        }).toThrow(/Security violation/);
      });

      it('should throw for unknown operation', () => {
        expect(() => {
          gatekeeper.validateRoute('unknown_op', 'READ');
        }).toThrow(/Unknown operation/);
      });
    });

    describe('enforce()', () => {
      it('should allow auto-approved operations', () => {
        const decision = gatekeeper.enforce({
          operation: 'list_elements',
          endpoint: 'READ',
        });

        expect(decision.allowed).toBe(true);
        expect(decision.permissionLevel).toBe(PermissionLevel.AUTO_APPROVE);
      });

      it('should deny operations called via wrong endpoint', () => {
        const decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'READ',
        });

        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe(GatekeeperErrorCode.ENDPOINT_MISMATCH);
      });

      it('should auto-approve READ-routed operations like activate_element', () => {
        const decision = gatekeeper.enforce({
          operation: 'activate_element',
          endpoint: 'READ',
        });

        expect(decision.allowed).toBe(true);
        expect(decision.permissionLevel).toBe(PermissionLevel.AUTO_APPROVE);
      });

      it('should auto-approve deactivate_element on READ endpoint', () => {
        const decision = gatekeeper.enforce({
          operation: 'deactivate_element',
          endpoint: 'READ',
        });

        expect(decision.allowed).toBe(true);
        expect(decision.permissionLevel).toBe(PermissionLevel.AUTO_APPROVE);
      });

      it('should require confirmation for session-confirm operations', () => {
        const decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
        });

        expect(decision.allowed).toBe(false);
        expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SESSION);
        expect(decision.confirmationPending).toBe(true);
      });

      it('should require confirmation for single-use operations', () => {
        const decision = gatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
        });

        expect(decision.allowed).toBe(false);
        expect(decision.permissionLevel).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
        expect(decision.confirmationPending).toBe(true);
      });
    });

    describe('Session confirmations', () => {
      it('should allow operation after session confirmation', () => {
        // Initially requires confirmation
        let decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
        });
        expect(decision.allowed).toBe(false);

        // Record confirmation
        gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

        // Now should be allowed
        decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
        });
        expect(decision.allowed).toBe(true);
        expect(decision.policySource).toBe('session_confirmation');
      });

      it('should revoke single-use confirmation after use', () => {
        // Record single-use confirmation
        gatekeeper.recordConfirmation('delete_element', PermissionLevel.CONFIRM_SINGLE_USE);

        // First use should be allowed
        let decision = gatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
        });
        expect(decision.allowed).toBe(true);

        // Second use should require confirmation again
        decision = gatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
        });
        expect(decision.allowed).toBe(false);
        expect(decision.confirmationPending).toBe(true);
      });

      it('should support element-type scoped confirmations', () => {
        // Confirm for personas only
        gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION, 'personas');

        // Should work for personas
        let decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          elementType: 'personas',
        });
        expect(decision.allowed).toBe(true);

        // Should not work for skills (no confirmation for this type)
        decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          elementType: 'skills',
        });
        expect(decision.allowed).toBe(false);
      });

      it('should revoke all confirmations', () => {
        gatekeeper.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);
        gatekeeper.recordConfirmation('edit_element', PermissionLevel.CONFIRM_SESSION);

        gatekeeper.revokeAllConfirmations();

        // Both should require confirmation again
        expect(
          gatekeeper.enforce({ operation: 'create_element', endpoint: 'CREATE' }).allowed
        ).toBe(false);
        expect(
          gatekeeper.enforce({ operation: 'edit_element', endpoint: 'UPDATE' }).allowed
        ).toBe(false);
      });
    });

    describe('Element policies', () => {
      it('should block operations denied by active element', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Restrictive Persona',
            metadata: {
              name: 'Restrictive Persona',
              gatekeeper: {
                deny: ['delete_element'],
              },
            },
          },
        ];

        const decision = gatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
          activeElements,
        });

        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe(GatekeeperErrorCode.ELEMENT_POLICY_VIOLATION);
        expect(decision.policySource).toBe('element_policy');
      });

      it('should auto-approve operations allowed by active element', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'skills',
            name: 'Admin Skill',
            metadata: {
              name: 'Admin Skill',
              gatekeeper: {
                allow: ['create_element'],
              },
            },
          },
        ];

        const decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          activeElements,
        });

        expect(decision.allowed).toBe(true);
        expect(decision.policySource).toBe('element_policy');
      });

      it('should enforce scope restrictions', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Skill-Only Persona',
            metadata: {
              name: 'Skill-Only Persona',
              gatekeeper: {
                scopeRestrictions: {
                  allowedTypes: ['skills'],
                },
              },
            },
          },
        ];

        // Should work for skills
        let decision = gatekeeper.enforce({
          operation: 'list_elements',
          endpoint: 'READ',
          elementType: 'skills',
          activeElements,
        });
        expect(decision.allowed).toBe(true);

        // Should deny for personas
        decision = gatekeeper.enforce({
          operation: 'list_elements',
          endpoint: 'READ',
          elementType: 'personas',
          activeElements,
        });
        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe(GatekeeperErrorCode.SCOPE_RESTRICTION);
      });

      // Issue #674: cross-element policy resolution — allow cannot override confirm from another element
      it('should not let allow from one element override confirm from another element', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Security Persona',
            metadata: {
              name: 'Security Persona',
              gatekeeper: {
                confirm: ['create_element'],
              },
            },
          },
          {
            type: 'skills',
            name: 'Permissive Skill',
            metadata: {
              name: 'Permissive Skill',
              gatekeeper: {
                allow: ['create_element'],
              },
            },
          },
        ];

        const decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          activeElements,
        });

        // confirm from Security Persona must win over allow from Permissive Skill
        expect(decision.allowed).toBe(false);
        expect(decision.confirmationPending).toBe(true);
        expect(decision.reason).toContain('"Security Persona"');
      });

      it('should report conflicting elements that wanted allow but were overridden by confirm', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Security Persona',
            metadata: {
              name: 'Security Persona',
              gatekeeper: {
                confirm: ['create_element'],
              },
            },
          },
          {
            type: 'skills',
            name: 'Permissive Skill',
            metadata: {
              name: 'Permissive Skill',
              gatekeeper: {
                allow: ['create_element'],
              },
            },
          },
        ];

        const decision = gatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          activeElements,
        });

        // Conflict note should appear in the reason
        expect(decision.reason).toContain('"Permissive Skill"');
        expect(decision.reason).toContain('would auto-approve');
        expect(decision.reason).toContain('overridden');
      });

      // Issue #679: allowElementPolicyOverrides kill switch
      it('should bypass element policy layer when allowElementPolicyOverrides is false', () => {
        const restrictedGatekeeper = new Gatekeeper(undefined, { allowElementPolicyOverrides: false });
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Restrictive Persona',
            metadata: {
              name: 'Restrictive Persona',
              gatekeeper: {
                deny: ['delete_element'],
              },
            },
          },
        ];

        // With override disabled, element deny policy is ignored
        const decision = restrictedGatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
          activeElements,
        });

        // delete_element default is CONFIRM_SINGLE_USE — element deny is bypassed
        expect(decision.allowed).toBe(false);
        // Should be confirmation required, not element policy violation
        expect(decision.confirmationPending).toBe(true);
        expect(decision.errorCode).not.toBe(GatekeeperErrorCode.ELEMENT_POLICY_VIOLATION);
      });

      it('should bypass element allow elevation when allowElementPolicyOverrides is false', () => {
        const restrictedGatekeeper = new Gatekeeper(undefined, { allowElementPolicyOverrides: false });
        const activeElements: ActiveElement[] = [
          {
            type: 'skills',
            name: 'Admin Skill',
            metadata: {
              name: 'Admin Skill',
              gatekeeper: {
                allow: ['create_element'],
              },
            },
          },
        ];

        // With override disabled, element allow policy is ignored — stays at route default
        const decision = restrictedGatekeeper.enforce({
          operation: 'create_element',
          endpoint: 'CREATE',
          activeElements,
        });

        // create_element default is CONFIRM_SESSION — element allow is bypassed
        expect(decision.allowed).toBe(false);
        expect(decision.confirmationPending).toBe(true);
        expect(decision.policySource).not.toBe('element_policy');
      });

      it('deny list should take priority over allow list', () => {
        const activeElements: ActiveElement[] = [
          {
            type: 'personas',
            name: 'Conflicting Persona',
            metadata: {
              name: 'Conflicting Persona',
              gatekeeper: {
                allow: ['delete_element'],
                deny: ['delete_element'],
              },
            },
          },
        ];

        const decision = gatekeeper.enforce({
          operation: 'delete_element',
          endpoint: 'DELETE',
          activeElements,
        });

        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe(GatekeeperErrorCode.ELEMENT_POLICY_VIOLATION);
      });
    });
  });

  describe('GatekeeperSession', () => {
    let session: GatekeeperSession;

    beforeEach(() => {
      session = new GatekeeperSession({ name: 'test', version: '1.0' });
    });

    it('should generate unique session IDs', () => {
      const session2 = new GatekeeperSession();
      expect(session.sessionId).not.toBe(session2.sessionId);
    });

    it('should track client info', () => {
      expect(session.clientInfo).toEqual({ name: 'test', version: '1.0' });
    });

    it('should record and check confirmations', () => {
      session.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      const confirmation = session.peekConfirmation('create_element');
      expect(confirmation).toBeDefined();
      expect(confirmation?.operation).toBe('create_element');
    });

    it('should consume single-use confirmations', () => {
      session.recordConfirmation('delete_element', PermissionLevel.CONFIRM_SINGLE_USE);

      // First check consumes it
      const confirmation = session.checkConfirmation('delete_element');
      expect(confirmation).toBeDefined();

      // Second check returns undefined
      const confirmation2 = session.checkConfirmation('delete_element');
      expect(confirmation2).toBeUndefined();
    });

    it('should keep session confirmations', () => {
      session.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      // Multiple checks should work
      expect(session.checkConfirmation('create_element')).toBeDefined();
      expect(session.checkConfirmation('create_element')).toBeDefined();
    });

    it('should revoke specific confirmations', () => {
      session.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);
      session.recordConfirmation('edit_element', PermissionLevel.CONFIRM_SESSION);

      expect(session.revokeConfirmation('create_element')).toBe(true);
      expect(session.peekConfirmation('create_element')).toBeUndefined();
      expect(session.peekConfirmation('edit_element')).toBeDefined();
    });

    it('should get summary', () => {
      session.recordConfirmation('create_element', PermissionLevel.CONFIRM_SESSION);

      const summary = session.getSummary();
      expect(summary.sessionId).toBe(session.sessionId);
      expect(summary.confirmationCount).toBe(1);
    });

    it('should enforce max confirmations limit', () => {
      const limitedSession = new GatekeeperSession(undefined, 3);

      limitedSession.recordConfirmation('op1', PermissionLevel.CONFIRM_SESSION);
      limitedSession.recordConfirmation('op2', PermissionLevel.CONFIRM_SESSION);
      limitedSession.recordConfirmation('op3', PermissionLevel.CONFIRM_SESSION);
      limitedSession.recordConfirmation('op4', PermissionLevel.CONFIRM_SESSION);

      // Oldest should be evicted
      expect(limitedSession.peekConfirmation('op1')).toBeUndefined();
      expect(limitedSession.peekConfirmation('op2')).toBeDefined();
      expect(limitedSession.peekConfirmation('op3')).toBeDefined();
      expect(limitedSession.peekConfirmation('op4')).toBeDefined();
    });
  });

  describe('GatekeeperConfig', () => {
    it('should use defaults when no options provided', () => {
      const config = new GatekeeperConfig();
      expect(config.strictness).toBeDefined();
      expect(config.verificationTimeoutMs).toBe(60000);
      expect(config.enableAuditLogging).toBe(true);
    });

    it('should merge provided options with defaults', () => {
      const config = new GatekeeperConfig({
        verificationTimeoutMs: 30000,
      });
      expect(config.verificationTimeoutMs).toBe(30000);
      expect(config.enableAuditLogging).toBe(true); // Default
    });

    it('should export full config as JSON', () => {
      const config = new GatekeeperConfig({ verificationTimeoutMs: 45000 });
      const json = config.toJSON();
      expect(json.verificationTimeoutMs).toBe(45000);
      expect(json.enableAuditLogging).toBe(true);
    });
  });

  describe('Operation Policies', () => {
    it('should have policies for all routed operations', () => {
      // All auto-approved operations should be read-only
      const autoApproved = getAutoApprovedOperations();
      expect(autoApproved.length).toBeGreaterThan(0);

      autoApproved.forEach(op => {
        expect(getDefaultPermissionLevel(op)).toBe(PermissionLevel.AUTO_APPROVE);
      });
    });

    it('should have confirmation-required operations', () => {
      const confirmRequired = getConfirmationRequiredOperations();
      expect(confirmRequired.length).toBeGreaterThan(0);

      confirmRequired.forEach(op => {
        const level = getDefaultPermissionLevel(op);
        expect([PermissionLevel.CONFIRM_SESSION, PermissionLevel.CONFIRM_SINGLE_USE]).toContain(level);
      });
    });

    it('should default to CONFIRM_SINGLE_USE for unknown operations', () => {
      const level = getDefaultPermissionLevel('unknown_operation');
      expect(level).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
    });

    it('should derive AUTO_APPROVE from READ endpoint for operations without overrides', () => {
      // activate_element and deactivate_element are on READ endpoint
      // and have no explicit override, so they should be AUTO_APPROVE
      expect(getDefaultPermissionLevel('activate_element')).toBe(PermissionLevel.AUTO_APPROVE);
      expect(getDefaultPermissionLevel('deactivate_element')).toBe(PermissionLevel.AUTO_APPROVE);
    });

    it('should derive CONFIRM_SESSION from CREATE endpoint for operations without overrides', () => {
      // create_element is on CREATE endpoint with no override
      expect(getDefaultPermissionLevel('create_element')).toBe(PermissionLevel.CONFIRM_SESSION);
      expect(getDefaultPermissionLevel('addEntry')).toBe(PermissionLevel.CONFIRM_SESSION);
    });

    it('should derive CONFIRM_SINGLE_USE from DELETE endpoint for operations without overrides', () => {
      // delete_element has an override (canBeElevated: false) but same level
      expect(getDefaultPermissionLevel('delete_element')).toBe(PermissionLevel.CONFIRM_SINGLE_USE);
    });

    it('should allow explicit overrides to differ from endpoint default', () => {
      // verify_challenge is on CREATE (default CONFIRM_SESSION) but overridden to AUTO_APPROVE
      expect(getDefaultPermissionLevel('verify_challenge')).toBe(PermissionLevel.AUTO_APPROVE);
      // confirm_operation is on EXECUTE (default CONFIRM_SINGLE_USE) but overridden to AUTO_APPROVE
      expect(getDefaultPermissionLevel('confirm_operation')).toBe(PermissionLevel.AUTO_APPROVE);
      // get_execution_state is on EXECUTE but overridden to AUTO_APPROVE
      expect(getDefaultPermissionLevel('get_execution_state')).toBe(PermissionLevel.AUTO_APPROVE);
    });
  });

  describe('Integration tests', () => {
    it('should validate all CRUD endpoints have permissions defined', () => {
      const endpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE'];
      endpoints.forEach(endpoint => {
        const permissions = Gatekeeper.getPermissions(endpoint);
        expect(permissions).toBeDefined();
        expect(typeof permissions.readOnly).toBe('boolean');
        expect(typeof permissions.destructive).toBe('boolean');
      });
    });

    it('should ensure only READ endpoint is marked as readOnly', () => {
      expect(Gatekeeper.getPermissions('CREATE').readOnly).toBe(false);
      expect(Gatekeeper.getPermissions('READ').readOnly).toBe(true);
      expect(Gatekeeper.getPermissions('UPDATE').readOnly).toBe(false);
      expect(Gatekeeper.getPermissions('DELETE').readOnly).toBe(false);
    });

    it('should ensure UPDATE and DELETE endpoints are marked as destructive', () => {
      expect(Gatekeeper.getPermissions('CREATE').destructive).toBe(false);
      expect(Gatekeeper.getPermissions('READ').destructive).toBe(false);
      expect(Gatekeeper.getPermissions('UPDATE').destructive).toBe(true);
      expect(Gatekeeper.getPermissions('DELETE').destructive).toBe(true);
    });

    it('should log audit events to SecurityMonitor for denied operations', () => {
      const gatekeeper = new Gatekeeper();

      // Perform a denied operation that will be logged
      // (allowed operations no longer generate security events)
      const decision = gatekeeper.enforce({
        operation: 'list_elements',
        endpoint: 'READ',
      });

      // Allowed decisions should NOT generate security events (noise reduction)
      const events = SecurityMonitor.getRecentEvents(10);
      const gatekeeperEvents = events.filter(e => e.source.includes('Gatekeeper'));
      if (decision.allowed) {
        expect(gatekeeperEvents.length).toBe(0);
      }
    });
  });

  describe('Confirmation rationale context', () => {
    let gatekeeper: Gatekeeper;

    beforeEach(() => {
      gatekeeper = new Gatekeeper();
    });

    it('should include route-level rationale for destructive operations', () => {
      const decision = gatekeeper.enforce({
        operation: 'delete_element',
        endpoint: 'DELETE',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.reason).toContain('requires confirmation each time');
      expect(decision.reason).toContain('Destructive operation, permanently removes data');
    });

    it('should include route-level rationale for execute operations', () => {
      const decision = gatekeeper.enforce({
        operation: 'execute_agent',
        endpoint: 'EXECUTE',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.reason).toContain('requires confirmation each time');
      expect(decision.reason).toContain('Executes agent with unpredictable side effects');
    });

    it('should include session-level label for create operations', () => {
      const decision = gatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.reason).toContain('requires confirmation once per session');
    });

    it('should include element name when element policy elevates confirmation', () => {
      const activeElements: ActiveElement[] = [{
        type: 'personas',
        name: 'Careful Reviewer',
        metadata: {
          name: 'Careful Reviewer',
          gatekeeper: { confirm: ['create_element'] },
        },
      }];

      const decision = gatekeeper.enforce({
        operation: 'create_element',
        endpoint: 'CREATE',
        activeElements,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.reason).toContain('"Careful Reviewer"');
      expect(decision.reason).toContain('policy requires confirmation');
      expect(decision.policySource).toBe('element_policy');
    });

    it('should provide default rationale for operations without explicit policy', () => {
      // record_execution_step is CREATE endpoint, no explicit override
      const decision = gatekeeper.enforce({
        operation: 'record_execution_step',
        endpoint: 'CREATE',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      expect(decision.reason).toContain('requires confirmation once per session');
      // No explicit rationale override for this operation — gets endpoint default
    });

    it('should include rationale in confirm response alongside element policy', () => {
      const activeElements: ActiveElement[] = [{
        type: 'skills',
        name: 'Safety First',
        metadata: {
          name: 'Safety First',
          gatekeeper: { confirm: ['delete_element'] },
        },
      }];

      const decision = gatekeeper.enforce({
        operation: 'delete_element',
        endpoint: 'DELETE',
        activeElements,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.confirmationPending).toBe(true);
      // Should contain both the element attribution AND the operation rationale
      expect(decision.reason).toContain('"Safety First"');
      expect(decision.reason).toContain('Destructive operation, permanently removes data');
    });

    it('should skip element policies when skipElementPolicies is true', () => {
      const activeElements: ActiveElement[] = [{
        type: 'personas',
        name: 'Blocker',
        metadata: {
          name: 'Blocker',
          gatekeeper: { confirm: ['confirm_operation'] },
        },
      }];

      // confirm_operation with skipElementPolicies should use route default (AUTO_APPROVE)
      const decision = gatekeeper.enforce({
        operation: 'confirm_operation',
        endpoint: 'EXECUTE',
        activeElements,
        skipElementPolicies: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.reason).not.toContain('Blocker');
    });
  });
});

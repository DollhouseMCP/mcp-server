/**
 * Unit tests for PermissionGuard
 *
 * Tests the security enforcement layer that validates operations
 * are called via the correct CRUD endpoints.
 */

import { describe, it, expect } from '@jest/globals';
import { PermissionGuard } from '../../../../src/handlers/mcp-aql/PermissionGuard.js';
import type { CRUDEndpoint } from '../../../../src/handlers/mcp-aql/OperationRouter.js';

describe('PermissionGuard', () => {
  describe('validate()', () => {
    describe('CREATE operations', () => {
      it('should allow create_element via CREATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('create_element', 'CREATE');
        }).not.toThrow();
      });

      it('should allow import_element via CREATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('import_element', 'CREATE');
        }).not.toThrow();
      });

      it('should reject create_element via READ endpoint', () => {
        expect(() => {
          PermissionGuard.validate('create_element', 'READ');
        }).toThrow(/Security violation.*create_element.*mcp_aql_create.*not mcp_aql_read/);
      });

      it('should reject create_element via UPDATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('create_element', 'UPDATE');
        }).toThrow(/Security violation.*create_element.*mcp_aql_create.*not mcp_aql_update/);
      });

      it('should reject create_element via DELETE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('create_element', 'DELETE');
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
            PermissionGuard.validate(operation, 'READ');
          }).not.toThrow();
        });

        it(`should reject ${operation} via CREATE endpoint`, () => {
          expect(() => {
            PermissionGuard.validate(operation, 'CREATE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_create/);
        });

        it(`should reject ${operation} via UPDATE endpoint`, () => {
          expect(() => {
            PermissionGuard.validate(operation, 'UPDATE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_update/);
        });

        it(`should reject ${operation} via DELETE endpoint`, () => {
          expect(() => {
            PermissionGuard.validate(operation, 'DELETE');
          }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_delete/);
        });
      });
    });

    describe('UPDATE operations', () => {
      it('should allow edit_element via UPDATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('edit_element', 'UPDATE');
        }).not.toThrow();
      });

      it('should reject edit_element via CREATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('edit_element', 'CREATE');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_create/);
      });

      it('should reject edit_element via READ endpoint', () => {
        expect(() => {
          PermissionGuard.validate('edit_element', 'READ');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_read/);
      });

      it('should reject edit_element via DELETE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('edit_element', 'DELETE');
        }).toThrow(/Security violation.*mcp_aql_update.*not mcp_aql_delete/);
      });
    });

    describe('READ operations - activation/deactivation', () => {
      // activate_element is READ (reads element into session, no persistent state created - Issue #535)
      it('should allow activate_element via READ endpoint', () => {
        expect(() => {
          PermissionGuard.validate('activate_element', 'READ');
        }).not.toThrow();
      });

      it('should reject activate_element via UPDATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('activate_element', 'UPDATE');
        }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_update/);
      });

      // deactivate_element is READ (modifies session state, not persistent data)
      it('should allow deactivate_element via READ endpoint', () => {
        expect(() => {
          PermissionGuard.validate('deactivate_element', 'READ');
        }).not.toThrow();
      });

      it('should reject deactivate_element via UPDATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('deactivate_element', 'UPDATE');
        }).toThrow(/Security violation.*mcp_aql_read.*not mcp_aql_update/);
      });
    });

    describe('DELETE operations', () => {
      it('should allow delete_element via DELETE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('delete_element', 'DELETE');
        }).not.toThrow();
      });

      it('should reject delete_element via CREATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('delete_element', 'CREATE');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_create/);
      });

      it('should reject delete_element via READ endpoint', () => {
        expect(() => {
          PermissionGuard.validate('delete_element', 'READ');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_read/);
      });

      it('should reject delete_element via UPDATE endpoint', () => {
        expect(() => {
          PermissionGuard.validate('delete_element', 'UPDATE');
        }).toThrow(/Security violation.*delete_element.*mcp_aql_delete.*not mcp_aql_update/);
      });
    });

    describe('Unknown operations', () => {
      it('should throw error for unknown operation', () => {
        expect(() => {
          PermissionGuard.validate('nonexistent_operation', 'READ');
        }).toThrow(/Unknown operation: "nonexistent_operation".*tool descriptions/);
      });

      it('should throw error for empty operation name', () => {
        expect(() => {
          PermissionGuard.validate('', 'READ');
        }).toThrow(/Unknown operation: "".*tool descriptions/);
      });

      it('should throw error for whitespace-only operation name', () => {
        expect(() => {
          PermissionGuard.validate('   ', 'READ');
        }).toThrow(/Unknown operation: " {3}".*tool descriptions/);
      });
    });

    describe('Error message content', () => {
      it('should include permission reason in error for CREATE violation', () => {
        expect(() => {
          PermissionGuard.validate('create_element', 'READ');
        }).toThrow(/additive, non-destructive nature/);
      });

      it('should include permission reason in error for READ violation', () => {
        expect(() => {
          PermissionGuard.validate('get_element', 'CREATE');
        }).toThrow(/read-only, safe nature/);
      });

      it('should include permission reason in error for UPDATE violation', () => {
        expect(() => {
          PermissionGuard.validate('edit_element', 'READ');
        }).toThrow(/data modification capabilities/);
      });

      it('should include permission reason in error for DELETE violation', () => {
        expect(() => {
          PermissionGuard.validate('delete_element', 'READ');
        }).toThrow(/destructive potential/);
      });
    });
  });

  describe('getPermissions()', () => {
    it('should return correct permissions for CREATE endpoint', () => {
      const permissions = PermissionGuard.getPermissions('CREATE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: false,
      });
    });

    it('should return correct permissions for READ endpoint', () => {
      const permissions = PermissionGuard.getPermissions('READ');
      expect(permissions).toEqual({
        readOnly: true,
        destructive: false,
      });
    });

    it('should return correct permissions for UPDATE endpoint', () => {
      const permissions = PermissionGuard.getPermissions('UPDATE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });

    it('should return correct permissions for DELETE endpoint', () => {
      const permissions = PermissionGuard.getPermissions('DELETE');
      expect(permissions).toEqual({
        readOnly: false,
        destructive: true,
      });
    });

    it('should return the same object reference for repeated calls', () => {
      const perm1 = PermissionGuard.getPermissions('READ');
      const perm2 = PermissionGuard.getPermissions('READ');
      expect(perm1).toBe(perm2);
    });
  });

  describe('Integration tests', () => {
    it('should validate all CRUD endpoints have permissions defined', () => {
      const endpoints: CRUDEndpoint[] = ['CREATE', 'READ', 'UPDATE', 'DELETE'];
      endpoints.forEach(endpoint => {
        const permissions = PermissionGuard.getPermissions(endpoint);
        expect(permissions).toBeDefined();
        expect(typeof permissions.readOnly).toBe('boolean');
        expect(typeof permissions.destructive).toBe('boolean');
      });
    });

    it('should ensure only READ endpoint is marked as readOnly', () => {
      expect(PermissionGuard.getPermissions('CREATE').readOnly).toBe(false);
      expect(PermissionGuard.getPermissions('READ').readOnly).toBe(true);
      expect(PermissionGuard.getPermissions('UPDATE').readOnly).toBe(false);
      expect(PermissionGuard.getPermissions('DELETE').readOnly).toBe(false);
    });

    it('should ensure UPDATE and DELETE endpoints are marked as destructive', () => {
      expect(PermissionGuard.getPermissions('CREATE').destructive).toBe(false);
      expect(PermissionGuard.getPermissions('READ').destructive).toBe(false);
      expect(PermissionGuard.getPermissions('UPDATE').destructive).toBe(true);
      expect(PermissionGuard.getPermissions('DELETE').destructive).toBe(true);
    });
  });
});

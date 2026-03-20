/**
 * Permission Guard
 *
 * Layer 3 (actual security enforcement) in the defense-in-depth model:
 * - Layer 1: MCP tool annotations (UX hints to clients)
 * - Layer 2: CRUD endpoint naming (signals intent)
 * - Layer 3: This guard (actual enforcement)
 *
 * Validates that operations are called via the correct CRUD endpoint
 * based on their permission requirements.
 */

import { CRUDEndpoint, getRoute } from './OperationRouter.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

export interface EndpointPermissions {
  readOnly: boolean;
  destructive: boolean;
}

export class PermissionGuard {
  /**
   * Permission flags for each CRUDE endpoint.
   * These define the security characteristics of each endpoint.
   */
  private static readonly ENDPOINT_PERMISSIONS: Record<CRUDEndpoint, EndpointPermissions> = {
    CREATE:  { readOnly: false, destructive: false },
    READ:    { readOnly: true,  destructive: false },
    UPDATE:  { readOnly: false, destructive: true },
    DELETE:  { readOnly: false, destructive: true },
    EXECUTE: { readOnly: false, destructive: true },  // Potentially destructive - agents can perform any action
  };

  /**
   * Validates that an operation is being called via the correct endpoint.
   * Throws an error if the operation doesn't exist or is called via wrong endpoint.
   *
   * @param operation - The operation being called (e.g., 'create_element')
   * @param calledEndpoint - The endpoint it was called through (e.g., 'CREATE')
   * @throws Error if operation unknown or endpoint mismatch
   *
   * @example
   * ```typescript
   * // Valid call - operation matches endpoint
   * PermissionGuard.validate('create_element', 'CREATE'); // OK
   *
   * // Invalid call - operation called via wrong endpoint
   * PermissionGuard.validate('create_element', 'READ'); // Throws: Security violation
   *
   * // Unknown operation
   * PermissionGuard.validate('unknown_op', 'READ'); // Throws: Unknown operation
   * ```
   */
  static validate(operation: string, calledEndpoint: CRUDEndpoint): void {
    const route = getRoute(operation);

    if (!route) {
      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'PermissionGuard.validate',
        details: `Unknown operation: "${operation}"`,
        additionalData: { operation, calledEndpoint }
      });
      throw new Error(`Unknown operation: "${operation}". See tool descriptions for available operations on each endpoint.`);
    }

    if (route.endpoint !== calledEndpoint) {
      // Log security violation attempt
      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'HIGH',
        source: 'PermissionGuard.validate',
        details: `Security violation: Operation "${operation}" called via wrong endpoint`,
        additionalData: {
          operation,
          expectedEndpoint: route.endpoint,
          actualEndpoint: calledEndpoint,
          permissionReason: this.getPermissionReason(route.endpoint)
        }
      });
      throw new Error(
        `Security violation: Operation "${operation}" must be called via mcp_aql_${route.endpoint.toLowerCase()} endpoint, ` +
        `not mcp_aql_${calledEndpoint.toLowerCase()}. ` +
        `This operation is classified as ${route.endpoint} due to its ${this.getPermissionReason(route.endpoint)}.`
      );
    }
  }

  /**
   * Gets the permission flags for an endpoint.
   *
   * @param endpoint - The CRUD endpoint to get permissions for
   * @returns The permission flags for the endpoint
   *
   * @example
   * ```typescript
   * const perms = PermissionGuard.getPermissions('READ');
   * // { readOnly: true, destructive: false }
   *
   * const deletePerms = PermissionGuard.getPermissions('DELETE');
   * // { readOnly: false, destructive: true }
   * ```
   */
  static getPermissions(endpoint: CRUDEndpoint): EndpointPermissions {
    return this.ENDPOINT_PERMISSIONS[endpoint];
  }

  /**
   * Returns a human-readable reason for the permission classification.
   * Uses exhaustive switch to ensure all endpoints are handled at compile time.
   *
   * @param endpoint - The CRUD endpoint to get the reason for
   * @returns A description of why the endpoint has its permission classification
   */
  private static getPermissionReason(endpoint: CRUDEndpoint): string {
    switch (endpoint) {
      case 'CREATE': return 'additive, non-destructive nature';
      case 'READ': return 'read-only, safe nature';
      case 'UPDATE': return 'data modification capabilities';
      case 'DELETE': return 'destructive potential';
      case 'EXECUTE': return 'runtime execution lifecycle (stateful, non-idempotent)';
      default: {
        // Exhaustive check - TypeScript will error if a case is missing
        const _exhaustive: never = endpoint;
        return _exhaustive;
      }
    }
  }
}

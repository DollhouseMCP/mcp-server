/**
 * UnifiedEndpoint - Single unified MCP-AQL endpoint handler (Issue #196)
 *
 * This handler provides a single `mcp_aql` endpoint as an alternative to the
 * 4 CRUD endpoints for users who want minimal token footprint (~300-400 tokens
 * vs ~943 tokens for 4 endpoints).
 *
 * ARCHITECTURE:
 * - Single entry point for all MCP-AQL operations
 * - Routes internally to appropriate MCPAQLHandler methods
 * - Uses Gatekeeper (PermissionGuard) for all permission checks
 * - Maintains full security with minimal client-side footprint
 *
 * USE CASES:
 * - Multi-server deployments where token budget is constrained
 * - Clients that prefer simpler tool interfaces
 * - Integration scenarios where 4 endpoints create complexity
 *
 * SECURITY:
 * - All operations pass through PermissionGuard.validate()
 * - Operation routing is determined server-side, not client-side
 * - Full audit logging for all operations
 */

import { MCPAQLHandler } from './MCPAQLHandler.js';
import { getRoute, CRUDEndpoint } from './OperationRouter.js';
import { OperationResult, BatchResult, ResponseMeta, isOperationInput, parseOperationInput, describeInvalidInput } from './types.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

/**
 * UnifiedEndpoint - Single entry point for all MCP-AQL operations
 *
 * This class wraps MCPAQLHandler to provide a unified endpoint that
 * automatically routes operations to the correct CRUD handler based
 * on the operation name.
 *
 * SECURITY NOTE:
 * Unlike the 4-endpoint mode where the client chooses which endpoint to call,
 * in single-endpoint mode the server determines the appropriate handler
 * based on the operation name. This means:
 * 1. The client cannot bypass security by calling the wrong endpoint
 * 2. All routing is enforced server-side via PermissionGuard
 * 3. The operation-to-endpoint mapping is authoritative
 */
export class UnifiedEndpoint {
  constructor(private readonly mcpAqlHandler: MCPAQLHandler) {}

  /**
   * Handle any MCP-AQL operation through the unified endpoint.
   *
   * This method:
   * 1. Validates input structure
   * 2. Determines the correct CRUD endpoint for the operation
   * 3. Routes to the appropriate handler method
   * 4. Returns standardized OperationResult or BatchResult
   *
   * @param input - Operation input with operation name and params, or BatchRequest
   * @returns OperationResult or BatchResult with success/failure status
   */
  async handle(input: unknown): Promise<OperationResult | BatchResult> {
    // Issue #301: Capture start time for response timing metadata
    const startTime = performance.now();

    // Extract operation name for logging (safe access before validation)
    const operationName = isOperationInput(input) ? input.operation : 'unknown';

    try {
      // Step 1: Validate and normalize input structure (supports silent JSON fallback)
      const parsedInput = parseOperationInput(input);
      if (!parsedInput) {
        return this.failure(
          'Invalid input: expected OperationInput with operation name and optional params. ' +
          describeInvalidInput(input),
          startTime
        );
      }

      const { operation } = parsedInput;

      // Step 2: Determine the correct CRUD endpoint for this operation
      const route = getRoute(operation);
      if (!route) {
        SecurityMonitor.logSecurityEvent({
          type: 'UPDATE_SECURITY_VIOLATION',
          severity: 'MEDIUM',
          source: 'UnifiedEndpoint.handle',
          details: `Unknown operation: "${operation}"`,
          additionalData: { operation }
        });
        return this.failure(
          `Unknown operation: "${operation}". See tool description for available operations.`,
          startTime
        );
      }

      // Step 3: Route to the appropriate handler method
      // The handler will perform its own PermissionGuard validation
      // Pass parsedInput to ensure normalized format is used
      const result = await this.routeToHandler(route.endpoint, parsedInput);

      // Log successful routing
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'UnifiedEndpoint.handle',
        details: `Operation '${operation}' routed to ${route.endpoint} handler`,
        additionalData: { operation, endpoint: route.endpoint }
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      SecurityMonitor.logSecurityEvent({
        type: 'UPDATE_SECURITY_VIOLATION',
        severity: 'MEDIUM',
        source: 'UnifiedEndpoint.handle',
        details: `Operation '${operationName}' failed: ${message}`,
        additionalData: { operation: operationName, error: message }
      });

      logger.error('UnifiedEndpoint operation failed', {
        operation: operationName,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return this.failure(message, startTime);
    }
  }

  /**
   * Route input to the appropriate CRUD handler based on endpoint type.
   *
   * @param endpoint - The CRUD endpoint determined from operation routing
   * @param input - The validated operation input
   * @returns OperationResult or BatchResult from the handler
   */
  private async routeToHandler(
    endpoint: CRUDEndpoint,
    input: unknown
  ): Promise<OperationResult | BatchResult> {
    switch (endpoint) {
      case 'CREATE':
        return this.mcpAqlHandler.handleCreate(input);
      case 'READ':
        return this.mcpAqlHandler.handleRead(input);
      case 'UPDATE':
        return this.mcpAqlHandler.handleUpdate(input);
      case 'DELETE':
        return this.mcpAqlHandler.handleDelete(input);
      case 'EXECUTE':
        return this.mcpAqlHandler.handleExecute(input);
      default: {
        // Exhaustive check - TypeScript will error if a case is missing
        const _exhaustive: never = endpoint;
        return _exhaustive;
      }
    }
  }

  /**
   * Build response metadata with correlation ID and timing.
   * Issue #301: Request correlation support.
   */
  private buildMeta(startTime: number): ResponseMeta {
    return {
      requestId: this.mcpAqlHandler.getCorrelationId() ?? 'unknown',
      durationMs: parseFloat((performance.now() - startTime).toFixed(2)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create a failed operation result
   */
  private failure(error: string, startTime: number): OperationResult {
    return {
      success: false,
      error,
      _meta: this.buildMeta(startTime),
    };
  }
}

/**
 * Get all available operations with their endpoint mappings.
 * This is useful for documentation and help text.
 *
 * @returns Map of operation names to their CRUDE endpoints
 */
export function getOperationHelp(): string {
  return `
## MCP-AQL Unified Endpoint Operations (CRUDE)

### CREATE Operations (additive, non-destructive)
- create_element: Create a new element
- import_element: Import an element from exported data
- addEntry: Add an entry to a memory element
- activate_element: Activate an element for use in session

### READ Operations (safe, read-only)
- list_elements: List elements with filtering and pagination
- get_element: Retrieve a single element by name
- get_element_details: Get detailed information about an element
- search_elements: Full-text search across elements
- query_elements: Query elements with advanced filters
- get_active_elements: Get currently active elements
- validate_element: Validate an element's structure
- render: Render a template with variables
- export_element: Export an element to portable format
- deactivate_element: Deactivate an active element

### UPDATE Operations (modifying)
- edit_element: Modify an existing element's fields

### DELETE Operations (destructive)
- delete_element: Permanently delete an element
- clear: Clear entries from a memory element

### EXECUTE Operations (runtime lifecycle, potentially destructive)
- execute_agent: Start execution of an agent
- get_execution_state: Query current execution state
- record_execution_step: Record execution progress
- complete_execution: Signal successful completion
- continue_execution: Resume from saved state
- abort_execution: Abort a running execution
`.trim();
}

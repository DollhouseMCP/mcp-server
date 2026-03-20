/**
 * ElementActivationStrategy - Interface for element activation/deactivation strategies
 *
 * Defines the contract for all element type-specific activation strategies.
 * Each element type (personas, skills, templates, agents, memories, ensembles)
 * implements this interface to provide custom activation logic.
 */

/**
 * Standard MCP response format
 */
export interface MCPResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * Strategy interface for element activation operations
 */
export interface ElementActivationStrategy {
  /**
   * Activate an element by name
   * @param name - The name of the element to activate
   * @param context - Optional activation context (parameters, variables, etc.)
   * @returns MCP-formatted response with activation result
   */
  activate(name: string, context?: Record<string, any>): Promise<MCPResponse>;

  /**
   * Deactivate an element by name
   * @param name - The name of the element to deactivate
   * @returns MCP-formatted response with deactivation result
   */
  deactivate(name: string): Promise<MCPResponse>;

  /**
   * Get all currently active elements of this type
   * @returns MCP-formatted response with list of active elements
   */
  getActiveElements(): Promise<MCPResponse>;

  /**
   * Get detailed information about a specific element
   * @param name - The name of the element to get details for
   * @returns MCP-formatted response with element details
   */
  getElementDetails(name: string): Promise<MCPResponse>;
}

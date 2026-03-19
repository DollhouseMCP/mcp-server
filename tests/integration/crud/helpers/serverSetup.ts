/**
 * Test server setup and lifecycle management
 *
 * This module provides utilities for setting up and managing DollhouseMCPServer
 * instances for integration testing. It handles:
 * - Server initialization with isolated test environment
 * - MCP tool invocation
 * - Cleanup and disposal
 *
 * Key Design Principles:
 * - Isolation: Each test gets fresh server instance
 * - Cleanup: Automatic resource cleanup
 * - Simplicity: Easy to use in test suites
 */

import { DollhouseMCPServer } from '../../../../src/index.js';
import { createIntegrationContainer, IntegrationContainer } from '../../../helpers/integration-container.js';
import { ElementType } from '../../../../src/portfolio/types.js';

/**
 * Test server context
 *
 * Contains server instance and integration container.
 * Use dispose() to clean up resources.
 */
export interface TestServerContext {
  /**
   * DollhouseMCPServer instance for testing
   */
  server: DollhouseMCPServer;

  /**
   * Integration container with isolated portfolio
   */
  container: IntegrationContainer;

  /**
   * Clean up server and container resources
   */
  dispose: () => Promise<void>;
}

/**
 * Setup a test server with isolated environment
 *
 * Creates:
 * - Isolated integration container with temporary portfolio
 * - Fresh DollhouseMCPServer instance
 * - Initialized server ready for testing
 *
 * @returns Test server context
 *
 * @example
 * ```typescript
 * const context = await setupTestServer();
 * try {
 *   const result = await callMCPTool(context.server, 'createElement', {...});
 *   // ... assertions
 * } finally {
 *   await context.dispose();
 * }
 * ```
 */
export async function setupTestServer(): Promise<TestServerContext> {
  // Create isolated integration container
  const container = await createIntegrationContainer({
    initializePortfolio: true,
  });

  // FIX: Issue #20 - Pass the container to DollhouseMCPServer to share portfolio directory
  // This ensures that both the test container and the server use the SAME portfolio directory
  // Previously: server created its own DollhouseContainer with a different portfolio directory
  // Now: server uses the test container's DollhouseContainer and portfolio directory
  const server = new DollhouseMCPServer(container.container);

  // Initialize server (triggers internal setup)
  await server.listPersonas();

  return {
    server,
    container,
    dispose: async () => {
      await teardownTestServer(server, container);
    },
  };
}

/**
 * Teardown test server and clean up resources
 *
 * @param server - Server instance to dispose
 * @param container - Integration container to dispose
 */
export async function teardownTestServer(
  server: DollhouseMCPServer,
  container: IntegrationContainer
): Promise<void> {
  // Dispose server
  if (server && typeof server.dispose === 'function') {
    await server.dispose();
  }

  // Dispose container (cleans up temp directories)
  if (container && typeof container.dispose === 'function') {
    await container.dispose();
  }
}

/**
 * Call an MCP tool via the server
 *
 * Generic wrapper for calling any MCP tool method on the server.
 *
 * @param server - Server instance
 * @param toolName - Name of the tool to call
 * @param params - Tool parameters
 * @returns Tool result
 *
 * @example
 * ```typescript
 * const result = await callMCPTool(server, 'createElement', {
 *   name: 'test-element',
 *   type: ElementType.SKILL,
 *   description: 'Test skill',
 *   metadata: { ... }
 * });
 * ```
 */
export async function callMCPTool(
  server: DollhouseMCPServer,
  toolName: string,
  params: any
): Promise<any> {
  // Map tool names to server methods
  const methodMap: Record<string, string> = {
    createElement: 'createElement',
    editElement: 'editElement',
    deleteElement: 'deleteElement',
    validateElement: 'validateElement',
    listElements: 'listElements',
    getElementDetails: 'getElementDetails',
    activateElement: 'activateElement',
    deactivateElement: 'deactivateElement',
    getActiveElements: 'getActiveElements',
  };

  const methodName = methodMap[toolName] || toolName;

  // Check method exists
  if (typeof (server as any)[methodName] !== 'function') {
    throw new Error(`Unknown MCP tool: ${toolName} (method: ${methodName})`);
  }

  // Call method with params
  return await (server as any)[methodName](params);
}

/**
 * Create an element via MCP tool
 *
 * Convenience wrapper for createElement tool.
 *
 * @param server - Server instance
 * @param elementData - Element data to create
 * @returns Tool result
 */
export async function createElementViaTool(
  server: DollhouseMCPServer,
  elementData: {
    name: string;
    type: ElementType;
    description: string;
    content?: string;
    instructions?: string;
    metadata?: Record<string, any>;
  }
): Promise<any> {
  return await server.createElement(elementData);
}

/**
 * Convert a dot-notation path and value to a nested input object.
 *
 * @param path - Dot-notation path (e.g., 'metadata.priority')
 * @param value - Value to set
 * @returns Nested object structure
 *
 * @example
 * ```typescript
 * pathToInput('description', 'New desc')
 * // => { description: 'New desc' }
 *
 * pathToInput('metadata.priority', 5)
 * // => { metadata: { priority: 5 } }
 * ```
 */
export function pathToInput(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const result: Record<string, unknown> = {};

  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = {};
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;

  return result;
}

/**
 * Edit an element via MCP tool using GraphQL-aligned nested input.
 *
 * Convenience wrapper for editElement tool. Accepts either:
 * - A nested input object directly
 * - A path string and value (for backward compatibility with tests)
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @param inputOrPath - Either a nested input object, or a dot-notation path string
 * @param value - Value to set (only when inputOrPath is a string path)
 * @returns Tool result
 *
 * @example
 * ```typescript
 * // Using input object (preferred)
 * await editElementViaTool(server, 'my-skill', ElementType.SKILL, { description: 'New desc' });
 *
 * // Using path and value (for test compatibility)
 * await editElementViaTool(server, 'my-skill', ElementType.SKILL, 'description', 'New desc');
 * ```
 */
export async function editElementViaTool(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType,
  inputOrPath: Record<string, unknown> | string,
  value?: unknown
): Promise<any> {
  // If inputOrPath is a string, convert path/value to input object
  const input = typeof inputOrPath === 'string'
    ? pathToInput(inputOrPath, value)
    : inputOrPath;

  return await server.editElement({ name, type, input });
}

/**
 * Delete an element via MCP tool
 *
 * Convenience wrapper for deleteElement tool.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @returns Tool result
 */
export async function deleteElementViaTool(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType
): Promise<any> {
  return await server.deleteElement({ name, type });
}

/**
 * Validate an element via MCP tool
 *
 * Convenience wrapper for validateElement tool.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @param strict - Use strict validation
 * @returns Tool result
 */
export async function validateElementViaTool(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType,
  strict: boolean = false
): Promise<any> {
  return await server.validateElement({ name, type, strict });
}

/**
 * List elements via MCP tool
 *
 * Convenience wrapper for listElements tool.
 *
 * @param server - Server instance
 * @param type - Element type
 * @returns Tool result
 */
export async function listElementsViaTool(
  server: DollhouseMCPServer,
  type: ElementType
): Promise<any> {
  // FIX: Server method expects (type) not ({type})
  return await server.listElements(type);
}

/**
 * Get element details via MCP tool
 *
 * Convenience wrapper for getElementDetails tool.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @returns Tool result
 */
export async function getElementDetailsViaTool(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType
): Promise<any> {
  // FIX: Server method expects (name, type) not ({name, type})
  return await server.getElementDetails(name, type);
}

/**
 * Wait for an element to be available after creation
 *
 * Retries getElementDetails with exponential backoff to handle
 * race conditions where file write/index update hasn't propagated.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @param maxRetries - Maximum retry attempts (default: 5)
 * @param initialDelayMs - Initial delay in ms (default: 50)
 * @returns Tool result
 * @throws ElementNotFoundError if element not found after all retries
 */
export async function waitForElement(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType,
  maxRetries: number = 5,
  initialDelayMs: number = 50
): Promise<any> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await server.getElementDetails(name, type);
    } catch (error) {
      lastError = error as Error;
      // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
      const delay = initialDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Wait for an element to be deleted
 *
 * Retries getElementDetails with exponential backoff until it throws
 * ElementNotFoundError, confirming the element is truly deleted.
 * This handles race conditions where index updates haven't propagated.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @param maxRetries - Maximum retry attempts (default: 5)
 * @param initialDelayMs - Initial delay in ms (default: 50)
 * @throws Error if element still exists after all retries
 */
export async function waitForElementDeleted(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType,
  maxRetries: number = 5,
  initialDelayMs: number = 50
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await server.getElementDetails(name, type);
      // Element still exists, wait and retry
      const delay = initialDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch {
      // Element not found - this is what we want
      return;
    }
  }
  throw new Error(`Element ${name} still exists after ${maxRetries} deletion check attempts`);
}

/**
 * Activate an element via MCP tool
 *
 * Convenience wrapper for activateElement tool.
 *
 * @param server - Server instance
 * @param name - Element name
 * @param type - Element type
 * @returns Tool result
 */
export async function activateElementViaTool(
  server: DollhouseMCPServer,
  name: string,
  type: ElementType,
  context?: Record<string, any>
): Promise<any> {
  // FIX: Server method expects (name, type) not ({name, type})
  // Pass context as third parameter
  return await server.activateElement(name, type, context);
}

/**
 * Get active elements via MCP tool
 *
 * Convenience wrapper for getActiveElements tool.
 *
 * @param server - Server instance
 * @param type - Element type
 * @returns Tool result
 */
export async function getActiveElementsViaTool(
  server: DollhouseMCPServer,
  type: ElementType
): Promise<any> {
  // FIX: Server method expects (type) not ({type})
  return await server.getActiveElements(type);
}

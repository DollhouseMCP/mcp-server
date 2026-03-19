/**
 * Activation test utilities
 *
 * This module provides utilities for testing element activation across all types.
 * It handles different activation strategies and provides generic assertion helpers.
 *
 * Key Design Principles:
 * - Strategy-based: Different activation strategies handled generically
 * - Context-aware: Support activation with/without context
 * - Verification: Helpers to verify activation results
 */

import type { DollhouseMCPServer } from '../../../../src/index.js';
import type { ElementTypeTestConfig, ActivationConfig } from '../config/types.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { activateElementViaTool, getActiveElementsViaTool, waitForElement } from './serverSetup.js';
import { assertElementActivated } from './crudTestHelpers.js';

/**
 * Prepare activation context for testing
 *
 * Generates appropriate context data based on activation configuration.
 *
 * @param config - Element type test configuration
 * @param contextIndex - Which test context to use (default: 0)
 * @returns Activation context or undefined
 *
 * @example
 * ```typescript
 * const context = prepareActivationContext(agentConfig);
 * const result = await executeActivation(server, 'my-agent', ElementType.AGENT, context);
 * ```
 */
export function prepareActivationContext(
  config: ElementTypeTestConfig,
  contextIndex: number = 0
): Record<string, any> | undefined {
  const activationConfig = config.capabilities.supportsActivation;
  if (!activationConfig) {
    return undefined;
  }

  // If activation doesn't require context, return undefined
  if (!activationConfig.requiresContext) {
    return undefined;
  }

  // Get test context if available
  if (activationConfig.testContexts && activationConfig.testContexts[contextIndex]) {
    return activationConfig.testContexts[contextIndex].context;
  }

  // Generate default context based on strategy
  return generateDefaultContext(activationConfig);
}

/**
 * Execute element activation
 *
 * Generic activation execution that works for any element type.
 *
 * @param server - Server instance
 * @param elementName - Name of element to activate
 * @param elementType - Type of element
 * @param context - Optional activation context
 * @returns Activation result
 *
 * @example
 * ```typescript
 * const result = await executeActivation(server, 'test-skill', ElementType.SKILL);
 * verifyActivationResult(result, skillConfig);
 * ```
 */
export async function executeActivation(
  server: DollhouseMCPServer,
  elementName: string,
  elementType: ElementType,
  context?: Record<string, any>
): Promise<any> {
  // Pass context to activateElementViaTool
  return await activateElementViaTool(server, elementName, elementType, context);
}

/**
 * Verify activation result
 *
 * Validates that activation completed as expected based on configuration.
 *
 * @param result - Activation result
 * @param config - Element type test configuration
 * @param expectedState - Expected activation state (optional)
 *
 * @example
 * ```typescript
 * const result = await executeActivation(server, 'test-persona', ElementType.PERSONA);
 * verifyActivationResult(result, personaConfig);
 * ```
 */
export function verifyActivationResult(
  result: any,
  config: ElementTypeTestConfig,
  expectedState?: Record<string, any>
): void {
  const activationConfig = config.capabilities.supportsActivation;
  if (!activationConfig) {
    throw new Error(`Element type ${config.displayName} does not support activation`);
  }

  // Use generic activation assertion
  assertElementActivated(result, expectedState);

  // Additional verification based on result type
  verifyResultType(result, activationConfig.expectedResultType);
}

/**
 * Verify element is in active state
 *
 * Checks that element appears in active elements list.
 * Uses retry logic to handle race conditions where activation state
 * may not be immediately visible (especially on macOS with parallel tests).
 *
 * @param server - Server instance
 * @param elementName - Name of element
 * @param elementType - Type of element
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param retryDelay - Delay between retries in ms (default: 100)
 * @returns True if element is active
 *
 * @example
 * ```typescript
 * await executeActivation(server, 'my-skill', ElementType.SKILL);
 * const isActive = await verifyElementActive(server, 'my-skill', ElementType.SKILL);
 * expect(isActive).toBe(true);
 * ```
 */
export async function verifyElementActive(
  server: DollhouseMCPServer,
  elementName: string,
  elementType: ElementType,
  maxRetries: number = 3,
  retryDelay: number = 100
): Promise<boolean> {
  // Retry logic to handle race conditions in parallel test execution
  // This addresses flakiness observed on macOS Node 20.x/22.x (PR #32, #34)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await getActiveElementsViaTool(server, elementType);

    // Parse result to check if element is in active list
    const text = result.content[0].text.toLowerCase();
    if (text.includes(elementName.toLowerCase())) {
      return true;
    }

    // Wait before retrying (skip delay on last attempt)
    if (attempt < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  return false;
}

/**
 * Execute activation with multiple contexts
 *
 * Tests activation with all available test contexts.
 *
 * @param server - Server instance
 * @param elementName - Name of element
 * @param elementType - Type of element
 * @param config - Element type test configuration
 * @returns Array of activation results
 *
 * @example
 * ```typescript
 * const results = await executeActivationWithContexts(
 *   server,
 *   'test-agent',
 *   ElementType.AGENT,
 *   agentConfig
 * );
 * results.forEach(r => verifyActivationResult(r, agentConfig));
 * ```
 */
export async function executeActivationWithContexts(
  server: DollhouseMCPServer,
  elementName: string,
  elementType: ElementType,
  config: ElementTypeTestConfig
): Promise<Array<{ result: any; context?: Record<string, any> }>> {
  const activationConfig = config.capabilities.supportsActivation;
  if (!activationConfig) {
    return [];
  }

  const results: Array<{ result: any; context?: Record<string, any> }> = [];

  // If no test contexts, just execute once
  if (!activationConfig.testContexts || activationConfig.testContexts.length === 0) {
    const result = await executeActivation(server, elementName, elementType);
    results.push({ result });
    return results;
  }

  // Execute with each test context
  for (let i = 0; i < activationConfig.testContexts.length; i++) {
    const context = prepareActivationContext(config, i);
    const result = await executeActivation(server, elementName, elementType, context);
    results.push({ result, context });
  }

  return results;
}

/**
 * Test activation failure scenarios
 *
 * Verifies that activation fails appropriately for invalid scenarios.
 *
 * @param server - Server instance
 * @param elementName - Name of element (may not exist)
 * @param elementType - Type of element
 * @returns Activation result (should indicate failure)
 *
 * @example
 * ```typescript
 * const result = await testActivationFailure(server, 'non-existent', ElementType.SKILL);
 * expect(result.content[0].text).toContain('❌');
 * ```
 */
export async function testActivationFailure(
  server: DollhouseMCPServer,
  elementName: string,
  elementType: ElementType
): Promise<any> {
  try {
    return await activateElementViaTool(server, elementName, elementType);
  } catch (error) {
    // Return error wrapped in MCP-style result
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error: ${(error as Error).message}`,
        },
      ],
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate default context based on activation strategy
 */
function generateDefaultContext(activationConfig: ActivationConfig): Record<string, any> {
  switch (activationConfig.activationStrategy) {
    case 'behavior-change':
      return {
        interactionMode: 'test',
      };

    case 'execution':
      return {
        goal: 'test goal',
        parameters: {},
      };

    case 'rendering':
      return {
        variables: {},
      };

    case 'orchestration':
      return {
        activationOrder: 'sequential',
      };

    case 'context-loading':
      return {
        contextId: 'test-context',
      };

    default:
      return {};
  }
}

/**
 * Verify result matches expected result type
 */
function verifyResultType(
  result: any,
  expectedType: ActivationConfig['expectedResultType']
): void {
  const text = result.content[0].text;

  switch (expectedType) {
    case 'state-change':
      // State change should mention activation or active state
      // FIX: Issue #20 - Accept "ready to use" for templates (they're stateless)
      expect(text.toLowerCase()).toMatch(/activated|active|enabled|ready to use/);
      break;

    case 'output':
      // Output should contain generated content
      expect(text.length).toBeGreaterThan(0);
      break;

    case 'side-effect':
      // Side effect should mention completion or success
      expect(text.toLowerCase()).toMatch(/completed|success|executed/);
      break;

    case 'multi-element':
      // Multi-element should mention multiple activations
      expect(text.toLowerCase()).toMatch(/elements|multiple|activated/);
      break;
  }
}

/**
 * Create test element for activation
 *
 * Helper to create an element specifically for activation testing.
 *
 * @param server - Server instance
 * @param elementName - Name for element
 * @param elementType - Type of element
 * @param config - Element type test configuration
 * @returns Creation result
 */
export async function createActivatableElement(
  server: DollhouseMCPServer,
  elementName: string,
  elementType: ElementType,
  config: ElementTypeTestConfig
): Promise<any> {
  // Use the config's factory to generate element data
  const elementData = config.factory({ name: elementName });

  const result = await server.createElement({
    name: elementData.name,
    type: elementType,
    description: elementData.description,
    content: elementData.content,
    instructions: elementData.instructions,
    metadata: elementData.metadata,
  });

  // Wait for element to be available (handles race condition in full suite runs)
  await waitForElement(server, elementData.name, elementType);

  return result;
}

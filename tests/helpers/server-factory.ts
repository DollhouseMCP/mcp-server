/**
 * Server Factory for Integration Tests
 *
 * Provides factory functions for creating real DollhouseMCPServer instances
 * with properly configured DI containers.
 *
 * This file is intentionally separate from di-mocks.ts to avoid importing
 * src/index.ts (and its module-level side effects like process.on handlers)
 * in tests that don't need the full server.
 *
 * @see docs/technical-debt/DI_CONTAINER_INJECTION_FIX.md
 */

import { DollhouseMCPServer } from '../../src/index.js';
import { createIntegrationContainer, type IntegrationContainer } from './integration-container.js';

/**
 * Result type for createRealDollhouseMCPServer
 */
export interface DollhouseMCPServerContext {
  /** The DollhouseMCPServer instance */
  server: DollhouseMCPServer;
  /** The integration container with DI services */
  container: IntegrationContainer;
  /** The portfolio directory path */
  portfolioDir: string;
  /** Dispose of the server and container, cleaning up resources */
  dispose: () => Promise<void>;
}

/**
 * Options for createRealDollhouseMCPServer
 */
export interface DollhouseMCPServerOptions {
  /** Base directory to use for the portfolio */
  portfolioDir?: string;
  /** Optional override for HOME environment variable */
  homeDir?: string;
  /** Controls whether the PortfolioManager should be initialised automatically (default: true) */
  initializePortfolio?: boolean;
}

/**
 * Create a real DollhouseMCPServer with a properly configured DI container.
 *
 * Use this in integration tests instead of calling `new DollhouseMCPServer()` directly.
 * This ensures proper DI container injection and isolated test environments.
 *
 * @param options - Configuration options for the server
 * @returns Server context with dispose function for cleanup
 *
 * @example
 * ```typescript
 * import { createRealDollhouseMCPServer, type DollhouseMCPServerContext } from '../helpers/server-factory';
 *
 * let ctx: DollhouseMCPServerContext;
 *
 * beforeEach(async () => {
 *   ctx = await createRealDollhouseMCPServer();
 * });
 *
 * afterEach(async () => {
 *   await ctx.dispose();
 * });
 *
 * it('should do something', async () => {
 *   const result = await ctx.server.someMethod();
 *   expect(result).toBeDefined();
 * });
 * ```
 */
export async function createRealDollhouseMCPServer(
  options: DollhouseMCPServerOptions = {}
): Promise<DollhouseMCPServerContext> {
  const container = await createIntegrationContainer({
    portfolioDir: options.portfolioDir,
    homeDir: options.homeDir,
    initializePortfolio: options.initializePortfolio,
  });

  const server = new DollhouseMCPServer(container.container);

  return {
    server,
    container,
    portfolioDir: container.portfolioDir,
    dispose: async () => {
      await server.dispose();
      await container.dispose();
    },
  };
}

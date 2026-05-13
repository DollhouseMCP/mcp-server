/**
 * HTTP session handler graph scoping
 *
 * Step 3 regression coverage: HTTP sessions must receive handler instances
 * from their SessionContainer, not the root bootstrap bundle.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  createHttpTestEnvironment,
  connectHttpClient,
  type HttpTestEnvironment,
  type HttpClientHandle,
} from '../../helpers/httpTransportHelper.js';
import type { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import type { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import type { CollectionHandler } from '../../../src/handlers/CollectionHandler.js';
import type { PortfolioHandler } from '../../../src/handlers/PortfolioHandler.js';
import type { GitHubAuthHandler } from '../../../src/handlers/GitHubAuthHandler.js';
import type { ConfigHandler } from '../../../src/handlers/ConfigHandler.js';
import type { SyncHandler } from '../../../src/handlers/SyncHandlerV2.js';
import type { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { TokenManager } from '../../../src/security/tokenManager.js';
import type { PortfolioRepoManager } from '../../../src/portfolio/PortfolioRepoManager.js';

const ENV_STARTUP_TIMEOUT = 20_000;

describe('HTTP session handler graph scoping', () => {
  let env: HttpTestEnvironment;
  let handleA: HttpClientHandle;
  let handleB: HttpClientHandle;

  beforeAll(async () => {
    env = await createHttpTestEnvironment({
      userIdSequence: ['handler-user-a', 'handler-user-b'],
    });
    handleA = await connectHttpClient(env.runtime);
    handleB = await connectHttpClient(env.runtime);
  }, ENV_STARTUP_TIMEOUT);

  afterAll(async () => {
    await handleA?.disconnect();
    await handleB?.disconnect();
    await env?.cleanup();
  });

  it('registers distinct handler and GitHub coordinator instances per HTTP session', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    expect(childA).toBeDefined();
    expect(childB).toBeDefined();

    expect(childA!.resolve<ElementCRUDHandler>('ElementCRUDHandler'))
      .not.toBe(childB!.resolve<ElementCRUDHandler>('ElementCRUDHandler'));
    expect(childA!.resolve<CollectionHandler>('CollectionHandler'))
      .not.toBe(childB!.resolve<CollectionHandler>('CollectionHandler'));
    expect(childA!.resolve<PortfolioHandler>('PortfolioHandler'))
      .not.toBe(childB!.resolve<PortfolioHandler>('PortfolioHandler'));
    expect(childA!.resolve<GitHubAuthHandler>('GitHubAuthHandler'))
      .not.toBe(childB!.resolve<GitHubAuthHandler>('GitHubAuthHandler'));
    expect(childA!.resolve<ConfigHandler>('ConfigHandler'))
      .not.toBe(childB!.resolve<ConfigHandler>('ConfigHandler'));
    expect(childA!.resolve<SyncHandler>('SyncHandler'))
      .not.toBe(childB!.resolve<SyncHandler>('SyncHandler'));

    expect(childA!.resolve<TokenManager>('TokenManager'))
      .not.toBe(childB!.resolve<TokenManager>('TokenManager'));
    expect(childA!.resolve<PortfolioRepoManager>('PortfolioRepoManager'))
      .not.toBe(childB!.resolve<PortfolioRepoManager>('PortfolioRepoManager'));
  });

  it('wires each session MCPAQLHandler to that session handler bundle', () => {
    const registry = env.container.resolve<SessionContainerRegistry>('SessionContainerRegistry');
    const childA = registry.get(env.sessionContexts[0].sessionId);
    const childB = registry.get(env.sessionContexts[1].sessionId);

    const aqlA = childA!.resolve<MCPAQLHandler>('mcpAqlHandler') as unknown as {
      handlers: { elementCRUD: ElementCRUDHandler; authHandler?: GitHubAuthHandler; portfolioHandler?: PortfolioHandler };
    };
    const aqlB = childB!.resolve<MCPAQLHandler>('mcpAqlHandler') as unknown as {
      handlers: { elementCRUD: ElementCRUDHandler; authHandler?: GitHubAuthHandler; portfolioHandler?: PortfolioHandler };
    };

    expect(aqlA).not.toBe(aqlB);
    expect(aqlA.handlers.elementCRUD).toBe(childA!.resolve<ElementCRUDHandler>('ElementCRUDHandler'));
    expect(aqlA.handlers.authHandler).toBe(childA!.resolve<GitHubAuthHandler>('GitHubAuthHandler'));
    expect(aqlA.handlers.portfolioHandler).toBe(childA!.resolve<PortfolioHandler>('PortfolioHandler'));

    expect(aqlB.handlers.elementCRUD).toBe(childB!.resolve<ElementCRUDHandler>('ElementCRUDHandler'));
    expect(aqlB.handlers.authHandler).toBe(childB!.resolve<GitHubAuthHandler>('GitHubAuthHandler'));
    expect(aqlB.handlers.portfolioHandler).toBe(childB!.resolve<PortfolioHandler>('PortfolioHandler'));
  });
});

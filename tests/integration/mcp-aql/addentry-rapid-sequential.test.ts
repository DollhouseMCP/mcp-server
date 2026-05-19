/**
 * Regression: rapid sequential addEntry calls must all persist.
 *
 * Pins the lost-update fix in `MCPAQLHandler.dispatchMemory`'s addEntry
 * case. Without the fix, every addEntry call within the debounce window
 * (~2s default) reloaded the memory from storage, mutated only that fresh
 * instance, and replaced the pending-save's memory ref — so the debounce
 * timer would flush only the LAST in-memory state, silently dropping all
 * prior addEntry mutations.
 *
 * The test fires N sequential awaited addEntry calls back-to-back (no
 * artificial delay between them, so they land within the debounce window),
 * then force-flushes pending saves via the handler's public flush method
 * and verifies all N entries are present in the memory's rendered content.
 *
 * Without the fix this test should fail: the rendered content would
 * contain only the last entry. With the fix all N entries land.
 *
 * Found live during Phase 4.5 PoC verification on 2026-05-12.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import {
  createPortfolioTestEnvironment,
  preConfirmAllOperations,
  type PortfolioTestEnvironment,
} from '../../helpers/portfolioTestHelper.js';
import type { OperationResult } from '../../../src/handlers/mcp-aql/types.js';

describe('addEntry rapid sequential — lost-update regression', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    process.env.DOLLHOUSE_SESSION_ID = 'addentry-rapid-sequential-test';
    env = await createPortfolioTestEnvironment('addentry-rapid-sequential');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');

    const createResult = (await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      element_type: 'memory',
      params: {
        element_name: 'lost-update-regression',
        description: 'Memory for lost-update regression coverage',
      },
    })) as OperationResult;
    expect(createResult.success).toBe(true);
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
    delete process.env.DOLLHOUSE_SESSION_ID;
  });

  it('persists ALL entries when N rapid awaited addEntry calls fire within the debounce window', async () => {
    const entryContents = [
      'rapid-entry-1: requirements gathered',
      'rapid-entry-2: design notes recorded',
      'rapid-entry-3: implementation started',
      'rapid-entry-4: tests written',
      'rapid-entry-5: ready for review',
    ];

    // Fire all addEntry calls sequentially, awaiting each so the dispatcher
    // path is reproduced exactly as a real MCP client would experience it
    // (each call returns success before the next fires). No sleeps in
    // between, so all five land inside the same debounce window.
    for (const content of entryContents) {
      const result = (await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'lost-update-regression',
          content,
        },
      })) as OperationResult;
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }

    // Force the pending debounced save to flush now, instead of waiting
    // for the timer to expire. Mirrors what flushPendingSaves does on
    // graceful shutdown.
    await mcpAqlHandler.flushPendingSaves();

    // Read the memory back via the same dispatcher path a real client
    // would use, and assert that all N entries appear in the rendered
    // content. The Memory.content getter renders all entries newest-first
    // separated by blank lines, so each content string will appear once.
    const details = (await mcpAqlHandler.handleRead({
      operation: 'get_element_details',
      element_type: 'memory',
      params: {
        element_name: 'lost-update-regression',
      },
    })) as OperationResult;

    expect(details.success).toBe(true);
    const rendered = JSON.stringify(details.data ?? {});
    for (const content of entryContents) {
      expect(rendered).toContain(content);
    }
  });
});

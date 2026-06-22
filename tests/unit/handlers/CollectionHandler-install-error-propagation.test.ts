/**
 * Regression: CollectionHandler.installContent must propagate errors
 * thrown by ElementInstaller rather than swallowing them into a
 * friendly text response. Without this, the MCP-AQL dispatcher saw
 * "success" (no thrown error) while the install had actually failed —
 * operators saw "installed" in their tool response and only discovered
 * the failure by inspecting the DB.
 *
 * The fix: log + sanitize the error (so operators can diagnose), then
 * re-throw so the dispatcher's outer catch converts the failure into
 * the OperationFailure response shape with the message preserved.
 *
 * Caught live during Phase 4.5 PoC verification on 2026-05-12 — when
 * the ELI5 Explainer install path actually worked, the dollhouse-expert
 * install path had thrown but reported success.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { CollectionHandler } from '../../../src/handlers/CollectionHandler.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';

function buildHandler(installContentImpl: () => Promise<unknown>): CollectionHandler {
  // Constructor positional args (see CollectionHandler.ts:35-48):
  //   0 collectionBrowser, 1 collectionSearch, 2 personaDetails,
  //   3 elementInstaller, 4 collectionCache, 5 portfolioManager,
  //   6 apiCache, 7 personaManager, 8 submitToPortfolioTool,
  //   9 unifiedIndexManager, 10 initService, 11 indicatorService,
  //   12 fileOperations.
  const stub = (overrides: object = {}) => overrides as never;
  return new (CollectionHandler as unknown as new (...args: unknown[]) => CollectionHandler)(
    stub(),                                          // 0 collectionBrowser
    stub(),                                          // 1 collectionSearch
    stub({ getElementDetails: jest.fn() }),          // 2 personaDetails
    stub({ installContent: installContentImpl, formatInstallSuccess: jest.fn(() => 'formatted-install-success') }), // 3 elementInstaller
    stub(),                                          // 4 collectionCache
    stub(),                                          // 5 portfolioManager
    stub(),                                          // 6 apiCache
    stub({ reload: jest.fn() }),                     // 7 personaManager
    stub(),                                          // 8 submitToPortfolioTool
    stub(),                                          // 9 unifiedIndexManager
    stub(),                                          // 10 initService
    stub({ getPersonaIndicator: jest.fn(() => '') }), // 11 indicatorService
    stub(),                                          // 12 fileOperations
  );
}

describe('CollectionHandler.installContent — error propagation', () => {
  it('propagates errors thrown by ElementInstaller (was: swallowed into a friendly text response)', async () => {
    const handler = buildHandler(async () => {
      throw new Error('Security validation failed: instructions: Field exceeds maximum length');
    });

    await expect(handler.installContent('library/personas/test.md')).rejects.toThrow(
      /Security validation failed: instructions/,
    );
  });

  it('does NOT throw when ElementInstaller returns success: false (expected non-error response)', async () => {
    // ElementInstaller returns `{success: false, message}` for handled
    // failure modes that aren't exceptional (e.g. "element already
    // exists"). Those should still render as a friendly text response,
    // not propagate as a thrown error.
    const handler = buildHandler(async () => ({
      success: false,
      message: 'AI customization element already exists: foo.md',
    }));

    const result = await handler.installContent('library/personas/foo.md');
    // Returns a text response without throwing
    expect(result).toEqual({
      content: [
        { type: 'text', text: expect.stringContaining('already exists') },
      ],
    });
  });

  it('returns the success-formatted text response when install succeeds', async () => {
    const handler = buildHandler(async () => ({
      success: true,
      metadata: { name: 'Test Persona' },
      filename: 'test.md',
      elementType: ElementType.PERSONA,
    }));

    const result = await handler.installContent('library/personas/test.md');
    // formatInstallSuccess is mocked to return undefined; we just verify
    // the path produced a content-array response without throwing.
    expect(result).toHaveProperty('content');
    expect(Array.isArray((result as { content: unknown[] }).content)).toBe(true);
  });
});

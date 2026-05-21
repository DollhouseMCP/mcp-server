/**
 * Regression: ConfigManager.updateSetting must admin-gate per-host
 * (operator_settings) writes.
 *
 * Without this gate, any authenticated MCP user — admin or not — could
 * mutate per-host operator config: console.port, license.*,
 * elements.enhanced_index.*, elements.default_element_dir. That's a
 * privilege-escalation surface in any multi-tenant deployment. Per-user
 * writes stay open since they're RLS-scoped to the caller's sub.
 *
 * The check reads the caller's `roles` from ContextTracker.getSessionContext().
 * Stdio sessions implicitly carry 'admin' (operator IS machine owner in
 * local single-user mode). HTTP sessions carry roles populated from the
 * JWT `roles` claim — typically empty unless the operator was pre-claimed
 * via `dollhousemcp admin bootstrap`.
 *
 * Found during Phase 4.5 PoC verification on 2026-05-12.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ConfigManager } from '../../../src/config/ConfigManager.js';

const CONSOLE_PORT_PATH = 'console.port';
const SYNC_ENABLED_PATH = 'sync.enabled';
import { InMemoryOperatorConfigStore } from '../../../src/storage/operatorConfig/InMemoryOperatorConfigStore.js';
import { InMemoryUserConfigStore } from '../../../src/storage/userConfig/InMemoryUserConfigStore.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import type { IFileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { SessionContext } from '../../../src/context/SessionContext.js';

function makeSession(overrides: Partial<SessionContext>): SessionContext {
  return Object.freeze({
    // Real UUID — InMemoryUserConfigStore.save validates the userId format
    // and rejects non-UUID strings. The test runs through persistMerged
    // which writes both stores, so the userId has to be a real UUID even
    // when we're only exercising the per-host path's role gate.
    userId: '00000000-0000-0000-0000-000000000123',
    sessionId: 'test-session-id',
    tenantId: null,
    transport: 'http' as const,
    createdAt: Date.now(),
    ...overrides,
  });
}

/**
 * Helper: run `fn` inside a ContextTracker execution context that has
 * `session` attached. Mirrors what the HTTP transport does per-request.
 */
async function runWithSession<T>(
  contextTracker: ContextTracker,
  session: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const execContext = contextTracker.createSessionContext('llm-request', session);
  return contextTracker.runAsync(execContext, fn);
}

function fakeFileOps(): IFileOperationsService {
  // Minimal stub — ConfigManager façade routes through stores, not files,
  // for the paths this test exercises.
  return {} as IFileOperationsService;
}

function fakeOs() {
  return { homedir: () => '/home/testuser' } as unknown as typeof import('os');
}

describe('ConfigManager admin-role gate on per-host writes', () => {
  let operatorStore: InMemoryOperatorConfigStore;
  let userStore: InMemoryUserConfigStore;
  let contextTracker: ContextTracker;
  let manager: ConfigManager;

  beforeEach(async () => {
    operatorStore = new InMemoryOperatorConfigStore();
    userStore = new InMemoryUserConfigStore();
    contextTracker = new ContextTracker();
    manager = new ConfigManager(
      fakeFileOps(),
      fakeOs(),
      operatorStore,
      userStore,
      contextTracker,
    );
    await manager.initialize();
  });

  describe('isPerHostPath classifier', () => {
    it.each([
      'version',
      CONSOLE_PORT_PATH,
      'console',
      'license.tier',
      'license',
      'elements.enhanced_index.limits.maxKeywordsToCheck',
      'elements.enhanced_index',
      'elements.default_element_dir',
    ])('classifies %s as per-host', (path) => {
      expect(ConfigManager.isPerHostPath(path)).toBe(true);
    });

    it.each([
      'user.username',
      'github.auth.use_oauth',
      SYNC_ENABLED_PATH,
      'autoLoad.token_budget',
      'retentionPolicy.defaults.ttl_days',
      'wizard.completed',
      'display.show_persona_indicator',
      'collection.auto_submit',
      'elements.auto_activate.personas',
      'source_priority.preferred_source',
    ])('classifies %s as per-user (not per-host)', (path) => {
      expect(ConfigManager.isPerHostPath(path)).toBe(false);
    });
  });

  describe('non-admin caller', () => {
    it('rejects per-host write with a clear message naming the path', async () => {
      const session = makeSession({ roles: [] });
      const result = await runWithSession(contextTracker, session, () =>
        manager.updateSetting(CONSOLE_PORT_PATH, 41716),
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain(CONSOLE_PORT_PATH);
      expect(result.message).toContain("'admin' role");
      // operator_settings was NOT mutated
      const operator = await operatorStore.load();
      expect((operator.consoleConfig as { port?: number }).port).not.toBe(41716);
    });

    it('rejects writes to every per-host path category', async () => {
      const session = makeSession({ roles: ['regular-user'] }); // not admin
      const perHostPaths = [
        'license.tier',
        'elements.enhanced_index.limits.maxKeywordsToCheck',
        'elements.default_element_dir',
      ];
      for (const path of perHostPaths) {
        const result = await runWithSession(contextTracker, session, () =>
          manager.updateSetting(path, 'whatever'),
        );
        expect(result.success).toBe(false);
        expect(result.message).toContain(path);
      }
    });

    it('still allows per-user writes (RLS-scoped, no admin needed)', async () => {
      const session = makeSession({ roles: [] });
      const result = await runWithSession(contextTracker, session, () =>
        manager.updateSetting(SYNC_ENABLED_PATH, true),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('admin caller', () => {
    it('allows per-host writes', async () => {
      const session = makeSession({ roles: ['admin'] });
      const result = await runWithSession(contextTracker, session, () =>
        manager.updateSetting(CONSOLE_PORT_PATH, 41717),
      );
      expect(result.success).toBe(true);
      const operator = await operatorStore.load();
      expect((operator.consoleConfig as { port?: number }).port).toBe(41717);
    });

    it('allows per-host writes alongside per-user writes (no surprise blocking)', async () => {
      const session = makeSession({ roles: ['admin'] });
      await runWithSession(contextTracker, session, async () => {
        const a = await manager.updateSetting('license.tier', 'paid-commercial');
        const b = await manager.updateSetting(SYNC_ENABLED_PATH, true);
        expect(a.success).toBe(true);
        expect(b.success).toBe(true);
      });
    });
  });

  describe('deleteSetting leaf safety', () => {
    it('rejects deleting an entire config section', async () => {
      const session = makeSession({ roles: ['admin'] });
      const result = await runWithSession(contextTracker, session, () =>
        manager.deleteSetting('sync'),
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('section');
      expect(manager.getSetting(SYNC_ENABLED_PATH)).toBe(false);
    });

    it('allows deleting a specific leaf setting', async () => {
      const session = makeSession({ roles: [] });
      await runWithSession(contextTracker, session, () =>
        manager.updateSetting(SYNC_ENABLED_PATH, true),
      );
      const result = await runWithSession(contextTracker, session, () =>
        manager.deleteSetting(SYNC_ENABLED_PATH),
      );
      expect(result.success).toBe(true);
      expect(result.previousValue).toBe(true);
      expect(manager.getSetting(SYNC_ENABLED_PATH)).toBe(false);
    });
  });

  describe('no-context fallback', () => {
    it('rejects per-host writes when ContextTracker is injected but no session is active', async () => {
      // Calling updateSetting OUTSIDE any contextTracker.runAsync scope —
      // common pattern for buggy callers or background tasks. The gate
      // defaults to "no roles" so privilege escalation via forgetting to
      // scope is not possible.
      const result = await manager.updateSetting(CONSOLE_PORT_PATH, 41718);
      expect(result.success).toBe(false);
      expect(result.message).toContain("'admin' role");
    });

    it('does NOT enforce the gate when ContextTracker is null (standalone / pre-DI mode)', async () => {
      // ConfigManager.createStandalone() and CapabilityIndexResourcesConfig-style
      // tests construct ConfigManager with contextTracker=null. In those modes,
      // the caller is trusted by being in-process — no session identity exists
      // to enforce a role against. This matches the policy implemented by
      // resolveUserId, which falls back to a sentinel userId in the same case.
      const standaloneStores = {
        operatorStore: new InMemoryOperatorConfigStore(),
        userStore: new InMemoryUserConfigStore(),
      };
      const standaloneManager = new ConfigManager(
        fakeFileOps(),
        fakeOs(),
        standaloneStores.operatorStore,
        standaloneStores.userStore,
        null, // no ContextTracker
      );
      await standaloneManager.initialize();
      const result = await standaloneManager.updateSetting(CONSOLE_PORT_PATH, 41719);
      expect(result.success).toBe(true);
    });
  });
});

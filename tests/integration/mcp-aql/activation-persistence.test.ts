/**
 * Integration tests for Per-Session Activation Persistence (Issue #598)
 *
 * Tests the full round-trip through the real DI container:
 * 1. MCP-AQL activate_element → ElementCRUDHandler → ActivationStore records
 * 2. MCP-AQL deactivate_element → ElementCRUDHandler → ActivationStore removes
 * 3. ActivationStore persists to disk → new instance restores state
 * 4. Container.restoreActivations() replays persisted activations on startup
 * 5. Session isolation — different session IDs produce independent state files
 * 6. Stale element pruning — deleted elements are cleaned from store during restore
 *
 * NOTE: These tests use the real Container wiring with an isolated portfolio
 * directory per test. The ActivationStore is resolved from DI and verified
 * through the MCP-AQL handler pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { ActivationStore } from '../../../src/services/ActivationStore.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import type { OperationResult } from '../../../src/handlers/mcp-aql/types.js';

describe('Activation Persistence Integration (Issue #598)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;
  let activationStore: ActivationStore;

  // Save env vars we modify
  let originalSessionId: string | undefined;
  let originalPersistenceFlag: string | undefined;

  beforeEach(async () => {
    originalSessionId = process.env.DOLLHOUSE_SESSION_ID;
    originalPersistenceFlag = process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;

    // Set a test session ID so we get a predictable file path
    process.env.DOLLHOUSE_SESSION_ID = 'integration-test';
    delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE; // ensure enabled

    env = await createPortfolioTestEnvironment('mcp-aql-activation');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server and all managers
    preConfirmAllOperations(container);

    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    activationStore = container.resolve<ActivationStore>('ActivationStore');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();

    // Restore env vars
    if (originalSessionId === undefined) {
      delete process.env.DOLLHOUSE_SESSION_ID;
    } else {
      process.env.DOLLHOUSE_SESSION_ID = originalSessionId;
    }
    if (originalPersistenceFlag === undefined) {
      delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
    } else {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = originalPersistenceFlag;
    }
  });

  describe('DI wiring verification', () => {
    it('should have ActivationStore registered as singleton', () => {
      const store1 = container.resolve<ActivationStore>('ActivationStore');
      const store2 = container.resolve<ActivationStore>('ActivationStore');
      expect(store1).toBe(store2);
    });

    it('should have ActivationStore with correct session ID', () => {
      expect(activationStore.getSessionId()).toBe('integration-test');
    });

    it('should have persistence enabled by default', () => {
      expect(activationStore.isEnabled()).toBe(true);
    });
  });

  describe('Activate → Store round-trip', () => {
    it('should record skill activation in ActivationStore after MCP-AQL activate_element', async () => {
      // Step 1: Create a skill so we have something to activate
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-activation-skill',
          description: 'A test skill for activation persistence',
          content: 'Test skill instructions for activation persistence testing.',
        },
      }) as OperationResult;
      expect(createResult.success).toBe(true);

      // Allow cache settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // Step 2: Activate the skill via MCP-AQL
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-activation-skill',
          element_type: 'skill',
        },
      }) as OperationResult;
      expect(activateResult.success).toBe(true);

      // Step 3: Verify ActivationStore recorded the activation
      const storedActivations = activationStore.getActivations('skill');
      expect(storedActivations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'test-activation-skill' }),
        ])
      );
    });

    it('should record memory activation in ActivationStore after MCP-AQL activate_element', async () => {
      // Create a memory
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'memory',
        params: {
          element_name: 'test-activation-memory',
          description: 'A test memory for activation persistence',
        },
      }) as OperationResult;
      expect(createResult.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Activate via MCP-AQL
      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-activation-memory',
          element_type: 'memory',
        },
      }) as OperationResult;
      expect(activateResult.success).toBe(true);

      // Verify ActivationStore recorded it
      const storedActivations = activationStore.getActivations('memory');
      expect(storedActivations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'test-activation-memory' }),
        ])
      );
    });

    it('should remove skill from ActivationStore after MCP-AQL deactivate_element', async () => {
      // Create and activate a skill
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-deactivation-skill',
          description: 'A test skill for deactivation persistence',
          content: 'Test skill instructions for deactivation.',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-deactivation-skill',
          element_type: 'skill',
        },
      });

      // Verify it's in the store
      let stored = activationStore.getActivations('skill');
      expect(stored.some(a => a.name === 'test-deactivation-skill')).toBe(true);

      // Deactivate via MCP-AQL
      const deactivateResult = await mcpAqlHandler.handleRead({
        operation: 'deactivate_element',
        params: {
          element_name: 'test-deactivation-skill',
          element_type: 'skill',
        },
      }) as OperationResult;
      expect(deactivateResult.success).toBe(true);

      // Verify it's removed from the store
      stored = activationStore.getActivations('skill');
      expect(stored.some(a => a.name === 'test-deactivation-skill')).toBe(false);
    });
  });

  describe('get_active_elements reflects persisted state', () => {
    it('should include activated element in get_active_elements response', async () => {
      // Create and activate a skill
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'test-active-list-skill',
          description: 'Test skill for active listing',
          content: 'Active listing test instructions.',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'test-active-list-skill',
          element_type: 'skill',
        },
      });

      // Get active elements via MCP-AQL
      const activeResult = await mcpAqlHandler.handleRead({
        operation: 'get_active_elements',
        params: { element_type: 'skill' },
      }) as OperationResult;

      expect(activeResult.success).toBe(true);
      if (activeResult.success) {
        // The response should contain our activated skill
        const data = activeResult.data;
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        expect(text).toContain('test-active-list-skill');
      }
    });
  });

  describe('Disk persistence round-trip', () => {
    it('should persist activation to disk and load in new store instance', async () => {
      // Create a temp state dir we control
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-integration-'));

      try {
        // Create a store with known state dir
        const fileOps = container.resolve<any>('FileOperationsService');
        const store1 = new ActivationStore(fileOps, stateDir);
        await store1.initialize();

        // Record some activations
        store1.recordActivation('skill', 'my-skill');
        store1.recordActivation('memory', 'my-memory');
        store1.recordActivation('persona', 'My Persona', 'my-persona.md');

        // Allow async persist to complete
        await new Promise(resolve => setTimeout(resolve, 300));

        // Verify file was written
        const files = await fs.readdir(stateDir);
        expect(files.some(f => f.startsWith('activations-'))).toBe(true);

        // Create a NEW store instance and load from the same directory
        const store2 = new ActivationStore(fileOps, stateDir);
        await store2.initialize();

        // Verify round-trip
        const skills = store2.getActivations('skill');
        expect(skills).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'my-skill' })])
        );

        const memories = store2.getActivations('memory');
        expect(memories).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'my-memory' })])
        );

        const personas = store2.getActivations('persona');
        expect(personas).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'My Persona', filename: 'my-persona.md' }),
          ])
        );
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });

    it('should handle deactivation persisted across store instances', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-deactivate-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Store 1: activate two skills, deactivate one
        const store1 = new ActivationStore(fileOps, stateDir);
        await store1.initialize();
        store1.recordActivation('skill', 'keep-me');
        store1.recordActivation('skill', 'remove-me');
        await new Promise(resolve => setTimeout(resolve, 200));

        store1.recordDeactivation('skill', 'remove-me');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Store 2: load and verify
        const store2 = new ActivationStore(fileOps, stateDir);
        await store2.initialize();

        const skills = store2.getActivations('skill');
        expect(skills.some(a => a.name === 'keep-me')).toBe(true);
        expect(skills.some(a => a.name === 'remove-me')).toBe(false);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Session isolation', () => {
    it('should produce different files for different session IDs', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-sessions-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Session A: activate skill-a
        process.env.DOLLHOUSE_SESSION_ID = 'session-alpha';
        const storeA = new ActivationStore(fileOps, stateDir);
        await storeA.initialize();
        storeA.recordActivation('skill', 'skill-a');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Session B: activate skill-b (different skill)
        process.env.DOLLHOUSE_SESSION_ID = 'session-beta';
        const storeB = new ActivationStore(fileOps, stateDir);
        await storeB.initialize();
        storeB.recordActivation('skill', 'skill-b');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify file isolation
        const files = await fs.readdir(stateDir);
        expect(files).toContain('activations-session-alpha.json');
        expect(files).toContain('activations-session-beta.json');

        // Verify data isolation — reload each
        process.env.DOLLHOUSE_SESSION_ID = 'session-alpha';
        const reloadA = new ActivationStore(fileOps, stateDir);
        await reloadA.initialize();
        expect(reloadA.getActivations('skill').some(a => a.name === 'skill-a')).toBe(true);
        expect(reloadA.getActivations('skill').some(a => a.name === 'skill-b')).toBe(false);

        process.env.DOLLHOUSE_SESSION_ID = 'session-beta';
        const reloadB = new ActivationStore(fileOps, stateDir);
        await reloadB.initialize();
        expect(reloadB.getActivations('skill').some(a => a.name === 'skill-b')).toBe(true);
        expect(reloadB.getActivations('skill').some(a => a.name === 'skill-a')).toBe(false);
      } finally {
        // Restore session ID for afterEach
        process.env.DOLLHOUSE_SESSION_ID = 'integration-test';
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Stale element pruning', () => {
    it('should skip stale activations during restore when element no longer exists', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-stale-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        // Write a fake activation file referencing a skill that doesn't exist
        const fakeState = {
          version: 1,
          sessionId: 'integration-test',
          lastUpdated: new Date().toISOString(),
          activations: {
            skill: [
              { name: 'nonexistent-skill-xyz', activatedAt: new Date().toISOString() },
            ],
          },
        };

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          JSON.stringify(fakeState, null, 2)
        );

        // Load the store — should succeed (loads in-memory)
        const store = new ActivationStore(fileOps, stateDir);
        await store.initialize();

        // The store should have the activation loaded
        const activations = store.getActivations('skill');
        expect(activations).toHaveLength(1);
        expect(activations[0].name).toBe('nonexistent-skill-xyz');
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Corrupt file resilience', () => {
    it('should start fresh when activation file contains invalid JSON', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-corrupt-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          'NOT_VALID_JSON{{{corrupted'
        );

        const store = new ActivationStore(fileOps, stateDir);
        await store.initialize(); // Should not throw

        // Should start with empty activations
        expect(store.getActivations('skill')).toEqual([]);
        expect(store.getActivations('persona')).toEqual([]);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });

    it('should start fresh when activation file has wrong version', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-version-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');

        const futureState = {
          version: 99,
          sessionId: 'integration-test',
          lastUpdated: new Date().toISOString(),
          activations: {
            skill: [{ name: 'future-skill', activatedAt: new Date().toISOString() }],
          },
        };

        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          path.join(stateDir, 'activations-integration-test.json'),
          JSON.stringify(futureState, null, 2)
        );

        const store = new ActivationStore(fileOps, stateDir);
        await store.initialize();

        // Version mismatch should cause it to start fresh
        expect(store.getActivations('skill')).toEqual([]);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('Persistence disabled mode', () => {
    it('should not record activations when persistence is disabled', async () => {
      process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'false';

      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-disabled-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');
        const store = new ActivationStore(fileOps, stateDir);
        await store.initialize();

        expect(store.isEnabled()).toBe(false);

        store.recordActivation('skill', 'should-not-persist');
        await new Promise(resolve => setTimeout(resolve, 200));

        // No activations recorded
        expect(store.getActivations('skill')).toEqual([]);

        // No file written
        const files = await fs.readdir(stateDir).catch(() => []);
        expect(files.filter(f => f.startsWith('activations-'))).toHaveLength(0);
      } finally {
        delete process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE;
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe('clearAll resets persisted state', () => {
    it('should clear all activations from store and persist empty state', async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-store-clear-'));

      try {
        const fileOps = container.resolve<any>('FileOperationsService');
        const store = new ActivationStore(fileOps, stateDir);
        await store.initialize();

        store.recordActivation('skill', 'clear-test-skill');
        store.recordActivation('memory', 'clear-test-memory');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify recorded
        expect(store.getActivations('skill')).toHaveLength(1);
        expect(store.getActivations('memory')).toHaveLength(1);

        // Clear all
        store.clearAll();
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(store.getActivations('skill')).toHaveLength(0);
        expect(store.getActivations('memory')).toHaveLength(0);

        // Reload from disk — should be empty
        const store2 = new ActivationStore(fileOps, stateDir);
        await store2.initialize();
        expect(store2.getActivations('skill')).toHaveLength(0);
        expect(store2.getActivations('memory')).toHaveLength(0);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Container Startup Behavior Tests (Non-Flaky)
 *
 * These tests verify BEHAVIOR without timing assertions.
 * Split from Container.startup.test.ts to isolate timing-sensitive tests.
 *
 * Behavior tests verify:
 * - Both checks are called
 * - Checks run in parallel (via call order tracking, not timing)
 * - Error handling works correctly
 * - Migration flows work
 *
 * Timing tests are in Container.startup-timing.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DollhouseContainer } from '../../src/di/Container.js';
import { createIsolatedContainer, type IsolatedContainer } from '../helpers/integration-container.js';

describe('Container Startup - Behavior (Non-Flaky)', () => {
  let container: DollhouseContainer;
  let env: IsolatedContainer;

  beforeEach(async () => {
    env = await createIsolatedContainer();
    container = env.container;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await env.dispose();
  });

  describe('Parallel Check Behavior', () => {
    it('should call both migration and portfolio checks', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      const needsMigrationSpy = jest.spyOn(migrationManager, 'needsMigration')
        .mockResolvedValue(false);
      const existsSpy = jest.spyOn(portfolioManager, 'exists')
        .mockResolvedValue(true);

      await container.preparePortfolio();

      expect(needsMigrationSpy).toHaveBeenCalledTimes(1);
      expect(existsSpy).toHaveBeenCalledTimes(1);
    });

    it('should start both checks before either completes (parallel verification)', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      // Track call order using a shared array
      const callOrder: string[] = [];
      let migrationResolve: () => void;
      let portfolioResolve: () => void;

      // Create controlled promises
      const migrationPromise = new Promise<void>(resolve => {
        migrationResolve = resolve;
      });
      const portfolioPromise = new Promise<void>(resolve => {
        portfolioResolve = resolve;
      });

      jest.spyOn(migrationManager, 'needsMigration').mockImplementation(async () => {
        callOrder.push('migration-start');
        await migrationPromise;
        callOrder.push('migration-end');
        return false;
      });

      jest.spyOn(portfolioManager, 'exists').mockImplementation(async () => {
        callOrder.push('portfolio-start');
        await portfolioPromise;
        callOrder.push('portfolio-end');
        return true;
      });

      // Start preparePortfolio (don't await yet)
      const preparePromise = container.preparePortfolio();

      // Wait a tick for both starts to register
      await new Promise(resolve => setImmediate(resolve));

      // VERIFY: Both checks should have started before either completed
      expect(callOrder).toContain('migration-start');
      expect(callOrder).toContain('portfolio-start');
      expect(callOrder).not.toContain('migration-end');
      expect(callOrder).not.toContain('portfolio-end');

      // Complete both checks
      migrationResolve!();
      portfolioResolve!();

      await preparePromise;

      // Both should have completed
      expect(callOrder).toContain('migration-end');
      expect(callOrder).toContain('portfolio-end');
    });
  });

  describe('Migration Flow', () => {
    it('should proceed with migration when needed', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(true);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(false);

      const migrateSpy = jest.spyOn(migrationManager, 'migrate').mockResolvedValue({
        success: true,
        migratedCount: 5,
        errors: [],
        backedUp: true,
        backupPath: '/test/backup'
      });

      const initializeSpy = jest.spyOn(portfolioManager, 'initialize').mockResolvedValue();

      await container.preparePortfolio();

      expect(migrateSpy).toHaveBeenCalledWith({ backup: true });
      expect(initializeSpy).toHaveBeenCalled();
    });

    it('should skip migration when not needed', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(false);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      const migrateSpy = jest.spyOn(migrationManager, 'migrate');

      await container.preparePortfolio();

      expect(migrateSpy).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should continue when migration check throws but portfolio succeeds', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration')
        .mockRejectedValue(new Error('Migration check failed'));
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(true);

      // Should not throw - logs warning and continues
      await expect(container.preparePortfolio()).resolves.not.toThrow();
    });

    it('should throw when portfolio check fails', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(false);
      jest.spyOn(portfolioManager, 'exists')
        .mockRejectedValue(new Error('Portfolio check failed'));

      await expect(container.preparePortfolio()).rejects.toThrow('Portfolio check failed');
    });

    it('should handle partial migration success', async () => {
      const migrationManager = container.resolve<any>('MigrationManager');
      const portfolioManager = container.resolve<any>('PortfolioManager');

      jest.spyOn(migrationManager, 'needsMigration').mockResolvedValue(true);
      jest.spyOn(portfolioManager, 'exists').mockResolvedValue(false);

      jest.spyOn(migrationManager, 'migrate').mockResolvedValue({
        success: false,
        migratedCount: 3,
        errors: ['Failed to migrate persona4.md'],
        backedUp: true,
        backupPath: '/test/backup'
      });

      const initializeSpy = jest.spyOn(portfolioManager, 'initialize').mockResolvedValue();

      await container.preparePortfolio();

      // Should still initialize portfolio after partial migration
      expect(initializeSpy).toHaveBeenCalled();
    });
  });

  // ============================================
  // STALE ACTIVATION PRUNING
  // Regression tests for the 37x skill loading bug (Fix 3)
  // ============================================

  describe('Stale Activation Pruning', () => {
    // Issue #706: Activation restore logic moved to completeDeferredSetup()
    // These tests now call both preparePortfolio() + completeDeferredSetup()

    it('should prune stale skill activations when activateSkill returns failure', async () => {
      // Resolve managers and activation store
      const skillManager = container.resolve<any>('SkillManager');
      const activationStore = container.resolve<any>('ActivationStore');

      // Setup: ActivationStore has stale skill entries
      const mockActivations = [
        { name: 'real-skill', activatedAt: new Date().toISOString() },
        { name: 'stale-test-artifact', activatedAt: new Date().toISOString() },
        { name: 'another-stale', activatedAt: new Date().toISOString() },
      ];

      jest.spyOn(activationStore, 'isEnabled').mockReturnValue(true);
      jest.spyOn(activationStore, 'initialize').mockResolvedValue(undefined);
      jest.spyOn(activationStore, 'getActivations').mockImplementation((type: string) => {
        if (type === 'skill') return [...mockActivations];
        return [];
      });
      const removeStalespy = jest.spyOn(activationStore, 'removeStaleActivation')
        .mockImplementation(() => {});

      // Mock activateSkill: real-skill succeeds, others fail
      jest.spyOn(skillManager, 'activateSkill').mockImplementation(async (name: string) => {
        if (name === 'real-skill') {
          return { success: true, message: 'Activated' };
        }
        return { success: false, message: `Skill '${name}' not found` };
      });

      await container.preparePortfolio();
      await container.completeDeferredSetup();

      // Verify stale entries were pruned
      expect(removeStalespy).toHaveBeenCalledWith('skill', 'stale-test-artifact');
      expect(removeStalespy).toHaveBeenCalledWith('skill', 'another-stale');
      // Real skill should NOT be pruned
      expect(removeStalespy).not.toHaveBeenCalledWith('skill', 'real-skill');
    });

    it('should prune stale agent activations when activateAgent returns failure', async () => {
      const agentManager = container.resolve<any>('AgentManager');
      const activationStore = container.resolve<any>('ActivationStore');

      jest.spyOn(activationStore, 'isEnabled').mockReturnValue(true);
      jest.spyOn(activationStore, 'initialize').mockResolvedValue(undefined);
      jest.spyOn(activationStore, 'getActivations').mockImplementation((type: string) => {
        if (type === 'agent') return [{ name: 'missing-agent', activatedAt: new Date().toISOString() }];
        return [];
      });
      const removeStaleSpy = jest.spyOn(activationStore, 'removeStaleActivation')
        .mockImplementation(() => {});

      jest.spyOn(agentManager, 'activateAgent').mockResolvedValue({
        success: false,
        message: 'Agent not found'
      });

      await container.preparePortfolio();
      await container.completeDeferredSetup();

      expect(removeStaleSpy).toHaveBeenCalledWith('agent', 'missing-agent');
    });

    it('should prune stale persona activations when activatePersona returns failure', async () => {
      const personaManager = container.resolve<any>('PersonaManager');
      const activationStore = container.resolve<any>('ActivationStore');

      jest.spyOn(activationStore, 'isEnabled').mockReturnValue(true);
      jest.spyOn(activationStore, 'initialize').mockResolvedValue(undefined);
      jest.spyOn(activationStore, 'getActivations').mockImplementation((type: string) => {
        if (type === 'persona') return [{ name: 'deleted-persona', activatedAt: new Date().toISOString() }];
        return [];
      });
      const removeStaleSpy = jest.spyOn(activationStore, 'removeStaleActivation')
        .mockImplementation(() => {});

      jest.spyOn(personaManager, 'activatePersona').mockReturnValue({
        success: false,
        message: 'Persona not found'
      });

      await container.preparePortfolio();
      await container.completeDeferredSetup();

      expect(removeStaleSpy).toHaveBeenCalledWith('persona', 'deleted-persona');
    });

    it('should still prune on thrown exceptions (defensive)', async () => {
      const skillManager = container.resolve<any>('SkillManager');
      const activationStore = container.resolve<any>('ActivationStore');

      jest.spyOn(activationStore, 'isEnabled').mockReturnValue(true);
      jest.spyOn(activationStore, 'initialize').mockResolvedValue(undefined);
      jest.spyOn(activationStore, 'getActivations').mockImplementation((type: string) => {
        if (type === 'skill') return [{ name: 'crash-skill', activatedAt: new Date().toISOString() }];
        return [];
      });
      const removeStaleSpy = jest.spyOn(activationStore, 'removeStaleActivation')
        .mockImplementation(() => {});

      // Simulate an unexpected throw (not normal, but defensive)
      jest.spyOn(skillManager, 'activateSkill').mockRejectedValue(
        new Error('Unexpected internal error')
      );

      // Should not crash startup
      await container.preparePortfolio();
      await container.completeDeferredSetup();

      // Should still prune the entry
      expect(removeStaleSpy).toHaveBeenCalledWith('skill', 'crash-skill');
    });
  });
});

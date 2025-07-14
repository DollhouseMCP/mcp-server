import { describe, it, expect } from '@jest/globals';
import { DependencyChecker } from '../../../../src/update/DependencyChecker.js';
import { VersionManager } from '../../../../src/update/VersionManager.js';

// Simple integration test - runs against real implementation
describe('DependencyChecker (Simple)', () => {
  let dependencyChecker: DependencyChecker;

  beforeEach(() => {
    const versionManager = new VersionManager();
    dependencyChecker = new DependencyChecker(versionManager);
  });

  describe('basic functionality', () => {
    it('should create a DependencyChecker instance', () => {
      expect(dependencyChecker).toBeDefined();
      expect(dependencyChecker).toBeInstanceOf(DependencyChecker);
    });

    it('should have required methods', () => {
      expect(typeof dependencyChecker.checkDependencies).toBe('function');
      expect(typeof dependencyChecker.formatDependencyStatus).toBe('function');
    });

    it('should check dependencies and return structured results', async () => {
      const result = await dependencyChecker.checkDependencies();
      
      expect(result).toHaveProperty('git');
      expect(result.git).toHaveProperty('installed');
      expect(typeof result.git.installed).toBe('boolean');
      
      expect(result).toHaveProperty('npm');
      expect(result.npm).toHaveProperty('installed');
      expect(typeof result.npm.installed).toBe('boolean');
    });

    it('should format dependency status', async () => {
      const dependencies = await dependencyChecker.checkDependencies();
      const formatted = dependencyChecker.formatDependencyStatus(dependencies);
      
      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });
});
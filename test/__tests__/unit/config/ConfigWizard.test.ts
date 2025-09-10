/**
 * ConfigWizard Test Suite
 * 
 * Tests the configuration wizard functionality including:
 * - Detection of new installations
 * - Tracking completion/dismissal
 * - Non-interactive environment handling
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { ConfigManager } from '../../../../src/config/ConfigManager.js';
import { ConfigWizard } from '../../../../src/config/ConfigWizard.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ConfigWizard', () => {
  let configManager: ConfigManager;
  let wizard: ConfigWizard;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(os.tmpdir(), `dollhouse-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Set test config directory
    process.env.TEST_CONFIG_DIR = testDir;
    
    // Reset singleton for clean tests
    ConfigManager.resetForTesting();
    
    // Get fresh instances
    configManager = ConfigManager.getInstance();
    wizard = new ConfigWizard(configManager);
    
    // Mock console methods to prevent output during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    wizard.close();
    jest.restoreAllMocks();
    
    // Clean up test directory
    if (testDir) {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    
    // Clean up environment variable
    delete process.env.TEST_CONFIG_DIR;
  });

  describe('shouldRunWizard', () => {
    it('should return false in non-interactive environment', async () => {
      // ConfigWizard checks process.stdin.isTTY which is undefined in tests
      const shouldRun = await wizard.shouldRunWizard();
      expect(shouldRun).toBe(false);
    });

    it('should detect new installation when wizard not completed or dismissed', async () => {
      // Mock interactive environment
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true
      });

      // Create new wizard with mocked TTY
      const interactiveWizard = new ConfigWizard(configManager);
      
      // Initialize config with default values (wizard not completed)
      await configManager.initialize();
      
      const shouldRun = await interactiveWizard.shouldRunWizard();
      
      // Should want to run on fresh install
      const config = configManager.getConfig();
      if (!config.wizard?.completed && !config.wizard?.dismissed) {
        expect(shouldRun).toBe(true);
      }
      
      interactiveWizard.close();
      
      // Clean up TTY mocks
      delete (process.stdin as any).isTTY;
      delete (process.stdout as any).isTTY;
    });

    it('should not run if wizard was completed', async () => {
      await configManager.initialize();
      await configManager.updateSetting('wizard.completed', true);
      await configManager.updateSetting('wizard.completedAt', new Date().toISOString());
      
      const shouldRun = await wizard.shouldRunWizard();
      expect(shouldRun).toBe(false);
    });

    it('should not run if wizard was dismissed', async () => {
      await configManager.initialize();
      await configManager.updateSetting('wizard.dismissed', true);
      
      const shouldRun = await wizard.shouldRunWizard();
      expect(shouldRun).toBe(false);
    });
  });

  describe('markCompleted', () => {
    it('should set completion status with timestamp', async () => {
      await configManager.initialize();
      await wizard.markCompleted();
      
      const config = configManager.getConfig();
      expect(config.wizard.completed).toBe(true);
      expect(config.wizard.completedAt).toBeDefined();
      expect(config.wizard.version).toBeDefined();
    });

    it('should track skipped sections', async () => {
      await configManager.initialize();
      const skippedSections = ['github', 'sync'];
      await wizard.markCompleted(skippedSections);
      
      const config = configManager.getConfig();
      expect(config.wizard.skippedSections).toEqual(skippedSections);
    });
  });

  describe('markDismissed', () => {
    it('should set dismissed flag', async () => {
      await configManager.initialize();
      await wizard.markDismissed();
      
      const config = configManager.getConfig();
      expect(config.wizard.dismissed).toBe(true);
    });
  });

  describe('Non-interactive environment', () => {
    it('should handle non-TTY environments gracefully', () => {
      // process.stdin.isTTY is undefined in test environment
      expect(process.stdin.isTTY).toBeUndefined();
      expect(process.stdout.isTTY).toBeUndefined();
      
      // Wizard should create successfully but not be interactive
      const nonInteractiveWizard = new ConfigWizard(configManager);
      expect(nonInteractiveWizard).toBeDefined();
      
      nonInteractiveWizard.close();
    });
  });

  describe('Configuration defaults', () => {
    it('should have wizard config in default configuration', async () => {
      await configManager.initialize();
      const config = configManager.getConfig();
      
      expect(config.wizard).toBeDefined();
      expect(config.wizard.completed).toBe(false);
      expect(config.wizard.dismissed).toBe(false);
    });
  });
});
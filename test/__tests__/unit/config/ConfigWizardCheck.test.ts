/**
 * Unit tests for ConfigWizardCheck
 * Tests automatic wizard detection and response wrapping functionality
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock modules using ESM approach
jest.unstable_mockModule('../../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn(),
    resetForTesting: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  }
}));

// Import after mocking
const { ConfigManager } = await import('../../../../src/config/ConfigManager.js');
const { logger } = await import('../../../../src/utils/logger.js');
const { ConfigWizardCheck } = await import('../../../../src/config/ConfigWizardCheck.js');

describe('ConfigWizardCheck', () => {
  let wizardCheck: ConfigWizardCheck;
  let mockConfigManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock ConfigManager instance
    mockConfigManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockReturnValue({}),
      updateSetting: jest.fn().mockResolvedValue(undefined),
    };
    
    // Mock getInstance to return our mock
    (ConfigManager.getInstance as jest.Mock).mockReturnValue(mockConfigManager);
    
    wizardCheck = new ConfigWizardCheck();
  });

  describe('checkIfWizardNeeded', () => {
    it('should return wizard prompt for new installation', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      
      const result = await wizardCheck.checkIfWizardNeeded();
      
      expect(result).toContain('Welcome to DollhouseMCP!');
      expect(result).toContain('Ready to get started?');
      expect(mockConfigManager.initialize).toHaveBeenCalledTimes(1);
    });

    it('should return null when wizard is already completed', async () => {
      mockConfigManager.getConfig.mockReturnValue({
        wizard: { completed: true, dismissed: false }
      });
      
      const result = await wizardCheck.checkIfWizardNeeded();
      
      expect(result).toBeNull();
    });

    it('should return null when wizard is dismissed', async () => {
      mockConfigManager.getConfig.mockReturnValue({
        wizard: { dismissed: true, completed: false }
      });
      
      const result = await wizardCheck.checkIfWizardNeeded();
      
      expect(result).toBeNull();
    });

    it('should only check once per session', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      
      // First call
      const result1 = await wizardCheck.checkIfWizardNeeded();
      expect(result1).toContain('Welcome to DollhouseMCP!');
      
      // Second call should return null without checking config
      const result2 = await wizardCheck.checkIfWizardNeeded();
      expect(result2).toBeNull();
      
      // Config should only be initialized once
      expect(mockConfigManager.initialize).toHaveBeenCalledTimes(1);
    });

    it('should handle config initialization errors gracefully', async () => {
      const error = new Error('Config error');
      mockConfigManager.initialize.mockRejectedValue(error);
      
      const result = await wizardCheck.checkIfWizardNeeded();
      
      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'Error checking config wizard status',
        { error }
      );
    });
  });

  describe('wrapResponse', () => {
    beforeEach(() => {
      // Reset the hasCheckedWizard flag for each test
      wizardCheck = new ConfigWizardCheck();
      (ConfigManager.getInstance as jest.Mock).mockReturnValue(mockConfigManager);
    });

    it('should wrap response with wizard prompt when needed', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const originalResponse = {
        content: [{ type: 'text', text: 'Original content' }]
      };
      
      const wrapped = await wizardCheck.wrapResponse(originalResponse);
      
      expect(wrapped.content).toHaveLength(3);
      expect(wrapped.content[0].text).toContain('Welcome to DollhouseMCP!');
      expect(wrapped.content[1].text).toBe('\n\n---\n\n');
      expect(wrapped.content[2]).toEqual({ type: 'text', text: 'Original content' });
    });

    it('should not mutate the original response object', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const originalResponse = {
        content: [{ type: 'text', text: 'Original content' }]
      };
      const originalCopy = JSON.parse(JSON.stringify(originalResponse));
      
      await wizardCheck.wrapResponse(originalResponse);
      
      expect(originalResponse).toEqual(originalCopy);
    });

    it('should handle non-standard response formats', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const response = { text: 'Simple text response' };
      
      const wrapped = await wizardCheck.wrapResponse(response);
      
      expect(wrapped.content).toHaveLength(3);
      expect(wrapped.content[0].text).toContain('Welcome to DollhouseMCP!');
      expect(wrapped.content[2].text).toBe('Simple text response');
    });

    it('should handle response with message property', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const response = { message: 'Message response' };
      
      const wrapped = await wizardCheck.wrapResponse(response);
      
      expect(wrapped.content).toHaveLength(3);
      expect(wrapped.content[2].text).toBe('Message response');
    });

    it('should handle primitive responses', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const response = 'String response';
      
      const wrapped = await wizardCheck.wrapResponse(response);
      
      expect(wrapped.content).toHaveLength(3);
      expect(wrapped.content[2].text).toBe('String response');
    });

    it('should handle null responses', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const response = null;
      
      const wrapped = await wizardCheck.wrapResponse(response);
      
      expect(wrapped.content).toHaveLength(3);
      expect(wrapped.content[2].text).toBe('Tool executed successfully');
    });

    it('should return original response when wizard not needed', async () => {
      mockConfigManager.getConfig.mockReturnValue({
        wizard: { completed: true, dismissed: false }
      });
      const originalResponse = { content: [{ type: 'text', text: 'Original' }] };
      
      const wrapped = await wizardCheck.wrapResponse(originalResponse);
      
      expect(wrapped).toBe(originalResponse);
    });

    it('should preserve other response properties', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      const originalResponse = {
        content: [{ type: 'text', text: 'Original' }],
        metadata: { key: 'value' },
        status: 'success'
      };
      
      const wrapped = await wizardCheck.wrapResponse(originalResponse);
      
      expect(wrapped.metadata).toEqual({ key: 'value' });
      expect(wrapped.status).toBe('success');
    });
  });

  describe('markWizardCompleted', () => {
    it('should update wizard completion settings', async () => {
      const mockDate = '2025-09-09T18:00:00.000Z';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockDate);
      
      await wizardCheck.markWizardCompleted();
      
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('wizard.completed', true);
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('wizard.completedAt', mockDate);
    });
  });

  describe('markWizardDismissed', () => {
    it('should update wizard dismissed setting', async () => {
      await wizardCheck.markWizardDismissed();
      
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('wizard.dismissed', true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle wizard flow from new install to completion', async () => {
      // Start with new installation
      mockConfigManager.getConfig.mockReturnValue({});
      
      // First interaction shows wizard
      const result1 = await wizardCheck.checkIfWizardNeeded();
      expect(result1).toContain('Welcome to DollhouseMCP!');
      
      // Subsequent interactions don't show wizard (same session)
      const result2 = await wizardCheck.checkIfWizardNeeded();
      expect(result2).toBeNull();
      
      // Mark as completed
      await wizardCheck.markWizardCompleted();
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('wizard.completed', true);
    });

    it('should handle wizard dismissal flow', async () => {
      mockConfigManager.getConfig.mockReturnValue({});
      
      // First check shows wizard
      const result1 = await wizardCheck.checkIfWizardNeeded();
      expect(result1).toContain('Welcome to DollhouseMCP!');
      
      // User dismisses wizard
      await wizardCheck.markWizardDismissed();
      expect(mockConfigManager.updateSetting).toHaveBeenCalledWith('wizard.dismissed', true);
    });
  });
});
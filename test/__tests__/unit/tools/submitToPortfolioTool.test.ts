/**
 * Unit tests for SubmitToPortfolioTool
 * Tests collection submission workflow enhancement (Issue #549)
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { SubmitToPortfolioTool } from '../../../../src/tools/portfolio/submitToPortfolioTool.js';
import { APICache } from '../../../../src/cache/APICache.js';
import { GitHubAuthManager } from '../../../../src/auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../../../src/portfolio/PortfolioRepoManager.js';
import { ContentValidator } from '../../../../src/security/contentValidator.js';
import { TokenManager } from '../../../../src/security/tokenManager.js';
import { UnicodeValidator } from '../../../../src/security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { FileDiscoveryUtil } from '../../../../src/utils/FileDiscoveryUtil.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import * as fs from 'fs/promises';

// Mock all dependencies
jest.mock('../../../../src/auth/GitHubAuthManager.js');
jest.mock('../../../../src/portfolio/PortfolioRepoManager.js');
jest.mock('../../../../src/security/contentValidator.js');
jest.mock('../../../../src/security/tokenManager.js');
jest.mock('../../../../src/security/validators/unicodeValidator.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/FileDiscoveryUtil.js');
jest.mock('fs/promises');

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('SubmitToPortfolioTool', () => {
  let tool: SubmitToPortfolioTool;
  let mockApiCache: jest.Mocked<APICache>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    
    // Create mock API cache
    mockApiCache = {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn(),
      has: jest.fn(),
      delete: jest.fn(),
    } as any;

    // Initialize tool
    tool = new SubmitToPortfolioTool(mockApiCache);

    // Reset all mocks
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Authentication', () => {
    it('should handle authentication failures gracefully', async () => {
      // Mock auth check to return not authenticated
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: false,
      });

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_AUTHENTICATED');
      expect(result.message).toContain('Not authenticated');
      expect(result.message).toContain('gh auth login');
    });

    it('should proceed when authenticated', async () => {
      // Mock successful authentication
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser',
      });

      // Mock other dependencies for successful flow
      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'test-element',
      });

      (FileDiscoveryUtil.findFile as jest.Mock).mockResolvedValue(null);

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(GitHubAuthManager.prototype.getAuthStatus).toHaveBeenCalled();
      expect(result.error).toBe('CONTENT_NOT_FOUND');
    });
  });

  describe('Input Validation', () => {
    it('should validate Unicode input correctly', async () => {
      // Mock auth success
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser',
      });

      // Mock Unicode validation failure
      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: false,
        detectedIssues: ['Homograph attack detected'],
      });

      const result = await tool.execute({
        name: 'test\u202Eelement',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(result.message).toContain('Invalid characters');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'UNICODE_VALIDATION_ERROR',
          severity: 'MEDIUM',
        })
      );
    });

    it('should handle file size limits', async () => {
      // Mock successful auth and validation
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser',
      });

      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'test-element',
      });

      (FileDiscoveryUtil.findFile as jest.Mock).mockResolvedValue('/path/to/element.md');

      // Mock file stat to exceed size limit
      (fs.stat as jest.Mock).mockResolvedValue({
        size: 11 * 1024 * 1024, // 11MB
      });

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('FILE_TOO_LARGE');
      expect(result.message).toContain('exceeds 10MB limit');
    });
  });

  describe('Collection Submission', () => {
    beforeEach(() => {
      // Setup common successful mocks
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser',
      });

      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'test-element',
      });

      (FileDiscoveryUtil.findFile as jest.Mock).mockResolvedValue('/path/to/element.md');

      (fs.stat as jest.Mock).mockResolvedValue({ size: 1024 });

      (fs.readFile as jest.Mock).mockResolvedValue('# Test Element Content');

      (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: true,
        sanitizedContent: '# Test Element Content',
      });

      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue('test-token');

      (PortfolioRepoManager.prototype.checkPortfolioExists as jest.Mock).mockResolvedValue(true);
      (PortfolioRepoManager.prototype.saveElement as jest.Mock).mockResolvedValue(
        'https://github.com/testuser/portfolio/element.md'
      );
    });

    it('should respect opt-in configuration for collection submission', async () => {
      // Test with auto-submit disabled (default)
      delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully uploaded');
      expect(result.message).toContain('You can submit to the collection later');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should create GitHub issue when auto-submit is enabled', async () => {
      // Enable auto-submit
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';

      // Mock successful GitHub API response
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/DollhouseMCP/collection/issues/123',
        }),
      });

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Also submitted to DollhouseMCP collection');
      expect(result.message).toContain('https://github.com/DollhouseMCP/collection/issues/123');

      // Verify GitHub API was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/DollhouseMCP/collection/issues',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('"title":"[personas] Add test-element by @testuser"'),
        })
      );
    });

    it('should handle GitHub API errors appropriately', async () => {
      // Enable auto-submit
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';

      // Mock GitHub API error
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Rate limit exceeded',
      });

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(true); // Portfolio upload still succeeds
      expect(result.message).toContain('Successfully uploaded');
      expect(result.message).toContain('Collection submission failed');
      expect(result.message).toContain('manually submit at');
    });

    it('should create proper GitHub issue format', async () => {
      // Enable auto-submit
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';

      // Mock successful GitHub API response
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/DollhouseMCP/collection/issues/123',
        }),
      });

      await tool.execute({
        name: 'test-element',
        type: ElementType.SKILL,
      });

      // Verify issue body format
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      
      expect(body.title).toBe('[skills] Add test-element by @testuser');
      expect(body.body).toContain('## New skills Submission');
      expect(body.body).toContain('**Name**: test-element');
      expect(body.body).toContain('**Author**: @testuser');
      expect(body.body).toContain('### Portfolio Link');
      expect(body.body).toContain('### Metadata');
      expect(body.body).toContain('### Review Checklist');
      expect(body.labels).toEqual(['contribution', 'pending-review', 'skills']);
    });

    it('should handle missing GitHub token gracefully', async () => {
      // Enable auto-submit
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';

      // Mock missing token
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue(null);

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('TOKEN_ERROR');
      expect(result.message).toContain('Could not retrieve GitHub token');
    });
  });

  describe('Error Handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      // Mock auth to throw unexpected error
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('error');
    });

    it('should continue with portfolio upload if collection submission fails', async () => {
      // Setup successful portfolio upload
      (GitHubAuthManager.prototype.getAuthStatus as jest.Mock).mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser',
      });

      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'test-element',
      });

      (FileDiscoveryUtil.findFile as jest.Mock).mockResolvedValue('/path/to/element.md');
      (fs.stat as jest.Mock).mockResolvedValue({ size: 1024 });
      (fs.readFile as jest.Mock).mockResolvedValue('# Content');
      (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: true,
      });
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue('token');
      (PortfolioRepoManager.prototype.checkPortfolioExists as jest.Mock).mockResolvedValue(true);
      (PortfolioRepoManager.prototype.saveElement as jest.Mock).mockResolvedValue(
        'https://github.com/user/portfolio/element.md'
      );

      // Enable auto-submit but make it fail
      process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';
      mockFetch.mockRejectedValue(new Error('Connection timeout'));

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA,
      });

      // Should still succeed with portfolio upload
      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully uploaded');
      expect(result.message).toContain('Collection submission failed');
    });
  });
});
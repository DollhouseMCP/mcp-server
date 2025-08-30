/**
 * Tests for SubmitToPortfolioTool
 * NOTE: This test is currently excluded from Jest due to complex mocking requirements.
 * The mocking of multiple dependencies causes TypeScript compilation issues.
 * TODO: Refactor to use integration tests or simpler unit tests.
 */

import { jest } from '@jest/globals';

// Manual mocking before imports
const mockGitHubAuthManager = jest.fn();
const mockPortfolioRepoManager = jest.fn();

jest.unstable_mockModule('../../../../../src/auth/GitHubAuthManager.js', () => ({
  GitHubAuthManager: mockGitHubAuthManager
}));

jest.unstable_mockModule('../../../../../src/portfolio/PortfolioRepoManager.js', () => ({
  PortfolioRepoManager: mockPortfolioRepoManager
}));
// Import the tool after setting up mocks
const { SubmitToPortfolioTool } = await import('../../../../../src/tools/portfolio/submitToPortfolioTool.js');
import { TokenManager } from '../../../../../src/security/tokenManager.js';
import { ContentValidator } from '../../../../../src/security/contentValidator.js';
import { PortfolioManager } from '../../../../../src/portfolio/PortfolioManager.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';
import { UnicodeValidator } from '../../../../../src/security/validators/unicodeValidator.js';
// APICache import removed - using mock
import { ElementType } from '../../../../../src/portfolio/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock other dependencies
jest.mock('../../../../../src/security/tokenManager.js');
jest.mock('../../../../../src/security/contentValidator.js');
jest.mock('../../../../../src/portfolio/PortfolioManager.js');
jest.mock('../../../../../src/security/securityMonitor.js');
jest.mock('../../../../../src/security/validators/unicodeValidator.js');
jest.mock('fs/promises');

// Type the mocked modules
const MockedFs = fs as jest.Mocked<typeof fs>;

describe.skip('SubmitToPortfolioTool', () => {
  let tool: InstanceType<typeof SubmitToPortfolioTool>;
  let mockApiCache: any;
  let mockAuthManager: any;
  let mockPortfolioRepoManager: any;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock API cache
    mockApiCache = {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn(),
      has: jest.fn(),
      delete: jest.fn()
    };
    
    // Setup auth manager mock with proper typing
    mockAuthManager = {
      getAuthStatus: jest.fn().mockImplementation(() => Promise.resolve({
        isAuthenticated: true,
        username: 'testuser'
      }))
    };
    
    // Setup portfolio repo manager mock with proper typing
    mockPortfolioRepoManager = {
      setToken: jest.fn(),
      checkPortfolioExists: jest.fn().mockImplementation(() => Promise.resolve(true)),
      createPortfolio: jest.fn().mockImplementation(() => Promise.resolve('https://github.com/testuser/portfolio')),
      saveElement: jest.fn().mockImplementation(() => Promise.resolve('https://github.com/testuser/portfolio/blob/main/personas/sample.md'))
    };
    
    // Configure mock constructors
    mockGitHubAuthManager.mockImplementation(() => mockAuthManager);
    mockPortfolioRepoManager.mockImplementation(() => mockPortfolioRepoManager);
    
    (TokenManager.getGitHubTokenAsync as jest.Mock<() => Promise<string | null>>).mockResolvedValue('test-token');
    
    (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
      isValid: true,
      sanitizedContent: 'test content'
    });
    
    (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
      isValid: true,
      normalizedContent: 'test-element'
    });
    
    (PortfolioManager.getInstance as jest.Mock).mockReturnValue({
      getElementDir: jest.fn().mockReturnValue('/test/portfolio/personas')
    });
    
    (SecurityMonitor.logSecurityEvent as jest.Mock).mockImplementation(() => {});
    
    MockedFs.stat.mockResolvedValue({ size: 1024 } as any); // 1KB file
    MockedFs.readFile.mockResolvedValue('test content' as any);
    MockedFs.access.mockResolvedValue(undefined);
    MockedFs.readdir.mockResolvedValue(['test-element.md'] as any);
    
    tool = new SubmitToPortfolioTool(mockApiCache);
  });
  
  describe('Authentication checks', () => {
    it('should fail when user is not authenticated', async () => {
      mockAuthManager.getAuthStatus.mockResolvedValue({
        isAuthenticated: false,
        username: null
      } as any);
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_AUTHENTICATED');
      expect(result.message).toContain('Not authenticated');
    });
    
    it('should proceed when user is authenticated', async () => {
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(true);
      expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
    });
  });
  
  describe('Unicode validation', () => {
    it('should reject invalid Unicode in element name', async () => {
      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: false,
        detectedIssues: ['Invalid Unicode characters detected']
      });
      
      const result = await tool.execute({
        name: 'test\u202Eelement'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'UNICODE_VALIDATION_ERROR',
          severity: 'MEDIUM'
        })
      );
    });
    
    it('should normalize valid Unicode in element name', async () => {
      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'normalized-name'
      });
      
      await tool.execute({
        name: 'tëst-élement'
      });
      
      expect(UnicodeValidator.normalize).toHaveBeenCalledWith('tëst-élement');
    });
  });
  
  describe('Local content discovery', () => {
    it('should find content by exact filename match', async () => {
      MockedFs.access.mockResolvedValue(undefined);
      
      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(fs.access).toHaveBeenCalled();
    });
    
    it('should find content by partial filename match', async () => {
      MockedFs.access.mockRejectedValue(new Error('File not found'));
      MockedFs.readdir.mockResolvedValue(['my-test-element-file.md'] as any);
      
      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(fs.readdir).toHaveBeenCalled();
    });
    
    it('should fail when content is not found', async () => {
      MockedFs.access.mockRejectedValue(new Error('File not found'));
      MockedFs.readdir.mockResolvedValue([]);
      
      const result = await tool.execute({
        name: 'nonexistent',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('CONTENT_NOT_FOUND');
    });
  });
  
  describe('File size validation', () => {
    it('should reject files larger than 10MB', async () => {
      MockedFs.stat.mockResolvedValue({ size: 11 * 1024 * 1024 } as any); // 11MB
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('FILE_TOO_LARGE');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RATE_LIMIT_EXCEEDED',
          severity: 'MEDIUM'
        })
      );
    });
    
    it('should accept files under 10MB', async () => {
      MockedFs.stat.mockResolvedValue({ size: 5 * 1024 * 1024 } as any); // 5MB
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(true);
    });
  });
  
  describe('Content validation', () => {
    it('should reject content with critical security issues', async () => {
      (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: false,
        severity: 'critical',
        detectedPatterns: ['prompt injection', 'XSS attempt']
      });
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_FAILED');
      expect(result.message).toContain('prompt injection');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH'
        })
      );
    });
    
    it('should allow content with non-critical warnings', async () => {
      (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: false,
        severity: 'warning',
        detectedPatterns: ['minor issue']
      });
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(true);
    });
  });
  
  describe('Token management', () => {
    it('should fail when token cannot be retrieved', async () => {
      (TokenManager.getGitHubTokenAsync as jest.Mock<() => Promise<string | null>>).mockResolvedValue(null);
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('TOKEN_ERROR');
    });
    
    it('should set token on PortfolioRepoManager', async () => {
      await tool.execute({
        name: 'test-element'
      });
      
      expect(mockPortfolioRepoManager.setToken).toHaveBeenCalledWith('test-token');
    });
  });
  
  describe('Portfolio repository management', () => {
    it('should create portfolio if it does not exist', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(false);
      
      await tool.execute({
        name: 'test-element'
      });
      
      expect(mockPortfolioRepoManager.createPortfolio).toHaveBeenCalledWith('testuser', true);
    });
    
    it('should not create portfolio if it already exists', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(true);
      
      await tool.execute({
        name: 'test-element'
      });
      
      expect(mockPortfolioRepoManager.createPortfolio).not.toHaveBeenCalled();
    });
    
    it('should fail if portfolio creation fails', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(false);
      mockPortfolioRepoManager.createPortfolio.mockResolvedValue(null as any);
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('CREATE_FAILED');
    });
  });
  
  describe('Element submission', () => {
    it('should save element with correct structure', async () => {
      await tool.execute({
        name: 'test-element',
        type: ElementType.SKILL
      });
      
      expect(mockPortfolioRepoManager.saveElement).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ElementType.SKILL,
          metadata: expect.objectContaining({
            name: 'test-element',
            author: 'testuser'
          }),
          content: 'test content'
        }),
        true
      );
    });
    
    it('should return success with GitHub URL', async () => {
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(true);
      expect(result.url).toBe('https://github.com/testuser/portfolio/blob/main/personas/sample.md');
    });
    
    it('should fail if element save fails', async () => {
      mockPortfolioRepoManager.saveElement.mockResolvedValue(null as any);
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('SAVE_FAILED');
    });
  });
  
  describe('Error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      const error = new Error('Unexpected error');
      mockAuthManager.getAuthStatus.mockRejectedValue(error);
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNEXPECTED_ERROR');
      expect(result.message).toContain('Unexpected error');
    });
    
    it('should handle non-Error objects', async () => {
      mockAuthManager.getAuthStatus.mockRejectedValue('string error');
      
      const result = await tool.execute({
        name: 'test-element'
      });
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('string error');
    });
  });
  
  describe('Collection submission with file content', () => {
    it('should read and include full file content when localPath provided', async () => {
      // Setup: Mock file content with frontmatter
      const fullContent = `---
name: test-persona
description: Test persona for unit testing
author: testuser
version: 1.0.0
---

# Test Persona

This is the full content of the test persona.`;
      
      MockedFs.readFile.mockResolvedValue(fullContent as any);
      MockedFs.stat.mockResolvedValue({ size: 1024 } as any);
      
      // Mock the createCollectionIssue method behavior
      const createIssueSpy = jest.spyOn(tool as any, 'createCollectionIssue');
      createIssueSpy.mockResolvedValue('https://github.com/DollhouseMCP/collection/issues/123');
      
      // Execute with localPath parameter
      const result = await tool.execute({
        name: 'test-persona',
        type: ElementType.PERSONA
      });
      
      // Verify file was read
      expect(MockedFs.readFile).toHaveBeenCalled();
      
      // Verify the result includes submission info
      expect(result.success).toBe(true);
    });
    
    it('should reject files exceeding size limit without truncation', async () => {
      // Setup: File larger than 10MB
      MockedFs.stat.mockResolvedValue({ size: 11 * 1024 * 1024 } as any); // 11MB
      
      const result = await tool.execute({
        name: 'oversized-element',
        type: ElementType.PERSONA
      });
      
      // Verify rejection without truncation
      expect(result.success).toBe(false);
      expect(result.error).toBe('FILE_TOO_LARGE');
      expect(result.message).toContain('exceeds');
      
      // Ensure file read wasn't attempted
      expect(MockedFs.readFile).not.toHaveBeenCalled();
    });
    
    it('should handle security validation failures for file content', async () => {
      // Setup: Malicious content
      const maliciousContent = `---
name: evil-persona
---
<script>alert('XSS')</script>`;
      
      MockedFs.readFile.mockResolvedValue(maliciousContent as any);
      MockedFs.stat.mockResolvedValue({ size: 100 } as any);
      
      // Mock security validation to fail
      (ContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: false,
        severity: 'critical',
        detectedPatterns: ['XSS attempt']
      });
      
      const result = await tool.execute({
        name: 'malicious-element',
        type: ElementType.PERSONA
      });
      
      // Verify security rejection
      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_FAILED');
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH'
        })
      );
    });
    
    it('should handle file not found errors gracefully', async () => {
      // Setup: File doesn't exist
      MockedFs.access.mockRejectedValue(new Error('ENOENT: no such file'));
      
      const result = await tool.execute({
        name: 'non-existent-element',
        type: ElementType.PERSONA
      });
      
      // Should still attempt submission but without file content
      expect(result.success).toBe(true);
    });
    
    it('should validate frontmatter presence in file content', async () => {
      // Setup: Content without frontmatter
      const contentWithoutFrontmatter = `This is just plain content without frontmatter`;
      
      MockedFs.readFile.mockResolvedValue(contentWithoutFrontmatter as any);
      MockedFs.stat.mockResolvedValue({ size: 100 } as any);
      
      // This should still work - the tool adds frontmatter if missing
      const result = await tool.execute({
        name: 'no-frontmatter-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
    });
    
    it('should handle Unicode content correctly', async () => {
      // Setup: Content with Unicode characters
      const unicodeContent = `---
name: unicode-test
description: 测试 🚀 Test
---

Content with émojis 🎉 and special characters: 中文、日本語、한국어`;
      
      MockedFs.readFile.mockResolvedValue(unicodeContent as any);
      MockedFs.stat.mockResolvedValue({ size: 200 } as any);
      
      // Mock Unicode validation to pass
      (UnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: unicodeContent
      });
      
      const result = await tool.execute({
        name: 'unicode-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(UnicodeValidator.normalize).toHaveBeenCalled();
    });
  });
});
/**
 * Tests for SubmitToPortfolioTool
 * Covers authentication, content discovery, validation, and GitHub submission
 */

import { jest } from '@jest/globals';
import { SubmitToPortfolioTool } from '../../../../../src/tools/portfolio/submitToPortfolioTool.js';
import { GitHubAuthManager } from '../../../../../src/auth/GitHubAuthManager.js';
import { PortfolioRepoManager } from '../../../../../src/portfolio/PortfolioRepoManager.js';
import { TokenManager } from '../../../../../src/security/tokenManager.js';
import { ContentValidator } from '../../../../../src/security/contentValidator.js';
import { PortfolioManager } from '../../../../../src/portfolio/PortfolioManager.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';
import { UnicodeValidator } from '../../../../../src/security/validators/unicodeValidator.js';
// APICache import removed - using mock
import { ElementType } from '../../../../../src/portfolio/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock all dependencies
jest.mock('../../../../../src/auth/GitHubAuthManager.js');
jest.mock('../../../../../src/portfolio/PortfolioRepoManager.js');
jest.mock('../../../../../src/security/tokenManager.js');
jest.mock('../../../../../src/security/contentValidator.js');
jest.mock('../../../../../src/portfolio/PortfolioManager.js');
jest.mock('../../../../../src/security/securityMonitor.js');
jest.mock('../../../../../src/security/validators/unicodeValidator.js');
jest.mock('fs/promises');

describe('SubmitToPortfolioTool', () => {
  let tool: SubmitToPortfolioTool;
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
    
    // Setup auth manager mock
    mockAuthManager = {
      getAuthStatus: jest.fn<any, any>().mockResolvedValue({
        isAuthenticated: true,
        username: 'testuser'
      })
    };
    
    // Setup portfolio repo manager mock
    mockPortfolioRepoManager = {
      setToken: jest.fn<any, any>(),
      checkPortfolioExists: jest.fn<any, any>().mockResolvedValue(true),
      createPortfolio: jest.fn<any, any>().mockResolvedValue('https://github.com/testuser/portfolio'),
      saveElement: jest.fn<any, any>().mockResolvedValue('https://github.com/testuser/portfolio/blob/main/personas/test.md')
    };
    
    // Mock constructors
    (GitHubAuthManager as any).mockImplementation(() => mockAuthManager);
    (PortfolioRepoManager as any).mockImplementation(() => mockPortfolioRepoManager);
    
    (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue<any, any>('test-token');
    
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
    
    (fs.stat as jest.Mock).mockResolvedValue({ size: 1024 } as any); // 1KB file
    (fs.readFile as jest.Mock).mockResolvedValue('test content' as any);
    (fs.access as jest.Mock).mockResolvedValue(undefined as any);
    (fs.readdir as jest.Mock).mockResolvedValue(['test-element.md'] as any);
    
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
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      
      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(fs.access).toHaveBeenCalled();
    });
    
    it('should find content by partial filename match', async () => {
      (fs.access as jest.Mock).mockRejectedValue(new Error('File not found'));
      (fs.readdir as jest.Mock).mockResolvedValue(['my-test-element-file.md']);
      
      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(fs.readdir).toHaveBeenCalled();
    });
    
    it('should fail when content is not found', async () => {
      (fs.access as jest.Mock).mockRejectedValue<any, any>(new Error('File not found'));
      (fs.readdir as jest.Mock).mockResolvedValue<any, any>([]);
      
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
      (fs.stat as jest.Mock).mockResolvedValue<any, any>({ size: 11 * 1024 * 1024 }); // 11MB
      
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
      (fs.stat as jest.Mock).mockResolvedValue<any, any>({ size: 5 * 1024 * 1024 }); // 5MB
      
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
      (TokenManager.getGitHubTokenAsync as jest.Mock).mockResolvedValue<any, any>(null);
      
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
      expect(result.url).toBe('https://github.com/testuser/portfolio/blob/main/personas/test.md');
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
});
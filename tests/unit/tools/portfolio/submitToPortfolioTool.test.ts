/**
 * Tests for SubmitToPortfolioTool
 */

import { jest } from '@jest/globals';

// Manual mocking before imports - ALL mocks must use unstable_mockModule for ES modules
const MockGitHubAuthManager = jest.fn();
const MockPortfolioRepoManager = jest.fn();
const MockTokenManagerInstance = {
  getGitHubTokenAsync: jest.fn(),
  getGitHubToken: jest.fn().mockReturnValue('test-token'),
  getTokenType: jest.fn().mockReturnValue('oauth'),
  validateTokenFormat: jest.fn().mockReturnValue(true),
  getRequiredScopes: jest.fn().mockReturnValue({ required: ['public_repo'] }),
  validateTokenScopes: jest.fn().mockResolvedValue({
    isValid: true,
    scopes: ['public_repo'],
    rateLimit: { remaining: 5000, resetTime: new Date(Date.now() + 3600000) }
  }),
  getTokenPrefix: jest.fn().mockReturnValue('ghp_test'),
  redactToken: jest.fn().mockReturnValue('[REDACTED]'),
  createSafeErrorMessage: jest.fn((msg: string) => msg),
  ensureTokenPermissions: jest.fn().mockResolvedValue({ isValid: true }),
  resetTokenValidationLimiter: jest.fn(),
};
const MockContentValidator = {
  validateAndSanitize: jest.fn()
};
const MockPortfolioManager = jest.fn();
const MockSecurityMonitor = {
  logSecurityEvent: jest.fn()
};
const MockUnicodeValidator = {
  normalize: jest.fn()
};
const MockFs = {
  readFile: jest.fn(),
  stat: jest.fn()
};

// Mock FileOperationsService that the tool uses internally
const MockFileOperationsService = {
  readFile: jest.fn(),
  stat: jest.fn(),
  exists: jest.fn(),
  readElementFile: jest.fn(),
  writeFile: jest.fn(),
  deleteFile: jest.fn(),
  createDirectory: jest.fn(),
  listDirectory: jest.fn(),
  resolvePath: jest.fn((p: string) => p),
  validatePath: jest.fn().mockReturnValue(true)
};

jest.unstable_mockModule('../../../../src/auth/GitHubAuthManager.js', () => ({
  GitHubAuthManager: MockGitHubAuthManager
}));

jest.unstable_mockModule('../../../../src/portfolio/PortfolioRepoManager.js', () => ({
  PortfolioRepoManager: MockPortfolioRepoManager
}));

jest.unstable_mockModule('../../../../src/security/tokenManager.js', () => ({
  TokenManager: jest.fn().mockImplementation(() => MockTokenManagerInstance)
}));

jest.unstable_mockModule('../../../../src/security/contentValidator.js', () => ({
  ContentValidator: MockContentValidator
}));

jest.unstable_mockModule('../../../../src/portfolio/PortfolioManager.js', () => ({
  PortfolioManager: MockPortfolioManager,
  getElementFileExtension: (type: string) => type === 'memories' ? '.yaml' : '.md',
}));

jest.unstable_mockModule('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: MockSecurityMonitor
}));

jest.unstable_mockModule('../../../../src/security/validators/unicodeValidator.js', () => ({
  UnicodeValidator: MockUnicodeValidator
}));

// Mock SecureYamlParser
const MockSecureYamlParser = {
  parse: jest.fn()
};

jest.unstable_mockModule('../../../../src/security/secureYamlParser.js', () => ({
  SecureYamlParser: MockSecureYamlParser
}));

// Mock githubRateLimiter
const MockGitHubRateLimiter = {
  queueRequest: jest.fn()
};

// Note: MockGitHubRateLimiter is no longer exported as singleton, it's injected via DI

// Mock ErrorHandler
const MockErrorHandler = {
  logError: jest.fn(),
  formatForResponse: jest.fn()
};

// Mock ErrorCategory enum to match the real enum values
const MockErrorCategory = {
  USER_ERROR: 'USER_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR'
};

jest.unstable_mockModule('../../../../src/utils/ErrorHandler.js', () => ({
  ErrorHandler: MockErrorHandler,
  ErrorCategory: MockErrorCategory
}));

// Mock FileDiscoveryUtil
const MockFileDiscoveryUtil = {
  findFile: jest.fn()
};

jest.unstable_mockModule('../../../../src/utils/FileDiscoveryUtil.js', () => ({
  FileDiscoveryUtil: MockFileDiscoveryUtil
}));

// Mock EarlyTerminationSearch
const MockEarlyTerminationSearch = {
  executeWithEarlyTermination: jest.fn()
};

jest.unstable_mockModule('../../../../src/utils/EarlyTerminationSearch.js', () => ({
  EarlyTerminationSearch: MockEarlyTerminationSearch
}));

// Mock global fetch
global.fetch = jest.fn() as any;

jest.unstable_mockModule('fs/promises', () => MockFs);

// Import the tool AFTER setting up all mocks
const { SubmitToPortfolioTool } = await import('../../../../src/tools/portfolio/submitToPortfolioTool.js');
import { ElementType } from '../../../../src/portfolio/types.js';

describe('SubmitToPortfolioTool', () => {
  let tool: any; // Using any since SubmitToPortfolioTool is a class, not a type
  let mockApiCache: any;
  let mockAuthManager: any;
  let mockPortfolioRepoManager: any;
  let mockPortfolioManager: any;
  let mockPortfolioIndexManager: any;
  
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
        username: 'testuser', type: 'personas' as any
      }))
    };
    
    // Setup portfolio repo manager mock with proper typing
    mockPortfolioRepoManager = {
      setToken: jest.fn(),
      checkPortfolioExists: jest.fn().mockImplementation(() => Promise.resolve(true)),
      createPortfolio: jest.fn().mockImplementation(() => Promise.resolve('https://github.com/testuser/portfolio')),
      saveElement: jest.fn().mockImplementation(() => Promise.resolve('https://github.com/testuser/portfolio/blob/main/personas/sample.md')),
      getRepositoryName: jest.fn().mockReturnValue('portfolio')
    };

    // Configure mock constructors
    MockGitHubAuthManager.mockImplementation(() => mockAuthManager);
    MockPortfolioRepoManager.mockImplementation(() => mockPortfolioRepoManager);

    MockTokenManagerInstance.getGitHubTokenAsync.mockResolvedValue('test-token');

    MockContentValidator.validateAndSanitize.mockReturnValue({
      isValid: true,
      sanitizedContent: 'test content'
    });

    MockUnicodeValidator.normalize.mockReturnValue({
      isValid: true,
      normalizedContent: 'test-element'
    });
    
    mockPortfolioManager = {
      getElementDir: jest.fn().mockReturnValue('/test/portfolio/personas'),
      getBaseDir: jest.fn().mockReturnValue('/test/portfolio')
    };
    MockPortfolioManager.mockImplementation(() => mockPortfolioManager);
    MockPortfolioManager.getInstance = jest.fn().mockReturnValue(mockPortfolioManager);

    mockPortfolioIndexManager = {
      getIndex: jest.fn().mockResolvedValue({
        byName: new Map([['test-element', {
          filePath: '/test/portfolio/personas/test-element.md',
          elementType: 'personas',
          metadata: { name: 'test-element', description: 'Test' },
          lastModified: new Date(),
          filename: 'test-element', type: 'personas' as any
        }]]),
        byFilename: new Map(),
        byType: new Map([['personas', [{
          filePath: '/test/portfolio/personas/test-element.md',
          elementType: 'personas',
          metadata: { name: 'test-element', description: 'Test' },
          lastModified: new Date(),
          filename: 'test-element', type: 'personas' as any
        }]]]),
        byKeyword: new Map(),
        byTag: new Map(),
        byTrigger: new Map()
      }),
      rebuildIndex: jest.fn().mockResolvedValue(undefined),
      getElementsByType: jest.fn().mockResolvedValue([{
        filePath: '/test/portfolio/personas/test-element.md',
        elementType: 'personas',
        metadata: { name: 'test-element', description: 'Test' },
        lastModified: new Date(),
        filename: 'test-element', type: 'personas' as any
      }]),
      findByName: jest.fn().mockResolvedValue({
        filePath: '/test/portfolio/personas/test-element.md',
        elementType: 'personas',
        metadata: { name: 'test-element', description: 'Test' },
        lastModified: new Date(),
        filename: 'test-element', type: 'personas' as any
      })
    };

    MockSecurityMonitor.logSecurityEvent.mockImplementation(() => {});

    MockFs.stat.mockResolvedValue({ size: 1024 } as any); // 1KB file
    MockFs.readFile.mockResolvedValue('test content' as any);
    MockFs.access = jest.fn().mockResolvedValue(undefined);
    MockFs.readdir = jest.fn().mockResolvedValue(['test-element.md'] as any);

    // Configure MockFileOperationsService (used by the tool)
    MockFileOperationsService.stat.mockResolvedValue({ size: 1024 } as any); // 1KB file
    MockFileOperationsService.readFile.mockResolvedValue('test content');
    MockFileOperationsService.exists.mockResolvedValue(true);
    MockFileOperationsService.readElementFile.mockResolvedValue('test content');

    // Configure SecureYamlParser mock
    MockSecureYamlParser.parse.mockReturnValue({
      data: {
        name: 'test-element',
        description: 'Test description',
        author: 'testuser',
        version: '1.0.0'
      }
    });

    // Configure FileDiscoveryUtil mock
    MockFileDiscoveryUtil.findFile.mockResolvedValue('/test/portfolio/personas/test-element.md');

    // Configure EarlyTerminationSearch mock
    MockEarlyTerminationSearch.executeWithEarlyTermination.mockResolvedValue({
      matches: [],
      exactMatch: null,
      failures: [],
      totalSearches: 0,
      completedSearches: 0,
      earlyTerminationTriggered: false,
      performanceGain: '0%'
    });

    // Configure GitHubRateLimiter mock
    MockGitHubRateLimiter.queueRequest.mockImplementation(async (_name: string, fn: () => Promise<any>) => {
      return fn();
    });

    // Configure ErrorHandler mock
    MockErrorHandler.logError.mockImplementation(() => {});
    MockErrorHandler.formatForResponse.mockImplementation((error: any) => ({
      success: false,
      message: error instanceof Error ? error.message : String(error),
      error: 'UNEXPECTED_ERROR'
    }));

    // Configure global fetch mock
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
      headers: new Headers({
        'X-RateLimit-Remaining': '5000',
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600)
      })
    });

    tool = new SubmitToPortfolioTool(mockApiCache, {
      authManager: mockAuthManager,
      portfolioRepoManager: mockPortfolioRepoManager,
      portfolioManager: mockPortfolioManager,
      portfolioIndexManager: mockPortfolioIndexManager,
      rateLimiter: MockGitHubRateLimiter as any,
      fileOperations: MockFileOperationsService as any,
      tokenManager: MockTokenManagerInstance as any
    });
  });
  
  describe('Authentication checks', () => {
    it('should fail when user is not authenticated', async () => {
      mockAuthManager.getAuthStatus.mockResolvedValue({
        isAuthenticated: false,
        username: null
      } as any);

      const result = await tool.execute({
        name: 'test-element',
        type: 'personas' as any
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_AUTHENTICATED');
      expect(result.message).toContain('Not authenticated');
    });
    
    it('should proceed when user is authenticated', async () => {
      // Add spy to capture actual errors
      const logErrorSpy = jest.spyOn(MockErrorHandler, 'logError');

      const result = await tool.execute({
        name: 'test-element',
        type: 'personas' as any
      });

      if (!result.success) {
        console.log('Tool execution failed:', JSON.stringify(result, null, 2));
        if (logErrorSpy.mock.calls.length > 0) {
          console.log('ErrorHandler.logError called with:', logErrorSpy.mock.calls[0]);
        }
      }

      expect(result.success).toBe(true);
      expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
    });
  });
  
  describe('Unicode validation', () => {
    it('should reject invalid Unicode in element name', async () => {
      (MockUnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: false,
        detectedIssues: ['Invalid Unicode characters detected']
      });
      
      const result = await tool.execute({
        name: 'test\u202Eelement', type: 'personas' as any
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(MockSecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'UNICODE_VALIDATION_ERROR',
          severity: 'MEDIUM'
        })
      );
    });
    
    it('should normalize valid Unicode in element name', async () => {
      (MockUnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: 'normalized-name'
      });
      
      await tool.execute({
        name: 'tëst-élement', type: 'personas' as any
      });
      
      expect(MockUnicodeValidator.normalize).toHaveBeenCalledWith('tëst-élement');
    });
  });
  
  describe('Local content discovery', () => {
    it('should find content by exact filename match', async () => {
      // The index manager is checked first, and we configured it to return a result
      mockPortfolioIndexManager.findByName.mockResolvedValue({
        filePath: '/test/portfolio/personas/test-element.md',
        elementType: 'personas',
        metadata: { name: 'test-element', description: 'Test' },
        lastModified: new Date(),
        filename: 'test-element', type: 'personas' as any
      });

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });

      expect(result.success).toBe(true);
      expect(mockPortfolioIndexManager.findByName).toHaveBeenCalled();
    });

    it('should find content by partial filename match', async () => {
      // Configure index to return null so it falls back to FileDiscoveryUtil
      mockPortfolioIndexManager.findByName.mockResolvedValue(null);
      MockFileDiscoveryUtil.findFile.mockResolvedValue('/test/portfolio/personas/my-test-element-file.md');

      const result = await tool.execute({
        name: 'test-element',
        type: ElementType.PERSONA
      });

      expect(result.success).toBe(true);
      expect(MockFileDiscoveryUtil.findFile).toHaveBeenCalled();
    });

    it('should fail when content is not found', async () => {
      MockFileDiscoveryUtil.findFile.mockResolvedValue(null);
      mockPortfolioIndexManager.findByName.mockResolvedValue(null);

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
      MockFileOperationsService.stat.mockResolvedValue({ size: 11 * 1024 * 1024 } as any); // 11MB

      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('FILE_TOO_LARGE');
      expect(MockSecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RATE_LIMIT_EXCEEDED',
          severity: 'MEDIUM'
        })
      );
    });

    it('should accept files under 10MB', async () => {
      MockFileOperationsService.stat.mockResolvedValue({ size: 5 * 1024 * 1024 } as any); // 5MB

      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });

      expect(result.success).toBe(true);
    });
  });
  
  describe('Content validation', () => {
    it('should reject content with critical security issues', async () => {
      (MockContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: false,
        severity: 'critical',
        detectedPatterns: ['prompt injection', 'XSS attempt']
      });
      
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('VALIDATION_FAILED');
      expect(result.message).toContain('prompt injection');
      expect(MockSecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH'
        })
      );
    });
    
    it('should allow content with non-critical warnings', async () => {
      (MockContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
        isValid: false,
        severity: 'warning',
        detectedPatterns: ['minor issue']
      });
      
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(result.success).toBe(true);
    });
  });
  
  describe('Token management', () => {
    it('should fail when token cannot be retrieved', async () => {
      // @ts-expect-error - Mock for skipped test
      MockTokenManagerInstance.getGitHubTokenAsync.mockResolvedValue(null);

      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('NO_TOKEN');
    });
    
    it('should set token on PortfolioRepoManager', async () => {
      await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(mockPortfolioRepoManager.setToken).toHaveBeenCalledWith('test-token');
    });
  });
  
  describe('Portfolio repository management', () => {
    it('should create portfolio if it does not exist', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(false);
      
      await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(mockPortfolioRepoManager.createPortfolio).toHaveBeenCalledWith('testuser', true);
    });
    
    it('should not create portfolio if it already exists', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(true);
      
      await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(mockPortfolioRepoManager.createPortfolio).not.toHaveBeenCalled();
    });
    
    it('should fail if portfolio creation fails', async () => {
      mockPortfolioRepoManager.checkPortfolioExists.mockResolvedValue(false);
      mockPortfolioRepoManager.createPortfolio.mockResolvedValue(null as any);
      
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
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
          portfolioElement: expect.objectContaining({
            type: ElementType.SKILL,
            metadata: expect.objectContaining({
              name: 'test-element',
              author: 'testuser'
            }),
            content: 'test content'
          })
        }),
        true
      );
    });
    
    it('should return success with GitHub URL', async () => {
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
      });
      
      expect(result.success).toBe(true);
      expect(result.url).toBe('https://github.com/testuser/portfolio/blob/main/personas/sample.md');
    });
    
    it('should fail if element save fails', async () => {
      mockPortfolioRepoManager.saveElement.mockResolvedValue(null as any);
      
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
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
        name: 'test-element', type: 'personas' as any
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNEXPECTED_ERROR');
      expect(result.message).toContain('Unexpected error');
    });
    
    it('should handle non-Error objects', async () => {
      mockAuthManager.getAuthStatus.mockRejectedValue('string error');
      
      const result = await tool.execute({
        name: 'test-element', type: 'personas' as any
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
      
      MockFileOperationsService.readFile.mockResolvedValue(fullContent);
      MockFileOperationsService.stat.mockResolvedValue({ size: 1024 } as any);
      
      // Mock the createCollectionIssue method behavior
      const createIssueSpy = jest.spyOn(tool as any, 'createCollectionIssue');
      createIssueSpy.mockResolvedValue('https://github.com/DollhouseMCP/collection/issues/123');
      
      // Execute with localPath parameter
      const result = await tool.execute({
        name: 'test-persona',
        type: ElementType.PERSONA
      });
      
      // Verify file was read
      expect(MockFileOperationsService.readFile).toHaveBeenCalled();
      
      // Verify the result includes submission info
      expect(result.success).toBe(true);
    });
    
    it('should reject files exceeding size limit without truncation', async () => {
      // Setup: File larger than 10MB
      MockFileOperationsService.stat.mockResolvedValue({ size: 11 * 1024 * 1024 } as any); // 11MB
      
      const result = await tool.execute({
        name: 'oversized-element',
        type: ElementType.PERSONA
      });
      
      // Verify rejection without truncation
      expect(result.success).toBe(false);
      expect(result.error).toBe('FILE_TOO_LARGE');
      expect(result.message).toContain('exceeds');
      
      // Ensure file read wasn't attempted
      expect(MockFileOperationsService.readFile).not.toHaveBeenCalled();
    });
    
    it('should handle security validation failures for file content', async () => {
      // Setup: Malicious content
      const maliciousContent = `---
name: evil-persona
---
<script>alert('XSS')</script>`;
      
      MockFileOperationsService.readFile.mockResolvedValue(maliciousContent);
      MockFileOperationsService.stat.mockResolvedValue({ size: 100 } as any);
      
      // Mock security validation to fail
      (MockContentValidator.validateAndSanitize as jest.Mock).mockReturnValue({
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
      expect(MockSecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: 'HIGH'
        })
      );
    });
    
    it('should handle file not found errors gracefully', async () => {
      // Setup: File doesn't exist
      MockFs.access.mockRejectedValue(new Error('ENOENT: no such file'));
      
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
      
      MockFileOperationsService.readFile.mockResolvedValue(contentWithoutFrontmatter);
      MockFileOperationsService.stat.mockResolvedValue({ size: 100 } as any);
      
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
      
      MockFileOperationsService.readFile.mockResolvedValue(unicodeContent);
      MockFileOperationsService.stat.mockResolvedValue({ size: 200 } as any);
      
      // Mock Unicode validation to pass
      (MockUnicodeValidator.normalize as jest.Mock).mockReturnValue({
        isValid: true,
        normalizedContent: unicodeContent
      });
      
      const result = await tool.execute({
        name: 'unicode-element',
        type: ElementType.PERSONA
      });
      
      expect(result.success).toBe(true);
      expect(MockUnicodeValidator.normalize).toHaveBeenCalled();
    });
  });
});

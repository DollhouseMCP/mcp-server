/**
 * PortfolioRepoManager Test Suite
 * 
 * Following TDD approach - RED phase
 * These tests should fail initially until implementation is complete
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PortfolioRepoManager } from '../../../../src/portfolio/PortfolioRepoManager.js';
import { IElement } from '../../../../src/types/elements/IElement.js';

// Mock modules
jest.mock('../../../../src/security/tokenManager.js');
jest.mock('../../../../src/security/validators/unicodeValidator.js');
jest.mock('../../../../src/security/securityMonitor.js');

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

describe('PortfolioRepoManager', () => {
  let manager: PortfolioRepoManager;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Mock TokenManager
    const { TokenManager } = await import('../../../../src/security/tokenManager.js');
    (TokenManager as any).getGitHubTokenAsync = jest.fn(() => Promise.resolve('test-token'));
    (TokenManager as any).validateTokenScopes = jest.fn(() => Promise.resolve({ 
      isValid: true, 
      scopes: ['public_repo'] 
    }));
    
    // Mock UnicodeValidator
    const { UnicodeValidator } = await import('../../../../src/security/validators/unicodeValidator.js');
    (UnicodeValidator as any).normalize = jest.fn((input: string) => ({ 
      normalizedContent: input,
      warnings: [] 
    }));
    
    // Mock SecurityMonitor
    const { SecurityMonitor } = await import('../../../../src/security/securityMonitor.js');
    (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();
    
    // Setup fetch mock
    mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;
    
    manager = new PortfolioRepoManager();
  });

  describe('checkPortfolioExists', () => {
    it('should check if portfolio repository exists for a user', async () => {
      // Arrange
      const username = 'testuser';
      const repoName = 'dollhouse-portfolio';
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: repoName,
          owner: { login: username }
        })
      } as Response);

      // Act
      const exists = await manager.checkPortfolioExists(username);

      // Assert
      expect(exists).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/${username}/${repoName}`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        })
      );
    });

    it('should return false when portfolio does not exist', async () => {
      // Arrange
      const username = 'testuser';
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' })
      } as Response);

      // Act
      const exists = await manager.checkPortfolioExists(username);

      // Assert
      expect(exists).toBe(false);
    });
  });

  describe('createPortfolio', () => {
    it('should create portfolio repository only with user consent', async () => {
      // Arrange
      const username = 'testuser';
      const consent = true;
      const repoUrl = 'https://github.com/testuser/dollhouse-portfolio';
      
      // First call: check if repo exists (404)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' })
      } as Response);
      
      // Second call: create repository
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          html_url: repoUrl,
          name: 'dollhouse-portfolio'
        })
      } as Response);
      
      // Mock calls for generatePortfolioStructure (README + 6 directories)
      for (let i = 0; i < 7; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ commit: { sha: 'abc123' } })
        } as Response);
      }

      // Act
      const url = await manager.createPortfolio(username, consent);

      // Assert
      expect(url).toBe(repoUrl);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user/repos',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('dollhouse-portfolio')
        })
      );
    });

    it('should throw error when user declines consent', async () => {
      // Arrange
      const username = 'testuser';
      const consent = false;

      // Act & Assert
      await expect(manager.createPortfolio(username, consent))
        .rejects.toThrow('User declined portfolio creation');
      
      // Should not make any API calls when consent is declined
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not create portfolio if it already exists', async () => {
      // Arrange
      const username = 'testuser';
      const consent = true;
      
      // Repository already exists
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'dollhouse-portfolio',
          html_url: 'https://github.com/testuser/dollhouse-portfolio'
        })
      } as Response);

      // Act
      const url = await manager.createPortfolio(username, consent);

      // Assert
      expect(url).toBe('https://github.com/testuser/dollhouse-portfolio');
      // Should only have made one call to check existence
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveElement', () => {
    const mockElement = {
      id: 'test-element-123',
      type: 'persona' as any,
      version: '1.0.0',
      metadata: {
        name: 'Test Element',
        description: 'A test element',
        author: 'testuser'
      },
      validate: () => ({ valid: true, errors: [], warnings: [] }),
      serialize: () => '# Test Element\n\nThis is test content',
      deserialize: (data: string) => {},
      getStatus: () => ({ status: 'active' } as any)
    } as IElement;

    it('should save element to portfolio with user consent', async () => {
      // Arrange
      const consent = true;
      const expectedPath = 'personas/test-element.md';
      const commitUrl = 'https://github.com/testuser/dollhouse-portfolio/commit/abc123';
      
      // First call: check if file exists (404 - doesn't exist)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' })
      } as Response);
      
      // Second call: create file
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          commit: {
            html_url: commitUrl
          }
        })
      } as Response);

      // Act
      const url = await manager.saveElement(mockElement, consent);

      // Assert
      expect(url).toBe(commitUrl);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(expectedPath),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('Test Element')
        })
      );
    });

    it('should throw error when user declines consent for saving', async () => {
      // Arrange
      const consent = false;

      // Act & Assert
      await expect(manager.saveElement(mockElement, consent))
        .rejects.toThrow('User declined to save element to portfolio');
      
      // Should not make any API calls
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should save element to correct location based on type', async () => {
      // Arrange
      const skillElement: IElement = {
        ...mockElement,
        type: 'skill' as any,
        metadata: {
          ...mockElement.metadata,
          name: 'Code Review Skill'
        }
      };
      const consent = true;

      // Mock file doesn't exist
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' })
      } as Response);
      
      // Mock file creation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          commit: { html_url: 'https://github.com/testuser/dollhouse-portfolio/commit/def456' }
        })
      } as Response);

      // Act
      await manager.saveElement(skillElement, consent);

      // Assert
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('skills/code-review-skill.md'),
        expect.objectContaining({
          method: 'PUT'
        })
      );
    });
  });

  describe('generatePortfolioStructure', () => {
    it('should generate correct portfolio structure with README', async () => {
      // Arrange
      const username = 'testuser';
      
      // Mock successful file creations (README + 6 directories)
      for (let i = 0; i < 7; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ commit: { sha: 'abc123' } })
        } as Response);
      }

      // Act
      await manager.generatePortfolioStructure(username);

      // Assert
      // Should create README.md
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('README.md'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('DollhouseMCP Portfolio')
        })
      );

      // Should create directory placeholders
      const expectedDirs = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
      expectedDirs.forEach(dir => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining(`${dir}/.gitkeep`),
          expect.objectContaining({
            method: 'PUT'
          })
        );
      });
    });
  });

  describe('error handling', () => {
    it('should handle API failures gracefully', async () => {
      // Arrange
      const username = 'testuser';
      
      mockFetch.mockRejectedValueOnce(new Error('GitHub API rate limit exceeded'));

      // Act
      const exists = await manager.checkPortfolioExists(username);

      // Assert
      expect(exists).toBe(false); // Should handle error gracefully
    });

    it('should provide helpful error messages for common failures', async () => {
      // Arrange
      const username = 'testuser';
      const consent = true;
      
      // TODO: mockGitHubClient needs to be defined
      // mockGitHubClient.createRepository = jest.fn().mockRejectedValue(
      //   new Error('Repository creation failed: insufficient permissions')
      // );

      // Act & Assert
      await expect(manager.createPortfolio(username, consent))
        .rejects.toThrow('insufficient permissions');
    });

    it('should validate element before saving', async () => {
      // Arrange
      const invalidElement: IElement = {
        id: '',
        type: 'persona' as any,
        version: '1.0.0',
        metadata: {
          name: '', // Invalid: empty name
          description: 'Test'
        },
        validate: () => ({ valid: true, errors: [], warnings: [] }),
        serialize: () => 'test',
        deserialize: (data: string) => {},
        getStatus: () => ({ status: 'active' } as any)
      };
      const consent = true;

      // Act & Assert
      await expect(manager.saveElement(invalidElement, consent))
        .rejects.toThrow('Invalid element: name is required');
      
      // Should not make any API calls
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('consent validation', () => {
    it('should never perform operations without explicit consent', async () => {
      // Test that all methods requiring consent validate it properly
      const username = 'testuser';
      const element: IElement = {
        id: 'test-element',
        type: 'persona' as any,
        version: '1.0.0',
        metadata: {
          name: 'Test',
          description: 'Test element'
        },
        validate: () => ({ valid: true, errors: [], warnings: [] }),
        serialize: () => 'test',
        deserialize: (data: string) => {},
        getStatus: () => ({ status: 'active' } as any)
      };
      
      // Test createPortfolio
      await expect(manager.createPortfolio(username, undefined as any))
        .rejects.toThrow('Consent is required');
      
      // Test saveElement
      await expect(manager.saveElement(element, undefined as any))
        .rejects.toThrow('Consent is required');
      
      // Verify no API calls were made
      // Should not make any API calls when consent is declined
      expect(mockFetch).not.toHaveBeenCalled();
      // Should not make any API calls
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should log consent decisions for audit trail', async () => {
      // Arrange
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const username = 'testuser';
      const consent = true;
      
      // Mock repo doesn't exist
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' })
      } as Response);
      
      // Mock repo creation
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          html_url: 'https://github.com/testuser/dollhouse-portfolio'
        })
      } as Response);
      
      // Mock structure creation (7 files)
      for (let i = 0; i < 7; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ commit: { sha: 'abc123' } })
        } as Response);
      }

      // Act
      await manager.createPortfolio(username, consent);

      // Assert
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('User consented to portfolio creation')
      );
      
      consoleSpy.mockRestore();
    });
  });
});
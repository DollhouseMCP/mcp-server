/**
 * Unit tests for PortfolioDownloader
 * Tests GitHub download functionality for portfolio synchronization
 */

import { jest } from '@jest/globals';
import { PortfolioDownloader } from '../../../../src/sync/PortfolioDownloader.js';
import { PortfolioRepoManager } from '../../../../src/portfolio/PortfolioRepoManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import * as path from 'path';

// Mock dependencies
jest.mock('../../../../src/portfolio/PortfolioRepoManager.js');
jest.mock('../../../../src/security/validators/unicodeValidator.js', () => ({
  UnicodeValidator: {
    normalize: jest.fn((content: string) => ({
      normalizedContent: content,
      warnings: []
    }))
  }
}));

describe('PortfolioDownloader', () => {
  let downloader: PortfolioDownloader;
  let mockRepoManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a mock PortfolioRepoManager with jest functions
    mockRepoManager = {
      githubRequest: jest.fn(),
      // Add other methods if needed
    };
    
    downloader = new PortfolioDownloader();
  });

  describe('downloadFromGitHub', () => {
    const mockFileContent = `---
name: Test Element
description: A test element
version: 1.0.0
---

# Test Content

This is test content.`;

    const mockBase64Content = Buffer.from(mockFileContent).toString('base64');

    it('should download and parse a valid element file', async () => {
      mockRepoManager.githubRequest.mockResolvedValue({
        content: mockBase64Content,
        encoding: 'base64',
        sha: 'abc123',
        size: mockFileContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/test-element.md',
        'testuser',
        'testrepo'
      );

      expect(result).toEqual({
        content: mockFileContent,
        metadata: {
          name: 'Test Element',
          description: 'A test element',
          version: '1.0.0'
        },
        sha: 'abc123'
      });

      expect(mockRepoManager.githubRequest).toHaveBeenCalledWith(
        '/repos/testuser/testrepo/contents/personas/test-element.md'
      );
    });

    it('should handle files without YAML frontmatter', async () => {
      const plainContent = '# Just Markdown\n\nNo frontmatter here.';
      const plainBase64 = Buffer.from(plainContent).toString('base64');

      mockRepoManager.githubRequest.mockResolvedValue({
        content: plainBase64,
        encoding: 'base64',
        sha: 'def456',
        size: plainContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/plain.md',
        'testuser',
        'testrepo'
      );

      expect(result).toEqual({
        content: plainContent,
        metadata: {},
        sha: 'def456'
      });
    });

    it('should normalize Unicode content', async () => {
      const unicodeContent = `---
name: Tëst Élement
---
Content with émojis 🎉`;
      const unicodeBase64 = Buffer.from(unicodeContent).toString('base64');

      mockRepoManager.githubRequest.mockResolvedValue({
        content: unicodeBase64,
        encoding: 'base64',
        sha: 'ghi789',
        size: unicodeContent.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/unicode.md',
        'testuser',
        'testrepo'
      );

      expect(result.content).toBe(unicodeContent);
      expect(result.metadata.name).toBe('Tëst Élement');
    });

    it('should handle network errors gracefully', async () => {
      mockRepoManager.githubRequest.mockRejectedValue(
        new Error('Network error: Unable to connect')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/error.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('Network error: Unable to connect');
    });

    it('should handle rate limit errors', async () => {
      mockRepoManager.githubRequest.mockRejectedValue(
        new Error('API rate limit exceeded')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/ratelimit.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle 404 not found errors', async () => {
      mockRepoManager.githubRequest.mockRejectedValue(
        new Error('Not Found')
      );

      await expect(
        downloader.downloadFromGitHub(
          mockRepoManager,
          'personas/missing.md',
          'testuser',
          'testrepo'
        )
      ).rejects.toThrow('Not Found');
    });
  });

  describe('downloadBatch', () => {
    it('should download multiple files in parallel', async () => {
      const files = [
        'personas/element1.md',
        'personas/element2.md',
        'skills/skill1.md'
      ];

      const mockResponses = files.map((file, index) => ({
        content: Buffer.from(`Content for ${file}`).toString('base64'),
        encoding: 'base64' as const,
        sha: `sha${index}`,
        size: 100
      }));

      mockRepoManager.githubRequest
        .mockResolvedValueOnce(mockResponses[0])
        .mockResolvedValueOnce(mockResponses[1])
        .mockResolvedValueOnce(mockResponses[2]);

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo'
      );

      expect(results.size).toBe(3);
      expect(results.get('personas/element1.md')).toBeDefined();
      expect(results.get('personas/element1.md')?.content).toContain('element1.md');
      expect(results.get('personas/element2.md')).toBeDefined();
      expect(results.get('skills/skill1.md')).toBeDefined();
      expect(mockRepoManager.githubRequest).toHaveBeenCalledTimes(3);
    });

    it('should handle partial failures in batch', async () => {
      const files = [
        'personas/success.md',
        'personas/failure.md',
        'personas/another-success.md'
      ];

      mockRepoManager.githubRequest
        .mockResolvedValueOnce({
          content: Buffer.from('Success content').toString('base64'),
          encoding: 'base64',
          sha: 'sha1',
          size: 100
        })
        .mockRejectedValueOnce(new Error('Download failed'))
        .mockResolvedValueOnce({
          content: Buffer.from('Another success').toString('base64'),
          encoding: 'base64',
          sha: 'sha3',
          size: 100
        });

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo'
      );

      expect(results.size).toBe(2); // Only successful downloads are in the Map
      expect(results.has('personas/success.md')).toBe(true);
      expect(results.has('personas/failure.md')).toBe(false); // Failed download not in Map
      expect(results.has('personas/another-success.md')).toBe(true);
      expect(results.get('personas/success.md')?.content).toBe('Success content');
      expect(results.get('personas/another-success.md')?.content).toBe('Another success');
    });

    it('should respect batch size limits', async () => {
      const files = Array.from({ length: 20 }, (_, i) => `personas/file${i}.md`);
      
      // Mock all responses
      files.forEach(() => {
        mockRepoManager.githubRequest.mockResolvedValueOnce({
          content: Buffer.from('Content').toString('base64'),
          encoding: 'base64',
          sha: 'sha',
          size: 100
        });
      });

      const results = await downloader.downloadBatch(
        mockRepoManager,
        files,
        'testuser',
        'testrepo',
        5 // batch size
      );

      expect(results.size).toBe(20);
      
      // Verify all files were downloaded successfully
      files.forEach(file => {
        expect(results.has(file)).toBe(true);
        expect(results.get(file)?.content).toBe('Content');
      });
    });

    it('should handle empty batch', async () => {
      const results = await downloader.downloadBatch(
        mockRepoManager,
        [],
        'testuser',
        'testrepo'
      );

      expect(results.size).toBe(0);
      expect(mockRepoManager.githubRequest).not.toHaveBeenCalled();
    });
  });

  describe('YAML parsing', () => {
    it('should safely parse YAML without code execution', async () => {
      const maliciousYaml = `---
name: !!js/function "() => console.log('executed')"
description: Test
---
Content`;
      const base64 = Buffer.from(maliciousYaml).toString('base64');

      mockRepoManager.githubRequest.mockResolvedValue({
        content: base64,
        encoding: 'base64',
        sha: 'xyz',
        size: maliciousYaml.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/malicious.md',
        'testuser',
        'testrepo'
      );

      // Should safely parse without executing the function
      expect(result.metadata.name).toBeDefined();
      expect(typeof result.metadata.name).not.toBe('function');
    });

    it('should handle invalid YAML gracefully', async () => {
      const invalidYaml = `---
name: Test
description: [Unclosed bracket
---
Content`;
      const base64 = Buffer.from(invalidYaml).toString('base64');

      mockRepoManager.githubRequest.mockResolvedValue({
        content: base64,
        encoding: 'base64',
        sha: 'bad',
        size: invalidYaml.length
      });

      const result = await downloader.downloadFromGitHub(
        mockRepoManager,
        'personas/invalid.md',
        'testuser',
        'testrepo'
      );

      // Should return content and parse what it can from YAML
      expect(result.content).toBe(invalidYaml);
      // The simple line-by-line parser can handle this partially invalid YAML
      expect(result.metadata).toEqual({
        name: 'Test',
        description: '[Unclosed bracket'
      });
    });
  });
});